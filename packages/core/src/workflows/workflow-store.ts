import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isTriggerNodeType, triggerPoolOfNodeConfig, type WorkflowNode, type WorkflowTriggerRef, type WorkflowView } from '@mimi/shared';
import { z } from 'zod';

export const WORKFLOW_NAME = /^[a-z][a-z0-9_-]*$/;
export const AGENT_NAME = /^[a-z][a-z0-9_-]*$/;
export const NODE_ID = /^[a-z0-9][a-z0-9_-]*$/;

const NODE_TYPES = [
  'agent',
  'chat',
  'if',
  'switch',
  'set',
  'code',
  'http',
  'tool',
  'connector',
  'filter',
  'sort',
  'limit',
  'aggregate',
  'remove_duplicates',
  'merge',
  'wait',
  'stop',
  'workflow',
  'respond',
  'llm',
  'classify',
  'extract',
  'split_out',
  'loop',
  'approval',
  'telegram',
  'datetime',
  'file',
  'extract_file',
  'knowledge',
  'sheets',
  'trigger_manual',
  'trigger_schedule',
  'trigger_webhook',
  'trigger_form',
  'trigger_mail',
  'trigger_poll',
  'trigger_chat',
  'trigger_telegram',
  'trigger_tool',
  'trigger_custom',
] as const;

const nodeSchema = z.strictObject({
  id: z.string().regex(NODE_ID, 'lowercase letters, digits, "-" or "_"'),
  type: z.enum(NODE_TYPES),
  title: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  links: z.record(z.string(), z.array(z.string())).default({ main: [] }),
  onError: z.enum(['stop', 'continue', 'branch']).optional(),
  retries: z.number().int().nonnegative().optional(),
  retryWaitMs: z.number().int().nonnegative().optional(),
  position: z.tuple([z.number(), z.number()]).optional(),
  disabled: z.boolean().optional(),
  pinned: z.array(z.record(z.string(), z.unknown())).max(500, 'pin at most 500 items').optional(),
});

const noteSchema = z.strictObject({
  id: z.string().regex(NODE_ID),
  text: z.string().max(5000),
  position: z.tuple([z.number(), z.number()]),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  color: z.string().max(20).optional(),
});

/** The trigger node is the source of truth once a workflow has one; old files keep `trigger`. */
function derivedTrigger(nodes: unknown, fallback: unknown): WorkflowTriggerRef | undefined {
  if (Array.isArray(nodes)) {
    const node = nodes.find(
      (entry) => entry && typeof entry === 'object' && isTriggerNodeType(String((entry as { type?: unknown }).type ?? '')),
    ) as { type?: unknown; config?: unknown } | undefined;
    const pool = node
      ? triggerPoolOfNodeConfig({ type: String(node.type ?? ''), config: (node.config && typeof node.config === 'object' ? node.config : {}) as WorkflowNode['config'] })
      : undefined;
    if (node && pool) {
      const config = { ...((node.config && typeof node.config === 'object' ? node.config : {}) as WorkflowTriggerRef['config']) };
      if (node.type === 'trigger_custom') delete config.pool;
      return { pool, config };
    }
  }
  return fallback as WorkflowTriggerRef | undefined;
}

const workflowSchema = z.strictObject({
  name: z.string().regex(WORKFLOW_NAME, 'lowercase letters, digits, "-" or "_"'),
  agent: z.string().regex(AGENT_NAME),
  title: z.string().min(1),
  description: z.string().default(''),
  enabled: z.boolean().default(true),
  trigger: z.strictObject({ pool: z.string().min(1), config: z.record(z.string(), z.unknown()).default({}) }),
  webhookKey: z.string().nullable().optional(),
  vars: z.record(z.string(), z.unknown()).default({}),
  errorWorkflow: z.string().optional(),
  nodes: z.array(nodeSchema).min(1, 'a workflow needs at least one node'),
  notes: z.array(noteSchema).max(100).optional(),
  triggerPosition: z.tuple([z.number(), z.number()]).optional(),
});

export interface StoredWorkflow extends WorkflowView {
  webhookKey: string | null;
}

/** Checks the shape and graph without writing anything (used by the editor and agent drafts). */
export function checkWorkflowData(view: WorkflowView): void {
  const triggerNodes = view.nodes.filter((node) => isTriggerNodeType(node.type));
  if (triggerNodes.length > 1) throw new Error(`workflow "${view.name}": only one trigger node is allowed.`);
  const trigger = derivedTrigger(view.nodes, view.trigger) ?? view.trigger;
  const { webhook: _derived, ...rest } = { ...view, trigger };
  const parsed = workflowSchema.safeParse({ ...rest, webhookKey: null });
  if (!parsed.success) throw new Error(`workflow "${view.name}":\n${z.prettifyError(parsed.error)}`);
  checkGraph(parsed.data.nodes as WorkflowNode[], `workflow "${view.name}"`);
}

