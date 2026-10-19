import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type {
  AgentEvent,
  AgentView,
  ModelChoice,
  ClientMessage,
  JsonValue,
  MemoryView,
  PcMessage,
  ProviderConnect,
  ServerMessage,
  SettingsChange,
  SettingsView,
  WorkflowNode,
  WorkflowView,
} from '@mimi/shared';
import { NODE_TYPES } from '@mimi/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { deleteAgent, saveAgent } from '../agents/loader.ts';
import { importN8n } from '../workflows/n8n-import.ts';
import { contextFor, resolveString } from '../workflows/expressions.ts';
import { REASONING_EFFORTS, type ReasoningEffort } from '@mimi/shared';
import { renderIconPng } from '../app/icon.ts';
import { AuthLimiter } from './auth-limiter.ts';
import { createBackup, listBackups } from '../backup/backup.ts';
import { AppSettings, MODEL_KEYS } from '../app/app-settings.ts';
import { presetSecretKey } from '../app/secrets.ts';
import { AgentImages } from '../chat/agent-images.ts';
import type { CoreConfig } from '../config.ts';
import { type Core, type CoreOptions, createCore } from '../core.ts';
import { startGoogleOAuth } from '../google/oauth-flow.ts';
import { type DiscoveredModel, discoverModels } from '../providers/discovery.ts';
import {
  CUSTOM_PROVIDER_NPM,
  formatModelRef,
  type ModelRef,
  parseModelRef,
  type ResolvedProvider,
} from '../providers/registry.ts';
import { resolveModelName } from '../providers/routing.ts';
import { toTriggerInfo } from '../scheduler/triggers.ts';
import { createChatApi } from './chat-api.ts';
import { handleHttpApi, type WebhookReply } from './http-api.ts';
import { PcHub } from './pc-hub.ts';
import { WsBroker } from './ws-broker.ts';

export interface MimiServer {
  core: Core;
  pc: PcHub;
  /** The port actually bound (useful when the configured port is 0). */
  port: number;
  close(): Promise<void>;
}

const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const WEB_DIR = path.join(import.meta.dirname, 'web');
/** The built-in web client: path -> [file, content type]. */
const WEB_FILES: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/feature-tools.js': ['feature-tools.js', 'text/javascript; charset=utf-8'],
  '/feature-providers.js': ['feature-providers.js', 'text/javascript; charset=utf-8'],
  '/feature-triggers.js': ['feature-triggers.js', 'text/javascript; charset=utf-8'],
  '/feature-workflows.js': ['feature-workflows.js', 'text/javascript; charset=utf-8'],
  '/feature-secrets.js': ['feature-secrets.js', 'text/javascript; charset=utf-8'],
  '/feature-chat.js': ['feature-chat.js', 'text/javascript; charset=utf-8'],
  '/feature-knowledge.js': ['feature-knowledge.js', 'text/javascript; charset=utf-8'],
  '/feature-wardrobe.js': ['feature-wardrobe.js', 'text/javascript; charset=utf-8'],
  '/feature-stage.js': ['feature-stage.js', 'text/javascript; charset=utf-8'],
  '/feature-backgrounds.js': ['feature-backgrounds.js', 'text/javascript; charset=utf-8'],
  '/feature-gallery.js': ['feature-gallery.js', 'text/javascript; charset=utf-8'],
  '/feature-canvas.js': ['feature-canvas.js', 'text/javascript; charset=utf-8'],
  '/feature-profile.js': ['feature-profile.js', 'text/javascript; charset=utf-8'],
  '/feature-notify.js': ['feature-notify.js', 'text/javascript; charset=utf-8'],
};

function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parse(data: unknown): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(String(data));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Finds permission decisions anywhere in an event, including inside sub-agent activity. */
function decisionsIn(event: AgentEvent): Array<Extract<AgentEvent, { type: 'permission-decision' }>> {
  if (event.type === 'permission-decision') return [event];
  return event.type === 'agent-activity' ? decisionsIn(event.event) : [];
}

/**
 * HTTP + WebSocket front end of the core. UI clients and the PC agent connect to
 * `/ws` and authenticate with the shared token in their first frame; the built-in
 * web client is served at `/`.
 */
