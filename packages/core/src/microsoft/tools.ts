import { z } from 'zod';
import { accountOf, accountSetting } from '../oauth/settings.ts';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import { microsoftAuthResolver, type MicrosoftAuth, type MicrosoftAuthSource } from './auth.ts';

const BODY_LIMIT = 8000;
const TEXT_BODY = { Prefer: 'outlook.body-content-type="text"' };

interface Recipient {
  emailAddress?: { name?: string; address?: string };
}
interface OutlookMessage {
  id: string;
  subject?: string;
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  receivedDateTime?: string;
  bodyPreview?: string;
  body?: { content?: string };
  hasAttachments?: boolean;
  isRead?: boolean;
}
interface OutlookEvent {
  id: string;
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  location?: { displayName?: string };
  bodyPreview?: string;
  isAllDay?: boolean;
}
interface TodoList {
  id: string;
  displayName?: string;
  wellknownListName?: string;
}
interface TodoTask {
  id: string;
  title?: string;
  status?: string;
  dueDateTime?: { dateTime?: string };
  body?: { content?: string };
}

const who = (recipient: Recipient | undefined) => {
  const address = recipient?.emailAddress;
  return address ? `${address.name ? `${address.name} ` : ''}<${address.address ?? '?'}>` : '?';
};
const recipients = (list: string) =>
  list
    .split(/[,;]/)
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
const id = (value: string) => encodeURIComponent(value);
/** Graph wants a wall-clock time plus a zone name; anything after the seconds is dropped. */
const wallClock = (value: string, timeZone: string) => ({ dateTime: value.replace(/(Z|[+-]\d\d:?\d\d)$/, ''), timeZone });

function messageLine(message: OutlookMessage): string {
  const flags = `${message.isRead === false ? ' [unread]' : ''}${message.hasAttachments ? ' [attachment]' : ''}`;
  return `[id ${message.id}] ${message.receivedDateTime ?? ''}${flags}\nFrom: ${who(message.from)}\nSubject: ${message.subject ?? '(no subject)'}\n${message.bodyPreview ?? ''}`;
}
function eventLine(event: OutlookEvent): string {
  const place = event.location?.displayName ? ` @ ${event.location.displayName}` : '';
  return `${event.start?.dateTime?.slice(0, 16) ?? '?'} -> ${event.end?.dateTime?.slice(0, 16) ?? '?'}${event.isAllDay ? ' (all day)' : ''} | ${event.subject ?? '(no title)'}${place} [id ${event.id}]`;
}
function taskLine(task: TodoTask): string {
  const due = task.dueDateTime?.dateTime ? ` (due ${task.dueDateTime.dateTime.slice(0, 10)})` : '';
  return `${task.status === 'completed' ? '[x]' : '[ ]'} ${task.title ?? '(untitled)'}${due} [id ${task.id}]`;
}

/**
 * Outlook mail, Outlook calendar and Microsoft To Do through Microsoft Graph. Mail and
 * invitations are written by other people, so the reading tools are marked as untrusted
 * input: an agent that has them cannot have a shell.
 */
