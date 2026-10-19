import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { embedMany, generateText } from 'ai';
import type { AgentEvent, HistoryMessage, Notification, WorkflowRunResult } from '@mimi/shared';
import { AgentCatalog } from './agents/loader.ts';
import type { AppSettings } from './app/app-settings.ts';
import { SecretStore } from './app/secrets.ts';
import { type AttachmentKind, AttachmentStore, ingestAttachments, MAX_ATTACHMENT_BYTES, PROMPTS } from './chat/attachments.ts';
import { ChatStore } from './chat/chat-store.ts';
import { ChatEngine } from './chat/engine.ts';
import { FileSnapshots, SnapshotExecutor } from './chat/file-snapshots.ts';
import { HistoryFiles } from './chat/history-files.ts';
import { SessionFiles } from './chat/session-files.ts';
import { MemoStore, StatusStore } from './chat/state-store.ts';
import type { CoreConfig } from './config.ts';
import { type Db, openDb } from './db/db.ts';
import { MessagesRepo } from './db/messages-repo.ts';
import { ThreadRepo } from './db/thread-repo.ts';
import { GoogleAuth } from './google/auth.ts';
import { gmailListUnread, gmailMarkRead } from './google/tools.ts';
import { type AgentLoopDeps, runAgent, type RunInput } from './loop/agent-loop.ts';
import { buildPromptVars } from './loop/prompt-vars.ts';
import { WardrobeStore } from './wardrobe/wardrobe-store.ts';
import { GalleryStore } from './gallery/gallery-store.ts';
import { BackgroundStore } from './backgrounds/background-store.ts';
import { Compactor } from './memory/compactor.ts';
import { MemoryFiles } from './memory/files.ts';
import { describeCompaction, PostTurnJobs } from './memory/post-turn.ts';
import { MemoryStore } from './memory/store.ts';
import { MemoryWriter } from './memory/writer.ts';
import { MeshRouter } from './mesh/router.ts';
import { MicrosoftAuth } from './microsoft/auth.ts';
import { outlookListUnread, outlookMarkRead } from './microsoft/tools.ts';
import { type PermissionBroker, PermissionGate } from './permissions/gate.ts';
import { AuthStore } from './providers/auth-store.ts';
import { loadCatalog, type ModelCatalog } from './providers/catalog.ts';
import { ProviderStore } from './providers/provider-store.ts';
import { type ModelInfo, parseModelRef, ProviderRegistry, providerOptionsFor } from './providers/registry.ts';
import { ModelRouter, type ModelService } from './providers/routing.ts';
import { loadSettings, type Settings } from './providers/settings.ts';
import { Scheduler } from './scheduler/scheduler.ts';
import { TriggerFiles } from './scheduler/trigger-files.ts';
import { type Trigger, TriggerStore } from './scheduler/triggers.ts';
import {
  createUseSkillTool,
  loadPersona,
  loadSkills,
  readSkillBody,
  renderSkillIndex,
  type Skill,
  type SkillRunner,
} from './skills/skills.ts';
import { makePcRunner, type PcLink, RoutingExecutor } from './tools/executor.ts';
import { createToolRegistry } from './tools/index.ts';
import { ToolPool } from './tools/pool.ts';
import { McpHub } from './mcp/hub.ts';
import { ToolStore } from './tools/tool-store.ts';
import { UsageLogger } from './usage/logger.ts';
import { resumeWorkflow, type ResumeOutcome, type RunOptions, runWorkflow as runWorkflowNodes, runWorkflowNode, triggerItems, WorkflowState, type WorkflowRunnerDeps } from './workflows/runner.ts';
import { KnowledgeStore } from './knowledge/store.ts';
import { UserProfileStore } from './profile/user-profile.ts';
import { NotificationCenter } from './notify/notifications.ts';
import { loadOrCreateVapid, type VapidKeys } from './notify/web-push.ts';
import { Approvals } from './workflows/approvals.ts';
import { ParkedRuns } from './workflows/parked-runs.ts';
import { allowedPath, documentText, htmlToText, kindOfFile } from './workflows/file-nodes.ts';
import { createWorkflowTool, workflowToolCallers } from './workflows/workflow-tools.ts';
import { WorkflowRunStore } from './workflows/run-history.ts';
import { DEFAULT_TOKEN_SECRET, TelegramHub, type TelegramListener } from './workflows/telegram.ts';
import { matchText } from './workflows/text-match.ts';
import { TriggerPool } from './workflows/trigger-pool.ts';
import { type StoredWorkflow, WorkflowStore } from './workflows/workflow-store.ts';
import type { FlowItem, JsonValue, WorkflowNode, WorkflowNodeTestResult, WorkflowView } from '@mimi/shared';

type RunFinish = Extract<AgentEvent, { type: 'run-finish' }>;

export interface CoreListeners {
  /** Reminders and results of unattended work, for whoever can show them to the user. */
  notification?: (notification: Notification) => void;
  /** Events of runs nobody started interactively (scheduled agent tasks). */
  backgroundEvent?: (event: AgentEvent) => void;
  /** Something was posted into a chat outside a turn (workflow message, approval request). */
  chatChanged?: (chatId: number) => void;
  /** An agent message landed in a chat outside a turn and nobody notified the user about it yet. */
  agentPosted?: (chatId: number, agent: string, text: string) => void;
}

export interface CoreOptions {
  /** Connection to the PC agent; without one, `pc` tools run locally or fail as "PC offline". */
  pc?: PcLink;
  /** What the user set inside the app: connected providers, default models. */
  app?: AppSettings;
  /** Test seams. */
  settings?: Settings;
  catalog?: ModelCatalog;
  models?: ModelService;
}

