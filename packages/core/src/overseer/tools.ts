import { NODE_TYPES, type CustomToolSpec, type OAuthAccountView, type ToolPreset, type WorkflowView } from '@mimi/shared';
import { z } from 'zod';
import { MODEL_KEYS } from '../app/app-settings.ts';
import type { AgentCatalog, AgentDefinition } from '../agents/loader.ts';
import { ERROR_CODE_GUIDE, errorGuideFor, formatError } from '../errors.ts';
import { saveAgent } from '../agents/loader.ts';
import { checkModelNeeds, MODEL_CAPABILITY } from '../providers/model-requirements.ts';
import type { ModelService } from '../providers/routing.ts';
import { deleteSkill, readSkillBody, saveSkill, type Skill } from '../skills/skills.ts';
import type { SecretStore } from '../app/secrets.ts';
import type { TriggerStore } from '../scheduler/triggers.ts';
import { localStamp } from '../scheduler/trigger-tools.ts';
import type { ToolPool } from '../tools/pool.ts';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import type { TriggerPool } from '../workflows/trigger-pool.ts';
import type { ToolCallRecord, ToolStat } from '../usage/logger.ts';
import type { WorkflowRunStore } from '../workflows/run-history.ts';
import type { WorkflowStore } from '../workflows/workflow-store.ts';
import { type CustomNodeSpec, type CustomNodeStore } from '../workflows/custom-nodes.ts';
import { auditSecrets, validateConfig } from './diagnostics.ts';
import { OVERSEER_NAME } from './overseer.ts';
import type { VersionStore } from './versions.ts';

export interface OverseerToolDeps {
  agentsDir: string;
  skillsDir: string;
  agents: AgentCatalog;
  tools: ToolPool;
  skills(): Skill[];
  workflows: WorkflowStore;
  nodes: CustomNodeStore;
  models: ModelService;
  secrets: SecretStore;
  triggers: TriggerStore;
  triggerPool: TriggerPool;
  workflowRuns: WorkflowRunStore;
  versions: VersionStore;
  /** OAuth accounts (views never contain a client secret). */
  oauthAccounts?(): OAuthAccountView[];
  /** Starts one account's sign-in and returns the page the user must open. */
  startOAuth?(accountId: string): Promise<{ url: string }>;
  /** Tool call counts and failures, for run_log. */
  toolStats?(days: number): ToolStat[];
  /** Records a tool call (tool_test included) for the Overseer's run_log. */
  logTool?(record: ToolCallRecord): void;
  timezone: string;
  allowedDirs: string[];
  /** Approved project roots for shell commands; empty means any allowed folder. */
  projectRoots?: string[];
  /** Runs a throw-away test turn with an agent and returns what it said (no chat, no notification). */
  runAgentTest?(agent: string, text: string, maxRounds: number): Promise<{ text: string; reason: string; error?: string; errorCode?: string; rounds: number }>;
  /** Runs a tool through the normal executor (so PC tools reach the PC agent), without the permission prompt. */
  runTool?(name: string, input: unknown, signal: AbortSignal): Promise<string>;
  /** The model a new agent gets when the request does not name one. */
  defaultModel(): string;
  changed: {
    agent(name: string): void;
    tools(): void;
    skills(): void;
    nodes?(): void;
    workflow?(id: string): void;
  };
}