/** Nodes that nothing links into are the starts; the rest must be reachable from them. */
export function checkGraph(nodes: WorkflowNode[], origin: string): void {
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) throw new Error(`${origin}: duplicate node ids.`);
  for (const node of nodes) {
    for (const targets of Object.values(node.links ?? {})) {
      for (const target of targets) {
        if (!ids.has(target)) throw new Error(`${origin}: node "${node.id}" points at unknown node "${target}".`);
      }
    }
  }
  const reached = new Set<string>();
  const walk = (id: string, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    reached.add(id);
    const node = nodes.find((entry) => entry.id === id);
    for (const targets of Object.values(node?.links ?? {})) for (const target of targets) walk(target, seen);
  };
  const linkedIn = new Set(Object.values(nodes.flatMap((node) => Object.values(node.links ?? {}))).flat());
  for (const node of nodes) {
    if (!linkedIn.has(node.id)) walk(node.id, new Set());
  }
  const orphan = nodes.find((node) => !reached.has(node.id));
  if (orphan) throw new Error(`${origin}: node "${orphan.id}" is not reachable from any start; link it or delete it.`);
}

/**
 * Workflows on disk, one folder per agent: `workflows/<agent>/<name>.json`. A workflow
 * is the agent's own automation: a trigger from the trigger pool feeds a small flow of
 * nodes, each written in n8n's style (items of JSON, `{{ $json.x }}` expressions).
 */
export class WorkflowStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  agents(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && AGENT_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  names(agent: string): string[] {
    const folder = path.join(this.dir, agent);
    if (!AGENT_NAME.test(agent) || !fs.existsSync(folder)) return [];
    return fs
      .readdirSync(folder)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -5))
      .filter((name) => WORKFLOW_NAME.test(name))
      .sort();
  }

  get(agent: string, name: string): StoredWorkflow | undefined {
    if (!AGENT_NAME.test(agent) || !WORKFLOW_NAME.test(name)) return undefined;
    const file = path.join(this.dir, agent, `${name}.json`);
    if (!fs.existsSync(file)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`${file}: not valid JSON: ${(error as Error).message}`);
    }
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    const trigger = record ? derivedTrigger(record.nodes, record.trigger) : undefined;
    const parsed = workflowSchema.safeParse(record && trigger ? { ...record, trigger } : raw);
    if (!parsed.success) throw new Error(`${file}: invalid workflow:\n${z.prettifyError(parsed.error)}`);
    const stored = parsed.data as StoredWorkflow;
    return { ...stored, webhook: stored.webhookKey ? `/api/workflow/${stored.webhookKey}` : null };
  }

  list(agent?: string): StoredWorkflow[] {
    const agents = agent ? [agent] : this.agents();
    return agents.flatMap((name) =>
      this.names(name)
        .map((workflowName) => this.get(name, workflowName))
        .filter((workflow): workflow is StoredWorkflow => workflow !== undefined),
    );
  }

  byWebhookKey(key: string): StoredWorkflow | undefined {
    if (!key || key.length > 200) return undefined;
    return this.list().find((workflow) => workflow.webhookKey === key);
  }

  save(view: WorkflowView, renameFrom?: string): StoredWorkflow {
    if (!AGENT_NAME.test(view.agent)) throw new Error(`Invalid agent "${view.agent}".`);
    if (view.nodes.filter((node) => isTriggerNodeType(node.type)).length > 1) {
      throw new Error(`workflow "${view.name}": only one trigger node is allowed.`);
    }
    const keeping = this.get(view.agent, view.name)?.webhookKey;
    const webhookKey = keeping ?? randomBytes(18).toString('base64url');
    const trigger = derivedTrigger(view.nodes, view.trigger) ?? view.trigger;
    const { webhook: _derived, ...rest } = { ...view, trigger };
    const parsed = workflowSchema.safeParse({ ...rest, webhookKey: webhookKey });
    if (!parsed.success) throw new Error(`workflow "${view.name}":\n${z.prettifyError(parsed.error)}`);
    checkGraph(parsed.data.nodes as WorkflowNode[], `workflow "${view.name}"`);
    if (renameFrom && renameFrom !== view.name) this.delete(view.agent, renameFrom);
    const folder = path.join(this.dir, view.agent);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${parsed.data.name}.json`), `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
    const stored = parsed.data as StoredWorkflow;
    return { ...stored, webhook: stored.webhookKey ? `/api/workflow/${stored.webhookKey}` : null };
  }

  delete(agent: string, name: string): boolean {
    const file = path.join(this.dir, agent, `${name}.json`);
    if (!AGENT_NAME.test(agent) || !WORKFLOW_NAME.test(name) || !fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  /** Deletes every workflow of an agent and returns their names (agent deletion). */
  forgetAgent(agent: string): string[] {
    const names = this.names(agent);
    for (const name of names) this.delete(agent, name);
    const folder = path.join(this.dir, agent);
    try {
      fs.rmdirSync(folder);
    } catch {
      // not empty (or not there): leave it
    }
    return names;
  }
}
