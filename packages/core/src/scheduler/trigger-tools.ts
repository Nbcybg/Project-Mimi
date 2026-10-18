import { z } from 'zod';
import type { AgentCatalog } from '../agents/loader.ts';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import type { Trigger, TriggerStore } from './triggers.ts';

const SCHEDULE_HELP =
  'Give exactly one of fire_at (one-shot local date-time like 2026-10-13T09:00:00), cron (recurring, e.g. "0 8 * * 1-5" for weekdays at 08:00), or webhook: true for a trigger that fires when an HTTP service calls its URL.';

function describe(trigger: Trigger): string {
  const when = trigger.webhook
    ? `on webhook ${trigger.webhook}`
    : trigger.cron
      ? `cron "${trigger.cron}"${trigger.repeat ? '' : ' (once)'}`
      : `at ${trigger.fireAt}`;
  const next = trigger.nextFireAt ? `, next ${trigger.nextFireAt}` : '';
  const who = trigger.kind === 'agent_task' ? ` [agent ${trigger.agent}]` : '';
  return `#${trigger.id} ${trigger.kind} "${trigger.title}" ${when}${next} (${trigger.status})${who}: ${trigger.text}`;
}

/** The four scheduling tools. Times are stored in UTC and returned in UTC. */
export function createTriggerTools(store: TriggerStore, agents: AgentCatalog): ToolDefinition<any>[] {
  const createTrigger = defineTool({
    name: 'create_trigger',
    description: `Schedule a reminder for the user, or an agent task that runs unattended at that time. ${SCHEDULE_HELP} The current time is in the context block of the user's message.`,
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      kind: z.enum(['reminder', 'agent_task']),
      title: z.string().min(1).describe('Short label shown in the notification'),
      text: z.string().min(1).describe('Reminder text, or the full instruction for an agent task'),
      fire_at: z.string().optional(),
      cron: z.string().optional(),
      webhook: z.boolean().optional().describe('True: fire when a service POSTs to the trigger URL the tool returns'),
      repeat: z.boolean().optional().describe('For cron: false to fire only once. Default true.'),
      agent: z.string().optional().describe('Agent that runs an agent_task; defaults to you'),
    }),
    summarize: (input) =>
      `Schedule ${input.kind} "${input.title}" ${input.webhook ? 'on a webhook' : input.cron ? `cron ${input.cron}` : `at ${input.fire_at}`}`,
    async execute(input, context) {
      const agent = input.agent ?? context.agent;
      agents.get(agent); // must exist
      const trigger = store.create({
        kind: input.kind,
        title: input.title,
        text: input.text,
        fireAt: input.fire_at,
        cron: input.cron,
        webhook: input.webhook,
        repeat: input.repeat,
        agent,
      });
      return `Created ${describe(trigger)}`;
    },
  });

  const listTriggers = defineTool({
    name: 'list_triggers',
    description: 'List reminders and scheduled agent tasks. Shows active ones unless another status is asked for.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ status: z.enum(['active', 'fired', 'cancelled', 'all']).optional() }),
    summarize: () => 'List triggers',
    async execute(input) {
      const status = input.status ?? 'active';
      const triggers = store.list(status === 'all' ? undefined : status);
      return triggers.length > 0 ? triggers.map(describe).join('\n') : `No ${status === 'all' ? '' : `${status} `}triggers.`;
    },
  });

  const updateTrigger = defineTool({
    name: 'update_trigger',
    description: `Change an active trigger's title, text or schedule. ${SCHEDULE_HELP}`,
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      id: z.number().int().positive(),
      title: z.string().optional(),
      text: z.string().optional(),
      fire_at: z.string().optional(),
      cron: z.string().optional(),
      repeat: z.boolean().optional(),
    }),
    summarize: (input) => `Update trigger #${input.id}`,
    async execute(input) {
      const { id, fire_at: fireAt, ...rest } = input;
      return `Updated ${describe(store.update(id, { ...rest, fireAt }))}`;
    },
  });

  const cancelTrigger = defineTool({
    name: 'cancel_trigger',
    description: 'Cancel a reminder or scheduled agent task.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ id: z.number().int().positive() }),
    summarize: (input) => `Cancel trigger #${input.id}`,
    async execute(input) {
      return `Cancelled ${describe(store.cancel(input.id))}`;
    },
  });

  return [createTrigger, listTriggers, updateTrigger, cancelTrigger];
}
