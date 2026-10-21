import { isTriggerNodeType, NODE_TYPES, type JsonValue, type WorkflowRunResult, type WorkflowView } from '@mimi/shared';
import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import type { TriggerPool } from './trigger-pool.ts';
import { checkWorkflowData, type WorkflowStore } from './workflow-store.ts';
import { validateWorkflowView } from './validate.ts';

/**
 * Workflow authoring for agents. Save always lands disabled: the user reviews the graph
 * (code / tool / HTTP nodes can do real work) and enables it in the editor.
 */
export interface WorkflowAuthorDeps {
  /** The agent the tools are bound to. Without `allowTarget` it only sees its own workflows. */
  agent: string;
  /** The caller may name another agent in the optional `agent` input (the Overseer does this). */
  allowTarget?: boolean;
  workflows: WorkflowStore;
  triggerPool: TriggerPool;
  hasAgent(name: string): boolean;
  hasTool(name: string): boolean;
  agentNames(): string[];
  tools(): Array<{ name: string; description: string; risk: string }>;
  run(name: string, input?: JsonValue): Promise<WorkflowRunResult>;
  /** Runs another agent's workflow; required when `allowTarget` is set. */
  runFor?: (agent: string, name: string, input?: JsonValue) => Promise<WorkflowRunResult>;
  changed(id?: string): void;
}

const workflowInput = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  trigger: z.object({
    pool: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
  nodes: z.array(z.record(z.string(), z.unknown())).min(1),
  vars: z.record(z.string(), z.unknown()).optional(),
  errorWorkflow: z.string().optional(),
  notes: z.array(z.record(z.string(), z.unknown())).optional(),
});

type WorkflowInput = z.infer<typeof workflowInput>;

const agentInput = z.string().min(1).optional().describe('The agent that owns the workflow. Omit for the calling agent; only the Overseer may name another agent.');