const MAX_OUTPUT = 30_000;
/** Test turns are real model work; the limits survive between turns (one tool set per turn). */
const testRuns = new Map<string, number>();
const recentTests: number[] = [];
const clip = (text: string): string =>
  text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n… [cut: ${text.length - MAX_OUTPUT} more characters]`;
const pretty = (value: unknown): string => clip(JSON.stringify(value, null, 2));

const modelKey = z.enum(MODEL_KEYS);
const modelChoice = z.record(modelKey, z.string()).describe('One model (or model-pool preset) per capability, e.g. {"model":"openai/gpt-4o"}');

const agentInput = z.object({
  name: z.string().min(1).describe('Lowercase id; it is also the folder name'),
  displayName: z.string().optional(),
  description: z.string().optional(),
  intro: z.string().optional().describe('What other agents are told about this one'),
  systemPrompt: z.string().optional().describe('The full system prompt; omit to keep the current one'),
  models: modelChoice.optional().describe('Merged into the current models; an empty string clears one'),
  tools: z.array(z.string()).optional().describe('The full tool list; replaces the current list'),
  lazyTools: z.boolean().optional().describe('Send only tool_search up front and load tools on demand (useful for 50+ tools)'),
  addTools: z.array(z.string()).optional(),
  removeTools: z.array(z.string()).optional(),
  permissions: z
    .record(z.string(), z.enum(['allow', 'ask', 'deny']))
    .optional()
    .describe('Per-agent policy: tool or preset name -> allow (never ask), ask (always ask), deny (never run)'),
  skills: z.array(z.string()).optional().describe('The full skill list; replaces the current list'),
  addSkills: z.array(z.string()).optional(),
  removeSkills: z.array(z.string()).optional(),
  canMessage: z.array(z.string()).optional().describe('Agents this one may message'),
  budgets: z
    .object({
      maxRounds: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
});

const paramField = z.object({
  key: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().optional(),
  required: z.boolean().optional().describe('Defaults to true'),
});

const settingField = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'secret', 'text']),
  description: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const customToolInput = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase letters, digits, "-" or "_"'),
  description: z.string().min(1),
  kind: z.enum(['http', 'code', 'shell']),
  params: z.array(paramField).default([]),
  settings: z.array(settingField).default([]),
  config: z
    .record(z.string(), z.unknown())
    .describe('code: {code,timeoutMs}; http: {method,url,headers,query,body,bodyType,timeoutMs}; shell: {command,cwd,runsOn,timeoutMs}'),
});

const customNodeInput = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{1,60}$/, 'lowercase letters, digits, "-" or "_"'),
  label: z.string().min(1),
  description: z.string().min(1).describe('What the node does; the user sees this in the editor'),
  code: z
    .string()
    .min(1)
    .describe('JavaScript body run in the workflow sandbox: items (JSON array) and $config are in scope; return new items, e.g. items.map((json) => ({...json, upper: String(json.text).toUpperCase()}))'),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  outputs: z
    .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'an output name'))
    .min(1)
    .max(12)
    .optional()
    .describe('Output keys; an item returned with "$output": "name" goes to that output (default main)'),
  fields: z
    .array(
      z.object({
        key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
        label: z.string().min(1),
        type: z.enum(['string', 'number', 'boolean', 'text', 'json', 'expression']),
        required: z.boolean().optional(),
        placeholder: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional()
    .describe('Optional form fields for the plugin config (documentation for the user)'),
});

const presetInput = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase letters, digits, "-" or "_"'),
  tool: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

const skillInput = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and "-" (no underscore)'),
  description: z.string().min(1),
  model: z.string().optional().describe('Optional model/preset the skill runs as a separate job'),
  tools: z.array(z.string()).optional().describe('Tools the skill may use when it runs as a separate job'),
  body: z.string().min(1).describe('The instructions the agent follows'),
});

function modelInfo(deps: OverseerToolDeps, key: (typeof MODEL_KEYS)[number], value: string): void {
  const ref = deps.models.resolve(MODEL_CAPABILITY[key], { [key]: value });
  checkModelNeeds(key, value, deps.models.info(ref));
}

function checkModels(deps: OverseerToolDeps, choice: Partial<Record<(typeof MODEL_KEYS)[number], string>>): void {
  for (const key of MODEL_KEYS) {
    const value = choice[key];
    if (value) modelInfo(deps, key, value);
  }
}

/** Saves every normal agent the callback changed, and tells the UI. */
function updateAgents(deps: OverseerToolDeps, change: (agent: AgentDefinition) => AgentDefinition | null): string[] {
  const changed: string[] = [];
  for (const name of deps.agents.names()) {
    if (name === OVERSEER_NAME) continue;
    const agent = deps.agents.get(name);
    const next = change(agent);
    if (!next) continue;
    saveAgent(deps.agentsDir, next);
    changed.push(name);
  }
  for (const name of changed) deps.changed.agent(name);
  return changed;
}

function applyList(current: string[], full?: string[], add?: string[], remove?: string[]): string[] {
  const set = new Set(full ?? current);
  for (const name of add ?? []) set.add(name);
  for (const name of remove ?? []) set.delete(name);
  return [...set];
}

/** What the Overseer needs to answer "did it fire, and will it fire again?" */
function triggerView(deps: OverseerToolDeps, trigger: ReturnType<TriggerStore['get']>) {
  if (!trigger) return null;
  const kind = trigger.webhook ? 'webhook' : trigger.cron ? 'cron' : 'fire_at';
  const oneShot = kind === 'fire_at';
  return {
    id: trigger.id,
    owner: trigger.workflow ? `workflow ${trigger.workflow}` : trigger.agent ? `agent ${trigger.agent}` : 'user',
    kind,
    title: trigger.title,
    text: clip(trigger.text),
    status: trigger.status,
    repeat: trigger.repeat,
    nextFireAt: trigger.nextFireAt,
    nextFireAtLocal: localStamp(trigger.nextFireAt, deps.timezone),
    lastFiredAt: trigger.lastFiredAt,
    lastFiredAtLocal: localStamp(trigger.lastFiredAt, deps.timezone),
    lastResult: trigger.lastResult ? clip(trigger.lastResult) : null,
    webhook: trigger.webhook,
    /** A one-shot trigger is done when it is no longer active; a cron one keeps waiting. */
    oneShotState: oneShot ? (trigger.status === 'active' ? 'pending' : trigger.status) : null,
    createdAt: trigger.createdAt,
    updatedAt: trigger.updatedAt,
  };
}

function versionSummary(entry: { id: string; at: string; data: unknown }) {
  const data = entry.data as Partial<AgentDefinition & CustomToolSpec>;
  return {
    id: entry.id,
    at: entry.at,
    name: data.name ?? null,
    displayName: 'displayName' in data ? data.displayName ?? null : null,
    tools: Array.isArray(data.tools) ? data.tools : null,
    promptPreview: typeof (data as { systemPrompt?: unknown }).systemPrompt === 'string' ? clip((data as { systemPrompt: string }).systemPrompt.slice(0, 240)) : null,
    kind: 'kind' in data ? data.kind ?? null : null,
    description: typeof data.description === 'string' ? clip(data.description.slice(0, 240)) : null,
  };
}

/** Flattens an object into `path -> JSON value` for a readable config diff. */
function flattened(value: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (value === null || typeof value !== 'object') {
    out.set(prefix || '(value)', JSON.stringify(value));
    return out;
  }
  if (Array.isArray(value)) {
    out.set(prefix || '(value)', JSON.stringify(value));
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) flattened(entry, path, out);
    else out.set(path, JSON.stringify(entry));
  }
  return out;
}

/** The fields a save would add, remove or change. */
function configDiff(current: unknown, next: Record<string, unknown>) {
  const before = flattened(current ?? {});
  const after = flattened(next);
  const added: Array<{ key: string; next: string }> = [];
  const removed: Array<{ key: string; current: string }> = [];
  const changed: Array<{ key: string; current: string; next: string }> = [];
  for (const [key, value] of after) {
    if (!before.has(key)) added.push({ key, next: value });
    else if (before.get(key) !== value) changed.push({ key, current: before.get(key)!, next: value });
  }
  for (const [key, value] of before) if (!after.has(key)) removed.push({ key, current: value });
  // Lists are easier to read as add/remove than as one long changed JSON value.
  const currentRecord = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  const lists: Record<string, { added: unknown[]; removed: unknown[] }> = {};
  for (const key of ['tools', 'skills', 'canMessage']) {
    const was = Array.isArray(currentRecord[key]) ? (currentRecord[key] as unknown[]) : undefined;
    const will = Array.isArray(next[key]) ? (next[key] as unknown[]) : undefined;
    if (!was || !will) continue;
    const addedItems = will.filter((entry) => !was.includes(entry));
    const removedItems = was.filter((entry) => !will.includes(entry));
    if (addedItems.length + removedItems.length > 0) lists[key] = { added: addedItems, removed: removedItems };
  }
  return { added, removed, changed, ...(Object.keys(lists).length > 0 ? { lists } : {}) };
}

/** The portable part of a skill: a restore writes these fields back to the file. */
function skillSnapshot(skill: Skill) {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.model ? { model: skill.model } : {}),
    tools: skill.tools,
    body: readSkillBody(skill),
  };
}

/** A workflow without the generated webhook fields, which a restore must not churn. */
function workflowSnapshot(workflow: WorkflowView): Record<string, unknown> {
  const { webhook: _webhook, webhookKey: _webhookKey, ...rest } = workflow as WorkflowView & { webhookKey?: string | null };
  return rest as unknown as Record<string, unknown>;
}

/** A workflow's owner from "agent/name", an explicit agent, or a unique name. */
function workflowTarget(deps: OverseerToolDeps, name: string, agent?: string): { agent: string; name: string } {
  const trimmed = name.trim();
  if (agent?.trim()) return { agent: agent.trim(), name: trimmed };
  if (trimmed.includes('/')) {
    const [who, what] = trimmed.split('/', 2);
    if (!who || !what) throw new Error(`Workflow "${name}" needs the form "agent/name".`);
    return { agent: who, name: what };
  }
  const matches = deps.workflows.list().filter((workflow) => workflow.name === trimmed);
  if (matches.length === 1) return { agent: matches[0]!.agent, name: trimmed };
  if (matches.length > 1) {
    throw new Error(`Workflow "${trimmed}" exists for ${matches.map((workflow) => workflow.agent).join(', ')}; pass the agent.`);
  }
  throw new Error(`No workflow "${trimmed}".`);
}

function agentSummary(deps: OverseerToolDeps, name: string) {
  const agent = deps.agents.get(name);
  return {
    name: agent.name,
    displayName: agent.displayName || agent.name,
    description: agent.description,
    model: agent.models.model ?? null,
    tools: agent.tools,
    permissions: agent.permissions ?? {},
    skills: agent.skills,
  };
}

export function createOverseerTools(deps: OverseerToolDeps): ToolDefinition<any>[] {
  const state: ToolDefinition<any> = defineTool({
    name: 'overseer_state',
    description:
      'Read the current setup: agents, tools, presets, skills, workflows, node types, models and stored secret names. Call this before changing anything.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'Read the current setup',
    async execute() {
      const overseer = deps.agents.get(OVERSEER_NAME);
      return pretty({
        overseer: {
          model: overseer.models.model ?? null,
          defaultModel: deps.defaultModel(),
        },
        agents: deps.agents.names().filter((name) => name !== OVERSEER_NAME).map((name) => agentSummary(deps, name)),
        skills: deps.skills().map((skill) => ({
          name: skill.name,
          description: skill.description,
          model: skill.model ?? null,
          tools: skill.tools,
          builtin: Boolean(skill.builtin),
        })),
        workflows: deps.workflows.list().map((workflow) => ({
          agent: workflow.agent,
          name: workflow.name,
          title: workflow.title,
          enabled: workflow.enabled,
          trigger: workflow.trigger.pool,
          nodes: workflow.nodes.length,
        })),
        triggers: deps.triggers.list().map((trigger) => triggerView(deps, trigger)),
        recentRuns: deps.workflowRuns.recent(8).map((run) => ({
          id: run.id,
          workflow: run.workflow,
          ok: run.ok,
          trigger: run.trigger,
          startedAt: run.startedAt,
          result: clip(run.result.slice(0, 300)),
        })),
        nodeTypes: NODE_TYPES.map((node) => ({ type: node.type, label: node.label })),
        customNodes: deps.nodes.list().map((node) => ({ name: node.name, label: node.label, description: node.description })),
        secrets: deps.secrets.names(),
        rules: {
          reservedAgent: `${OVERSEER_NAME} may be updated, never renamed or duplicated`,
          drive: 'Google Drive is read-only here (drive_search). Writing/uploading needs a new OAuth scope and the user\'s consent.',
          workflows: 'workflow_save always lands disabled; workflow_enable is a separate write step the user approves.',
          secrets: 'Only names are shown. Put values in the vault; use {{secret.NAME}} in tools.',
          errors: 'Chat errors, tool_test and agent_message carry a stable code (E-AUTH-401, E-RATE-429, E-CONTEXT, E-NETWORK, E-CONFIG, E-BUDGET, ...). Call error_codes when the user reports one; it explains the cause and the next step.',
          nodes: 'Custom nodes are files under user/nodes. Each one is a real node type "custom:<name>" (and still works through the "plugin" node). Create them with node_save; they may read items and $config and must return items. Never put secrets in a custom node.',
        },
        // Names are enough here; tool_get has the full settings and templates.
        tools: deps.tools.views().map((tool) => ({
          name: tool.name,
          risk: tool.risk,
          builtin: tool.builtin,
          presets: tool.presets,
          description: tool.description.split('. ')[0]!.slice(0, 180),
        })),
        presets: deps.tools.presetViews().map((preset) => ({
          name: preset.name,
          tool: preset.tool,
          label: preset.label ?? null,
          settings: Object.keys(preset.settings ?? {}),
        })),
      });
    },
  });

  const agentSchema: ToolDefinition<any> = defineTool({
    name: 'agent_schema',
    description: 'Show how an agent is defined, with a complete example. Call this before agent_save.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'Read the agent schema',
    async execute() {
      return pretty({
        storage: 'agents/<name>/agent.md — YAML frontmatter plus the system prompt body',
        fields: {
          name: 'lowercase letters, digits, "-" or "_"; also the folder name',
          displayName: 'shown in chats',
          description: 'one line for the agent list',
          intro: 'what the other agents are told about this one',
          models: 'one model/preset per capability; unset ones fall back to the global default',
          tools: 'tool or preset names from the pool',
          skills: 'skill names from the skill hub',
          canMessage: 'agent names this one may message',
          budgets: 'maxRounds, maxTokens',
          systemPrompt: 'the full instructions (required)',
        },
        tips: [
          'Use addTools/removeTools to change one or two tools without resending the full list.',
          'Reads, PDFs: read_document. Gmail: gmail_*. Calendar: calendar_*. Sheets: sheets_*. Drive: drive_search only.',
          'Never put API keys in the prompt; tools read them from the vault.',
          'An agent cannot have both an untrusted-content tool and a shell tool.',
          'permissions: {"run_shell":"allow","delete_path":"ask"} sets this agent\'s policy; it beats the global risk default, and deny is always refused.',
          'lazyTools: true sends only tool_search up front; the model loads the tools it needs (use it for 50+ tools).',
        ],
        example: {
          name: 'researcher',
          displayName: 'นักวิจัย',
          description: 'ค้นคว้าและสรุปเอกสาร',
          systemPrompt: 'You are a careful researcher. Read the document before answering, cite the file name, and reply in Thai.',
          models: { model: deps.defaultModel() },
          tools: ['read_document', 'web_search'],
          skills: [],
          canMessage: [],
          budgets: { maxRounds: 12, maxTokens: 200000 },
        },
      });
    },
  });

  const agentList: ToolDefinition<any> = defineTool({
    name: 'agent_list',
    description: 'List the user\'s agents with their model, tools and skills (the Overseer itself is left out).',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'List agents',
    async execute() {
      const names = deps.agents.names().filter((name) => name !== OVERSEER_NAME);
      return names.length === 0 ? 'No agents yet.' : pretty(names.map((name) => agentSummary(deps, name)));
    },
  });

  const agentGet: ToolDefinition<any> = defineTool({
    name: 'agent_get',
    description: 'Read one agent in full: model, tools, skills, permissions, budgets and system prompt.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1) }),
    summarize: (input) => `Read agent ${input.name}`,
    async execute(input) {
      return pretty(deps.agents.get(input.name.trim()));
    },
  });

  const agentSave: ToolDefinition<any> = defineTool({
    name: 'agent_save',
    description:
      'Create or update an agent. Omitted fields keep their current value. Use addTools/removeTools for small changes; validate tool and skill names first.',
    risk: 'write',
    target: 'core',
    inputSchema: agentInput,
    summarize: (input) => `Save agent ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      const exists = deps.agents.names().includes(name);
      if (name === OVERSEER_NAME && !exists) throw new Error('The AI Overseer is created by the app; it cannot be created here.');
      const current = exists ? deps.agents.get(name) : undefined;
      if (!exists && !input.systemPrompt?.trim()) throw new Error('A new agent needs a systemPrompt.');

      const tools = applyList(current?.tools ?? [], input.tools, input.addTools, input.removeTools);
      deps.tools.select(tools);
      if (name === OVERSEER_NAME) {
        // The built-in capabilities already include run_shell; keep the untrusted/shell rule.
        for (const tool of tools) {
          const definition = deps.tools.get(tool);
          if (definition?.untrustedInput && !definition.allowWithShell) {
            throw new Error(`The Overseer always has run_shell, so "${tool}" (third-party content) cannot be added to it. Use browser_open for web pages.`);
          }
        }
      }

      const knownSkills = deps.skills().map((skill) => skill.name);
      const skills = applyList(current?.skills ?? [], input.skills, input.addSkills, input.removeSkills);
      for (const skill of skills) {
        if (!knownSkills.includes(skill)) throw new Error(`Skill "${skill}" does not exist. Available: ${knownSkills.join(', ') || 'none'}`);
      }

      const canMessage = (input.canMessage ?? current?.canMessage ?? []).map(String).filter((peer) => peer !== name);
      const knownAgents = deps.agents.names();
      for (const peer of canMessage) {
        if (!knownAgents.includes(peer)) throw new Error(`Agent "${peer}" does not exist.`);
      }

      const models = { ...(current?.models ?? {}), ...(input.models ?? {}) };
      for (const key of MODEL_KEYS) {
        if (models[key] === '') delete models[key];
      }
      checkModels(deps, models);
      if (!models.model) models.model = deps.defaultModel();

      const agent: AgentDefinition = {
        name,
        displayName: input.displayName ?? current?.displayName ?? '',
        description: input.description ?? current?.description ?? '',
        intro: input.intro ?? current?.intro,
        models,
        tools,
        lazyTools: input.lazyTools ?? current?.lazyTools,
        permissions: { ...(current?.permissions ?? {}), ...(input.permissions ?? {}) },
        skills,
        canMessage,
        character: current?.character,
        idleMotion: current?.idleMotion,
        budgets: {
          maxRounds: input.budgets?.maxRounds ?? current?.budgets.maxRounds ?? 12,
          maxTokens: input.budgets?.maxTokens ?? current?.budgets.maxTokens ?? 200_000,
        },
        systemPrompt: input.systemPrompt?.trim() || current?.systemPrompt || '',
      };
      if (!agent.systemPrompt) throw new Error('The system prompt is empty.');
      // Keep the version that is about to be replaced: a wrong prompt must be undoable.
      if (current) deps.versions.save('agent', name, current);
      saveAgent(deps.agentsDir, agent);
      deps.changed.agent(name);
      return `Saved agent "${name}" (${agent.tools.length} tools, ${agent.skills.length} skills, model ${agent.models.model}). The previous version is in agent_history.`;
    },
  });

  const toolSchema: ToolDefinition<any> = defineTool({
    name: 'tool_schema',
    description:
      'Show the custom-tool format: HTTP, JavaScript code and shell, plus the fixed workflow node types. Call this before tool_save.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'Read the tool schema',
    async execute() {
      return pretty({
        overview: 'A reusable tool lives in the pool. A preset is the same tool with settings filled in; agents list the preset name like any tool.',
        fields: {
          name: 'lowercase letters, digits, "-" or "_"',
          description: 'what the model reads to decide when to call it',
          kind: 'http | code | shell',
          params: 'inputs the model provides per call: {key,type:string|number|boolean,description,required}',
          settings: 'values a preset fills in: {key,label,type:string|number|boolean|secret|text,description,required,default}',
          config: 'kind-specific settings (see examples)',
        },
        templates:
          'In URLs, headers, bodies and shell commands: {{input.x}}, {{settings.x}}, {{secret.NAME}}, {{env.NAME}}. In code tools use input, settings and console.log; return a string or JSON.',
        examples: {
          http: {
            name: 'weather',
            description: 'Current weather for a city',
            kind: 'http',
            params: [{ key: 'city', type: 'string', description: 'City name' }],
            settings: [],
            config: { method: 'GET', url: 'https://wttr.in/{{input.city}}?format=j1' },
          },
          code: {
            name: 'invoice_total',
            description: 'Add up invoice lines',
            kind: 'code',
            params: [{ key: 'lines', type: 'string', description: 'JSON array of {amount}' }],
            settings: [],
            config: {
              code: 'const lines = JSON.parse(input.lines);\nreturn { total: lines.reduce((sum, line) => sum + Number(line.amount || 0), 0) };',
            },
          },
          shell: {
            name: 'disk_space',
            description: 'Show free disk space',
            kind: 'shell',
            params: [],
            settings: [],
            config: { command: 'df -h' },
          },
        },
        rules: [
          'Code tools run in a sandbox without filesystem, child processes or network; use an http tool for network calls.',
          'Shell tools are high risk and cannot be combined with untrusted-content tools on one agent, except the built-in browser tools.',
          'Do not put secrets in params, settings defaults or code. Use a secret-type setting or {{secret.NAME}}.',
          'A JavaScript tool is not a workflow node type. Add it to the agent (or a preset), then call it from a workflow "tool" node; workflows also have an inline "code" node.',
          'For a reusable workflow node, create a custom node with node_save; it appears as the "plugin" node and its code runs in the sandbox with items and $config.',
        ],
        nodeTypes: NODE_TYPES.map((node) => ({ type: node.type, label: node.label, description: node.description })),
      });
    },
  });

  const toolList: ToolDefinition<any> = defineTool({
    name: 'tool_list',
    description: 'List the tool pool: built-in tools, custom tools, presets, risks and settings.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'List tools',
    async execute() {
      return pretty({
        tools: deps.tools.views(),
        presets: deps.tools.presetViews(),
        custom: deps.tools.customSpecs(),
      });
    },
  });

  const toolGet: ToolDefinition<any> = defineTool({
    name: 'tool_get',
    description: 'Read one tool or preset in full.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1) }),
    summarize: (input) => `Read tool ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      const spec = deps.tools.customSpecs().find((tool) => tool.name === name);
      if (spec) return pretty(spec);
      const preset = deps.tools.presetViews().find((entry) => entry.name === name);
      if (preset) return pretty(preset);
      const view = deps.tools.views().find((tool) => tool.name === name);
      if (!view) throw new Error(`Unknown tool "${name}".`);
      return pretty(view);
    },
  });

  const toolSave: ToolDefinition<any> = defineTool({
    name: 'tool_save',
    description:
      'Create or replace a custom tool (HTTP, JavaScript code or shell). For settings, create a preset afterward with preset_save. Never put secrets in the tool.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ tool: customToolInput, renameFrom: z.string().optional() }),
    summarize: (input) => `Save tool ${input.tool.name}`,
    async execute(input) {
      const current = deps.tools.customSpecs().find((tool) => tool.name === (input.renameFrom ?? input.tool.name));
      if (current) deps.versions.save('tool', current.name, current);
      const saved = deps.tools.saveCustom(input.tool as CustomToolSpec, input.renameFrom);
      if (input.renameFrom && input.renameFrom !== saved.name) {
        updateAgents(deps, (agent) => {
          if (!agent.tools.includes(input.renameFrom!)) return null;
          const tools = agent.tools.map((name) => (name === input.renameFrom ? saved.name : name));
          return { ...agent, tools };
        });
      }
      deps.changed.tools();
      return `Saved custom tool "${saved.name}" (${saved.kind}). Add it to an agent with agent_save (addTools), or make a preset with preset_save.`;
    },
  });

  const toolDelete: ToolDefinition<any> = defineTool({
    name: 'tool_delete',
    description: 'Delete a custom tool and every preset built on it, after removing them from the agents that use them.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1) }),
    summarize: (input) => `Delete tool ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      if (!deps.tools.customSpecs().some((tool) => tool.name === name)) {
        throw new Error(`"${name}" is not a custom tool. Built-in tools cannot be deleted.`);
      }
      const presets = deps.tools.presetViews().filter((preset) => preset.tool === name).map((preset) => preset.name);
      const removed = deps.tools.deleteCustom(name);
      const gone = new Set([name, ...removed, ...presets]);
      updateAgents(deps, (agent) => {
        const tools = agent.tools.filter((tool) => !gone.has(tool));
        return tools.length === agent.tools.length ? null : { ...agent, tools };
      });
      deps.changed.tools();
      return `Deleted tool "${name}"${removed.length > 0 ? ` and ${removed.length} preset(s)` : ''}.`;
    },
  });

  const presetSave: ToolDefinition<any> = defineTool({
    name: 'preset_save',
    description:
      'Create or replace a preset (a configured tool instance, e.g. "Manager Sheet"). Secret-type settings must stay in the vault; never put a key here.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ preset: presetInput, renameFrom: z.string().optional() }),
    summarize: (input) => `Save preset ${input.preset.name}`,
    async execute(input) {
      const name = input.preset.name;
      const base = deps.tools.get(input.preset.tool);
      if (!base) throw new Error(`Unknown tool "${input.preset.tool}".`);
      const secretKeys = new Set((base.settings ?? []).filter((field) => field.type === 'secret').map((field) => field.key));
      for (const key of Object.keys(input.preset.settings ?? {})) {
        if (secretKeys.has(key)) {
          throw new Error(`"${key}" is a secret setting. Do not put its value here; tell the user to add it in the vault.`);
        }
      }
      const current = deps.tools.presetViews().find((preset) => preset.name === (input.renameFrom ?? name));
      if (current) deps.versions.save('preset', name, current);
      const saved = deps.tools.savePreset(input.preset as ToolPreset, input.renameFrom);
      if (input.renameFrom && input.renameFrom !== saved.name) {
        updateAgents(deps, (agent) => {
          if (!agent.tools.includes(input.renameFrom!)) return null;
          return { ...agent, tools: agent.tools.map((tool) => (tool === input.renameFrom ? saved.name : tool)) };
        });
      }
      deps.changed.tools();
      return `Saved preset "${saved.name}" of tool "${saved.tool}". Add it to an agent with agent_save (addTools).`;
    },
  });

  const presetDelete: ToolDefinition<any> = defineTool({
    name: 'preset_delete',
    description: 'Delete a preset and remove it from every agent that uses it.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1) }),
    summarize: (input) => `Delete preset ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      if (!deps.tools.presetViews().some((preset) => preset.name === name)) throw new Error(`Unknown preset "${name}".`);
      deps.tools.deletePreset(name);
      updateAgents(deps, (agent) => {
        const tools = agent.tools.filter((tool) => tool !== name);
        return tools.length === agent.tools.length ? null : { ...agent, tools };
      });
      deps.changed.tools();
      return `Deleted preset "${name}".`;
    },
  });

  const skillSchema: ToolDefinition<any> = defineTool({
    name: 'skill_schema',
    description: 'Show the skill format and when to use one. Call this before skill_save.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'Read the skill schema',
    async execute() {
      return pretty({
        storage: 'skills/<name>.md — YAML frontmatter plus the instructions',
        fields: {
          name: 'lowercase letters, digits and "-" (no underscore)',
          description: 'one line; this is what the agent sees in its skill index',
          model: 'optional; a skill with its own model runs as a separate job and returns the result',
          tools: 'optional tools for that separate job',
          body: 'the instructions the agent follows',
        },
        when: 'Use a skill for a repeatable procedure or expertise (e.g. how to file expenses), not for a one-off prompt. Add it to an agent with agent_save (addSkills).',
        example: {
          name: 'expense-report',
          description: 'Collect receipts and produce a monthly expense report',
          body: '1. Ask for the month and the folder.\n2. Read every receipt with read_document.\n3. Group by category, sum the totals and show a table.\n4. Save the result as a new document and ask before sending it anywhere.',
        },
      });
    },
  });

  const skillList: ToolDefinition<any> = defineTool({
    name: 'skill_list',
    description: 'List the skills in the hub with their description, model and tools.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'List skills',
    async execute() {
      return pretty(
        deps.skills().map((skill) => ({
          name: skill.name,
          description: skill.description,
          model: skill.model ?? null,
          tools: skill.tools,
          builtin: Boolean(skill.builtin),
        })),
      );
    },
  });

  const skillGet: ToolDefinition<any> = defineTool({
    name: 'skill_get',
    description: 'Read one skill in full, including its instructions.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1) }),
    summarize: (input) => `Read skill ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      const skill = deps.skills().find((entry) => entry.name === name);
      if (!skill) throw new Error(`Unknown skill "${name}".`);
      return pretty({ ...skill, body: readSkillBody(skill) });
    },
  });

  const skillSave: ToolDefinition<any> = defineTool({
    name: 'skill_save',
    description: 'Create or replace a skill file. Add it to an agent with agent_save (addSkills).',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ skill: skillInput, renameFrom: z.string().optional() }),
    summarize: (input) => `Save skill ${input.skill.name}`,
    async execute(input) {
      if (input.skill.model) modelInfo(deps, 'model', input.skill.model);
      if (input.skill.tools) deps.tools.select(input.skill.tools);
      const name = input.skill.name;
      const current = deps.skills().find((skill) => skill.name === (input.renameFrom ?? name));
      if (current && !current.builtin) deps.versions.save('skill', name, skillSnapshot(current));
      const saved = saveSkill(deps.skillsDir, {
        name: input.skill.name,
        description: input.skill.description,
        ...(input.skill.model ? { model: input.skill.model } : {}),
        tools: input.skill.tools ?? [],
        body: input.skill.body,
      });
      if (input.renameFrom && input.renameFrom !== saved.name) {
        deleteSkill(deps.skillsDir, input.renameFrom);
        updateAgents(deps, (agent) => {
          if (!agent.skills.includes(input.renameFrom!)) return null;
          return { ...agent, skills: agent.skills.map((skill) => (skill === input.renameFrom ? saved.name : skill)) };
        });
      }
      deps.changed.skills();
      return `Saved skill "${saved.name}". Add it to an agent with agent_save (addSkills).`;
    },
  });

  const skillDelete: ToolDefinition<any> = defineTool({
    name: 'skill_delete',
    description: 'Delete a skill and remove it from every agent that uses it.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1) }),
    summarize: (input) => `Delete skill ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      if (!deps.skills().some((skill) => skill.name === name)) throw new Error(`Unknown skill "${name}".`);
      if (!deleteSkill(deps.skillsDir, name)) throw new Error(`Skill "${name}" is built in and cannot be deleted.`);
      updateAgents(deps, (agent) => {
        const skills = agent.skills.filter((skill) => skill !== name);
        return skills.length === agent.skills.length ? null : { ...agent, skills };
      });
      deps.changed.skills();
      return `Deleted skill "${name}".`;
    },
  });

  const nodeSchema: ToolDefinition<any> = defineTool({
    name: 'node_schema',
    description:
      'Show the custom workflow node format. Call this before node_save. Custom nodes live under user/nodes and run in the workflow sandbox as the "plugin" node.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'Read the custom node schema',
    async execute() {
      return pretty({
        storage: 'user/nodes/<name>.json; the workflow editor lists it as node type "custom:<name>" (and on the "plugin" node)',
        fields: {
          name: 'lowercase letters, digits, "-" or "_"',
          label: 'shown in the workflow editor',
          description: 'what it does; the model and the user read it',
          code: 'JavaScript body; items and $config are in scope; return an array of JSON objects or one object',
          timeoutMs: 'optional, 1000-120000',
          outputs: 'optional output keys (default ["main"]); return an item with "$output": "<key>" to route it',
          fields: 'optional form documentation: [{key,label,type,required,placeholder,description}]',
        },
        example: {
          name: 'uppercase-subject',
          label: 'Uppercase subject',
          description: 'Turn each item’s Subject into upper case',
          code: 'return items.map((json) => ({ ...json, Subject: String(json.Subject || "").toUpperCase() }));',
          fields: [{ key: 'suffix', label: 'Suffix', type: 'string', required: false }],
        },
        rules: [
          'The sandbox has no files, child processes, network or secrets; it only gets items and config as JSON.',
          'Never put API keys or passwords in a custom node. Use a tool or connector for authenticated work.',
          'Add node type "custom:<name>" in the workflow (the older "plugin" node still works).',
          'A custom node cannot run shell commands or read files; use the built-in file/tool nodes for that.',
        ],
      });
    },
  });

  const nodeList: ToolDefinition<any> = defineTool({
    name: 'node_list',
    description: 'List the custom workflow nodes under user/nodes.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'List custom nodes',
    async execute() {
      const nodes = deps.nodes.list();
      return nodes.length === 0 ? 'No custom nodes yet.' : pretty(nodes.map((node) => ({ name: node.name, label: node.label, description: node.description })));
    },
  });

  const nodeGet: ToolDefinition<any> = defineTool({
    name: 'node_get',
    description: 'Read one custom node in full, including its code.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1) }),
    summarize: (input) => `Read custom node ${input.name}`,
    async execute(input) {
      const node = deps.nodes.get(input.name.trim());
      if (!node) throw new Error(`Unknown custom node "${input.name}".`);
      return pretty(node);
    },
  });

  const nodeSave: ToolDefinition<any> = defineTool({
    name: 'node_save',
    description:
      'Create or replace a custom workflow node under user/nodes. The plugin node then offers it by name. Never put secrets in the code or config.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ node: customNodeInput, renameFrom: z.string().optional() }),
    summarize: (input) => `Save custom node ${input.node.name}`,
    async execute(input) {
      const saved = deps.nodes.save(input.node as CustomNodeSpec, input.renameFrom);
      deps.changed.nodes?.();
      return `Saved custom node "${saved.name}" (${saved.label}). Add a workflow "plugin" node and choose "${saved.name}".`;
    },
  });

  const nodeDelete: ToolDefinition<any> = defineTool({
    name: 'node_delete',
    description: 'Delete a custom workflow node. Workflows that still use it will fail until it is removed or recreated.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1) }),
    summarize: (input) => `Delete custom node ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      if (!deps.nodes.remove(name)) throw new Error(`Unknown custom node "${name}".`);
      deps.changed.nodes?.();
      return `Deleted custom node "${name}".`;
    },
  });

  const triggerList: ToolDefinition<any> = defineTool({
    name: 'trigger_list',
    description:
      'Read-only list of reminders, scheduled agent tasks and webhooks. Shows the owner (agent or workflow), the kind (fire_at / cron / webhook), the next fire time in the local zone, the last result, and whether a one-shot trigger is still pending or already fired/cancelled.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      status: z.enum(['active', 'fired', 'cancelled', 'all']).optional().describe('Defaults to all'),
      owner: z.string().optional().describe('Agent name or "agent/name" workflow owner'),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    summarize: () => 'List triggers',
    async execute(input) {
      const status = input.status && input.status !== 'all' ? input.status : undefined;
      let triggers = deps.triggers.list(status);
      if (input.owner) {
        const owner = input.owner.trim();
        triggers = triggers.filter(
          (trigger) => trigger.agent === owner || trigger.workflow === owner || (trigger.workflow ?? '').endsWith(`/${owner}`),
        );
      }
      triggers = triggers.slice(0, input.limit ?? 100);
      return triggers.length === 0 ? 'No triggers.' : pretty(triggers.map((trigger) => triggerView(deps, trigger)));
    },
  });

  const triggerGet: ToolDefinition<any> = defineTool({
    name: 'trigger_get',
    description: 'Read one trigger in full: owner, kind, next fire, last result, webhook URL and one-shot state.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ id: z.number().int().positive() }),
    summarize: (input) => `Read trigger #${input.id}`,
    async execute(input) {
      const trigger = deps.triggers.get(input.id);
      if (!trigger) throw new Error(`No trigger #${input.id}.`);
      return pretty(triggerView(deps, trigger));
    },
  });

  const agentMessage: ToolDefinition<any> = defineTool({
    name: 'agent_message',
    description:
      'Send one test message to an agent and read its reply. This runs a real turn (with the agent\'s prompt, tools and skills) but posts nothing to the user\'s chats. Pass test: true. Rounds are capped, and the same agent can be tested at most once every 10 seconds (5 tests per minute overall).',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      agent: z.string().min(1),
      text: z.string().min(1),
      test: z.boolean().default(true).describe('Must be true; this tool only runs test messages'),
      maxRounds: z.number().int().min(1).max(8).optional().describe('Defaults to 3'),
    }),
    summarize: (input) => `Test agent ${input.agent}`,
    async execute(input) {
      if (input.test !== true) throw new Error('agent_message only runs test messages; pass test: true.');
      if (!deps.runAgentTest) throw new Error('Test turns are not available in this build.');
      const name = input.agent.trim();
      if (name === OVERSEER_NAME) throw new Error('The Overseer cannot message itself.');
      deps.agents.get(name); // must exist
      const now = Date.now();
      const last = testRuns.get(name) ?? 0;
      if (now - last < 10_000) throw new Error(`Just tested "${name}" — wait ${Math.ceil((10_000 - (now - last)) / 1000)}s before trying again.`);
      while (recentTests.length > 0 && now - recentTests[0]! > 60_000) recentTests.shift();
      if (recentTests.length >= 5) throw new Error('Too many agent tests in one minute; wait a moment.');
      testRuns.set(name, now);
      recentTests.push(now);
      const started = Date.now();
      const result = await deps.runAgentTest(name, input.text.trim(), input.maxRounds ?? 3);
      return pretty({
        test: true,
        agent: name,
        rounds: result.rounds,
        reason: result.reason,
        durationMs: Date.now() - started,
        ...(result.error ? { error: result.error, errorCode: result.errorCode ?? null } : {}),
        text: result.text || '(no text)',
      });
    },
  });

  // The name people ask for; it is the same safe, rate-limited test turn as agent_message.
  const agentTest: ToolDefinition<any> = {
    ...agentMessage,
    name: 'agent_test',
    description: 'Test an agent with one message and see what it replies and which tools it picks (same as agent_message; no chat is posted).',
  };

  const workflowRuns: ToolDefinition<any> = defineTool({
    name: 'workflow_runs',
    description:
      'Read workflow run history. Without a run id it lists recent runs (newest first) with ok/failed and the result/error; with a run id it shows every node input/output and the failing node.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      agent: z.string().optional(),
      workflow: z.string().optional().describe('Workflow name, or "agent/name"'),
      runId: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    summarize: (input) => (input.runId ? `Read workflow run #${input.runId}` : 'List workflow runs'),
    async execute(input) {
      if (input.runId) {
        const run = deps.workflowRuns.get(input.runId);
        if (!run) throw new Error(`No workflow run #${input.runId}.`);
        return pretty(run);
      }
      const limit = input.limit ?? 20;
      let runs;
      if (input.workflow) {
        const name = input.workflow.trim();
        let key = name;
        if (!name.includes('/')) {
          const found = deps.workflows.list(input.agent).find((workflow) => workflow.name === name);
          if (!found) throw new Error(`No workflow "${name}"${input.agent ? ` for agent "${input.agent}"` : ''}.`);
          key = `${found.agent}/${found.name}`;
        }
        runs = deps.workflowRuns.list(key, limit);
      } else if (input.agent) {
        runs = deps.workflows
          .list(input.agent)
          .flatMap((workflow) => deps.workflowRuns.list(`${workflow.agent}/${workflow.name}`, limit))
          .sort((a, b) => b.id - a.id)
          .slice(0, limit);
      } else {
        runs = deps.workflowRuns.recent(limit);
      }
      if (runs.length === 0) return 'No workflow runs yet.';
      return pretty(
        runs.map((run) => ({
          id: run.id,
          workflow: run.workflow,
          agent: run.agent,
          trigger: run.trigger,
          ok: run.ok,
          startedAt: run.startedAt,
          durationMs: run.durationMs,
          nodeCount: run.nodeCount,
          result: clip(run.result),
          ...(run.ok ? {} : { error: clip(run.result) }),
        })),
      );
    },
  });

  const toolTest: ToolDefinition<any> = defineTool({
    name: 'tool_test',
    description:
      'Run a tool or preset once with sample input and return its real output. Use it to check a preset\'s spreadsheet id, an HTTP tool\'s endpoint, or a connector. Shell and delete tools are refused; write tools need confirmWrite: true because they may change real data.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      name: z.string().min(1),
      input: z.record(z.string(), z.unknown()).optional().describe('Sample input matching the tool\'s params'),
      confirmWrite: z.boolean().optional().describe('Required for write-risk tools'),
      timeoutMs: z.number().int().min(1000).max(120_000).optional(),
    }),
    summarize: (input) => `Test tool ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      const tool = deps.tools.get(name);
      if (!tool) throw new Error(`Unknown tool or preset "${name}".`);
      if (tool.risk === 'shell' || tool.risk === 'delete') {
        throw new Error(`"${name}" is ${tool.risk}-risk and cannot be run from tool_test. Ask the user to run it.`);
      }
      if (tool.alwaysAsk) {
        throw new Error(`"${name}" needs the user's approval for every call and cannot be run from tool_test. Ask the user to run it.`);
      }
      if (tool.risk === 'write' && !input.confirmWrite) {
        throw new Error(`"${name}" can change data. Pass confirmWrite: true only when the sample values are safe to run for real.`);
      }
      const parsed = tool.inputSchema.safeParse(input.input ?? {});
      if (!parsed.success) throw new Error(`Invalid sample input:\n${z.prettifyError(parsed.error)}`);
      const timeoutMs = input.timeoutMs ?? 30_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`tool_test timed out after ${timeoutMs}ms`)), timeoutMs);
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      const started = Date.now();
      const context = {
        traceId: `overseer-tool-test-${Date.now().toString(36)}`,
        thread: 'overseer-test',
        agent: OVERSEER_NAME,
        allowedDirs: deps.allowedDirs,
        ...(deps.projectRoots?.length ? { projectRoots: deps.projectRoots } : {}),
        signal: controller.signal,
      };
      try {
        const output = await Promise.race([
          deps.runTool ? deps.runTool(name, parsed.data, controller.signal) : tool.execute(parsed.data, context),
          aborted,
        ]);
        const durationMs = Date.now() - started;
        deps.logTool?.({ traceId: context.traceId, agent: OVERSEER_NAME, tool: name, risk: tool.risk, ok: true, durationMs });
        return pretty({ name, risk: tool.risk, ok: true, durationMs, output: clip(String(output)) });
      } catch (error) {
        const durationMs = Date.now() - started;
        const message = formatError(error);
        deps.logTool?.({ traceId: context.traceId, agent: OVERSEER_NAME, tool: name, risk: tool.risk, ok: false, durationMs, error: message });
        return pretty({ name, risk: tool.risk, ok: false, durationMs, error: message });
      } finally {
        clearTimeout(timer);
      }
    },
  });

  const errorCodes: ToolDefinition<any> = defineTool({
    name: 'error_codes',
    description:
      'Explain the stable error codes shown in chats, toasts, tool_test and agent_message: what each one means and what to do next. Call it when the user reports a code such as E-RATE-429.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      code: z.string().optional().describe('One code such as E-RATE-429; omit to list every code'),
    }),
    summarize: (input) => (input.code ? `Explain error ${input.code}` : 'List error codes'),
    async execute(input) {
      if (input.code) {
        const found = errorGuideFor(input.code);
        if (!found) throw new Error(`Unknown error code "${input.code}". Known: ${ERROR_CODE_GUIDE.map((entry) => entry.code).join(', ')}.`);
        return pretty(found);
      }
      return pretty(ERROR_CODE_GUIDE);
    },
  });

  const configValidate: ToolDefinition<any> = defineTool({
    name: 'config_validate',
    description:
      'Check the whole setup for leftovers: agents naming missing tools/skills/agents, prompts mentioning tools the agent does not have, tools using vault secrets that do not exist, presets with missing settings, workflows naming deleted agents/tools/workflows/plugins, and stale or broken triggers. Nothing is changed.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'Validate the whole setup',
    async execute() {
      return pretty(
        validateConfig({
          agents: deps.agents,
          tools: deps.tools,
          skills: deps.skills,
          workflows: deps.workflows,
          nodes: deps.nodes,
          secrets: deps.secrets,
          triggers: deps.triggers,
          triggerPool: deps.triggerPool,
          mcpServers: () => deps.tools.mcp?.views() ?? [],
        }),
      );
    },
  });

  const agentHistory: ToolDefinition<any> = defineTool({
    name: 'agent_history',
    description: 'List the last 10 saved versions of an agent (prompt, tools, models), newest first.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1), limit: z.number().int().min(1).max(10).optional() }),
    summarize: (input) => `Read history of agent ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      const versions = deps.versions.list('agent', name, input.limit ?? 10);
      return versions.length === 0 ? `No saved versions of agent "${name}" yet.` : pretty({ name, versions: versions.map(versionSummary) });
    },
  });

  const agentRestore: ToolDefinition<any> = defineTool({
    name: 'agent_restore',
    description:
      'Restore an agent from a saved version (agent_history). The current version is snapshotted first, so a restore can itself be undone. Omit version to restore the newest snapshot.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1), version: z.string().optional() }),
    summarize: (input) => `Restore agent ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      const versions = deps.versions.list('agent', name, 10);
      if (versions.length === 0) throw new Error(`No saved versions of agent "${name}".`);
      const entry = input.version ? deps.versions.get<AgentDefinition>('agent', name, input.version) : (versions[0] as { id: string; at: string; data: AgentDefinition });
      if (!entry) throw new Error(`No version "${input.version}" for agent "${name}".`);
      const current = deps.agents.names().includes(name) ? deps.agents.get(name) : undefined;
      if (current) deps.versions.save('agent', name, current);
      const restored = saveAgent(deps.agentsDir, { ...entry.data, name });
      deps.changed.agent(name);
      return `Restored agent "${name}" from ${entry.at} (${entry.id}). The version it replaced is in agent_history.`;
    },
  });

  const toolHistory: ToolDefinition<any> = defineTool({
    name: 'tool_history',
    description: 'List the last 10 saved versions of a custom tool, newest first.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1), limit: z.number().int().min(1).max(10).optional() }),
    summarize: (input) => `Read history of tool ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      const versions = deps.versions.list('tool', name, input.limit ?? 10);
      return versions.length === 0 ? `No saved versions of tool "${name}" yet.` : pretty({ name, versions: versions.map(versionSummary) });
    },
  });

  const toolRestore: ToolDefinition<any> = defineTool({
    name: 'tool_restore',
    description:
      'Restore a custom tool from a saved version (tool_history). The current version is snapshotted first. Omit version to restore the newest snapshot.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1), version: z.string().optional() }),
    summarize: (input) => `Restore tool ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      const versions = deps.versions.list('tool', name, 10);
      if (versions.length === 0) throw new Error(`No saved versions of tool "${name}".`);
      const entry = input.version ? deps.versions.get<CustomToolSpec>('tool', name, input.version) : (versions[0] as { id: string; at: string; data: CustomToolSpec });
      if (!entry) throw new Error(`No version "${input.version}" for tool "${name}".`);
      const current = deps.tools.customSpecs().find((tool) => tool.name === name);
      if (current) deps.versions.save('tool', name, current);
      const restored = deps.tools.saveCustom({ ...entry.data, name });
      deps.changed.tools();
      return `Restored tool "${restored.name}" from ${entry.at} (${entry.id}). The version it replaced is in tool_history.`;
    },
  });

  const secretAudit: ToolDefinition<any> = defineTool({
    name: 'secret_audit',
    description:
      'List every {{secret.NAME}} the setup references (agent prompts, skills, custom tools, presets, workflows, MCP servers) and whether the vault has it. Missing names are the ones that will fail at run time.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      missingOnly: z.boolean().optional().describe('Only list names that are not in the vault (default true)'),
    }),
    summarize: () => 'Audit vault secret references',
    async execute(input) {
      const refs = auditSecrets({
        agents: deps.agents,
        tools: deps.tools,
        skills: deps.skills,
        workflows: deps.workflows,
        nodes: deps.nodes,
        secrets: deps.secrets,
        triggers: deps.triggers,
        triggerPool: deps.triggerPool,
        mcpServers: () => deps.tools.mcp?.views() ?? [],
      });
      const missing = refs.filter((entry) => !entry.present);
      const shown = input.missingOnly === false ? refs : missing;
      return pretty({
        vault: deps.secrets.names(),
        missing: missing.map((entry) => entry.name).filter((name, index, all) => all.indexOf(name) === index),
        references: shown,
      });
    },
  });

  const secretSet: ToolDefinition<any> = defineTool({
    name: 'secret_set',
    description:
      'Store one value in the machine\'s vault under a secret name. The value is written once and is never shown again; use the name as {{secret.NAME}} in tools, MCP servers and workflows. Ask the user to paste the value only when they are ready for it to be stored.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      name: z.string().min(1).describe('Secret name, e.g. SERPER_API_KEY'),
      value: z.string().min(1).describe('The value to store; it is hidden from permission cards and chat history'),
    }),
    summarize: (input) => `Store vault secret "${input.name}" (value hidden)`,
    redactInput: (input) => ({ ...input, value: '[redacted]' }),
    async execute(input) {
      const name = input.name.trim();
      deps.secrets.set(name, input.value);
      return `Stored secret "${name}" in the vault. Its value is never shown again; reference it as {{secret.${name}}}.`;
    },
  });

  const secretDelete: ToolDefinition<any> = defineTool({
    name: 'secret_delete',
    description: 'Remove one secret from the vault. Tools that reference it will fail until a new value is stored.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1) }),
    summarize: (input) => `Delete vault secret "${input.name}"`,
    async execute(input) {
      const name = input.name.trim();
      if (!deps.secrets.names().includes(name)) throw new Error(`No secret "${name}" in the vault.`);
      deps.secrets.remove(name);
      return `Removed secret "${name}" from the vault.`;
    },
  });

  const oauthAccounts: ToolDefinition<any> = defineTool({
    name: 'oauth_accounts',
    description: 'List the Google and Microsoft accounts with whether each is connected. Client secrets are never returned.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ service: z.enum(['google', 'microsoft']).optional() }),
    summarize: (input) => `List OAuth accounts${input.service ? ` (${input.service})` : ''}`,
    async execute(input) {
      const accounts = (deps.oauthAccounts?.() ?? []).filter((account) => !input.service || account.service === input.service);
      return accounts.length === 0 ? 'No OAuth accounts yet. Add one in Settings > Accounts first.' : pretty(accounts);
    },
  });

  const oauthStart: ToolDefinition<any> = defineTool({
    name: 'oauth_start',
    description:
      'Start the sign-in of a Google or Microsoft account and return the page the user must open. The user still types the password and approves the consent screen; when they finish, the account is connected for every tool and workflow.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      account: z.string().optional().describe('Account id or name; omit for the default account of the service'),
      service: z.enum(['google', 'microsoft']).optional().describe('Which service when no account is named'),
    }),
    summarize: (input) => `Start OAuth sign-in${input.account ? ` for ${input.account}` : input.service ? ` for ${input.service}` : ''}`,
    async execute(input) {
      if (!deps.startOAuth || !deps.oauthAccounts) throw new Error('OAuth sign-in is not available in this build.');
      const accounts = deps.oauthAccounts();
      const wanted = input.account?.trim().toLowerCase();
      const account = wanted
        ? accounts.find((entry) => entry.id.toLowerCase() === wanted || entry.name.toLowerCase() === wanted)
        : accounts.find((entry) => entry.default && (!input.service || entry.service === input.service)) ??
          accounts.find((entry) => !input.service || entry.service === input.service);
      if (!account) {
        throw new Error(
          wanted
            ? `No OAuth account "${input.account}". Call oauth_accounts to see the ids.`
            : `No ${input.service ?? 'Google or Microsoft'} account is set up. Add one in Settings > Accounts first.`,
        );
      }
      const { url } = await deps.startOAuth(account.id);
      return `Open this link, sign in as ${account.name} (${account.service}) and approve the consent screen:\n${url}\nThe account is connected automatically when the browser comes back.`;
    },
  });

  const configDiffTool: ToolDefinition<any> = defineTool({
    name: 'config_diff',
    description:
      'Show what saving a proposed agent, custom tool, preset, skill or workflow would add, remove or change, without writing anything. Use it before agent_save / tool_save / preset_save / skill_save / workflow_save.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      kind: z.enum(['agent', 'tool', 'preset', 'skill', 'workflow']),
      name: z.string().min(1).describe('The name; a workflow may be "agent/name"'),
      agent: z.string().optional().describe('The workflow owner when name has no agent/ prefix'),
      next: z.record(z.string(), z.unknown()).describe('The fields you intend to save (partial is fine)'),
    }),
    summarize: (input) => `Diff ${input.kind} ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      let current: unknown;
      let exists = false;
      let key = name;
      if (input.kind === 'agent') {
        exists = deps.agents.names().includes(name);
        current = exists ? deps.agents.get(name) : {};
      } else if (input.kind === 'tool') {
        current = deps.tools.customSpecs().find((tool) => tool.name === name);
        exists = current !== undefined;
      } else if (input.kind === 'preset') {
        current = deps.tools.presetViews().find((preset) => preset.name === name);
        exists = current !== undefined;
      } else if (input.kind === 'skill') {
        const skill = deps.skills().find((entry) => entry.name === name);
        current = skill ? skillSnapshot(skill) : {};
        exists = skill !== undefined;
      } else {
        const target = workflowTarget(deps, name, input.agent);
        key = `${target.agent}/${target.name}`;
        const workflow = deps.workflows.get(target.agent, target.name);
        current = workflow ? workflowSnapshot(workflow) : {};
        exists = workflow !== undefined;
      }
      return pretty({ kind: input.kind, name: key, exists, ...configDiff(current, input.next) });
    },
  });

  const configRollback: ToolDefinition<any> = defineTool({
    name: 'config_rollback',
    description:
      'Roll an agent, custom tool, preset, skill or workflow back to a saved version (the newest by default). The version being replaced is snapshotted first, so even a rollback can be undone.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      kind: z.enum(['agent', 'tool', 'preset', 'skill', 'workflow']),
      name: z.string().min(1).describe('The name; a workflow may be "agent/name"'),
      agent: z.string().optional().describe('The workflow owner when name has no agent/ prefix'),
      version: z.string().optional().describe('A version id from the matching history tool; omit for the newest'),
    }),
    summarize: (input) => `Roll back ${input.kind} ${input.name}`,
    async execute(input) {
      const name = input.name.trim();
      if (input.kind === 'workflow') {
        const target = workflowTarget(deps, name, input.agent);
        const key = `${target.agent}/${target.name}`;
        const versions = deps.versions.list('workflow', key, 10);
        if (versions.length === 0) throw new Error(`No saved versions of workflow "${key}".`);
        const entry = input.version ? deps.versions.get<WorkflowView>('workflow', key, input.version) : (versions[0] as { id: string; at: string; data: WorkflowView });
        if (!entry) throw new Error(`No version "${input.version}" for workflow "${key}".`);
        const current = deps.workflows.get(target.agent, target.name);
        if (current) deps.versions.save('workflow', key, workflowSnapshot(current));
        deps.workflows.save({ ...entry.data, agent: target.agent, name: target.name });
        deps.changed.workflow?.(key);
        return `Rolled workflow "${key}" back to ${entry.at} (${entry.id}).`;
      }
      const versions = deps.versions.list(input.kind, name, 10);
      if (versions.length === 0) throw new Error(`No saved versions of ${input.kind} "${name}".`);
      if (input.kind === 'agent') {
        const entry = input.version ? deps.versions.get<AgentDefinition>('agent', name, input.version) : (versions[0] as { id: string; at: string; data: AgentDefinition });
        if (!entry) throw new Error(`No version "${input.version}" for agent "${name}".`);
        const current = deps.agents.names().includes(name) ? deps.agents.get(name) : undefined;
        if (current) deps.versions.save('agent', name, current);
        saveAgent(deps.agentsDir, { ...entry.data, name });
        deps.changed.agent(name);
        return `Rolled agent "${name}" back to ${entry.at} (${entry.id}).`;
      }
      if (input.kind === 'tool') {
        const entry = input.version ? deps.versions.get<CustomToolSpec>('tool', name, input.version) : (versions[0] as { id: string; at: string; data: CustomToolSpec });
        if (!entry) throw new Error(`No version "${input.version}" for tool "${name}".`);
        const current = deps.tools.customSpecs().find((tool) => tool.name === name);
        if (current) deps.versions.save('tool', name, current);
        deps.tools.saveCustom({ ...entry.data, name });
        deps.changed.tools();
        return `Rolled tool "${name}" back to ${entry.at} (${entry.id}).`;
      }
      if (input.kind === 'preset') {
        const entry = input.version ? deps.versions.get<ToolPreset>('preset', name, input.version) : (versions[0] as { id: string; at: string; data: ToolPreset });
        if (!entry) throw new Error(`No version "${input.version}" for preset "${name}".`);
        const current = deps.tools.presetViews().find((preset) => preset.name === name);
        if (current) deps.versions.save('preset', name, current);
        deps.tools.savePreset({ ...entry.data, name });
        deps.changed.tools();
        return `Rolled preset "${name}" back to ${entry.at} (${entry.id}).`;
      }
      const entry = input.version
        ? deps.versions.get<ReturnType<typeof skillSnapshot>>('skill', name, input.version)
        : (versions[0] as { id: string; at: string; data: ReturnType<typeof skillSnapshot> });
      if (!entry) throw new Error(`No version "${input.version}" for skill "${name}".`);
      const current = deps.skills().find((skill) => skill.name === name);
      if (current && !current.builtin) deps.versions.save('skill', name, skillSnapshot(current));
      saveSkill(deps.skillsDir, { ...entry.data, name, body: String(entry.data.body ?? ''), tools: Array.isArray(entry.data.tools) ? entry.data.tools : [] });
      deps.changed.skills();
      return `Rolled skill "${name}" back to ${entry.at} (${entry.id}).`;
    },
  });

  const runLog: ToolDefinition<any> = defineTool({
    name: 'run_log',
    description:
      'Show which tools were called, how often, how slow and how often they failed over the last days, so a bad tool list or prompt can be changed with evidence.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      days: z.number().int().min(1).max(90).optional().describe('Default 7'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
      errorsOnly: z.boolean().optional().describe('Only tools that failed at least once'),
    }),
    summarize: (input) => `Read tool run log (${input.days ?? 7} days)`,
    async execute(input) {
      const stats = deps.toolStats?.(input.days ?? 7) ?? [];
      const shown = (input.errorsOnly ? stats.filter((entry) => entry.errors > 0) : stats).slice(0, input.limit ?? 50);
      return pretty({
        days: input.days ?? 7,
        tools: shown.map((entry) => ({ ...entry, errorRate: Number(entry.errorRate.toFixed(3)) })),
        recentWorkflowRuns: deps.workflowRuns.recent(10).map((run) => ({ id: run.id, workflow: run.workflow, ok: run.ok, startedAt: run.startedAt, result: clip(run.result.slice(0, 200)) })),
      });
    },
  });

  return [
    state,
    agentSchema,
    agentList,
    agentGet,
    agentSave,
    agentHistory,
    agentRestore,
    agentMessage,
    agentTest,
    toolSchema,
    toolList,
    toolGet,
    toolSave,
    toolDelete,
    toolTest,
    toolHistory,
    toolRestore,
    presetSave,
    presetDelete,
    triggerList,
    triggerGet,
    workflowRuns,
    runLog,
    secretAudit,
    secretSet,
    secretDelete,
    oauthAccounts,
    oauthStart,
    configDiffTool,
    configRollback,
    errorCodes,
    configValidate,
    nodeSchema,
    nodeList,
    nodeGet,
    nodeSave,
    nodeDelete,
    skillSchema,
    skillList,
    skillGet,
    skillSave,
    skillDelete,
  ];
}
