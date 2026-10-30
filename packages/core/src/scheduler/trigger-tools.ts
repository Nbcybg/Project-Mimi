import { z } from 'zod';
import type { AgentCatalog } from '../agents/loader.ts';
import { timeZoneName, type TimeZoneSource } from '../timezone.ts';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import type { Trigger, TriggerStore } from './triggers.ts';

const SCHEDULE_HELP =
  'Give exactly one of fire_at (one-shot local date-time in the configured time zone, like 2026-10-13T09:00:00), cron (recurring, e.g. "0 8 * * 1-5" for weekdays at 08:00), or webhook: true for a trigger that fires when an HTTP service calls its URL. Results show times in that same local zone with its UTC offset.';

/** An ISO instant as local date-time, offset and zone name, e.g. 2026-10-31T00:30:00+07:00 (Asia/Bangkok). */
function localStamp(iso: string | null, timezone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wallClock = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMinutes = Math.round((wallClock - date.getTime()) / 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${get('year')}-${pad(get('month'))}-${pad(get('day'))}T${pad(get('hour'))}:${pad(get('minute'))}:${pad(get('second'))}${offset} (${timezone})`;
}

function describe(trigger: Trigger, timezone: string): string {
  const when = trigger.webhook
    ? `on webhook ${trigger.webhook}`
    : trigger.cron
      ? `cron "${trigger.cron}"${trigger.repeat ? '' : ' (once)'}`
      : `at ${localStamp(trigger.fireAt, timezone)}`;
  const next = trigger.nextFireAt ? `, next ${localStamp(trigger.nextFireAt, timezone)}` : '';
  const who = trigger.kind === 'agent_task' ? ` [agent ${trigger.agent}]` : '';
  return `#${trigger.id} ${trigger.kind} "${trigger.title}" ${when}${next} (${trigger.status})${who}: ${trigger.text}`;
}

/** The four scheduling tools. Times are stored in UTC and shown in the user's local zone. */
export function createTriggerTools(store: TriggerStore, agents: AgentCatalog, timezone: TimeZoneSource): ToolDefinition<any>[] {
  const zone = () => timeZoneName(timezone);
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
      return `Created ${describe(trigger, zone())}`;
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
      return triggers.length > 0 ? triggers.map((trigger) => describe(trigger, zone())).join('\n') : `No ${status === 'all' ? '' : `${status} `}triggers.`;
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
      return `Updated ${describe(store.update(id, { ...rest, fireAt }), zone())}`;
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
      return `Cancelled ${describe(store.cancel(input.id), zone())}`;
    },
  });

  return [createTrigger, listTriggers, updateTrigger, cancelTrigger];
}
