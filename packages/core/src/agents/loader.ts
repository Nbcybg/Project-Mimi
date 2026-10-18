import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { REASONING_EFFORTS, type ReasoningEffort } from '@mimi/shared';
import type { ModelSelection } from '../providers/routing.ts';
import { modelRefString } from '../providers/settings.ts';

const agentName = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase letters, digits, "-" or "_"');
const AGENT_NAME = /^[a-z][a-z0-9_-]*$/;
/** Every agent is a folder of its own: the definition sits in `agent.md`. */
export const AGENT_FILE = 'agent.md';

const FrontmatterSchema = z.strictObject({
  name: agentName,
  /** The name shown in chats; the file name stays the id. */
  display_name: z.string().default(''),
  description: z.string().default(''),
  /** What the other agents are told about this one (personality, how to work with it). */
  intro: z.string().default(''),
  /** Reasoning effort of its chat model; overrides the preset's. */
  effort: z.enum(REASONING_EFFORTS).optional(),
  // Same keys as the settings file; each one overrides it for this agent only.
  model: modelRefString.optional(),
  small_model: modelRefString.optional(),
  vision_model: modelRefString.optional(),
  transcript_model: modelRefString.optional(),
  tools: z.array(z.string()).default([]),
  /** Skills from the skill hub this agent may use. */
  skills: z.array(z.string()).default([]),
  can_message: z.array(agentName).default([]),
  budgets: z
    .strictObject({
      max_rounds: z.number().int().positive().default(12),
      max_tokens: z.number().int().positive().default(200_000),
    })
    .prefault({}),
});

export interface AgentDefinition {
  name: string;
  displayName: string;
  description: string;
  /** Card the other agents see: personality, strengths, how to work with it. */
  intro?: string;
  /** Reasoning effort for its chat model; unset = the preset's or the provider's default. */
  effort?: ReasoningEffort;
  models: ModelSelection;
  tools: string[];
  skills: string[];
  /** Agents this one is allowed to message. */
  canMessage: string[];
  budgets: { maxRounds: number; maxTokens: number };
  systemPrompt: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Parses an `agents/<name>/agent.md` file: YAML frontmatter + system prompt body. */
export function parseAgentFile(source: string, origin = 'agent file'): AgentDefinition {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error(`${origin}: missing "---" frontmatter block`);

  let raw: unknown;
  try {
    raw = parseYaml(match[1]!);
  } catch (error) {
    throw new Error(`${origin}: invalid YAML frontmatter: ${(error as Error).message}`);
  }
  const parsed = FrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${origin}: invalid frontmatter:\n${z.prettifyError(parsed.error)}`);
  }

  const systemPrompt = source.slice(match[0].length).trim();
  if (!systemPrompt) throw new Error(`${origin}: system prompt body is empty`);

  const { name, display_name, description, intro, effort, tools, skills, can_message, budgets, ...models } = parsed.data;
  return {
    name,
    displayName: display_name,
    description,
    ...(intro ? { intro } : {}),
    ...(effort ? { effort } : {}),
    models,
    tools,
    skills,
    canMessage: can_message,
    budgets: { maxRounds: budgets.max_rounds, maxTokens: budgets.max_tokens },
    systemPrompt,
  };
}

export function agentFile(agentsDir: string, name: string): string {
  return path.join(agentsDir, name, AGENT_FILE);
}

export function loadAgent(agentsDir: string, name: string): AgentDefinition {
  const file = agentFile(agentsDir, name);
  if (!AGENT_NAME.test(name) || !fs.existsSync(file)) {
    throw new Error(`Unknown agent "${name}" (no ${file}). Available: ${listAgents(agentsDir).join(', ') || 'none'}`);
  }
  const agent = parseAgentFile(fs.readFileSync(file, 'utf8'), file);
  if (agent.name !== name) {
    throw new Error(`${file}: frontmatter name "${agent.name}" must match the folder name`);
  }
  return agent;
}

export function listAgents(agentsDir: string): string[] {
  if (!fs.existsSync(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && AGENT_NAME.test(entry.name))
    .filter((entry) => fs.existsSync(path.join(agentsDir, entry.name, AGENT_FILE)))
    .map((entry) => entry.name)
    .sort();
}

/** Looks agents up by name. Files are read on every call, so edits apply to the next run. */
export class AgentCatalog {
  private readonly agentsDir: string;
  private readonly modelOverrides: () => Record<string, string>;

  /** `modelOverrides` maps agent name -> chat model chosen in the app; it beats the agent file. */
  constructor(agentsDir: string, modelOverrides: () => Record<string, string> = () => ({})) {
    this.agentsDir = agentsDir;
    this.modelOverrides = modelOverrides;
  }

  get(name: string): AgentDefinition {
    const agent = loadAgent(this.agentsDir, name);
    const model = this.modelOverrides()[name];
    return model ? { ...agent, models: { ...agent.models, model } } : agent;
  }

  names(): string[] {
    return listAgents(this.agentsDir);
  }

  list(): Array<{ name: string; displayName: string; description: string }> {
    return this.names().map((name) => {
      const agent = this.get(name);
      return { name: agent.name, displayName: agent.displayName || agent.name, description: agent.description };
    });
  }
}

/** Renders an agent definition back into the `agents/<name>/agent.md` format. */
export function serializeAgent(agent: AgentDefinition): string {
  const frontmatter: Record<string, unknown> = { name: agent.name };
  if (agent.displayName) frontmatter.display_name = agent.displayName;
  if (agent.description) frontmatter.description = agent.description;
  if (agent.intro) frontmatter.intro = agent.intro;
  if (agent.effort) frontmatter.effort = agent.effort;
  // One model per capability; a capability left out falls back to the global default.
  for (const key of ['model', 'small_model', 'vision_model', 'transcript_model'] as const) {
    if (agent.models[key]) frontmatter[key] = agent.models[key];
  }
  frontmatter.tools = agent.tools;
  if (agent.skills.length > 0) frontmatter.skills = agent.skills;
  frontmatter.can_message = agent.canMessage;
  frontmatter.budgets = { max_rounds: agent.budgets.maxRounds, max_tokens: agent.budgets.maxTokens };
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${agent.systemPrompt.trim()}\n`;
}

/** Writes an agent file. The definition is re-parsed first, so an invalid one never reaches disk. */
export function saveAgent(agentsDir: string, agent: AgentDefinition): AgentDefinition {
  const source = serializeAgent(agent);
  const parsed = parseAgentFile(source, `agent "${agent.name}"`);
  fs.mkdirSync(path.join(agentsDir, parsed.name), { recursive: true });
  fs.writeFileSync(agentFile(agentsDir, parsed.name), source, 'utf8');
  return parsed;
}

/** Deletes an agent folder and removes the agent from every other agent's `can_message`. */
export function deleteAgent(agentsDir: string, name: string): boolean {
  const folder = path.join(agentsDir, name);
  if (!AGENT_NAME.test(name) || !fs.existsSync(path.join(folder, AGENT_FILE))) return false;
  fs.rmSync(folder, { recursive: true, force: true });
  for (const other of listAgents(agentsDir)) {
    const agent = loadAgent(agentsDir, other);
    if (agent.canMessage.includes(name)) {
      saveAgent(agentsDir, { ...agent, canMessage: agent.canMessage.filter((peer) => peer !== name) });
    }
  }
  return true;
}