export interface Core {
  db: Db;
  settings: Settings;
  registry: ProviderRegistry;
  auth: AuthStore;
  /** Connected providers as syncable files under `providers/`. */
  providers: ProviderStore;
  agents: AgentCatalog;
  /** Name of the agent used when none is given; null while no agent exists. */
  defaultAgentName(): string | null;
  models: ModelService;
  memory: MemoryStore;
  chats: ChatStore;
  /** Runs a message sent to a chat: session, attachments, who answers whom. */
  engine: ChatEngine;
  status: StatusStore;
  memos: MemoStore;
  /** The outfit pool; `{{id}}` in a prompt expands to the outfit. */
  wardrobe: WardrobeStore;
  /** Backdrops for the chat stage and which one each agent uses. */
  backgrounds: BackgroundStore;
  /** The situation gallery of each agent. */
  gallery: GalleryStore;
  attachments: AttachmentStore;
  /** The skill hub as it is on disk right now. */
  skills(): Skill[];
  /** The tool pool: built-in tools, custom tools and their presets. */
  tools: ToolPool;
  /** API keys entered in the app; machine-local. */
  secrets: SecretStore;
  /** Workflows and their schedules. */
  workflows: WorkflowStore;
  /** Trigger types a workflow can pick from; user-defined ones live under triggers/pool. */
  triggerPool: TriggerPool;
  /** Past runs of every workflow, with node input/output. */
  workflowRuns: WorkflowRunStore;
  /** Workflow runs paused at an approval or a long wait. */
  parkedRuns: ParkedRuns;
  /** Finishes a paused run now (tests; normally the answer or the timer does it). */
  resumeParked(runId: number, outcome: ResumeOutcome): Promise<WorkflowRunResult | undefined>;
  /** Files as they were before agents wrote them (restored on rewind). */
  fileSnapshots: FileSnapshots;
  /** Estimated model spending since midnight (configured zone). */
  spentToday(): number;
  /** Stored notifications and the browsers they are pushed to. */
  notifications: NotificationCenter;
  /** Stores a notification in the inbox, pushes it and hands it to the live clients. */
  notify(notification: Notification): void;
  /** The user's profile fields; each agent sees the ones shared with it. */
  profile: UserProfileStore;
  /** Knowledge bases searched by agents (knowledge_search) and workflows. */
  knowledge: KnowledgeStore;
  /** Adds a document to a knowledge base from typed text, a file in the allowed folders, a URL or an uploaded attachment. */
  addKnowledge(
    collection: string,
    input: { title?: string; text?: string; path?: string; url?: string; attachmentId?: string },
  ): Promise<import('@mimi/shared').KnowledgeAddResult>;
  /** Approval requests workflows are waiting on. */
  approvals: Approvals;
  /** Bots polled for Telegram-triggered workflows. */
  telegram: TelegramHub;
  /**
   * Workflows whose chat trigger matches a message the user sent in a direct chat.
   * `consumed` means the agent should not answer it; `run` starts the workflows.
   */
  /** Workflows a chat message (and its files) starts; `consumed` = the agent stays quiet. */
  chatTriggers(chatId: number, text: string, attachmentIds?: string[]): { consumed: boolean; run(): void };
  /** Stores a user message in a chat without an agent turn (a chat trigger took it). */
  postUserMessage(chatId: number, text: string, attachmentIds?: string[]): { sessionId: number; id: number; createdAt: string };
  /** Runs a workflow by hand with optional input; returns every node's input and output. */
  runWorkflow(agent: string, name: string, input?: JsonValue, options?: { pins?: boolean }): Promise<WorkflowRunResult>;
  /** Runs again from one node with the input it got in a stored run; earlier nodes keep that run's outputs. */
  runWorkflowFrom(agent: string, name: string, nodeId: string, runId: number): Promise<WorkflowRunResult>;
  /** Runs one node alone with sample items (the editor's per-node test). */
  testWorkflowNode(workflow: WorkflowView, node: WorkflowNode, input: FlowItem[]): Promise<WorkflowNodeTestResult>;
  /** Keeps the workflow's schedule in step with its trigger settings. */
  syncWorkflowSchedule(workflow: StoredWorkflow): void;
  clearWorkflowSchedule(id: string): void;
  google: GoogleAuth;
  microsoft: MicrosoftAuth;
  compactor: Compactor;
  jobs: PostTurnJobs;
  mesh: MeshRouter;
  triggers: TriggerStore;
  scheduler: Scheduler;
  deps: AgentLoopDeps;
  listeners: CoreListeners;
  /** One user turn: compaction check, the agent run (and any handoffs), then the background jobs. */
  runTurn(input: RunInput): AsyncGenerator<AgentEvent>;
  /** Fires a trigger now (the "run" button, or a webhook call). */
  fire(id: number, payload?: string): Promise<string>;
  /** The spoken messages of the user's thread, for chat clients. */
  history(beforeId?: number, limit?: number): HistoryMessage[];
  /** Waits for background jobs, stops the scheduler and closes the database. */
  close(): Promise<void>;
}

const USER_THREAD = 'main';

/** Wires the core services together. Each front end (CLI, WebSocket server) brings its own broker. */
/**
 * Whether a message's files suit a chat trigger: `any`, `none` (text only), `some`
 * (at least one file) or one kind (at least one image / audio / video / other file).
 */
export function filesMatch(rule: string, kinds: AttachmentKind[]): boolean {
  switch (rule) {
    case 'none':
      return kinds.length === 0;
    case 'some':
      return kinds.length > 0;
    case 'image':
    case 'audio':
    case 'video':
    case 'file':
      return kinds.includes(rule);
    default:
      return true;
  }
}

