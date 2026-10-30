import { NODE_TYPES, type CustomToolSpec, type ToolPreset } from '@mimi/shared';
import { z } from 'zod';
import { MODEL_KEYS } from '../app/app-settings.ts';
import type { AgentCatalog, AgentDefinition } from '../agents/loader.ts';
import { saveAgent } from '../agents/loader.ts';
import { checkModelNeeds, MODEL_CAPABILITY } from '../providers/model-requirements.ts';
import type { ModelService } from '../providers/routing.ts';
import { deleteSkill, readSkillBody, saveSkill, type Skill } from '../skills/skills.ts';
import type { SecretStore } from '../app/secrets.ts';
import type { ToolPool } from '../tools/pool.ts';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import type { WorkflowStore } from '../workflows/workflow-store.ts';
import { type CustomNodeSpec, type CustomNodeStore } from '../workflows/custom-nodes.ts';
import { OVERSEER_NAME } from './overseer.ts';

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
  /** The model a new agent gets when the request does not name one. */
  defaultModel(): string;
  changed: {
    agent(name: string): void;
    tools(): void;
    skills(): void;
    nodes?(): void;
  };
}

const MAX_OUTPUT = 30_000;
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
  addTools: z.array(z.string()).optional(),
  removeTools: z.array(z.string()).optional(),
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

function agentSummary(deps: OverseerToolDeps, name: string) {
  const agent = deps.agents.get(name);
  return {
    name: agent.name,
    displayName: agent.displayName || agent.name,
    description: agent.description,
    model: agent.models.model ?? null,
    tools: agent.tools,
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
        nodeTypes: NODE_TYPES.map((node) => ({ type: node.type, label: node.label })),
        customNodes: deps.nodes.list().map((node) => ({ name: node.name, label: node.label, description: node.description })),
        secrets: deps.secrets.names(),
        rules: {
          reservedAgent: OVERSEER_NAME,
          drive: 'Google Drive is read-only here (drive_search). Writing/uploading needs a new OAuth scope and the user\'s consent.',
          workflows: 'Workflows are always saved disabled; the user enables them.',
          secrets: 'Only names are shown. Put values in the vault; use {{secret.NAME}} in tools.',
          nodes: 'Custom nodes are files under user/nodes and run in the workflow sandbox via the "plugin" node. Create them with node_save; they may read items and $config and must return items. Never put secrets in a custom node.',
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
      if (name === OVERSEER_NAME) throw new Error('"overseer" is reserved for the AI Overseer.');
      const exists = deps.agents.names().includes(name);
      const current = exists ? deps.agents.get(name) : undefined;
      if (!exists && !input.systemPrompt?.trim()) throw new Error('A new agent needs a systemPrompt.');

      const tools = applyList(current?.tools ?? [], input.tools, input.addTools, input.removeTools);
      deps.tools.select(tools);

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
      saveAgent(deps.agentsDir, agent);
      deps.changed.agent(name);
      return `Saved agent "${name}" (${agent.tools.length} tools, ${agent.skills.length} skills, model ${agent.models.model}).`;
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
        storage: 'user/nodes/<name>.json; the workflow editor lists it in the "plugin" node',
        fields: {
          name: 'lowercase letters, digits, "-" or "_"',
          label: 'shown in the workflow editor',
          description: 'what it does; the model and the user read it',
          code: 'JavaScript body; items and $config are in scope; return an array of JSON objects or one object',
          timeoutMs: 'optional, 1000-120000',
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
          'Use a workflow "plugin" node and choose this custom node by name.',
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

  return [
    state,
    agentSchema,
    agentList,
    agentGet,
    agentSave,
    toolSchema,
    toolList,
    toolGet,
    toolSave,
    toolDelete,
    presetSave,
    presetDelete,
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