export async function startServer(
  config: CoreConfig & { token: string },
  coreOptions: CoreOptions = {},
): Promise<MimiServer> {
  const clients = new Set<WebSocket>();
  const broadcast = (message: ServerMessage) => {
    const frame = JSON.stringify(message);
    for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(frame);
  };

  const broker = new WsBroker();
  const pc = new PcHub((online, name) => broadcast({ type: 'pc-status', online, name }));
  const appSettings = AppSettings.load(config.appSettingsPath);
  const core = await createCore(config, broker, {
    app: appSettings,
    ...coreOptions,
    pc,
  });
  // Providers used to live in user/data/app-settings.json; copy them into syncable files once.
  core.providers.migrate(
    Object.fromEntries(Object.entries(appSettings.providers).map(([id, entry]) => [id, { def: entry.def, models: entry.models }])),
  );
  const images = new AgentImages(config.agentsDir);
  core.status.onChange = (agent, status) => broadcast({ type: 'status', agent, status });

  const hasKey = (provider: string) => {
    try {
      return core.registry.hasCredentials(provider);
    } catch {
      return false;
    }
  };
  /** True when the model is known and its provider can be called. */
  const usable = (ref: ModelRef) => {
    try {
      core.registry.info(ref);
      return hasKey(ref.provider);
    } catch {
      return false;
    }
  };
  /** Default model per capability: what the app saved, else the settings file. */
  const effectiveDefaults = (): ModelChoice => ({
    model: appSettings.defaults.model ?? core.settings.model,
    small_model: appSettings.defaults.small_model ?? core.settings.small_model,
    vision_model: appSettings.defaults.vision_model ?? core.settings.vision_model,
    transcript_model: appSettings.defaults.transcript_model ?? core.settings.transcript_model,
    image_model: appSettings.defaults.image_model ?? core.settings.image_model,
    speech_model: appSettings.defaults.speech_model ?? core.settings.speech_model,
    video_model: appSettings.defaults.video_model ?? core.settings.video_model,
  });
  /** Rejects a model choice that names a model no connected provider offers. */
  /** A model string is `provider/model` or the name of a preset from the model pool. */
  const modelRef = (name: string) => resolveModelName(name, appSettings.presets);
  const checkModels = (choice: ModelChoice) => {
    for (const key of MODEL_KEYS) {
      const value = choice[key];
      if (value) core.registry.info(modelRef(value));
    }
  };

  const backgroundsMessage = (saved?: string): ServerMessage => ({
    type: 'backgrounds',
    items: core.backgrounds.list(),
    settings: core.backgrounds.settings(),
    ...(saved ? { saved } : {}),
  });

  const agentsMessage = (saved?: string): ServerMessage => ({
    type: 'agents',
    agents: core.agents.names().map((name) => {
      const { displayName, description, intro, effort, systemPrompt, models, tools, skills, canMessage, budgets } =
        core.agents.get(name);
      return {
        name,
        displayName,
        description,
        intro,
        ...(effort ? { effort } : {}),
        systemPrompt,
        models,
        tools,
        skills,
        canMessage,
        budgets,
        status: core.status.get(name),
        avatar: images.version(name, 'avatar'),
        portrait: images.version(name, 'portrait'),
        sprites: images.sprites(name)?.list() ?? {},
      };
    }),
    tools: core.tools.views(),
    defaultAgent: core.defaultAgentName(),
    saved,
  });

  /** The tool pool for the tools screen: definitions, presets and what agents cannot see. */
  const toolsMessage = (saved?: string): ServerMessage => ({
    type: 'tools',
    tools: core.tools.views(),
    presets: core.tools.presetViews(),
    custom: core.tools.customSpecs(),
    secretKeys: core.tools.secretKeys(),
    mcp: core.tools.mcp?.views() ?? [],
    saved,
  });

  const triggersMessage = (): ServerMessage => ({ type: 'triggers', triggers: core.triggers.list().map(toTriggerInfo) });

  /** Creates or replaces an agent file from the editor. Everything is validated before it is written. */
  const saveAgentView = (view: AgentView, renameFrom?: string) => {
    const name = String(view.name ?? '').trim().toLowerCase();
    const models: ModelChoice = {};
    for (const key of MODEL_KEYS) {
      const value = view.models?.[key]?.trim();
      if (value) models[key] = value;
    }
    checkModels(models);
    const tools = (view.tools ?? []).map(String);
    core.tools.select(tools); // unknown tools, or untrusted-content + shell together
    const skills = [...new Set((view.skills ?? []).map(String))];
    const hub = core.skills().map((skill) => skill.name);
    for (const skill of skills) {
      if (!hub.includes(skill)) throw new Error(`Skill "${skill}" does not exist.`);
    }
    const canMessage = (view.canMessage ?? []).map(String).filter((peer) => peer !== name);
    const known = core.agents.names();
    for (const peer of canMessage) {
      if (!known.includes(peer)) throw new Error(`Agent "${peer}" does not exist.`);
    }
    if (renameFrom !== name && known.includes(name)) throw new Error(`An agent named "${name}" already exists.`);
    if (core.wardrobe.has(name)) throw new Error(`"${name}" is already the id of an outfit; {{${name}}} cannot mean both.`);

    saveAgent(config.agentsDir, {
      name,
      displayName: String(view.displayName ?? '').trim(),
      description: String(view.description ?? '').trim(),
      intro: String(view.intro ?? '').trim(),
      ...((REASONING_EFFORTS as readonly string[]).includes(String(view.effort)) ? { effort: view.effort as ReasoningEffort } : {}),
      systemPrompt: String(view.systemPrompt ?? ''),
      models,
      tools,
      skills,
      canMessage,
      budgets: {
        maxRounds: Number(view.budgets?.maxRounds) || 12,
        maxTokens: Number(view.budgets?.maxTokens) || 200_000,
      },
    });
    if (renameFrom && renameFrom !== name && known.includes(renameFrom)) {
      // Peers that could message the old name keep that right under the new one.
      for (const other of known) {
        if (other === renameFrom) continue;
        const peer = core.agents.get(other);
        if (peer.canMessage.includes(renameFrom)) {
          saveAgent(config.agentsDir, {
            ...peer,
            canMessage: peer.canMessage.map((entry) => (entry === renameFrom ? name : entry)),
          });
        }
      }
      // The pictures live in the agent's folder, so they move before it is removed.
      images.rename(renameFrom, name);
      deleteAgent(config.agentsDir, renameFrom);
      // Chats, status and notes follow the agent to its new name.
      core.chats.renameAgent(renameFrom, name);
      core.profile.renameAgent(renameFrom, name);
      core.backgrounds.renameAgent(renameFrom, name);
      core.status.rename(renameFrom, name);
      core.memos.rename(renameFrom, name);
    }
    return name;
  };

  /** One node may only name agents, tools and workflows that exist (expressions are checked at run time). */
  const validateNode = (node: WorkflowNode, agent: string) => {
    const where = `node "${node.id}"`;
    const dynamic = (value: unknown) => typeof value === 'string' && value.includes('{{');
    if (node.type === 'agent' && !dynamic(node.config.agent) && !core.agents.names().includes(String(node.config.agent ?? ''))) {
      throw new Error(`${where}: agent "${String(node.config.agent ?? '')}" does not exist.`);
    }
    if ((node.type === 'chat' || node.type === 'approval') && node.config.agent && !dynamic(node.config.agent) && !core.agents.names().includes(String(node.config.agent))) {
      throw new Error(`${where}: agent "${String(node.config.agent)}" does not exist.`);
    }
    if (node.type === 'tool' && !dynamic(node.config.tool) && !core.tools.get(String(node.config.tool ?? ''))) {
      throw new Error(`${where}: unknown tool "${String(node.config.tool ?? '')}".`);
    }
    if ((node.type === 'workflow' || node.type === 'loop') && !dynamic(node.config.workflow) && !core.workflows.names(agent).includes(String(node.config.workflow ?? ''))) {
      throw new Error(`${where}: unknown workflow "${String(node.config.workflow ?? '')}".`);
    }
  };

  /** A workflow may only name agents, tools and a trigger type that exist. */
  const validateWorkflow = (view: WorkflowView) => {
    if (!core.agents.names().includes(view.agent)) throw new Error(`Agent "${view.agent}" does not exist.`);
    if (!core.triggerPool.get(view.trigger.pool)) throw new Error(`Unknown trigger "${view.trigger.pool}"; add it to the trigger pool first.`);
    if (view.errorWorkflow && view.errorWorkflow !== view.name && !core.workflows.names(view.agent).includes(view.errorWorkflow)) {
      throw new Error(`Error workflow "${view.errorWorkflow}" does not exist.`);
    }
    for (const node of view.nodes) validateNode(node, view.agent);
  };

  /** What the settings screen shows. Keys themselves are never sent back to a client. */
  const settingsView = (): SettingsView => {    const defaultAgent = core.defaultAgentName();
    const available = core.registry.available();
    const catalog = core.registry.catalogProviders();
    const inCatalog = new Set(catalog.map((provider) => provider.id));
    const stored = core.providers.list();
    // Connected providers, plus ones added in the app that lost their credential.
    const shown = new Set([
      ...available.map((provider) => provider.id),
      ...Object.keys(stored),
      ...Object.keys(appSettings.providers),
    ]);
    return {
      providers: [...shown].sort().map((id) => {
        const provider = core.registry.describe(id);
        const modelIds = stored[id]?.models ?? appSettings.providers[id]?.models ?? [];
        return {
          id,
          name: provider.name,
          baseURL: provider.api ?? null,
          connected: hasKey(id),
          custom: !inCatalog.has(id),
          models: available.find((entry) => entry.id === id)?.models.length ?? modelIds.length,
          modelIds,
        };
      }),
      catalog,
      models: available.flatMap((provider) =>
        provider.models
          .filter((model) => model.textOutput)
          .map((model) => ({
            ref: formatModelRef(model.ref),
            label: `${provider.name} · ${model.name}${model.imageInput ? ' [image]' : ''}${model.cost ? ` ($${model.cost.input}/$${model.cost.output})` : ''}`,
          })),
      ),
      defaults: effectiveDefaults(),
      presets: chatApi.presetViews(),
      agents: core.agents.names().length,
      allowedDirs: [...config.allowedDirs],
      google: { hasClient: core.google.hasClient, connected: core.google.isConfigured },
      microsoft: { hasClient: core.microsoft.hasClient, connected: core.microsoft.isConfigured },
      preferences: appSettings.preferences,
      spentTodayUsd: core.spentToday(),
      toolKeys: { serper: Boolean(process.env.SERPER_API_KEY), openweather: Boolean(process.env.OPENWEATHER_API_KEY) },
      ready: (() => {
        try {
          return defaultAgent !== null && usable(core.models.resolve('chat', core.agents.get(defaultAgent).models));
        } catch {
          return false; // e.g. the agent names a preset that no longer exists
        }
      })(),
    };
  };

  /**
   * opencode-style connect: resolve the provider (catalog entry or the user's own URL),
   * ask it for its models with the given key, and only then store the credential.
   */
  const connectProvider = async (request: ProviderConnect) => {
    const id = String(request.id ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
      throw new Error('Provider id: use lowercase letters, digits, "-", "_" or ".", e.g. "opencode" or "my-server".');
    }
    let known: ResolvedProvider | null = null;
    try {
      known = core.registry.describe(id);
    } catch {
      // a provider of the user's own
    }
    const baseURL = request.baseURL?.trim().replace(/\/+$/, '') || known?.api;
    if (!known && !baseURL) throw new Error(`"${id}" is not in the catalog: give its API base URL, e.g. https://example.com/v1`);
    if (baseURL && !/^https?:\/\//i.test(baseURL)) throw new Error('The base URL must start with http:// or https://');

    const npm = known?.npm ?? CUSTOM_PROVIDER_NPM;
    const apiKey = request.apiKey?.trim() || (known ? core.registry.credentialFor(id) : undefined);
    if (known && known.env.length > 0 && !apiKey) throw new Error(`${known.name} needs an API key.`);
    const manual = (request.models ?? []).map((model) => String(model).trim()).filter(Boolean);
    const discovered: DiscoveredModel[] =
      manual.length > 0 ? manual.map((model) => ({ id: model })) : await discoverModels({ npm, baseURL, apiKey });

    // Everything checked out: create the credential and remember the provider.
    if (request.apiKey?.trim()) core.auth.set(id, request.apiKey.trim());
    const previous = core.providers.get(id)?.def ?? appSettings.providers[id]?.def;
    core.providers.save(id, {
      def: {
        ...previous,
        name: request.name?.trim() || previous?.name || known?.name || id,
        ...(known && !previous?.npm ? {} : { npm }),
        ...(baseURL && baseURL !== core.registry.catalogProviders().find((entry) => entry.id === id)?.baseURL ? { api: baseURL } : {}),
        models: Object.fromEntries(
          discovered.map((model) => [
            model.id,
            {
              ...(model.name ? { name: model.name } : {}),
              ...(model.contextLimit ? { limit: { context: model.contextLimit } } : {}),
            },
          ]),
        ),
      },
      models: discovered.map((model) => model.id),
    });
    appSettings.removeProvider(id);
    core.registry.reset();
  };

  /** Edits a provider without touching its credential: display name, base URL, model list. */
  const updateProvider = (request: { id: string; name?: string; baseURL?: string; models?: string[] }) => {
    const id = String(request.id ?? '').trim().toLowerCase();
    const existing = core.providers.get(id);
    const legacy = appSettings.providers[id];
    if (!existing && !legacy) throw new Error(`No provider "${id}".`);
    const def: Record<string, unknown> = { ...(existing?.def ?? legacy?.def ?? {}) };
    if (request.name !== undefined && String(request.name).trim()) def.name = String(request.name).trim();
    if (request.baseURL !== undefined) {
      const base = String(request.baseURL).trim().replace(/\/+$/, '');
      if (base && !/^https?:\/\//i.test(base)) throw new Error('The base URL must start with http:// or https://');
      if (base) def.api = base;
      else delete def.api;
    }
    let models = existing?.models ?? legacy?.models ?? [];
    if (request.models) {
      models = [...new Set(request.models.map((model) => String(model).trim()).filter(Boolean))];
      // Keep the metadata of models that stay; drop the rest.
      const known = (def.models as Record<string, unknown> | undefined) ?? {};
      def.models = Object.fromEntries(models.filter((model) => known[model] !== undefined).map((model) => [model, known[model]]));
    }
    core.providers.save(id, { def, models } as Parameters<typeof core.providers.save>[1]);
    appSettings.removeProvider(id);
    core.registry.reset();
  };

  const removeProvider = (rawId: string) => {
    const id = String(rawId).trim().toLowerCase();
    core.auth.remove(id);
    core.providers.remove(id);
    appSettings.removeProvider(id);
    core.registry.reset();
  };

  const saveSettings = (change: SettingsChange) => {
    if (change.defaults) {
      checkModels(change.defaults);
      appSettings.setDefaults(change.defaults);
    }
    if (change.keys) {
      appSettings.setKeys(change.keys, process.env);
      core.registry.reset();
      core.google.reset();
      core.microsoft.reset();
    }
    if (change.allowedDirs) {
      const dirs = change.allowedDirs
        .map((dir) => String(dir).trim())
        .filter(Boolean)
        .map((dir) => path.resolve(config.rootDir, dir));
      for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
      appSettings.setAllowedDirs(dirs);
      // Same array the tools use, so the new list applies to the next tool call.
      config.allowedDirs.splice(0, config.allowedDirs.length, ...(dirs.length > 0 ? dirs : [path.join(config.rootDir, 'workspace')]));
    }
  };

  const memoryView = (): MemoryView[] =>
    core.memory.list().map(({ path: file, layer, description, content, updatedAt }) => ({
      path: file,
      layer,
      description,
      content,
      updatedAt,
    }));

  const forward = (event: AgentEvent) => {
    broadcast({ type: 'event', event });
    for (const decided of decisionsIn(event)) {
      broadcast({ type: 'permission-resolved', requestId: decided.requestId, decision: decided.decision });
    }
  };
  core.listeners.notification = (notification) => broadcast({ type: 'notification', notification });
  core.listeners.backgroundEvent = forward;

  // One turn at a time: turns from any client, in any chat, queue up in arrival order.
  let turns: Promise<void> = Promise.resolve();
  let queued = 0;
  let active: AbortController | null = null;
  let activeChat: number | null = null;

  const chatApi = createChatApi({
    core,
    config,
    appSettings,
    images,
    broadcast,
    modelRef,
    busy: () => queued > 0,
    resolved: (event) => {
      for (const decided of decisionsIn(event)) {
        broadcast({ type: 'permission-resolved', requestId: decided.requestId, decision: decided.decision });
      }
    },
    settingsChanged: () => broadcast({ type: 'settings', settings: settingsView(), saved: true }),
    agentsChanged: () => broadcast(agentsMessage()),
    enqueue: (chatId, job) => {
      queued++;
      turns = turns.then(async () => {
        active = new AbortController();
        activeChat = chatId;
        broadcast({ type: 'busy', chatId });
        try {
          await job(active.signal);
        } catch (error) {
          broadcast({ type: 'error', message: (error as Error).message, chatId });
        } finally {
          active = null;
          activeChat = null;
          queued--;
          broadcast({ type: 'busy', chatId: null });
        }
        reportJobs();
      });
    },
  });
  // Workflow messages and approval requests land in a chat outside a turn: clients reload it.
  core.listeners.chatChanged = (chatId) => {
    const [session] = core.chats.sessions(chatId, 1);
    if (session) broadcast({ type: 'chat-changed', chatId, sessionId: session.id });
    broadcast(chatApi.chatsMessage());
  };

  /** Memory writer and compaction report back once they are done; nobody waits for them. */
  const reportJobs = () => {
    void core.jobs.idle().then(() => {
      for (const notice of core.jobs.drainNotices()) {
        broadcast({ type: 'notification', notification: { kind: 'info', title: 'Mimi', body: notice } });
      }
    });
  };

  const runTurn = async (text: string, agentName: string) => {
    active = new AbortController();
    try {
      const agent = core.agents.get(agentName);
      broadcast({ type: 'user-message', text, agent: agent.name });
      for await (const event of core.runTurn({ agent, userText: text, signal: active.signal })) forward(event);
    } catch (error) {
      broadcast({ type: 'error', message: (error as Error).message });
    } finally {
      active = null;
      queued--;
    }
    reportJobs();
  };

  const handleClient = (socket: WebSocket, message: ClientMessage) => {
    const reply = (response: ServerMessage) => socket.send(JSON.stringify(response));
    if (chatApi.handle(message, reply)) return;
    switch (message.type) {
      case 'send': {
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        if (!text) return;
        const agentName = message.agent || core.defaultAgentName();
        if (!agentName) throw new Error('There is no agent yet. Create one on the Agent screen first.');
        queued++;
        turns = turns.then(() => runTurn(text, agentName));
        break;
      }
      case 'abort':
        active?.abort();
        break;
      case 'permission-response':
        broker.respond(message.requestId, message.allow === true);
        break;
      case 'history':
        reply({ type: 'history', messages: core.history(message.beforeId, Math.min(message.limit ?? 50, 200)) });
        break;
      case 'triggers-sync': {
        const triggers = core.triggers.list('active');
        core.triggers.markSynced(triggers.map((trigger) => trigger.id));
        reply({ type: 'triggers', triggers: triggers.map(toTriggerInfo) });
        break;
      }
      case 'trigger-create': {
        const agent = message.trigger.agent ? String(message.trigger.agent) : null;
        if (agent && !core.agents.names().includes(agent)) throw new Error(`Agent "${agent}" does not exist.`);
        if (message.trigger.kind !== 'reminder' && message.trigger.kind !== 'agent_task') {
          throw new Error('A trigger is either a reminder or an agent_task.');
        }
        core.triggers.create({
          kind: message.trigger.kind,
          title: String(message.trigger.title ?? ''),
          text: String(message.trigger.text ?? ''),
          agent,
          repeat: message.trigger.repeat,
          fireAt: message.trigger.fireAt || undefined,
          cron: message.trigger.cron || undefined,
          webhook: message.trigger.webhook === true,
        });
        broadcast(triggersMessage());
        break;
      }
      case 'trigger-update': {
        const agent = message.patch.agent ? String(message.patch.agent) : message.patch.agent === null ? null : undefined;
        if (typeof agent === 'string' && !core.agents.names().includes(agent)) throw new Error(`Agent "${agent}" does not exist.`);
        core.triggers.update(Number(message.id), {
          title: message.patch.title,
          text: message.patch.text,
          agent,
          repeat: message.patch.repeat,
          fireAt: message.patch.fireAt || undefined,
          cron: message.patch.cron || undefined,
        });
        broadcast(triggersMessage());
        break;
      }
      case 'trigger-delete':
        core.triggers.delete(Number(message.id));
        broadcast(triggersMessage());
        break;
      case 'trigger-run':
        void core.fire(Number(message.id)).then(
          () => broadcast(triggersMessage()),
          (error: Error) => reply({ type: 'error', message: error.message }),
        );
        break;
      case 'settings-get':
        reply({ type: 'settings', settings: settingsView() });
        break;
      case 'settings-save':
        saveSettings(message);
        reply({ type: 'settings', settings: settingsView(), saved: true });
        break;
      case 'provider-connect':
        connectProvider(message).then(
          () => broadcast({ type: 'settings', settings: settingsView(), saved: true }),
          (error: Error) => reply({ type: 'error', message: error.message }),
        );
        break;
      case 'provider-update':
        updateProvider(message);
        broadcast({ type: 'settings', settings: settingsView(), saved: true });
        break;
      case 'provider-remove':
        removeProvider(message.id);
        broadcast({ type: 'settings', settings: settingsView(), saved: true });
        break;
      case 'google-connect': {
        const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
        if (!clientId || !clientSecret) throw new Error('Save the Google OAuth client ID and secret first.');
        void startGoogleOAuth({ clientId, clientSecret, tokenFile: config.googleTokenPath }).then((flow) => {
          reply({ type: 'google-auth-url', url: flow.url });
          flow.done.then(
            () => {
              core.google.reset();
              broadcast({ type: 'settings', settings: settingsView(), saved: true });
            },
            (error: Error) => reply({ type: 'error', message: error.message }),
          );
        });
        break;
      }
      case 'microsoft-connect':
        void core.microsoft.startSignIn().then(
          (flow) => {
            reply({ type: 'microsoft-auth-url', url: flow.url });
            flow.done.then(
              () => broadcast({ type: 'settings', settings: settingsView(), saved: true }),
              (error: Error) => reply({ type: 'error', message: error.message }),
            );
          },
          (error: Error) => reply({ type: 'error', message: error.message }),
        );
        break;
      case 'agents-list':
        reply(agentsMessage());
        break;
      case 'tools-list':
        reply(toolsMessage());
        break;
      case 'tool-save': {
        const saved = core.tools.saveCustom(message.tool, message.renameFrom);
        broadcast(toolsMessage(saved.name));
        broadcast(agentsMessage());
        break;
      }
      case 'tool-delete': {
        const orphans = core.tools.deleteCustom(String(message.name));
        broadcast(toolsMessage());
        if (orphans.length > 0) {
          broadcast({ type: 'notification', notification: { kind: 'info', title: 'Mimi', body: `Removed presets: ${orphans.join(', ')}` } });
        }
        broadcast(agentsMessage());
        break;
      }
      case 'tool-preset-save': {
        // Secret settings go to the machine-local vault, never into the synced preset file.
        if (message.secrets) {
          const values: Record<string, string> = {};
          for (const [key, value] of Object.entries(message.secrets)) {
            values[presetSecretKey(message.preset.name, key)] = String(value);
          }
          core.secrets.save(values);
        }
        const saved = core.tools.savePreset(message.preset, message.renameFrom);
        broadcast(toolsMessage(saved.name));
        broadcast(agentsMessage());
        break;
      }
      case 'mcp-save': {
        const hub = core.tools.mcp;
        if (!hub) throw new Error('MCP is not available.');
        const saved = hub.save(message.server, message.renameFrom);
        broadcast(toolsMessage());
        // Reads the tool list right away so agents can pick them.
        if (saved.enabled) {
          void hub.refresh(saved.name).then(
            () => {
              broadcast(toolsMessage());
              broadcast(agentsMessage());
            },
            (error: Error) => reply({ type: 'error', message: error.message }),
          );
        } else broadcast(agentsMessage());
        break;
      }
      case 'mcp-refresh': {
        const hub = core.tools.mcp;
        if (!hub) throw new Error('MCP is not available.');
        void hub.refresh(String(message.name)).then(
          () => {
            broadcast(toolsMessage());
            broadcast(agentsMessage());
          },
          (error: Error) => reply({ type: 'error', message: error.message }),
        );
        break;
      }
      case 'mcp-delete': {
        core.tools.mcp?.remove(String(message.name));
        broadcast(toolsMessage());
        broadcast(agentsMessage());
        break;
      }
      case 'tool-preset-delete': {
        core.tools.deletePreset(String(message.name));
        broadcast(toolsMessage());
        broadcast(agentsMessage());
        break;
      }
      case 'secrets-list':
        reply({ type: 'secrets', names: core.secrets.names() });
        break;
      case 'secrets-save':
        core.secrets.save(message.values);
        broadcast({ type: 'secrets', names: core.secrets.names() });
        break;
      case 'workflows-list':
        reply({ type: 'workflows', workflows: core.workflows.list(message.agent), pool: core.triggerPool.list(), nodeTypes: NODE_TYPES });
        break;
      case 'workflow-save': {
        validateWorkflow(message.workflow);
        const saved = core.workflows.save(message.workflow, message.renameFrom);
        if (message.renameFrom && message.renameFrom !== saved.name) {
          core.clearWorkflowSchedule(`${saved.agent}/${message.renameFrom}`);
        }
        core.syncWorkflowSchedule(saved);
        broadcast({
          type: 'workflows',
          workflows: core.workflows.list(),
          pool: core.triggerPool.list(),
          nodeTypes: NODE_TYPES,
          saved: `${saved.agent}/${saved.name}`,
        });
        broadcast(triggersMessage());
        break;
      }
      case 'workflow-delete': {
        const id = `${message.agent}/${message.name}`;
        core.workflows.delete(String(message.agent), String(message.name));
        core.clearWorkflowSchedule(id);
        core.workflowRuns.forget(id);
        core.parkedRuns.forget(id);
        broadcast({ type: 'workflows', workflows: core.workflows.list(), pool: core.triggerPool.list(), nodeTypes: NODE_TYPES });
        broadcast(triggersMessage());
        break;
      }
      case 'workflow-run':
        void core
          .runWorkflow(String(message.agent), String(message.name), message.input as Record<string, JsonValue> | undefined, { pins: message.pins === true })
          .then(
            (result) => {
              reply({ type: 'workflow-result', result });
              const id = `${message.agent}/${message.name}`;
              broadcast({ type: 'workflow-runs', workflow: id, runs: core.workflowRuns.list(id) });
            },
            (error: Error) => reply({ type: 'error', message: error.message }),
          );
        break;
      case 'workflow-run-from':
        void core.runWorkflowFrom(String(message.agent), String(message.name), String(message.nodeId), Number(message.runId)).then(
          (result) => {
            reply({ type: 'workflow-result', result });
            const id = `${message.agent}/${message.name}`;
            broadcast({ type: 'workflow-runs', workflow: id, runs: core.workflowRuns.list(id) });
          },
          (error: Error) => reply({ type: 'error', message: error.message }),
        );
        break;
      case 'workflow-expr-preview': {
        const json = message.json && typeof message.json === 'object' ? message.json : {};
        try {
          const value = resolveString(String(message.text ?? '').slice(0, 5000), contextFor({ json }, 0, [{ json }], {
            $vars: message.vars ?? {},
            $node: message.nodes ?? {},
            $execution: { id: 'preview', mode: 'manual' },
            $trigger: { json, items: [json] },
          }));
          const text = typeof value === 'string' ? value : JSON.stringify(value);
          reply({ type: 'workflow-expr-preview', reqId: Number(message.reqId), ok: true, value: (text ?? '').slice(0, 500) });
        } catch (error) {
          reply({ type: 'workflow-expr-preview', reqId: Number(message.reqId), ok: false, error: (error as Error).message.slice(0, 300) });
        }
        break;
      }
      case 'workflow-import-n8n': {
        const agent = String(message.agent);
        if (!core.agents.names().includes(agent)) throw new Error(`Agent "${agent}" does not exist.`);
        let raw: unknown;
        try {
          raw = JSON.parse(String(message.json ?? ''));
        } catch {
          throw new Error('The file is not valid JSON.');
        }
        const { workflows, report } = importN8n(raw, {
          agent,
          existingNames: core.workflows.names(agent),
          hasTool: (name) => Boolean(core.tools.get(name)),
        });
        const errors: string[] = [];
        if (message.save) {
          for (const workflow of workflows) {
            try {
              validateWorkflow(workflow);
              core.syncWorkflowSchedule(core.workflows.save(workflow));
            } catch (error) {
              errors.push(`${workflow.name}: ${(error as Error).message}`);
            }
          }
          broadcast({ type: 'workflows', workflows: core.workflows.list(), pool: core.triggerPool.list(), nodeTypes: NODE_TYPES });
        }
        reply({ type: 'workflow-import', agent, saved: Boolean(message.save), workflows, report, errors });
        break;
      }
      case 'preferences-save': {
        const input = message.preferences ?? {};
        const time = (value: unknown) => (typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value) ? value : undefined);
        const budget = Number(input.dailyBudgetUsd);
        const kinds = Array.isArray(input.pushKinds) ? input.pushKinds.filter((kind) => ['reminder', 'task-result', 'approval', 'info'].includes(kind)) : undefined;
        appSettings.setPreferences({
          ...(Number.isFinite(budget) && budget > 0 ? { dailyBudgetUsd: Math.round(budget * 100) / 100 } : {}),
          ...(time(input.quietFrom) && time(input.quietTo) ? { quietFrom: time(input.quietFrom), quietTo: time(input.quietTo) } : {}),
          ...(kinds ? { pushKinds: kinds } : {}),
          urgentApprovals: input.urgentApprovals !== false,
        });
        broadcast({ type: 'settings', settings: settingsView(), saved: true });
        break;
      }
      case 'backups-list':
        reply({ type: 'backups', backups: listBackups(config.backupsDir), dir: config.backupsDir });
        break;
      case 'backup-create':
        void createBackup({ userDir: config.userDir, db: core.db, outDir: config.backupsDir, includeSecrets: message.includeSecrets !== false }).then(
          (made) => reply({ type: 'backups', backups: listBackups(config.backupsDir), dir: config.backupsDir, created: made.name }),
          (error: Error) => reply({ type: 'error', message: `Backup failed: ${error.message}` }),
        );
        break;
      case 'notifications-list':
        reply({ type: 'notifications', ...core.notifications.list() });
        break;
      case 'notifications-read':
        core.notifications.markRead(Array.isArray(message.ids) ? message.ids.map(Number) : undefined);
        broadcast({ type: 'notifications', ...core.notifications.list() });
        break;
      case 'push-key':
        reply({ type: 'push-key', publicKey: core.notifications.publicKey() });
        break;
      case 'push-subscribe':
        core.notifications.subscribe(
          { endpoint: String(message.subscription?.endpoint ?? ''), p256dh: String(message.subscription?.keys?.p256dh ?? ''), auth: String(message.subscription?.keys?.auth ?? '') },
          String(message.label ?? ''),
        );
        broadcast({ type: 'push-devices', devices: core.notifications.devices() });
        break;
      case 'push-unsubscribe':
        core.notifications.unsubscribe(String(message.endpoint));
        broadcast({ type: 'push-devices', devices: core.notifications.devices() });
        break;
      case 'push-devices':
        reply({ type: 'push-devices', devices: core.notifications.devices() });
        break;
      case 'push-test':
        void core.notifications
          .push({ id: 0, kind: 'reminder', title: 'ทดสอบแจ้งเตือน', body: 'ถ้าเห็นข้อความนี้ แปลว่าแจ้งเตือนเข้าเครื่องได้แล้ว ✓' })
          .then((tested) => reply({ type: 'push-devices', devices: core.notifications.devices(), tested }));
        break;
      case 'profile-get':
        reply({ type: 'profile', profile: core.profile.get() });
        break;
      case 'profile-save':
        broadcast({ type: 'profile', profile: core.profile.save(message.profile, core.agents.names()), saved: true });
        break;
      case 'gallery-list': {
        const agent = String(message.agent);
        if (!core.agents.names().includes(agent)) throw new Error(`No agent "${agent}".`);
        const query = String(message.query ?? '');
        const offset = Math.max(0, Number(message.offset) || 0);
        const { total, items } = core.gallery.list(agent, { query, offset, limit: Number(message.limit) || 60 });
        reply({ type: 'gallery', agent, query, offset, total, items });
        break;
      }
      case 'gallery-update':
        core.gallery.update(String(message.agent), String(message.id), { title: message.title, tags: message.tags, description: message.description });
        broadcast({ type: 'gallery-changed', agent: String(message.agent) });
        break;
      case 'gallery-delete':
        core.gallery.remove(String(message.agent), String(message.id));
        // A picture that is on show goes with it.
        if (core.status.get(String(message.agent)).situation === String(message.id)) core.status.set(String(message.agent), 'situation', '');
        broadcast({ type: 'gallery-changed', agent: String(message.agent) });
        break;
      case 'backgrounds-list':
        reply(backgroundsMessage());
        break;
      case 'background-save': {
        const background = message.background;
        const from = message.renameFrom ? String(message.renameFrom) : '';
        if (from && from !== background.id) core.backgrounds.rename(from, String(background.id));
        const saved = core.backgrounds.save(background);
        broadcast(backgroundsMessage(saved.id));
        break;
      }
      case 'background-delete':
        core.backgrounds.remove(String(message.id));
        broadcast(backgroundsMessage());
        break;
      case 'background-select':
        core.backgrounds.select(message.agent === undefined ? undefined : String(message.agent), String(message.choice ?? ''));
        broadcast(backgroundsMessage());
        break;
      case 'wardrobe-list':
        reply({ type: 'wardrobe', outfits: core.wardrobe.list() });
        break;
      case 'wardrobe-save': {
        const outfit = message.outfit;
        const from = message.renameFrom ? String(message.renameFrom) : '';
        if (from && from !== outfit.id) core.wardrobe.rename(from, String(outfit.id));
        const saved = core.wardrobe.save(outfit);
        broadcast({ type: 'wardrobe', outfits: core.wardrobe.list(), saved: saved.id });
        break;
      }
      case 'wardrobe-delete':
        core.wardrobe.remove(String(message.id));
        broadcast({ type: 'wardrobe', outfits: core.wardrobe.list() });
        break;
      case 'knowledge-list':
        reply({ type: 'knowledge', collections: core.knowledge.collections() });
        break;
      case 'knowledge-save': {
        const saved = core.knowledge.saveCollection(message.collection);
        broadcast({ type: 'knowledge', collections: core.knowledge.collections(), saved: saved.name });
        break;
      }
      case 'knowledge-delete':
        core.knowledge.deleteCollection(String(message.name));
        broadcast({ type: 'knowledge', collections: core.knowledge.collections() });
        break;
      case 'knowledge-documents':
        reply({ type: 'knowledge-documents', collection: String(message.collection), documents: core.knowledge.documents(String(message.collection)) });
        break;
      case 'knowledge-add': {
        const collection = String(message.collection);
        void core
          .addKnowledge(collection, {
            title: typeof message.title === 'string' ? message.title : undefined,
            text: typeof message.text === 'string' ? message.text : undefined,
            path: typeof message.path === 'string' ? message.path : undefined,
            url: typeof message.url === 'string' ? message.url : undefined,
            attachmentId: typeof message.attachmentId === 'string' ? message.attachmentId : undefined,
          })
          .then(
            (result) => {
              reply({ type: 'knowledge-added', collection, documentId: result.document.id, chunks: result.document.chunks, ...(result.warning ? { warning: result.warning } : {}) });
              reply({ type: 'knowledge-documents', collection, documents: core.knowledge.documents(collection) });
              broadcast({ type: 'knowledge', collections: core.knowledge.collections() });
            },
            (error: Error) => reply({ type: 'error', message: error.message }),
          );
        break;
      }
      case 'knowledge-remove-document': {
        const collection = String(message.collection);
        core.knowledge.deleteDocument(Number(message.id));
        reply({ type: 'knowledge-documents', collection, documents: core.knowledge.documents(collection) });
        broadcast({ type: 'knowledge', collections: core.knowledge.collections() });
        break;
      }
      case 'knowledge-search': {
        const query = String(message.query ?? '');
        void core.knowledge.search(query, { collection: message.collection || undefined, limit: 8 }).then(
          (hits) => reply({ type: 'knowledge-results', query, hits }),
          (error: Error) => reply({ type: 'error', message: error.message }),
        );
        break;
      }
      case 'knowledge-embed': {
        const collection = String(message.collection);
        void core.knowledge.embedMissing(collection).then(
          (count) => {
            reply({ type: 'knowledge-embedded', collection, count });
            broadcast({ type: 'knowledge', collections: core.knowledge.collections() });
          },
          (error: Error) => reply({ type: 'error', message: `Embedding failed: ${error.message}` }),
        );
        break;
      }
      case 'approval-decide':
        if (!core.approvals.decide(Number(message.id), message.approved === true, typeof message.note === 'string' ? message.note : undefined)) {
          throw new Error('This request is no longer waiting (answered, timed out, or the app restarted).');
        }
        break;
      case 'workflow-runs': {
        const id = `${message.agent}/${message.name}`;
        reply({ type: 'workflow-runs', workflow: id, runs: core.workflowRuns.list(id) });
        break;
      }
      case 'workflow-run-get': {
        const run = core.workflowRuns.get(Number(message.id));
        if (!run) throw new Error(`No stored run #${String(message.id)}.`);
        reply({ type: 'workflow-run-record', run });
        break;
      }
      case 'workflow-test-node': {
        if (!core.agents.names().includes(message.workflow.agent)) {
          throw new Error(`Agent "${message.workflow.agent}" does not exist.`);
        }
        validateNode(message.node, message.workflow.agent);
        void core.testWorkflowNode(message.workflow, message.node, message.input ?? []).then(
          (result) => reply({ type: 'workflow-node-result', result }),
          (error: Error) => reply({ type: 'error', message: error.message }),
        );
        break;
      }
      case 'trigger-pool-save': {
        core.triggerPool.save(message.entry);
        broadcast({ type: 'workflows', workflows: core.workflows.list(), pool: core.triggerPool.list(), nodeTypes: NODE_TYPES, saved: message.entry.name });
        break;
      }
      case 'trigger-pool-delete': {
        core.triggerPool.remove(String(message.name));
        broadcast({ type: 'workflows', workflows: core.workflows.list(), pool: core.triggerPool.list(), nodeTypes: NODE_TYPES });
        break;
      }
      case 'agent-save': {
        const saved = saveAgentView(message.agent, message.renameFrom);
        broadcast(agentsMessage(saved));
        broadcast({ type: 'settings', settings: settingsView() });
        break;
      }
      case 'agent-delete':
        if (deleteAgent(config.agentsDir, String(message.name))) {
          const gone = String(message.name);
          core.chats.forgetAgent(gone);
          core.status.forget(gone);
          core.memos.forget(gone);
          core.profile.forgetAgent(gone);
          core.backgrounds.forgetAgent(gone);
          images.forget(gone);
          // An agent's workflows go with it, and so do their schedules.
          for (const name of core.workflows.forgetAgent(gone)) {
            core.clearWorkflowSchedule(`${gone}/${name}`);
            core.workflowRuns.forget(`${gone}/${name}`);
            core.parkedRuns.forget(`${gone}/${name}`);
          }
          broadcast(chatApi.chatsMessage());
        }
        broadcast(agentsMessage());
        broadcast({ type: 'settings', settings: settingsView() });
        break;
      case 'memory-list':
        reply({ type: 'memory', entries: memoryView() });
        break;
      case 'memory-save':
        core.memory.write({ path: message.path, description: message.description, content: message.content });
        reply({ type: 'memory', entries: memoryView() });
        break;
      case 'memory-delete':
        core.memory.delete(String(message.path));
        reply({ type: 'memory', entries: memoryView() });
        break;
      default:
        reply({ type: 'error', message: 'Unknown message type' });
    }
  };

  // Wrong tokens from one address are counted; too many and it is refused for a while.
  const limiter = new AuthLimiter();
  const addressOf = (request: http.IncomingMessage) => request.socket.remoteAddress ?? 'unknown';
  const httpApi = {
    attachments: core.attachments,
    images,
    wardrobe: core.wardrobe,
    backgrounds: core.backgrounds,
    gallery: core.gallery,
    galleryChanged: (agent: string) => broadcast({ type: 'gallery-changed', agent }),
    backgroundsChanged: () => broadcast(backgroundsMessage()),
    wardrobeChanged: () => broadcast({ type: 'wardrobe', outfits: core.wardrobe.list() }),
    authorized: (request: http.IncomingMessage) => {
      const address = addressOf(request);
      if (limiter.blocked(address)) return false;
      const ok = sameToken(/^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1], config.token);
      if (ok) limiter.succeed(address);
      else limiter.fail(address);
      return ok;
    },
    agentExists: (name: string) => core.agents.names().includes(name),
    imagesChanged: () => broadcast(agentsMessage()),
    backupsDir: config.backupsDir,
    webhook: async (key: string, payload: string, secret?: string): Promise<WebhookReply | null> => {
      const trigger = core.triggers.byWebhookKey(key);
      if (trigger && trigger.status === 'active') {
        const result = await core.fire(trigger.id, payload.slice(0, 8000));
        broadcast(triggersMessage());
        return { status: 200, body: { ok: true, result: result.slice(0, 500) } };
      }
      const workflow = core.workflows.byWebhookKey(key);
      if (!workflow || !workflow.enabled) return null;
      if (core.triggerPool.get(workflow.trigger.pool)?.kind !== 'webhook') return null;
      // An optional shared secret on top of the unguessable URL.
      const expected = String(workflow.trigger.config.secret ?? '').trim();
      if (expected && !sameToken(secret, expected)) return { status: 401, body: { ok: false, error: 'wrong or missing x-mimi-secret' } };
      let body: JsonValue = payload.slice(0, 8000) as JsonValue;
      try {
        body = JSON.parse(payload) as JsonValue;
      } catch {
        // not JSON: the text becomes { value }
      }
      const result = await core.runWorkflow(workflow.agent, workflow.name, body);
      if (result.response) {
        return { status: result.response.status ?? 200, headers: result.response.headers, body: result.response.body };
      }
      return { status: 200, body: { ok: true, result: result.result.slice(0, 500) } };
    },
  };
  // One automatic backup a day (the newest 7 are kept), checked at start and hourly.
  const autoBackup = async () => {
    const newest = listBackups(config.backupsDir).find((backup) => backup.name.includes('-auto'));
    if (newest && Date.now() - Date.parse(newest.createdAt) < 23 * 3600_000) return;
    try {
      const made = await createBackup({ userDir: config.userDir, db: core.db, outDir: config.backupsDir, includeSecrets: true });
      const auto = made.name.replace('.tar.gz', '-auto.tar.gz');
      fs.renameSync(path.join(config.backupsDir, made.name), path.join(config.backupsDir, auto));
      const autos = listBackups(config.backupsDir).filter((backup) => backup.name.includes('-auto'));
      for (const old of autos.slice(7)) fs.rmSync(path.join(config.backupsDir, old.name), { force: true });
    } catch (error) {
      console.error(`automatic backup failed: ${(error as Error).message}`);
    }
  };
  const backupTimer = setInterval(() => void autoBackup(), 3600_000);
  backupTimer.unref();
  const firstBackup = setTimeout(() => void autoBackup(), 60_000);
  firstBackup.unref();
  let appIcon: Buffer | undefined;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const page = WEB_FILES[url.pathname];
    if (request.method === 'GET' && page) {
      response.writeHead(200, { 'content-type': page[1], 'cache-control': 'no-store' });
      response.end(fs.readFileSync(path.join(WEB_DIR, page[0])));
    } else if (await handleHttpApi(httpApi, request, response)) {
      // answered by the file API
    } else if (request.method === 'GET' && url.pathname === '/icon.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
      response.end(appIcon ??= renderIconPng());
    } else if (request.method === 'GET' && url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, pcOnline: pc.online, clients: clients.size }));
    } else {
      response.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 4 * 1024 * 1024,
    // Browsers send an Origin header and allow cross-site WebSocket connections, so only
    // pages served by this server may connect. Non-browser clients send no Origin.
    verifyClient: ({ origin, req }: { origin?: string; req: http.IncomingMessage }) => {
      if (!origin) return true;
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    },
  });

  const alive = new WeakSet<WebSocket>();
  wss.on('connection', (socket, request) => {
    const address = addressOf(request);
    let role: 'client' | 'pc' | null = null;
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    const helloTimer = setTimeout(() => socket.close(4001, 'hello timeout'), HELLO_TIMEOUT_MS);

    socket.on('message', (data) => {
      const message = parse(data);
      if (!message) return;

      if (role === null) {
        if (limiter.blocked(address)) {
          socket.close(4029, 'too many wrong tokens; try again later');
          return;
        }
        if (message.type !== 'hello' || !sameToken(message.token, config.token)) {
          limiter.fail(address);
          socket.close(4003, 'invalid token');
          return;
        }
        limiter.succeed(address);
        clearTimeout(helloTimer);
        if (message.role === 'pc') {
          role = 'pc';
          const hello = message as Extract<PcMessage, { type: 'hello' }>;
          pc.attach(socket, {
            ...hello,
            allowedDirs: Array.isArray(hello.allowedDirs) ? hello.allowedDirs.map(String) : [],
            tools: Array.isArray(hello.tools) ? hello.tools.map(String) : [],
          });
        } else {
          role = 'client';
          clients.add(socket);
          const welcome: ServerMessage = {
            type: 'welcome',
            agents: core.agents.list(),
            defaultAgent: core.defaultAgentName() ?? '',
            pcOnline: pc.online,
            busy: queued > 0,
            busyChat: activeChat,
            pendingPermissions: broker.pending(),
          };
          socket.send(JSON.stringify(welcome));
        }
        return;
      }

      if (role === 'pc') {
        if (message.type === 'tool-result') pc.handleResult(message as Extract<PcMessage, { type: 'tool-result' }>);
        return;
      }
      try {
        handleClient(socket, message as ClientMessage);
      } catch (error) {
        // A rejected setting or memory write is the client's to show, not a reason to drop it.
        socket.send(JSON.stringify({ type: 'error', message: (error as Error).message } satisfies ServerMessage));
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      clients.delete(socket);
      if (role === 'pc') pc.detach(socket);
    });
    socket.on('error', () => socket.terminate());
  });

  // Drop connections that stopped answering pings, so "PC offline" is noticed quickly.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, HEARTBEAT_MS);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  core.scheduler.start();

  return {
    core,
    pc,
    port: (server.address() as AddressInfo).port,
    async close() {
      clearInterval(heartbeat);
      clearInterval(backupTimer);
      clearTimeout(firstBackup);
      active?.abort();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await turns.catch(() => {});
      await core.close();
    },
  };
}
