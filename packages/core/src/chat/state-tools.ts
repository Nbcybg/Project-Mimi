import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import { type MemoStore, STATUS_KEYS, type StatusStore } from './state-store.ts';

/**
 * Tools an agent uses on its own state: its status and its memos. They change nothing
 * that belongs to the user, so they run without asking.
 */
export function createStateTools(status: StatusStore, memos: MemoStore): ToolDefinition<any>[] {
  const statusSet = defineTool({
    name: 'status_set',
    description:
      'Update your own status when it changes: where you are (location), what you wear (outfit), what you are doing (current_task) or how you feel (mood). One key per call; an empty value clears it.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      key: z.enum(STATUS_KEYS),
      value: z.string().describe('Short, in the language you speak with the user'),
    }),
    summarize: (input) => `Status ${input.key}: ${input.value}`,
    async execute(input, context) {
      status.set(context.agent, input.key, input.value);
      return `Status updated: ${input.key} = ${input.value.trim() || '(cleared)'}`;
    },
  });

  const memoSave = defineTool({
    name: 'memo_save',
    description:
      'Save a short note for yourself under a key (replaces the note with the same key). For working notes; lasting facts about the user belong in memory.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ key: z.string().min(1).max(80), value: z.string().min(1).max(4000) }),
    summarize: (input) => `Memo ${input.key}`,
    async execute(input, context) {
      memos.save(context.agent, input.key.trim(), input.value);
      return `Memo "${input.key.trim()}" saved.`;
    },
  });

  const memoGet = defineTool({
    name: 'memo_get',
    description: 'Read one of your memos by key, or list all of them when no key is given.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ key: z.string().optional() }),
    summarize: (input) => (input.key ? `Read memo ${input.key}` : 'List memos'),
    async execute(input, context) {
      const key = input.key?.trim();
      if (key) {
        const memo = memos.get(context.agent, key);
        if (!memo) throw new Error(`No memo "${key}".`);
        return `${memo.key} (updated ${memo.updatedAt.slice(0, 10)})\n${memo.value}`;
      }
      const all = memos.list(context.agent);
      if (all.length === 0) return 'You have no memos.';
      return all.map((memo) => `- ${memo.key}: ${memo.value.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');
    },
  });

  const memoDelete = defineTool({
    name: 'memo_delete',
    description: 'Delete one of your memos.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ key: z.string().min(1) }),
    summarize: (input) => `Delete memo ${input.key}`,
    async execute(input, context) {
      if (!memos.delete(context.agent, input.key.trim())) throw new Error(`No memo "${input.key}".`);
      return `Memo "${input.key.trim()}" deleted.`;
    },
  });

  return [statusSet, memoSave, memoGet, memoDelete];
}
