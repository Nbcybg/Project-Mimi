import { AsyncLocalStorage } from 'node:async_hooks';
import type { FlowItem, JsonValue, WorkflowRunResult, WorkflowView } from '@mimi/shared';
import { z } from 'zod';
import { defineTool, type ToolContext, type ToolDefinition } from '../tools/registry.ts';

/**
 * Workflows an agent can call like any other tool. The workflow's "agent tool" trigger says
 * when to use it (the tool's description) and what to pass (its inputs); the agent decides
 * from that, the way it picks web_search or send_to. The run lands in the history as usual.
 */

export interface ToolInput {
  name: string;
  type: 'string' | 'number' | 'boolean';
  optional: boolean;
  description: string;
}

const MAX_RESULT_CHARS = 4000;

/**
 * Reads the trigger's input list: one per line, `name: description`; `name?` is optional,
 * `name (number)` / `name (boolean)` set the type. Lines that are not a name are skipped.
 */
export function parseToolInputs(text: string): ToolInput[] {
  const inputs: ToolInput[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)(\?)?\s*(?:\((string|number|boolean)\))?\s*(\?)?\s*(?::\s*(.*))?$/.exec(line);
    if (!match || inputs.some((input) => input.name === match[1])) continue;
    inputs.push({
      name: match[1]!,
      type: (match[3] as ToolInput['type'] | undefined) ?? 'string',
      optional: Boolean(match[2] || match[4]),
      description: (match[5] ?? '').trim(),
    });
  }
  return inputs;
}

/** The tool name of a workflow: `workflow_<name>`, inside the 64 characters providers allow. */
export function workflowToolName(workflow: Pick<WorkflowView, 'name'>): string {
  return `workflow_${workflow.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
}

/** Who may call a tool workflow: its owner and the agents its trigger lists. */
export function workflowToolCallers(workflow: WorkflowView): string[] {
  const listed = String((workflow.trigger.config as Record<string, unknown>).agents ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  return [...new Set([workflow.agent, ...listed])];
}

/** What the agent gets back: the respond node's body, else what the last node put out. */
export function workflowToolResult(workflow: WorkflowView, outcome: WorkflowRunResult): string {
  if (outcome.suspended) {
    return outcome.suspended.kind === 'approval'
      ? `Workflow "${workflow.title || workflow.name}" is waiting for the user's approval in the chat; it finishes by itself afterwards. Tell the user.`
      : `Workflow "${workflow.title || workflow.name}" is waiting until ${outcome.suspended.resumeAt ?? 'later'}; it finishes by itself.`;
  }
  let value: unknown;
  if (outcome.response) value = outcome.response.body;
  else {
    const last = [...outcome.nodes].reverse().find((view) => view.status === 'ok' && !view.note);
    const items = last?.output ?? [];
    value = items.length === 1 ? items[0]!.json : items.map((item) => item.json);
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const cut = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [cut: ${text.length - MAX_RESULT_CHARS} more characters]` : text;
  return `Workflow "${workflow.title || workflow.name}" finished. Result:\n${cut}`;
}

/** How many tool workflows may run inside one another (agent -> workflow -> agent -> workflow ...). */
const MAX_NESTING = 3;

/** The tool workflows the current call runs inside of; follows the async chain, not other chats. */
const chain = new AsyncLocalStorage<string[]>();

/** One tool per workflow; `run` starts the workflow with the agent's values as its item. */
export function createWorkflowTool(
  workflow: WorkflowView,
  run: (items: FlowItem[], context: ToolContext) => Promise<WorkflowRunResult>,
): ToolDefinition<Record<string, JsonValue>> {
  const config = workflow.trigger.config as Record<string, unknown>;
  const inputs = parseToolInputs(String(config.inputs ?? ''));
  const shape: Record<string, z.ZodType> = {};
  for (const input of inputs) {
    const base = input.type === 'number' ? z.number() : input.type === 'boolean' ? z.boolean() : z.string();
    const described = input.description ? base.describe(input.description) : base;
    shape[input.name] = input.optional ? described.optional() : described;
  }
  const when = String(config.when ?? '').trim() || workflow.description || workflow.title || workflow.name;
  const id = `${workflow.agent}/${workflow.name}`;
  return defineTool({
    name: workflowToolName(workflow),
    description: `Workflow "${workflow.title || workflow.name}": ${when}`,
    // "ask" (the default) puts the run behind the permission prompt; "no" runs it straight away.
    risk: String(config.ask ?? 'ask') === 'no' ? 'read' : 'write',
    target: 'core',
    inputSchema: z.object(shape) as unknown as z.ZodType<Record<string, JsonValue>>,
    summarize: (input) => `Run workflow ${workflow.title || workflow.name} ${JSON.stringify(input).slice(0, 160)}`,
    async execute(input, context) {
      const outer = chain.getStore() ?? [];
      if (outer.includes(id)) throw new Error(`Workflow "${workflow.name}" is already running and would call itself; not run again.`);
      if (outer.length >= MAX_NESTING) throw new Error(`Workflows are nested ${MAX_NESTING} deep already; not running "${workflow.name}".`);
      const outcome = await chain.run([...outer, id], () => run([{ json: { ...input, agent: context.agent } }], context));
      if (!outcome.ok && !outcome.suspended) throw new Error(`Workflow "${workflow.title || workflow.name}" failed: ${outcome.result}`);
      return workflowToolResult(workflow, outcome);
    },
  });
}
