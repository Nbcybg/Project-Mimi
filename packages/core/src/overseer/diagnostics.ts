import type { AgentCatalog } from '../agents/loader.ts';
import { presetSecretKey, type SecretStore } from '../app/secrets.ts';
import type { TriggerStore } from '../scheduler/triggers.ts';
import { readSkillBody, type Skill } from '../skills/skills.ts';
import type { ToolPool } from '../tools/pool.ts';
import type { CustomNodeStore } from '../workflows/custom-nodes.ts';
import type { TriggerPool } from '../workflows/trigger-pool.ts';
import { validateWorkflowView } from '../workflows/validate.ts';
import type { WorkflowStore } from '../workflows/workflow-store.ts';

export interface DiagnosticsDeps {
  agents: AgentCatalog;
  tools: ToolPool;
  skills(): Skill[];
  workflows: WorkflowStore;
  nodes: CustomNodeStore;
  secrets: SecretStore;
  triggers: TriggerStore;
  triggerPool: TriggerPool;
}

export interface DiagnosticIssue {
  code: string;
  where: string;
  message: string;
}

export interface DiagnosticReport {
  ok: boolean;
  errors: DiagnosticIssue[];
  warnings: DiagnosticIssue[];
}

const secretRefs = (text: string): string[] => [...text.matchAll(/\{\{\s*secret\.([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]!);
const envRefs = (text: string): string[] => [...text.matchAll(/\{\{\s*env\.([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]!);
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A tool name is "mentioned" only as a whole word, so `web_search` does not match `search`. */
function mentionedTools(prompt: string, names: string[]): string[] {
  const found: string[] = [];
  for (const name of names) {
    // Tool ids almost always carry "_" or "-"; plain words like "reply" would match prose.
    if (name.length < 5 || name === 'use_skill' || !/[_-]/.test(name)) continue;
    const pattern = new RegExp(`(^|[^a-zA-Z0-9_])${escape(name)}([^a-zA-Z0-9_]|$)`, 'i');
    if (pattern.test(prompt)) found.push(name);
  }
  return found;
}

/**
 * Finds the leftovers that break a setup later: names that no longer exist, deleted
 * workflows/agents, missing vault entries, and prompts that talk about tools the agent
 * was never given. Nothing is changed here.
 */
export function validateConfig(deps: DiagnosticsDeps): DiagnosticReport {
  const errors: DiagnosticIssue[] = [];
  const warnings: DiagnosticIssue[] = [];
  const addError = (code: string, where: string, message: string) => errors.push({ code, where, message });
  const addWarning = (code: string, where: string, message: string) => warnings.push({ code, where, message });

  const agentNames = deps.agents.names();
  const knownAgents = new Set(agentNames);
  const skills = deps.skills();
  const knownSkills = new Set(skills.map((skill) => skill.name));
  const toolNames = deps.tools.names();
  const knownTools = new Set(toolNames);
  const secretNames = new Set(deps.secrets.names());
  const nodeNames = new Set(deps.nodes.names());

  for (const name of agentNames) {
    const agent = deps.agents.get(name);
    const where = `agent "${name}"`;
    for (const tool of agent.tools) {
      if (!knownTools.has(tool)) addError('CFG-AGENT-TOOL', where, `tool "${tool}" is not in the tool pool`);
    }
    for (const skill of agent.skills) {
      if (!knownSkills.has(skill)) addError('CFG-AGENT-SKILL', where, `skill "${skill}" does not exist`);
    }
    for (const peer of agent.canMessage) {
      if (!knownAgents.has(peer)) addError('CFG-AGENT-PEER', where, `canMessage names missing agent "${peer}"`);
    }
    for (const secret of secretRefs(agent.systemPrompt)) {
      if (!secretNames.has(secret)) addError('CFG-PROMPT-SECRET', where, `prompt uses {{secret.${secret}}} but the vault has no "${secret}"`);
      else addWarning('CFG-PROMPT-SECRET', where, `prompt contains {{secret.${secret}}}; secret values belong in tools, not prompts`);
    }
    for (const tool of mentionedTools(agent.systemPrompt, toolNames)) {
      if (!agent.tools.includes(tool)) addWarning('CFG-PROMPT-TOOL', where, `prompt mentions "${tool}" but the agent does not have that tool`);
    }
  }

  for (const skill of skills) {
    for (const tool of skill.tools) {
      if (!knownTools.has(tool)) addError('CFG-SKILL-TOOL', `skill "${skill.name}"`, `tool "${tool}" is not in the tool pool`);
    }
    const body = (() => {
      try {
        return readSkillBody(skill);
      } catch {
        return '';
      }
    })();
    for (const secret of secretRefs(body)) {
      if (!secretNames.has(secret)) addError('CFG-SKILL-SECRET', `skill "${skill.name}"`, `instructions use {{secret.${secret}}} but the vault has no "${secret}"`);
    }
  }

  for (const spec of deps.tools.customSpecs()) {
    const where = `tool "${spec.name}"`;
    const text = JSON.stringify(spec);
    for (const secret of secretRefs(text)) {
      if (!secretNames.has(secret)) addError('CFG-TOOL-SECRET', where, `uses {{secret.${secret}}} but the vault has no "${secret}"`);
    }
    for (const env of envRefs(text)) {
      if (!process.env[env]) addWarning('CFG-TOOL-ENV', where, `uses {{env.${env}}} but this process has no "${env}"`);
    }
    if (spec.kind === 'http' && !String(spec.config.url ?? '').trim()) addError('CFG-TOOL-HTTP', where, 'HTTP tool has no url');
  }

  for (const preset of deps.tools.presetViews()) {
    const where = `preset "${preset.name}"`;
    for (const secret of secretRefs(JSON.stringify(preset.settings ?? {}))) {
      if (!secretNames.has(secret)) addError('CFG-PRESET-SECRET', where, `uses {{secret.${secret}}} but the vault has no "${secret}"`);
    }
    const base = deps.tools.get(preset.tool);
    if (!base) {
      addError('CFG-PRESET-TOOL', where, `base tool "${preset.tool}" does not exist`);
      continue;
    }
    for (const field of base.settings ?? []) {
      if (field.required === false || field.default) continue;
      if (preset.settings?.[field.key] !== undefined && preset.settings[field.key] !== '') continue;
      if (field.type === 'secret' && deps.secrets.has(presetSecretKey(preset.name, field.key))) continue;
      addError('CFG-PRESET-SETTING', where, `required setting "${field.label}" is empty`);
    }
  }

  const workflows = deps.workflows.list();
  const workflowNames = (agent: string) => deps.workflows.list(agent).map((workflow) => workflow.name);
  const context = {
    hasAgent: (name: string) => knownAgents.has(name),
    hasTool: (name: string) => knownTools.has(name),
    hasTrigger: (name: string) => Boolean(deps.triggerPool.get(name)),
    workflowNames,
  };
  for (const workflow of workflows) {
    const where = `workflow "${workflow.agent}/${workflow.name}"`;
    try {
      validateWorkflowView(workflow, context);
    } catch (error) {
      addError('CFG-WORKFLOW', where, (error as Error).message);
    }
    for (const node of workflow.nodes) {
      if (node.type !== 'plugin') continue;
      const plugin = String(node.config.plugin ?? '').trim();
      if (plugin && !nodeNames.has(plugin)) addError('CFG-WORKFLOW-PLUGIN', where, `node "${node.id}" uses missing plugin "${plugin}"`);
    }
  }

  const now = Date.now();
  for (const trigger of deps.triggers.list()) {
    const where = `trigger #${trigger.id} "${trigger.title}"`;
    if (trigger.agent && !knownAgents.has(trigger.agent)) addError('CFG-TRIGGER-AGENT', where, `agent "${trigger.agent}" does not exist`);
    if (trigger.workflow && !workflows.some((workflow) => `${workflow.agent}/${workflow.name}` === trigger.workflow || workflow.name === trigger.workflow)) {
      addError('CFG-TRIGGER-WORKFLOW', where, `workflow "${trigger.workflow}" does not exist`);
    }
    if (trigger.status === 'active' && trigger.nextFireAt && new Date(trigger.nextFireAt).getTime() < now - 60_000) {
      addWarning('CFG-TRIGGER-STALE', where, `next fire time ${trigger.nextFireAt} is in the past`);
    }
    if (trigger.lastResult && /^error:/i.test(trigger.lastResult)) {
      addWarning('CFG-TRIGGER-RESULT', where, `last run failed: ${trigger.lastResult.slice(0, 200)}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