const MAX_SCHEMA_CHARS = 48_000;
const MAX_VIEW_CHARS = 30_000;
const MAX_RESULT_CHARS = 8_000;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… [cut: ${text.length - limit} more characters]`;
}

function pretty(value: unknown, limit = MAX_VIEW_CHARS): string {
  return clip(JSON.stringify(value, null, 2), limit);
}

function asWorkflow(input: WorkflowInput | string): WorkflowInput {
  if (typeof input !== 'string') return input;
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch (error) {
    throw new Error(`The workflow is not valid JSON: ${(error as Error).message}`);
  }
  return workflowInput.parse(raw);
}

function ownerOf(deps: WorkflowAuthorDeps, requested?: string): string {
  const name = requested?.trim() || deps.agent;
  if (name === deps.agent) return name;
  if (!deps.allowTarget) throw new Error('Workflow tools can only change workflows of the agent that called them.');
  if (!deps.hasAgent(name)) throw new Error(`Unknown agent "${name}".`);
  return name;
}

function ownWorkflow(deps: WorkflowAuthorDeps, name: string, agent = deps.agent): WorkflowView {
  const workflow = deps.workflows.get(agent, name.trim());
  if (!workflow) throw new Error(`No workflow "${name}" for agent "${agent}".`);
  return workflow;
}

function saveView(deps: WorkflowAuthorDeps, input: WorkflowInput | string, agent: string): string {
  const draft = asWorkflow(input);
  const view = {
    ...draft,
    agent,
    // Agent writes never enable a workflow. The user turns it on after reviewing it.
    enabled: false,
    trigger: { pool: draft.trigger.pool, config: draft.trigger.config ?? {} },
    nodes: draft.nodes,
  } as unknown as WorkflowView;
  checkWorkflowData(view);
  validateWorkflowView(view, {
    hasAgent: deps.hasAgent,
    hasTool: deps.hasTool,
    hasTrigger: (pool) => deps.triggerPool.get(pool) !== undefined,
    workflowNames: (agent) => deps.workflows.names(agent),
  });
  const saved = deps.workflows.save(view);
  deps.changed(`${saved.agent}/${saved.name}`);
  return `Saved workflow "${saved.name}" for agent "${saved.agent}" (${saved.nodes.length} nodes). It is disabled until the user reviews and enables it in Workflows.`;
}

/** Tools an agent uses to inspect, write and test its own workflows. */
export function createWorkflowAuthorTools(deps: WorkflowAuthorDeps): ToolDefinition<any>[] {
  const schema: ToolDefinition<any> = defineTool({
    name: 'workflow_schema',
    description:
      'Show the workflow format: trigger types, every node type with its fields and outputs, expression rules and a small example. Call this before writing a workflow.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      nodeType: z.string().optional().describe('Only show this node type'),
      trigger: z.string().optional().describe('Only show this trigger type'),
    }),
    summarize: (input) => `Read workflow schema${input.nodeType ? ` for node ${input.nodeType}` : ''}`,
    async execute(input) {
      const triggers = deps.triggerPool.list().filter((entry) => !input.trigger || entry.name === input.trigger);
      // Trigger nodes reuse the trigger schema above; including them twice doubles the
      // size and pushes the tools list past the clip.
      const nodes = NODE_TYPES.filter(
        (entry) => (!input.nodeType || entry.type === input.nodeType) && (!isTriggerNodeType(entry.type) || entry.type === input.nodeType),
      );
      return pretty(
        {
          triggers,
          nodeTypes: nodes,
          agents: deps.agentNames(),
          tools: deps.tools().map((tool) => ({
            name: tool.name,
            risk: tool.risk,
            description: tool.description.split('. ')[0],
          })),
          rules: {
            workflow: 'name: lowercase letters/digits/_-; title required; at least one node; node ids unique and lowercase.',
            links: 'Each node links outputs to node ids, e.g. {"main":["next"]}; if/switch use true/false/case0/fallback; links must not point at unknown or unreachable nodes.',
            expressions: 'Strings may use {{ $json.field }}, {{ $node["Title"].json.field }}, {{ $trigger.json.field }}, {{ $vars.name }}, {{ $execution.id }}, {{ $today }}, {{ $now }}.',
            trigger: 'Pick a trigger from the trigger list and put its settings in trigger.config. A manual trigger is best for testing.',
            safety: 'Saved workflows are always disabled. Use workflow_run to test; the user must review and enable it.',
          },
          example: {
            name: 'daily-summary',
            title: 'Daily summary',
            description: 'Fetch a report and send it to the chat.',
            trigger: { pool: 'schedule', config: { cron: '0 8 * * *' } },
            nodes: [
              { id: 'get', type: 'http', title: 'Get report', config: { method: 'GET', url: 'https://example.com/report.json' }, links: { main: ['send'] } },
              { id: 'send', type: 'chat', title: 'Send summary', config: { text: '{{ $json.summary }}' }, links: { main: [] } },
            ],
          },
        },
        MAX_SCHEMA_CHARS,
      );
    },
  });

  const list: ToolDefinition<any> = defineTool({
    name: 'workflow_list',
    description: 'List your workflows with their trigger, enabled state and node count. Use workflow_get for the full graph.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ agent: agentInput }),
    summarize: () => 'List workflows',
    async execute(input) {
      const agent = ownerOf(deps, input.agent);
      const workflows = deps.workflows.list(agent).map((workflow) => ({
        name: workflow.name,
        title: workflow.title,
        description: workflow.description,
        enabled: workflow.enabled,
        trigger: workflow.trigger,
        errorWorkflow: workflow.errorWorkflow ?? null,
        nodes: workflow.nodes.map((node) => ({ id: node.id, type: node.type, title: node.title ?? null })),
      }));
      return workflows.length === 0 ? `No workflows for agent "${agent}".` : pretty(workflows);
    },
  });

  const get: ToolDefinition<any> = defineTool({
    name: 'workflow_get',
    description: 'Read one workflow in full, including nodes, links and trigger settings.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1), agent: agentInput }),
    summarize: (input) => `Read workflow ${input.name}`,
    async execute(input) {
      return pretty(ownWorkflow(deps, input.name, ownerOf(deps, input.agent)));
    },
  });

  const validate: ToolDefinition<any> = defineTool({
    name: 'workflow_validate',
    description: 'Check a workflow draft without saving it. Returns the validation error, or says it is valid.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ workflow: z.union([workflowInput, z.string()]), agent: agentInput }),
    summarize: () => 'Validate a workflow draft',
    async execute(input) {
      const draft = asWorkflow(input.workflow);
      const view = {
        ...draft,
        agent: ownerOf(deps, input.agent),
        enabled: false,
        trigger: { pool: draft.trigger.pool, config: draft.trigger.config ?? {} },
        nodes: draft.nodes,
      } as unknown as WorkflowView;
      checkWorkflowData(view);
      validateWorkflowView(view, {
        hasAgent: deps.hasAgent,
        hasTool: deps.hasTool,
        hasTrigger: (pool) => deps.triggerPool.get(pool) !== undefined,
        workflowNames: (agent) => deps.workflows.names(agent),
      });
      return `The workflow is valid. It would be saved disabled, with ${draft.nodes.length} nodes.`;
    },
  });

  const save: ToolDefinition<any> = defineTool({
    name: 'workflow_save',
    description:
      'Create or replace a workflow. Always saves disabled; the user enables it after reviewing. Include every node and link in the full workflow object.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ workflow: z.union([workflowInput, z.string()]), agent: agentInput }),
    summarize: (input) => {
      try {
        const draft = asWorkflow(input.workflow);
        return `Save workflow ${draft.name} (${draft.nodes.length} nodes)`;
      } catch {
        return 'Save a workflow';
      }
    },
    async execute(input) {
      return saveView(deps, input.workflow, ownerOf(deps, input.agent));
    },
  });

  const remove: ToolDefinition<any> = defineTool({
    name: 'workflow_delete',
    description: 'Delete a workflow after the user approves the request.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1), agent: agentInput }),
    summarize: (input) => `Delete workflow ${input.name}`,
    async execute(input) {
      const agent = ownerOf(deps, input.agent);
      ownWorkflow(deps, input.name, agent);
      if (!deps.workflows.delete(agent, input.name.trim())) throw new Error(`No workflow "${input.name}".`);
      deps.changed(`${agent}/${input.name.trim()}`);
      return `Deleted workflow "${input.name}".`;
    },
  });

  const run: ToolDefinition<any> = defineTool({
    name: 'workflow_run',
    description: 'Run one of your workflows now with optional input JSON, and return what it produced. Use this to test before asking the user to enable it.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      name: z.string().min(1),
      agent: agentInput,
      input: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
    }),
    summarize: (input) => `Run workflow ${input.name}`,
    async execute(input) {
      const agent = ownerOf(deps, input.agent);
      ownWorkflow(deps, input.name, agent);
      let value: JsonValue | undefined;
      if (input.input !== undefined) {
        if (typeof input.input === 'string') {
          try {
            value = JSON.parse(input.input) as JsonValue;
          } catch (error) {
            throw new Error(`input is not valid JSON: ${(error as Error).message}`);
          }
        } else value = input.input as JsonValue;
      }
      const outcome =
        agent === deps.agent
          ? await deps.run(input.name.trim(), value)
          : deps.runFor
            ? await deps.runFor(agent, input.name.trim(), value)
            : (() => {
                throw new Error(`These workflow tools cannot run agent "${agent}" workflows.`);
              })();
      return pretty(
        {
          ok: outcome.ok,
          runId: outcome.runId ?? null,
          suspended: outcome.suspended ?? null,
          result: outcome.result,
          errors: outcome.nodes.filter((node) => node.status === 'error').map((node) => ({ id: node.id, title: node.title, error: node.error })),
        },
        MAX_RESULT_CHARS,
      );
    },
  });

  return [schema, list, get, validate, save, remove, run];
}
