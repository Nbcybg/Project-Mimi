import type { StoredMessage } from '@mimi/shared';
import { z } from 'zod';
import type { MessagesRepo } from '../db/messages-repo.ts';
import type { MemoryStore } from '../memory/store.ts';
import { defineTool, type ToolDefinition } from './registry.ts';

const SNIPPET_RADIUS = 200;
const RANGE_MAX_MESSAGES = 50;
const RANGE_TEXT_LIMIT = 2000;

function header(message: StoredMessage): string {
  const who = message.role === 'assistant' ? `assistant ${message.agent}` : message.role;
  return `#${message.id} ${message.createdAt.slice(0, 16)}Z ${who}`;
}

/** The part of `text` around the first occurrence of `term`. */
function snippet(text: string, term: string): string {
  const at = Math.max(text.toLowerCase().indexOf(term.toLowerCase()), 0);
  const start = Math.max(at - SNIPPET_RADIUS, 0);
  const end = Math.min(at + term.length + SNIPPET_RADIUS, text.length);
  return `${start > 0 ? '...' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '...' : ''}`;
}

/**
 * Memory tools for chat agents: layer 2 on demand, layer 3 via search.
 * `sessionThreads` lists the threads of every session an agent may read, which is what
 * `search_history` covers when asked to look beyond the current session.
 */
export function createMemoryTools(
  memory: MemoryStore,
  messages: MessagesRepo,
  sessionThreads: (agent: string) => string[] = () => [],
): ToolDefinition<any>[] {
  const readMemory = defineTool({
    name: 'read_memory',
    description:
      'Open a memory file by its path from the memory index (or "profile" / "preferences"). Returns the latest content.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ path: z.string().min(1).describe('e.g. "projects/garden"') }),
    summarize: (input) => `Read memory ${input.path}`,
    async execute(input) {
      const entry = memory.get(input.path.trim());
      if (!entry) {
        const paths = memory.list().map((candidate) => candidate.path);
        throw new Error(`No memory file "${input.path}". Existing files: ${paths.join(', ') || 'none'}`);
      }
      return `${entry.path} (updated ${entry.updatedAt.slice(0, 10)})\n${entry.description}\n\n${entry.content}`;
    },
  });

  const writeMemory = defineTool({
    name: 'write_memory',
    description:
      'Create or replace a memory file. Use only when the user explicitly asks you to remember something. To change an existing file, read it first and write the complete new content.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      path: z.string().min(1).describe('"profile", "preferences", or a topic file like "people/somchai"'),
      description: z.string().optional().describe('One-line index entry; required for a new topic file'),
      content: z.string().min(1).describe('Complete new content of the file'),
    }),
    summarize: (input) => `Remember in ${input.path}: ${input.content.replace(/\s+/g, ' ').slice(0, 120)}`,
    async execute(input) {
      const entry = memory.write(input);
      return `Saved ${entry.path} (${entry.content.length} characters). It appears in the memory block after the next compaction; read_memory returns it right away.`;
    },
  });

  const deleteMemory = defineTool({
    name: 'delete_memory',
    description:
      'Delete a memory file. Use only when the user explicitly asks you to forget something.',
    risk: 'delete',
    target: 'core',
    inputSchema: z.object({ path: z.string().min(1) }),
    summarize: (input) => `Forget memory file ${input.path}`,
    async execute(input) {
      if (!memory.delete(input.path)) throw new Error(`No memory file "${input.path}".`);
      return `Deleted ${input.path}.`;
    },
  });

  const searchHistory = defineTool({
    name: 'search_history',
    description:
      'Look up the raw conversation log, including messages that were already summarized. Either search by text (every word must appear; works for Thai substrings) or fetch a range of message ids as cited in summaries. Set all_sessions to search earlier sessions too.',
    risk: 'read',
    target: 'core',
    inputSchema: z
      .object({
        query: z.string().optional().describe('Words or phrases that must all appear'),
        from_id: z.number().int().positive().optional().describe('First message id of a range'),
        to_id: z.number().int().positive().optional().describe('Last message id of a range'),
        limit: z.number().int().positive().max(50).optional(),
        all_sessions: z
          .boolean()
          .optional()
          .describe('Search every earlier session of your chats, not only this one'),
      })
      .refine((input) => input.query?.trim() || input.from_id !== undefined, {
        error: 'Provide either "query" or "from_id"',
      }),
    summarize: (input) =>
      input.query ? `Search history for "${input.query}"` : `Read messages #${input.from_id}-#${input.to_id ?? input.from_id}`,
    async execute(input, context) {
      if (input.query?.trim()) {
        const firstTerm = input.query.trim().split(/\s+/)[0]!;
        const scope = input.all_sessions
          ? [...new Set([context.thread, ...sessionThreads(context.agent)])]
          : context.thread;
        const hits = messages.search(scope, input.query, input.limit ?? 10);
        if (hits.length === 0) return `No messages match "${input.query}".`;
        return hits.map((hit) => `${header(hit)}\n${snippet(hit.text, firstTerm)}`).join('\n\n');
      }
      const fromId = input.from_id!;
      const toId = Math.max(input.to_id ?? fromId, fromId);
      const found = messages.range(context.thread, fromId, toId, RANGE_MAX_MESSAGES);
      if (found.length === 0) return `No messages in #${fromId}-#${toId}.`;
      const body = found
        .filter((message) => message.text.trim())
        .map((message) => `${header(message)}\n${message.text.slice(0, RANGE_TEXT_LIMIT)}`)
        .join('\n\n');
      const more = found.length === RANGE_MAX_MESSAGES ? `\n\n[showing the first ${RANGE_MAX_MESSAGES} messages of the range]` : '';
      return body + more;
    },
  });

  return [readMemory, writeMemory, deleteMemory, searchHistory];
}
