import { z } from 'zod';
import type { MessagesRepo } from '../db/messages-repo.ts';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import { stripAttachments } from './attachments.ts';
import type { Chat, ChatStore, Session } from './chat-store.ts';

const READ_MAX_MESSAGES = 40;
const MESSAGE_TEXT_LIMIT = 1500;

function label(chat: Chat): string {
  return chat.title || (chat.kind === 'group' ? `group of ${chat.agents.join(', ')}` : `chat with ${chat.agents[0]}`);
}

function line({ session, chat }: { session: Session; chat: Chat }, current: string): string {
  const here = session.thread === current ? ' (this session)' : '';
  const summary = session.summary ? `\n  ${session.summary.replace(/\s+/g, ' ').slice(0, 240)}` : '';
  return `- session ${session.id}${here} · ${label(chat)} · ${session.lastMessageAt.slice(0, 16)}Z · ${session.title || 'untitled'}${summary}`;
}

/**
 * Lets an agent look into earlier sessions of the chats it takes part in. Each session
 * has its own context window; these tools are how knowledge crosses from one to the next.
 */
export function createSessionTools(chats: ChatStore, messages: MessagesRepo): ToolDefinition<any>[] {
  const listSessions = defineTool({
    name: 'list_sessions',
    description:
      'List the recent sessions of your chats (one-to-one and groups), newest first, with their titles and summaries. Use it to find an earlier conversation.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ limit: z.number().int().positive().max(50).optional() }),
    summarize: () => 'List earlier sessions',
    async execute(input, context) {
      const found = chats.sessionsFor(context.agent, input.limit ?? 15);
      if (found.length === 0) return 'There are no sessions yet.';
      return found.map((entry) => line(entry, context.thread)).join('\n');
    },
  });

  const readSession = defineTool({
    name: 'read_session',
    description:
      'Read an earlier session by its id from list_sessions: its summary and its last messages. Use search_history with all_sessions for a specific detail.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      session_id: z.number().int().positive(),
      limit: z.number().int().positive().max(READ_MAX_MESSAGES).optional().describe('How many of the last messages'),
    }),
    summarize: (input) => `Read session ${input.session_id}`,
    async execute(input, context) {
      const session = chats.getSession(input.session_id);
      const chat = session && chats.getChat(session.chatId);
      if (!session || !chat?.agents.includes(context.agent)) {
        throw new Error(`No session ${input.session_id} among your chats.`);
      }
      const page = messages.page(session.thread, undefined, input.limit ?? 20);
      const body = page
        .map((message) => {
          const who = message.role === 'user' ? 'user' : message.agent;
          return `#${message.id} ${message.createdAt.slice(0, 16)}Z ${who}\n${stripAttachments(message.text).slice(0, MESSAGE_TEXT_LIMIT)}`;
        })
        .join('\n\n');
      return [
        `Session ${session.id} · ${label(chat)} · ${session.title || 'untitled'}`,
        session.summary ? `Summary: ${session.summary}` : 'No summary yet.',
        '',
        body || '(no messages)',
      ].join('\n');
    },
  });

  return [listSessions, readSession];
}