export async function createCore(
  config: CoreConfig,
  broker: PermissionBroker,
  options: CoreOptions = {},
): Promise<Core> {
  const settings = options.settings ?? loadSettings(config.settingsPath);
  const catalog =
    options.catalog ??
    (await loadCatalog({
      cachePath: config.catalogCachePath,
      offline: config.catalogOffline,
      url: config.catalogUrl,
    }));
  const auth = new AuthStore(config.authPath);
  const providerStore = new ProviderStore(config.providersDir);
  const registry = new ProviderRegistry(catalog, settings.provider, process.env, {
    auth,
    // Provider files win over the legacy app-settings store.
    extra: () => ({ ...(options.app?.providerDefs() ?? {}), ...providerStore.defs() }),
    listed: () => ({ ...(options.app?.listedModels() ?? {}), ...providerStore.listed() }),
  });
  // Defaults chosen in the app sit on top of the settings file.
  const models =
    options.models ??
    new ModelRouter(
      () => ({
        model: settings.model,
        small_model: settings.small_model,
        vision_model: settings.vision_model,
        transcript_model: settings.transcript_model,
        image_model: settings.image_model,
        speech_model: settings.speech_model,
        video_model: settings.video_model,
        ...options.app?.defaults,
      }),
      registry,
      () => options.app?.presets ?? {},
    );

  const db = openDb(config.dbPath);
  const messages = new MessagesRepo(db);
  const threads = new ThreadRepo(db);
  const usage = new UsageLogger(db);
  const memory = new MemoryStore(db, { profileMaxChars: settings.memory.profile_max_chars });
  const agents = new AgentCatalog(config.agentsDir);
  const chats = new ChatStore(db);
  const status = new StatusStore(db);
  const memos = new MemoStore(db);
  const wardrobe = new WardrobeStore(config.wardrobeDir, () => agents.names());
  const backgrounds = new BackgroundStore(config.backgroundsDir);
  const gallery = new GalleryStore(config.agentsDir);
  const attachments = new AttachmentStore(db, config.filesDir);

  // The database stays the source of truth; the mirrors under `user/sessions`,
  // `user/memory` and `user/history` keep it readable, syncable and easy to back up.
  // A failed mirror write must never stop the app, so every one is best-effort.
  const memoryFiles = new MemoryFiles(config.memoryDir);
  const sessionFiles = new SessionFiles(config.sessionsDir);
  const historyFiles = new HistoryFiles(config.historyDir);
  const mirror = (job: () => void) => {
    try {
      job();
    } catch {
      // keep going on the database alone
    }
  };
  memory.onChange = (entry) => mirror(() => memoryFiles.write(entry));
  memory.onDelete = (path) => mirror(() => memoryFiles.remove(path));
  chats.onChange = () => mirror(() => sessionFiles.sync(chats));
  messages.onAppend = (message) => mirror(() => historyFiles.append(message));
  // Files dropped into `user/memory` by hand are imported once, then kept in step.
  const knownMemory = new Set(memory.list().map((entry) => entry.path));
  for (const path of memoryFiles.paths()) {
    if (knownMemory.has(path)) continue;
    const imported = memoryFiles.read(path);
    if (!imported?.content) continue;
    try {
      memory.write({ path, description: imported.description, content: imported.content });
    } catch {
      // an invalid path or oversized content: leave the file as it is
    }
  }
  mirror(() => memoryFiles.sync(memory.list()));
  mirror(() => sessionFiles.sync(chats));
  mirror(() => historyFiles.sync(messages));
  const idleMs = settings.session.idle_minutes * 60_000;
  /** The agent that answers when a client names none: the configured one, else the first that exists. */
  const defaultAgentName = (): string | null => {
    const names = agents.names();
    return names.includes(settings.default_agent) ? settings.default_agent : (names[0] ?? null);
  };
  const google = GoogleAuth.fromEnv(process.env, config.googleTokenPath);
  const microsoft = MicrosoftAuth.fromEnv(process.env, config.microsoftTokenPath);
  const triggers = new TriggerStore(db, config.timezone);
  // The database schedules; the files under `triggers/` mirror it so a synced folder
  // carries reminders and webhooks to another machine.
  const triggerFiles = new TriggerFiles(config.triggersDir);
  triggers.onChange = (trigger) => triggerFiles.write(trigger);
  triggers.onDelete = (id) => triggerFiles.remove(id);
  triggerFiles.reconcile(triggers);
  const mesh = new MeshRouter({ db, agents, messages, settings: settings.mesh });
  const listeners: CoreListeners = {};

  // The persona is read once per start. Skills are read on demand, so one added in the app
  // works right away; a file broken by hand must not stop every agent, so the last good
  // list is kept. The index only changes when a skill does, which keeps the prefix cacheable.
  let knownSkills = loadSkills(config.skillsDir);
  const currentSkills = (): Skill[] => {
    try {
      knownSkills = loadSkills(config.skillsDir);
    } catch {
      // keep the last list that loaded
    }
    return knownSkills;
  };
  const skillsOf = (agent: { skills: string[] }) =>
    currentSkills().filter((skill) => agent.skills.includes(skill.name));
  const persona = loadPersona(config.personaPath);
  const profile = new UserProfileStore(config.userProfilePath, config.userProfileLocalPath);

  /** Start of today in the configured zone, as a UTC timestamp (for "spent today"). */
  const startOfToday = (): string => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const elapsed = ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 + now.getMilliseconds();
    return new Date(now.getTime() - elapsed).toISOString();
  };
  const spentToday = () => usage.spentSince(startOfToday());
  let budgetNoticeDay = '';
  /** A message when today's spending reached the limit set in Settings. */
  const budgetCheck = (): string | null => {
    const limit = options.app?.preferences.dailyBudgetUsd;
    if (!limit || limit <= 0) return null;
    const spent = spentToday();
    if (spent < limit) return null;
    const day = startOfToday();
    if (budgetNoticeDay !== day) {
      budgetNoticeDay = day;
      notify({ kind: 'info', title: 'ถึงงบรายวันแล้ว', body: `ใช้ไป ${spent.toFixed(2)} จากงบ ${limit.toFixed(2)} — หยุดเรียก model จนถึงพรุ่งนี้ (ปรับได้ที่ ตั้งค่า)` });
    }
    return `Today's spending limit is reached (${spent.toFixed(2)} of ${limit.toFixed(2)}). Raise it in Settings, or wait until tomorrow.`;
  };

  const knowledge = new KnowledgeStore(db, async (model, texts, signal) => {
    const overBudget = budgetCheck();
    if (overBudget) throw new Error(overBudget);
    const ref = parseModelRef(model);
    const startedAt = Date.now();
    const { embeddings, usage: used } = await embedMany({
      model: await registry.embeddingModel(ref),
      values: texts,
      maxParallelCalls: 2,
      abortSignal: signal,
    });
    // The catalog rarely prices embedding models: log the tokens, cost when known.
    let info: ModelInfo;
    try {
      info = registry.info(ref);
    } catch {
      info = { ref, name: ref.model, npm: '', baseURL: undefined, contextLimit: 0, outputLimit: undefined, cost: null, imageInput: false, toolCall: false, textOutput: false, options: {} };
    }
    usage.logCall({ runId: null, traceId: randomUUID(), agent: 'knowledge', kind: 'embedding', model: info, inputTokens: used?.tokens ?? 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, durationMs: Date.now() - startedAt });
    return embeddings;
  });

  /** A broken profile file must not stop the agents: it is left out of the prompt and logged. */
  const profileBlock = (agentName: string): string => {
    try {
      return profile.render(agentName);
    } catch (error) {
      console.error(`profile: ${(error as Error).message}`);
      return '';
    }
  };

  const tools = createToolRegistry({
    notifyUser: (agent, message, title) => {
      const { chatId } = postAs(agent, message, `notify:${randomUUID()}`);
      const name = agents.names().includes(agent) ? agents.get(agent).displayName || agent : agent;
      notify({ kind: 'message', title: title ?? name, body: message, ...(chatId !== undefined ? { chatId } : {}) });
      if (chatId !== undefined) listeners.chatChanged?.(chatId);
      return { chatId };
    },
    gallery,
    knowledge,
    profile,
    media: {
      attachments,
      models,
      usage,
      modelsOf: (agent) => agents.get(agent).models,
      budgetCheck: () => budgetCheck(),
    },
    // Agents read PDFs / images / Excel / text in the allowed folders (e.g. saved mail attachments).
    readDocument: async (requested, agentName, allowedDirs) => {
      const file = allowedPath(requested, allowedDirs);
      return documentText(file, (data, mime, name) => workflowRunner.readMedia!({ agent: agentName, data, mime, name, instruction: '' }));
    },
    memory,
    messages,
    triggers,
    agents,
    google,
    microsoft,
    skills: currentSkills,
    chats,
    status,
    memos,
    timezone: config.timezone,
  });
  const toolStore = new ToolStore(config.toolsDir);
  const secrets = new SecretStore(config.secretsPath);
  const pcRunner = makePcRunner(options.pc, config.localPcTools);
  const mcp = new McpHub({
    pc: pcRunner,
    configPath: path.join(config.toolsDir, 'mcp', 'servers.json'),
    cachePath: path.join(config.dataDir, 'mcp-tools.json'),
    secret: (name) => secrets.get(name) ?? process.env[name],
  });
  const toolPool = new ToolPool(tools, toolStore, secrets, mcp, pcRunner);
  const workflows = new WorkflowStore(config.workflowsDir);
  const triggerPool = new TriggerPool(path.join(config.triggersDir, 'pool'));
  const workflowState = new WorkflowState(config.workflowStatePath);
  const workflowRuns = new WorkflowRunStore(db);
  let vapid: VapidKeys | undefined;
  const notifications = new NotificationCenter(db, {
    vapid: () => (vapid ??= loadOrCreateVapid(config.pushKeysPath)),
    subject: config.pushContact,
    preferences: () => options.app?.preferences ?? {},
    timezone: config.timezone,
    log: (message) => console.error(message),
  });
  /** Every notification is kept (inbox) and pushed, then handed to whoever shows it live. */
  const notify = (notification: Notification) => {
    const item = notifications.add(notification);
    listeners.notification?.({ ...notification, id: item.id });
  };
  const parkedRuns = new ParkedRuns(db);
  const approvals = new Approvals(db, {
    post: (agent, text) => postAs(agent, text, `approval:${randomUUID()}`),
    changed: (chatId) => {
      if (chatId !== undefined) listeners.chatChanged?.(chatId);
    },
    onParked: (runId, decision, note) => void resumeParked(runId, { kind: 'approval', decision, ...(note ? { note } : {}) }),
  });

  const compactor = new Compactor({
    messages,
    threads,
    memory,
    models,
    usage,
    settings: settings.compaction,
    workingDir: config.allowedDirs[0],
  });
  const writer = new MemoryWriter({
    messages,
    memory,
    models,
    usage,
    profileMaxChars: settings.memory.profile_max_chars,
    timezone: config.timezone,
  });
  const jobs = new PostTurnJobs(writer, compactor, settings.memory.auto_write);

  const fileSnapshots = new FileSnapshots(db);
  const deps: AgentLoopDeps = {
    budgetCheck: () => budgetCheck(),
    messages,
    threads,
    memory,
    usage,
    models,
    tools: toolPool,
    executor: new SnapshotExecutor(new RoutingExecutor({ pc: options.pc, localPcTools: config.localPcTools }), fileSnapshots, { pc: options.pc, localPcTools: config.localPcTools }),
    gate: new PermissionGate(broker, {
      timeoutMs: config.permissionTimeoutMs,
      overrides: settings.permission,
    }),
    allowedDirs: config.allowedDirs,
    timezone: config.timezone,
    mesh,
    workingDir: () => (options.pc?.online ? options.pc.allowedDirs[0] : config.allowedDirs[0]),
    promptExtras: (agent) => {
      const own = skillsOf(agent);
      const index =
        own.length > 0
          ? renderSkillIndex(own, 'use_skill')
          : agent.tools.includes('load_skill')
            ? renderSkillIndex(currentSkills())
            : '';
      return [persona, profileBlock(agent.name), index, agent.tools.includes('status_set') ? wardrobe.renderIndex() : '']
        .filter(Boolean)
        .join('\n\n');
    },
    promptVars: (agent) => {
      let userName = '';
      try {
        userName = profile.displayName(agent.name);
      } catch {
        // a broken profile file only costs the name
      }
      return buildPromptVars({
        userName: userName || 'the user',
        self: agent,
        agents: agents.list(),
        extra: wardrobe.promptEntries(),
      });
    },
    contextExtras: (agent) =>
      status.render(agent.name, (key, value) => {
        if (key === 'outfit') return wardrobe.promptEntries()[value];
        const item = key === 'situation' ? gallery.get(agent.name, value) : undefined;
        return item && `${item.title}${item.description ? ` (${item.description.slice(0, 120)})` : ''}`;
      }),
    media: attachments,
    extraTools: (agent) => {
      const own = skillsOf(agent);
      // Workflows with an "agent tool" trigger this agent may call (its own, or ones that list it).
      const flows = workflowsOfKind('tool')
        .filter((workflow) => workflowToolCallers(workflow).includes(agent.name))
        .map((workflow) => createWorkflowTool(workflow, (items) => runWorkflowWithHandler(workflow, items, 'tool')));
      return [...(own.length > 0 ? [createUseSkillTool(own, runSkill)] : []), ...flows];
    },
  };
  mesh.attach((input) => runAgent(deps, input));

  /** Runs one workflow step with a configured agent; only the final text comes back. */
  const runWorkflowAgent = async (agentName: string, prompt: string, thread: string, signal?: AbortSignal): Promise<string> => {
    const agent = agents.get(agentName);
    const traceId = randomUUID();
    let finish: RunFinish | undefined;
    try {
      for await (const event of runAgent(deps, {
        agent,
        userText: prompt,
        thread,
        traceId,
        budget: mesh.budgetFor(traceId),
        signal,
      })) {
        if (event.type === 'run-finish') finish = event;
        listeners.backgroundEvent?.({ type: 'agent-activity', agent: agent.name, messageId: 0, event });
      }
    } finally {
      mesh.endTrace(traceId);
    }
    const done = finish as RunFinish | undefined;
    if (!done || done.reason === 'error' || done.reason === 'aborted') {
      throw new Error(`agent "${agentName}" failed: ${done?.error ?? done?.reason ?? 'no result'}`);
    }
    return done.text.trim() || '(the agent returned no text)';
  };

  const workflowRunner: WorkflowRunnerDeps = {
    runAgent: runWorkflowAgent,
    tool: (name) => toolPool.get(name),
    speak: (agentName, text, files = []) => {
      const speaker = agentName ?? defaultAgentName() ?? 'system';
      // Resolved first: a missing file fails the node before anything is posted.
      const ids = chatFiles(files, speaker);
      const posted = postAs(speaker, text, randomUUID());
      if (ids.length > 0) attachments.link(ids, posted.messageId);
      if (posted.chatId !== undefined) {
        listeners.chatChanged?.(posted.chatId);
        listeners.agentPosted?.(posted.chatId, speaker, text);
      }
    },
    requestApproval: async (request) => {
      const decision = approvals.request(request);
      const chatId = agents.names().includes(request.agent) ? chats.directChat(request.agent).id : undefined;
      notify({ kind: 'approval', title: 'รออนุมัติ', body: request.text, ...(chatId !== undefined ? { chatId } : {}) });
      return decision;
    },
    secret: (name) => secrets.get(name),
    // Approvals and long waits store the run; it finishes later, also after a restart.
    park: (parked) => {
      const id = parkedRuns.add(parked);
      if (parked.wait.kind === 'approval') {
        const { chatId } = approvals.requestParked({ workflow: `${parked.workflow.agent}/${parked.workflow.name}`, agent: parked.wait.agent, text: parked.wait.text, timeoutMs: parked.wait.timeoutMs, runId: id });
        notify({ kind: 'approval', title: 'รออนุมัติ', body: parked.wait.text, ...(chatId !== undefined ? { chatId } : {}) });
      }
      return id;
    },
    permissions: settings.permission,
    knowledge,
    attachmentFile: (id) => {
      const file = attachments.get(id);
      const data = file && attachments.read(id);
      return file && data ? { data, mime: file.mime, name: file.name } : undefined;
    },
    readMedia: async ({ agent: agentName, data, mime, name, instruction, signal }) => {
      const overBudget = budgetCheck();
      if (overBudget) throw new Error(overBudget);
      const agent = agents.get(agentName);
      const audio = mime.startsWith('audio/');
      const capability = audio ? 'transcript' : 'vision';
      const ref = models.resolve(capability, agent.models);
      const info = models.info(ref);
      const prompt = instruction
        ? `${instruction}\n\nOutput only the result.`
        : PROMPTS[audio ? 'audio' : mime.startsWith('video/') ? 'video' : mime === 'application/pdf' ? 'pdf' : 'image'];
      const startedAt = Date.now();
      const result = await generateText({
        model: await models.languageModel(ref),
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'file', mediaType: mime, data, filename: name }] }],
        providerOptions: providerOptionsFor(info),
        abortSignal: signal,
      });
      usage.logCall({
        runId: null,
        traceId: randomUUID(),
        agent: agentName,
        kind: capability,
        model: info,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        cachedTokens: result.usage.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: result.usage.inputTokenDetails.cacheWriteTokens ?? 0,
        durationMs: Date.now() - startedAt,
      });
      const text = result.text.trim();
      if (!text) throw new Error(`the model returned nothing for "${name}"`);
      return text;
    },
    mail: {
      list: (source, query, max) => (source === 'google' ? gmailListUnread(google, query, max) : outlookListUnread(microsoft, query, max)),
      markRead: (source, ids) => (source === 'google' ? gmailMarkRead(google, ids) : outlookMarkRead(microsoft, ids)),
    },
    state: workflowState,
    allowedDirs: config.allowedDirs,
    timezone: config.timezone,
    runSubWorkflow: async (agent, name, subItems, depth) => {
      const sub = workflows.get(agent, name);
      if (!sub) throw new Error(`workflow node: no workflow "${name}" for agent "${agent}"`);
      const outcome = await runWorkflowNodes(sub, subItems, workflowRunner, undefined, triggerPool.get(sub.trigger.pool)?.kind ?? 'manual', depth);
      if (!outcome.ok) throw new Error(`sub-workflow "${name}" failed: ${outcome.result}`);
      const last = outcome.nodes.findLast((view) => view.status === 'ok' && view.output.length > 0);
      return last?.output ?? [];
    },
    complete: async ({ agent: agentName, model, system, prompt, signal }) => {
      const overBudget = budgetCheck();
      if (overBudget) throw new Error(overBudget);
      const agent = agents.get(agentName);
      const ref =
        model === '@small'
          ? models.resolve('summarize', agent.models)
          : models.resolve('chat', model ? { model } : agent.models);
      const info = models.info(ref);
      const startedAt = Date.now();
      const response = await generateText({
        model: await models.languageModel(ref),
        ...(system ? { instructions: system } : {}),
        prompt,
        providerOptions: providerOptionsFor(info),
        ...ref.params,
        abortSignal: signal,
      });
      usage.logCall({
        runId: null,
        traceId: randomUUID(),
        agent: agentName,
        kind: model === '@small' ? 'summarize' : 'chat',
        model: info,
        inputTokens: response.usage.inputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
        cachedTokens: response.usage.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: response.usage.inputTokenDetails.cacheWriteTokens ?? 0,
        durationMs: Date.now() - startedAt,
      });
      return response.text;
    },
  };

  /**
   * Runs a workflow; when it fails and names an error workflow, that one runs once with
   * the failure info. The handler's own failure never masks the original one.
   */
  async function runWorkflowWithHandler(workflow: StoredWorkflow, items: FlowItem[], mode: string, options: RunOptions = {}): Promise<WorkflowRunResult> {
    const startedAt = new Date();
    const outcome = await runWorkflowNodes(workflow, items, workflowRunner, undefined, mode, 0, options);
    // Every top-level run lands in the history, whatever started it.
    outcome.runId = workflowRuns.record(`${workflow.agent}/${workflow.name}`, mode, startedAt, outcome);
    if (!outcome.ok) await runErrorWorkflow(workflow, outcome);
    return outcome;
  }

  /** Runs the workflow's error workflow once with what failed; its own failure never masks the first. */
  async function runErrorWorkflow(workflow: StoredWorkflow, outcome: WorkflowRunResult): Promise<void> {
    if (workflow.errorWorkflow && workflow.errorWorkflow !== workflow.name) {
      const handler = workflows.get(workflow.agent, workflow.errorWorkflow);
      if (handler) {
        const failed = outcome.nodes.find((view) => view.status === 'error');
        const errorItems: FlowItem[] = [
          { json: { workflow: `${workflow.agent}/${workflow.name}`, title: workflow.title, node: failed?.id ?? '', error: failed?.error ?? outcome.result } },
        ];
        try {
          await runWorkflowNodes(handler, errorItems, workflowRunner, undefined, triggerPool.get(handler.trigger.pool)?.kind ?? 'manual');
        } catch {
          // the handler's failure must not mask the original error
        }
      }
    }
  }

  /** Enabled workflows whose trigger is of this kind. */
  const workflowsOfKind = (kind: string, agent?: string) =>
    workflows.list(agent).filter((workflow) => workflow.enabled && triggerPool.get(workflow.trigger.pool)?.kind === kind);

  const telegram = new TelegramHub({
    secret: (name) => secrets.get(name),
    listeners: (): TelegramListener[] =>
      workflowsOfKind('telegram').map((workflow) => {
        const config = workflow.trigger.config as Record<string, unknown>;
        return {
          id: `${workflow.agent}/${workflow.name}`,
          tokenSecret: String(config.tokenSecret ?? '').trim() || DEFAULT_TOKEN_SECRET,
          chatIds: String(config.chatIds ?? '').split(/[\s,]+/).filter(Boolean),
          match: String(config.match ?? 'any'),
          pattern: String(config.pattern ?? ''),
          run: (item) => runWorkflowWithHandler(workflow, [item], 'telegram'),
        };
      }),
    cursor: { get: (key) => workflowState.cursor(key), set: (key, value) => workflowState.setCursor(key, value) },
    report: (message) => notify({ kind: 'info', title: 'Telegram', body: message }),
  });

  function chatTriggers(chatId: number, text: string, attachmentIds: string[] = []): { consumed: boolean; run(): void } {
    const chat = chats.getChat(chatId);
    if (!chat || chat.kind !== 'direct' || !chat.agents[0]) return { consumed: false, run: () => {} };
    const agent = chat.agents[0];
    const sent = attachmentIds.map((id) => attachments.get(id)).filter((file) => file !== undefined);
    const matched: Array<{ workflow: StoredWorkflow; rest: string; read: boolean }> = [];
    let consumed = false;
    for (const workflow of workflowsOfKind('chat', agent)) {
      const config = workflow.trigger.config as Record<string, unknown>;
      if (!filesMatch(String(config.files ?? 'any'), sent.map((file) => file.kind))) continue;
      const result = matchText(String(config.match ?? 'starts_with'), String(config.pattern ?? ''), text);
      if (!result.ok) continue;
      matched.push({ workflow, rest: result.rest, read: String(config.read_files ?? 'yes') !== 'no' });
      if (String(config.reply ?? 'workflow_only') !== 'agent_also') consumed = true;
    }
    return {
      consumed,
      run: () => {
        if (matched.length === 0) return;
        void (async () => {
          // Files are read once (description / transcript / text), only when a workflow asks.
          let files = sent;
          if (sent.length > 0 && matched.some((entry) => entry.read)) {
            files = await ingestAttachments(
              { store: attachments, models, usage },
              { ids: sent.map((file) => file.id), agent: agents.get(agent), traceId: randomUUID() },
            ).catch(() => sent);
          }
          for (const { workflow, rest, read } of matched) {
            const list = files.map(({ id, kind, name, mime, size, text: content }) => ({ id, kind, name, mime, size, text: read ? content : '' }));
            void runWorkflowWithHandler(workflow, [{ json: { text: text.trim(), rest, chatId, agent, files: list } }], 'chat').catch(() => {});
          }
        })();
      },
    };
  }

  /** The text of a source for the knowledge base: typed, a file, a web page or an upload. */
  async function addKnowledge(
    collection: string,
    input: { title?: string; text?: string; path?: string; url?: string; attachmentId?: string },
  ) {
    const agent = defaultAgentName();
    const media = async (data: Buffer, mime: string, name: string) => {
      if (!agent) throw new Error('Create an agent first: its vision / transcript model reads PDFs, images and audio.');
      return workflowRunner.readMedia!({ agent, data, mime, name, instruction: '' });
    };
    let text = input.text ?? '';
    let source = '';
    let title = input.title?.trim() ?? '';
    if (input.path?.trim()) {
      const file = allowedPath(input.path, config.allowedDirs);
      text = await documentText(file, media);
      source = file;
      title ||= path.basename(file);
    } else if (input.url?.trim()) {
      const url = new URL(input.url.trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http(s) links can be added.');
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${url.host} answered HTTP ${response.status}`);
      const body = await response.text();
      text = /html/i.test(response.headers.get('content-type') ?? '') ? htmlToText(body) : body;
      source = url.toString();
      title ||= (/<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1] ?? url.host).trim();
    } else if (input.attachmentId) {
      const file = attachments.get(input.attachmentId);
      const data = attachments.read(input.attachmentId);
      if (!file || !data) throw new Error('The uploaded file is gone; upload it again.');
      const { kind } = kindOfFile(file.name);
      text =
        file.kind === 'image' || file.kind === 'audio' || file.kind === 'video' || kind === 'pdf'
          ? await media(data, kind === 'pdf' ? 'application/pdf' : file.mime, file.name)
          : kind === 'html'
            ? htmlToText(data.toString('utf8'))
            : data.toString('utf8');
      source = `upload:${file.name}`;
      title ||= file.name;
    }
    if (!text.trim()) throw new Error('There is no text to add.');
    return knowledge.add(collection, { title, text, source });
  }

  function postUserMessage(chatId: number, text: string, attachmentIds: string[] = []): { sessionId: number; id: number; createdAt: string } {
    const chat = chats.getChat(chatId);
    if (!chat) throw new Error(`Chat #${chatId} does not exist.`);
    const { session } = chats.currentSession(chat.id, idleMs);
    const id = messages.append({ thread: session.thread, traceId: randomUUID(), agent: chat.agents[0] ?? '', role: 'user', content: text, text });
    if (attachmentIds.length > 0) attachments.link(attachmentIds, id);
    chats.touch(session.id);
    return { sessionId: session.id, id, createdAt: messages.get(id)?.createdAt ?? new Date().toISOString() };
  }

  /** Finishes a stored run: its waiting node ends with `outcome`, the rest runs, history records it. */
  async function resumeParked(runId: number, outcome: ResumeOutcome): Promise<WorkflowRunResult | undefined> {
    const parked = parkedRuns.take(runId);
    if (!parked) return undefined;
    const workflow = workflows.get(parked.workflow.agent, parked.workflow.name);
    if (!workflow) return undefined;
    const startedAt = new Date();
    try {
      const outcomeRun = await resumeWorkflow(workflow, parked, outcome, workflowRunner);
      outcomeRun.runId = workflowRuns.record(`${workflow.agent}/${workflow.name}`, `${parked.state.execution.mode} (ต่อ)`, startedAt, outcomeRun);
      if (!outcomeRun.ok) await runErrorWorkflow(workflow, outcomeRun);
      return outcomeRun;
    } catch (error) {
      console.error(`resuming ${workflow.agent}/${workflow.name} failed: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** Wakes stored runs whose wait is over, and times out stored approvals nobody answered. */
  let closed = false;
  async function wakeParked(): Promise<void> {
    if (closed) return;
    try {
      for (const id of parkedRuns.due()) await resumeParked(id, { kind: 'wait' });
      for (const runId of approvals.expireParked()) await resumeParked(runId, { kind: 'approval', decision: 'timeout' });
    } catch (error) {
      if (!closed) console.error(`waking paused runs failed: ${(error as Error).message}`);
    }
  }
  const wakeTimer = setInterval(() => void wakeParked(), 30_000);
  wakeTimer.unref();
  const firstWake = setTimeout(() => void wakeParked(), 2000);
  firstWake.unref();

  /** Keeps the workflow's schedule row in the triggers table in step with its settings. */
  function syncWorkflowSchedule(workflow: StoredWorkflow): void {
    telegram.sync();
    const id = `${workflow.agent}/${workflow.name}`;
    const existing = triggers.byWorkflow(id);
    const entry = triggerPool.get(workflow.trigger.pool);
    const kind = entry?.kind;
    const scheduled = workflow.enabled && (kind === 'schedule' || kind === 'mail' || kind === 'poll');
    if (!scheduled) {
      if (existing) triggers.delete(existing.id);
      return;
    }
    const everyMinutes = Math.min(1440, Math.max(5, Number(workflow.trigger.config.everyMinutes) || 15));
    const cron =
      kind === 'schedule' ? String(workflow.trigger.config.cron ?? '').trim() : `*/${everyMinutes} * * * *`;
    if (!cron) throw new Error('The workflow needs a cron pattern, e.g. "0 8 * * *".');
    const title = `workflow: ${workflow.title}`;
    const text = `Workflow "${workflow.title}" (${workflow.trigger.pool})`;
    if (existing && existing.status === 'active') triggers.update(existing.id, { title, text, cron, repeat: true });
    else {
      if (existing) triggers.delete(existing.id);
      triggers.create({ kind: 'agent_task', title, text, cron, repeat: true, workflow: id, agent: null });
    }
  }

  function clearWorkflowSchedule(id: string): void {
    telegram.sync();
    const existing = triggers.byWorkflow(id);
    if (existing) triggers.delete(existing.id);
  }

  /**
   * A skill with its own model runs as a separate job: the skill's instructions are the
   * system prompt, the model and tools are the skill's, and only the result comes back.
   */
  const runSkill: SkillRunner = async (skill, input, context) => {
    const owner = agents.get(context.agent);
    const worker = {
      ...owner,
      systemPrompt: readSkillBody(skill),
      models: { ...owner.models, model: skill.model },
      tools: skill.tools,
      skills: [],
      canMessage: [],
    };
    let finish: RunFinish | undefined;
    for await (const event of runAgent(deps, {
      agent: worker,
      userText: input,
      thread: `skill:${randomUUID()}`,
      traceId: context.traceId,
      budget: mesh.budgetFor(context.traceId),
      signal: context.signal,
    })) {
      if (event.type === 'run-finish') finish = event;
      context.emit?.({ type: 'agent-activity', agent: `${owner.name}:${skill.name}`, messageId: 0, event });
    }
    const done = finish as RunFinish | undefined;
    if (!done || done.reason === 'error' || done.reason === 'aborted') {
      throw new Error(`Skill "${skill.name}" failed: ${done?.error ?? done?.reason ?? 'no result'}`);
    }
    return done.text.trim() || `(skill "${skill.name}" finished without text: ${done.reason})`;
  };

  /** Runs an agent and every agent it hands the turn to; returns the first run's finish. */
  async function* runWithHandoffs(input: RunInput, userThread: string): AsyncGenerator<AgentEvent, RunFinish | undefined> {
    let first: RunFinish | undefined;
    let last: RunFinish | undefined;
    for await (const event of runAgent(deps, input)) {
      if (event.type === 'run-finish') first = last = event;
      yield event;
    }
    // Each handoff is one hop; send_to refuses to create one past the hop limit.
    while (last?.handoff) {
      const { messageId } = last.handoff;
      last = undefined;
      for await (const event of mesh.runHandoff(messageId, userThread, input.signal)) {
        if (event.type === 'run-finish') last = event;
        yield event;
      }
    }
    return first;
  }

  async function* runTurn(input: RunInput): AsyncGenerator<AgentEvent> {
    const thread = input.thread ?? USER_THREAD;
    // Safety net for prompts that outgrew the window without a turn finishing (first run
    // on an old database, a smaller model). Normally compaction happens after the turn.
    try {
      const compacted = await compactor.maybeCompact(thread, input.agent);
      if (compacted) jobs.note(describeCompaction(compacted));
    } catch (error) {
      jobs.note(`compaction failed: ${(error as Error).message}`);
    }

    const traceId = input.traceId ?? randomUUID();
    try {
      const finish = yield* runWithHandoffs(
        { ...input, thread, traceId, budget: mesh.budgetFor(traceId) },
        thread,
      );
      if (finish) {
        jobs.schedule({
          thread,
          traceId,
          agent: input.agent,
          contextTokens: finish.contextTokens,
          completed: finish.reason !== 'error' && finish.reason !== 'aborted',
        });
      }
    } finally {
      mesh.endTrace(traceId);
    }
  }

  /**
   * Attachment ids for files a workflow posts: ids found in the text (a file that already
   * belongs to a message is copied, so it stays there too) or paths in the allowed folders.
   */
  function chatFiles(entries: string[], speaker: string): string[] {
    const ids: string[] = [];
    for (const entry of entries) {
      const found = entry.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
      if (found) {
        for (const id of found) {
          const file = attachments.get(id.toLowerCase());
          if (!file) throw new Error(`chat node: no chat file "${id}"`);
          ids.push(file.messageId === null ? file.id : attachments.clone(file.id)!);
        }
        continue;
      }
      const file = allowedPath(entry, config.allowedDirs);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`chat node: "${entry}" is not a file`);
      if (fs.statSync(file).size > MAX_ATTACHMENT_BYTES) throw new Error(`chat node: "${entry}" is larger than 25 MB`);
      const saved = attachments.save({ name: path.basename(file), mime: kindOfFile(file).mime, data: fs.readFileSync(file) });
      attachments.setText(saved.id, `(sent by ${speaker}'s workflow)`);
      ids.push(saved.id);
    }
    return ids;
  }

  /** Posts a message into an agent's one-to-one chat with the user; returns the chat id. */
  const speakAs = (speaker: string, text: string, traceId: string): number | undefined => postAs(speaker, text, traceId).chatId;

  /** Posts as an agent into its direct chat (or the main thread); says where it landed. */
  function postAs(speaker: string, text: string, traceId: string): { chatId?: number; messageId: number } {
    let chatId: number | undefined;
    let thread = USER_THREAD;
    if (agents.names().includes(speaker)) {
      const chat = chats.directChat(speaker);
      const { session } = chats.currentSession(chat.id, idleMs);
      chats.touch(session.id);
      chatId = chat.id;
      thread = session.thread;
    }
    const messageId = messages.append({ thread, traceId, agent: speaker, role: 'assistant', content: text, text });
    return { chatId, messageId };
  }

  /** What the scheduler does when a trigger comes due; `payload` is the body of a webhook call. */
  async function fireTrigger(trigger: Trigger, payload?: string): Promise<string> {
    // A schedule that belongs to a workflow runs the workflow instead of an agent turn.
    if (trigger.workflow) {
      const [agent, name] = trigger.workflow.split('/');
      const workflow = agent && name ? workflows.get(agent, name) : undefined;
      if (!workflow || !workflow.enabled) return `workflow "${trigger.workflow}" is missing or disabled`;
      const outcome = await fireWorkflow(workflow);
      return outcome;
    }
    const speaker = trigger.agent ?? defaultAgentName() ?? 'system';

    if (trigger.kind === 'reminder') {
      const extra = payload ? `\n${payload}` : '';
      const text = `⏰ ${trigger.title}: ${trigger.text}${extra}`;
      const chatId = speakAs(speaker, text, `trigger:${trigger.id}`);
      notify({ kind: 'reminder', title: trigger.title, body: `${trigger.text}${extra}`, triggerId: trigger.id, chatId });
      return 'notified';
    }

    // Unattended agent run in its own thread; only the result joins the user's thread.
    const agent = agents.get(speaker);
    const traceId = randomUUID();
    const task = [
      `<scheduled_task id="${trigger.id}" title="${trigger.title}">`,
      trigger.text,
      '</scheduled_task>',
      ...(payload ? [`<webhook_payload>\n${payload}\n</webhook_payload>`] : []),
      'This task was scheduled earlier and runs unattended: nobody is reading along. Do it and finish with a short report for the user.',
    ].join('\n');
    let finish: RunFinish | undefined;
    /** The agent already told the user itself (notify_user); a second notice would be noise. */
    let notifiedItself = false;
    try {
      for await (const event of runAgent(deps, {
        agent,
        userText: task,
        thread: `task:${trigger.id}`,
        traceId,
        budget: mesh.budgetFor(traceId),
      })) {
        if (event.type === 'run-finish') finish = event;
        if (event.type === 'tool-call' && event.call.name === 'notify_user') notifiedItself = true;
        listeners.backgroundEvent?.({ type: 'agent-activity', agent: agent.name, messageId: 0, event });
      }
    } finally {
      mesh.endTrace(traceId);
    }
    const done = finish as RunFinish | undefined;
    const result = done?.text.trim() || `(no report; the run ended with: ${done?.error ?? done?.reason ?? 'no result'})`;
    const chatId = speakAs(speaker, `[Scheduled task "${trigger.title}"]\n${result}`, traceId);
    if (notifiedItself) {
      if (chatId !== undefined) listeners.chatChanged?.(chatId);
    } else {
      notify({ kind: 'task-result', title: trigger.title, body: result, triggerId: trigger.id, chatId });
    }
    return result;
  }

  /** Runs a workflow from its trigger: mail polls run once per new message, others once. */
  async function fireWorkflow(workflow: StoredWorkflow): Promise<string> {
    const entry = triggerPool.get(workflow.trigger.pool);
    const id = `${workflow.agent}/${workflow.name}`;
    if (entry?.kind === 'mail') {
      const items = await triggerItems(workflow, triggerPool, workflowRunner);
      const seen = workflowState.seen(id);
      const fresh = items.filter((item) => !seen.has(String(item.json.Id ?? '')));
      if (fresh.length === 0) return 'no new mail';
      let last = '';
      for (const item of fresh) {
        const outcome = await runWorkflowWithHandler(workflow, [item], entry?.kind ?? 'manual');
        last = outcome.result;
        workflowState.mark(id, [String(item.json.Id ?? '')]);
      }
      if (asBoolean(workflow.trigger.config.markRead, true)) {
        try {
          const source = String(workflow.trigger.config.source ?? '') === 'microsoft' ? 'microsoft' : 'google';
          await workflowRunner.mail.markRead(source, fresh.map((item) => String(item.json.Id ?? '')));
        } catch {
          // leaving them unread is fine: seen() keeps them from being handled twice
        }
      }
      return `${fresh.length} mail: ${last.slice(0, 200)}`;
    }
    const items: FlowItem[] = await triggerItems(workflow, triggerPool, workflowRunner);
    const outcome = await runWorkflowWithHandler(workflow, items, entry?.kind ?? 'manual');
    return outcome.result;
  }

  const asBoolean = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

  const engine = new ChatEngine({
    chats,
    agents,
    messages,
    attachments,
    models,
    usage,
    idleMs,
    maxGroupTurns: settings.mesh.max_hops,
    run: runWithHandoffs,
    beforeRun: async (thread, agent) => {
      try {
        const compacted = await compactor.maybeCompact(thread, agent);
        if (compacted) jobs.note(describeCompaction(compacted));
      } catch (error) {
        jobs.note(`compaction failed: ${(error as Error).message}`);
      }
    },
    afterTurn: ({ thread, traceId, agent, finish }) => {
      if (!finish) return;
      jobs.schedule({
        thread,
        traceId,
        agent,
        contextTokens: finish.contextTokens,
        completed: finish.reason !== 'error' && finish.reason !== 'aborted',
      });
    },
    budgetFor: (traceId) => mesh.budgetFor(traceId),
    endTrace: (traceId) => mesh.endTrace(traceId),
  });

  const scheduler = new Scheduler({
    store: triggers,
    fire: fireTrigger,
    onError: (trigger, error) =>
      notify({
        kind: 'info',
        title: `Trigger "${trigger.title}" failed`,
        body: error.message,
        triggerId: trigger.id,
      }),
  });

  telegram.sync();

  return {
    db,
    settings,
    registry,
    auth,
    providers: providerStore,
    agents,
    defaultAgentName,
    models,
    memory,
    chats,
    engine,
    status,
    memos,
    wardrobe,
    backgrounds,
    gallery,
    attachments,
    skills: currentSkills,
    tools: toolPool,
    secrets,
    workflows,
    triggerPool,
    workflowRuns,
    knowledge,
    addKnowledge,
    profile,
    notifications,
    notify,
    spentToday,
    fileSnapshots,
    parkedRuns,
    resumeParked,
    approvals,
    telegram,
    chatTriggers,
    postUserMessage,
    async runWorkflow(agent: string, name: string, input?: JsonValue, options?: { pins?: boolean }): Promise<WorkflowRunResult> {
      const workflow = workflows.get(agent, name);
      if (!workflow) throw new Error(`No workflow "${name}" for agent "${agent}".`);
      const items = await triggerItems(workflow, triggerPool, workflowRunner, { input });
      return runWorkflowWithHandler(workflow, items, triggerPool.get(workflow.trigger.pool)?.kind ?? 'manual', options?.pins ? { usePins: true } : {});
    },
    async runWorkflowFrom(agent: string, name: string, nodeId: string, runId: number): Promise<WorkflowRunResult> {
      const workflow = workflows.get(agent, name);
      if (!workflow) throw new Error(`No workflow "${name}" for agent "${agent}".`);
      const run = workflowRuns.get(runId);
      if (!run || run.workflow !== `${agent}/${name}`) throw new Error(`No stored run #${runId} of this workflow.`);
      const view = run.nodes.find((entry) => entry.id === nodeId);
      if (!view || view.input.length === 0) throw new Error('That node got no input in this run; run the whole workflow first.');
      // Nodes before it keep what they gave in that run, so $node["…"] still works.
      const outputs: Record<string, { json: Record<string, JsonValue>; items: Array<Record<string, JsonValue>> }> = {};
      for (const entry of run.nodes) {
        if (entry.output.length === 0) continue;
        const record = { json: entry.output[0]!.json, items: entry.output.map((item) => item.json) };
        outputs[entry.title] = record;
        outputs[entry.id] = record;
      }
      return runWorkflowWithHandler(workflow, view.input, 'จากกลางทาง', { usePins: true, startAt: { nodeId, input: view.input, outputs } });
    },
    testWorkflowNode: (workflow, node, input) => runWorkflowNode(workflow, node, input, workflowRunner),
    syncWorkflowSchedule,
    clearWorkflowSchedule,
    google,
    microsoft,
    compactor,
    jobs,
    mesh,
    triggers,
    scheduler,
    deps,
    listeners,
    runTurn,
    async fire(id: number, payload?: string): Promise<string> {
      const trigger = triggers.get(id);
      if (!trigger) throw new Error(`No trigger #${id}.`);
      if (trigger.status === 'cancelled') throw new Error(`Trigger #${id} is cancelled.`);
      // A manual run leaves the schedule alone; only the time and result are recorded.
      triggers.markFired(id);
      const result = await fireTrigger(trigger, payload);
      triggers.setResult(id, result);
      return result;
    },
    history: (beforeId, limit = 50) =>
      messages.page(USER_THREAD, beforeId, limit).map((message) => ({
        id: message.id,
        role: message.role,
        agent: message.agent,
        text: message.text,
        createdAt: message.createdAt,
      })),
    async close() {
      scheduler.stop();
      await mcp.close();
      closed = true;
      clearInterval(wakeTimer);
      clearTimeout(firstWake);
      approvals.close();
      await telegram.close();
      await jobs.idle();
      db.close();
    },
  };
}