export function createMicrosoftTools(source: MicrosoftAuthSource, timezone: string): ToolDefinition<any>[] {
  const resolve = microsoftAuthResolver(source);
  const client = (settings?: { account?: unknown }) => resolve(accountOf(settings));
  const zone = { Prefer: `outlook.timezone="${timezone}"` };

  /** The id of a To Do list: the one given, else the account's default list. */
  const listId = async (auth: MicrosoftAuth, given: string | undefined): Promise<string> => {
    if (given?.trim()) return given.trim();
    const lists = await auth.request<{ value: TodoList[] }>('/me/todo/lists');
    const chosen = lists.value.find((list) => list.wellknownListName === 'defaultList') ?? lists.value[0];
    if (!chosen) throw new Error('The account has no To Do list.');
    return chosen.id;
  };

  const outlookSearch = defineTool({
    name: 'outlook_search',
    description:
      'List or search the user\'s Outlook mail, newest first. Without a query it lists the inbox; with one it searches all folders (words, or KQL such as "from:bank subject:invoice"). Returns id, sender, subject, date and a preview per message.',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({
      query: z.string().optional(),
      unread_only: z.boolean().optional().describe('Inbox listing only'),
      max_results: z.number().int().positive().max(25).optional(),
    }),
    summarize: (input) => (input.query ? `Search Outlook: ${input.query}` : 'List the Outlook inbox'),
    async execute(input, _context, settings) {
      const auth = client(settings);
      const select = '$select=id,subject,from,receivedDateTime,bodyPreview,hasAttachments,isRead';
      const top = `$top=${input.max_results ?? 10}`;
      const query = input.query?.trim();
      const path = query
        ? `/me/messages?$search=${encodeURIComponent(`"${query.replaceAll('"', '')}"`)}&${top}&${select}`
        : `/me/mailFolders/inbox/messages?$orderby=receivedDateTime desc&${top}&${select}${input.unread_only ? '&$filter=isRead eq false' : ''}`;
      const found = await auth.request<{ value: OutlookMessage[] }>(path);
      return found.value.length > 0 ? found.value.map(messageLine).join('\n\n') : 'No messages match.';
    },
  });

  const outlookRead = defineTool({
    name: 'outlook_read',
    description: 'Read one Outlook message in full, by the id from outlook_search.',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({ id: z.string().min(1) }),
    summarize: () => 'Read an Outlook message',
    async execute(input, _context, settings) {
      const auth = client(settings);
      const message = await auth.request<OutlookMessage>(
        `/me/messages/${id(input.id)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments`,
        { headers: TEXT_BODY },
      );
      const body = (message.body?.content ?? '').trim();
      return [
        `From: ${who(message.from)}`,
        `To: ${(message.toRecipients ?? []).map(who).join(', ')}`,
        ...(message.ccRecipients?.length ? [`Cc: ${message.ccRecipients.map(who).join(', ')}`] : []),
        `Date: ${message.receivedDateTime ?? ''}`,
        `Subject: ${message.subject ?? ''}`,
        ...(message.hasAttachments ? ['(has attachments)'] : []),
        '',
        body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}\n[cut: ${body.length - BODY_LIMIT} more characters]` : body,
      ].join('\n');
    },
  });

  const outlookSend = defineTool({
    name: 'outlook_send',
    description: 'Send an e-mail from the user\'s Outlook account. Plain text. Several addresses are separated by commas.',
    risk: 'network',
    target: 'core',
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({
      to: z.string().min(3),
      subject: z.string().min(1),
      body: z.string().min(1),
      cc: z.string().optional(),
    }),
    summarize: (input) => `Send Outlook mail to ${input.to}: ${input.subject}`,
    async execute(input, _context, settings) {
      const auth = client(settings);
      await auth.request('/me/sendMail', {
        method: 'POST',
        body: {
          message: {
            subject: input.subject,
            body: { contentType: 'Text', content: input.body },
            toRecipients: recipients(input.to),
            ...(input.cc ? { ccRecipients: recipients(input.cc) } : {}),
          },
          saveToSentItems: true,
        },
      });
      return `Sent to ${input.to}.`;
    },
  });

  const outlookReply = defineTool({
    name: 'outlook_reply',
    description: 'Reply to an Outlook message (id from outlook_search). The original is quoted below your text.',
    risk: 'network',
    target: 'core',
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({
      id: z.string().min(1),
      body: z.string().min(1),
      reply_all: z.boolean().optional(),
    }),
    summarize: (input) => `Reply${input.reply_all ? ' to all' : ''} in Outlook: ${input.body.replace(/\s+/g, ' ').slice(0, 100)}`,
    async execute(input, _context, settings) {
      const auth = client(settings);
      await auth.request(`/me/messages/${id(input.id)}/${input.reply_all ? 'replyAll' : 'reply'}`, {
        method: 'POST',
        body: { comment: input.body },
      });
      return 'Reply sent.';
    },
  });

  const calendarList = defineTool({
    name: 'outlook_calendar_list',
    description: `List events of the user's Outlook calendar between two times, in order. Times are in ${timezone}.`,
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({
      from: z.string().min(10).describe('Start, e.g. 2026-10-13T00:00:00'),
      to: z.string().min(10).describe('End, e.g. 2026-10-14T00:00:00'),
      max_results: z.number().int().positive().max(50).optional(),
    }),
    summarize: (input) => `List Outlook calendar ${input.from} to ${input.to}`,
    async execute(input, _context, settings) {
      const auth = client(settings);
      const found = await auth.request<{ value: OutlookEvent[] }>(
        `/me/calendarView?startDateTime=${encodeURIComponent(input.from)}&endDateTime=${encodeURIComponent(input.to)}&$orderby=start/dateTime&$top=${input.max_results ?? 20}&$select=id,subject,start,end,location,bodyPreview,isAllDay`,
        { headers: zone },
      );
      return found.value.length > 0 ? found.value.map(eventLine).join('\n') : 'No events in that period.';
    },
  });

  const calendarCreate = defineTool({
    name: 'outlook_calendar_create',
    description: `Create an event in the user's Outlook calendar. Times are wall-clock times in ${timezone}, e.g. 2026-10-13T14:00:00.`,
    risk: 'write',
    target: 'core',
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({
      title: z.string().min(1),
      start: z.string().min(10),
      end: z.string().min(10),
      location: z.string().optional(),
      description: z.string().optional(),
      attendees: z.string().optional().describe('E-mail addresses separated by commas; they receive an invitation'),
    }),
    summarize: (input) => `Create Outlook event "${input.title}" ${input.start} to ${input.end}`,
    async execute(input, _context, settings) {
      const auth = client(settings);
      const event = await auth.request<OutlookEvent>('/me/events', {
        method: 'POST',
        headers: zone,
        body: {
          subject: input.title,
          start: wallClock(input.start, timezone),
          end: wallClock(input.end, timezone),
          ...(input.location ? { location: { displayName: input.location } } : {}),
          ...(input.description ? { body: { contentType: 'Text', content: input.description } } : {}),
          ...(input.attendees
            ? { attendees: recipients(input.attendees).map((attendee) => ({ ...attendee, type: 'required' })) }
            : {}),
        },
      });
      return `Created: ${eventLine(event)}`;
    },
  });

  const calendarUpdate = defineTool({
    name: 'outlook_calendar_update',
    description: 'Change an Outlook calendar event (id from outlook_calendar_list). Only the fields you give are changed.',
    risk: 'write',
    target: 'core',
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({
      id: z.string().min(1),
      title: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      location: z.string().optional(),
      description: z.string().optional(),
    }),
    summarize: (input) => `Update Outlook event${input.title ? ` "${input.title}"` : ''}${input.start ? ` to ${input.start}` : ''}`,
    async execute(input, _context, settings) {
      const auth = client(settings);
      const change: Record<string, unknown> = {};
      if (input.title !== undefined) change.subject = input.title;
      if (input.start !== undefined) change.start = wallClock(input.start, timezone);
      if (input.end !== undefined) change.end = wallClock(input.end, timezone);
      if (input.location !== undefined) change.location = { displayName: input.location };
      if (input.description !== undefined) change.body = { contentType: 'Text', content: input.description };
      if (Object.keys(change).length === 0) throw new Error('Nothing to change: give at least one field.');
      const event = await auth.request<OutlookEvent>(`/me/events/${id(input.id)}`, { method: 'PATCH', headers: zone, body: change });
      return `Updated: ${eventLine(event)}`;
    },
  });

  const calendarDelete = defineTool({
    name: 'outlook_calendar_delete',
    description: 'Delete an Outlook calendar event (id from outlook_calendar_list).',
    risk: 'delete',
    target: 'core',
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({ id: z.string().min(1), title: z.string().optional().describe('Title, shown when asking for approval') }),
    summarize: (input) => `Delete Outlook event${input.title ? ` "${input.title}"` : ''}`,
    async execute(input, _context, settings) {
      const auth = client(settings);
      await auth.request(`/me/events/${id(input.id)}`, { method: 'DELETE' });
      return 'Event deleted.';
    },
  });

  const todoLists = defineTool({
    name: 'todo_lists',
    description: 'List the user\'s Microsoft To Do lists with their ids.',
    risk: 'read',
    target: 'core',
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({}),
    summarize: () => 'List To Do lists',
    async execute(_input, _context, settings) {
      const auth = client(settings);
      const lists = await auth.request<{ value: TodoList[] }>('/me/todo/lists');
      if (lists.value.length === 0) return 'There are no lists.';
      return lists.value
        .map((list) => `${list.displayName ?? '(unnamed)'}${list.wellknownListName === 'defaultList' ? ' (default)' : ''} [id ${list.id}]`)
        .join('\n');
    },
  });

  const todoTasks = defineTool({
    name: 'todo_tasks',
    description: 'List the tasks of a Microsoft To Do list (the default list when no list_id is given). Open tasks only, unless include_completed is set.',
    risk: 'read',
    target: 'core',
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({ list_id: z.string().optional(), include_completed: z.boolean().optional() }),
    summarize: () => 'List To Do tasks',
    async execute(input, _context, settings) {
      const auth = client(settings);
      const list = await listId(auth, input.list_id);
      const filter = input.include_completed ? '' : `&$filter=${encodeURIComponent("status ne 'completed'")}`;
      const tasks = await auth.request<{ value: TodoTask[] }>(`/me/todo/lists/${id(list)}/tasks?$top=50${filter}`);
      return tasks.value.length > 0 ? tasks.value.map(taskLine).join('\n') : 'No tasks.';
    },
  });

  const todoCreate = defineTool({
    name: 'todo_create',
    description: 'Add a task to Microsoft To Do (the default list when no list_id is given).',
    risk: 'write',
    target: 'core',
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({
      title: z.string().min(1),
      list_id: z.string().optional(),
      due: z.string().optional().describe('Due date, e.g. 2026-10-15'),
      note: z.string().optional(),
    }),
    summarize: (input) => `Add To Do task "${input.title}"${input.due ? ` due ${input.due}` : ''}`,
    async execute(input, _context, settings) {
      const auth = client(settings);
      const list = await listId(auth, input.list_id);
      const task = await auth.request<TodoTask>(`/me/todo/lists/${id(list)}/tasks`, {
        method: 'POST',
        body: {
          title: input.title,
          ...(input.due ? { dueDateTime: wallClock(input.due.length <= 10 ? `${input.due}T00:00:00` : input.due, timezone) } : {}),
          ...(input.note ? { body: { content: input.note, contentType: 'text' } } : {}),
        },
      });
      return `Added: ${taskLine(task)}`;
    },
  });

  const todoUpdate = defineTool({
    name: 'todo_update',
    description: 'Change a Microsoft To Do task or mark it done (task_id from todo_tasks). Only the fields you give are changed.',
    risk: 'write',
    target: 'core',
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({
      task_id: z.string().min(1),
      list_id: z.string().optional(),
      title: z.string().optional(),
      completed: z.boolean().optional(),
      due: z.string().optional(),
      note: z.string().optional(),
    }),
    summarize: (input) =>
      `${input.completed ? 'Complete' : 'Update'} To Do task${input.title ? ` "${input.title}"` : ''}`,
    async execute(input, _context, settings) {
      const auth = client(settings);
      const change: Record<string, unknown> = {};
      if (input.title !== undefined) change.title = input.title;
      if (input.completed !== undefined) change.status = input.completed ? 'completed' : 'notStarted';
      if (input.due !== undefined) change.dueDateTime = wallClock(input.due.length <= 10 ? `${input.due}T00:00:00` : input.due, timezone);
      if (input.note !== undefined) change.body = { content: input.note, contentType: 'text' };
      if (Object.keys(change).length === 0) throw new Error('Nothing to change: give at least one field.');
      const list = await listId(auth, input.list_id);
      const task = await auth.request<TodoTask>(`/me/todo/lists/${id(list)}/tasks/${id(input.task_id)}`, { method: 'PATCH', body: change });
      return `Updated: ${taskLine(task)}`;
    },
  });

  const todoDelete = defineTool({
    name: 'todo_delete',
    description: 'Delete a Microsoft To Do task for good (task_id from todo_tasks).',
    risk: 'delete',
    target: 'core',
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({ task_id: z.string().min(1), list_id: z.string().optional(), title: z.string().optional().describe('Title, shown when asking for approval') }),
    summarize: (input) => `Delete To Do task${input.title ? ` "${input.title}"` : ''}`,
    async execute(input, _context, settings) {
      const auth = client(settings);
      const list = await listId(auth, input.list_id);
      await auth.request(`/me/todo/lists/${id(list)}/tasks/${id(input.task_id)}`, { method: 'DELETE' });
      return 'Task deleted.';
    },
  });

  return [
    outlookSearch,
    outlookRead,
    outlookSend,
    outlookReply,
    calendarList,
    calendarCreate,
    calendarUpdate,
    calendarDelete,
    todoLists,
    todoTasks,
    todoCreate,
    todoUpdate,
    todoDelete,
  ];
}

/** One mail, as a trigger hands it to a workflow run. */
export interface OutlookMailItem {
  id: string;
  from: string;
  to: string;
  date?: string;
  subject: string;
  content: string;
}

/** Unread messages with their text body; used by mail triggers. */
export async function outlookListUnread(auth: MicrosoftAuth, query: string, max: number): Promise<OutlookMailItem[]> {
  const select = '$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body';
  const term = query.trim();
  const path = term
    ? `/me/messages?$search=${encodeURIComponent(`"${term.replaceAll('"', '')}"`)}&$top=${max}&${select}`
    : `/me/mailFolders/inbox/messages?$filter=isRead eq false&$orderby=receivedDateTime desc&$top=${max}&${select}`;
  const found = await auth.request<{ value?: OutlookMessage[] }>(path, { headers: { Prefer: 'outlook.body-content-type="text"' } });
  return (found.value ?? []).map((message) => ({
    id: message.id,
    from: who(message.from),
    to: (message.toRecipients ?? []).map((recipient) => who(recipient)).join(', '),
    date: message.receivedDateTime,
    subject: message.subject ?? '(no subject)',
    content: (message.body?.content ?? message.bodyPreview ?? '').trim().slice(0, 4000),
  }));
}

/** Marks the given messages as read. */
export async function outlookMarkRead(auth: MicrosoftAuth, ids: string[]): Promise<void> {
  for (const messageId of ids) {
    await auth.request(`/me/messages/${id(messageId)}`, { method: 'PATCH', body: { isRead: true } });
  }
}
