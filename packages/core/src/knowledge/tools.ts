import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import { type KnowledgeStore, renderHits } from './store.ts';

/** The agent-side door to the knowledge bases: search, and read the list of bases. */
export function createKnowledgeTools(store: KnowledgeStore): ToolDefinition[] {
  const search = defineTool({
    name: 'knowledge_search',
    description:
      'Search the user\'s knowledge bases (documents, notes, manuals they added in the app) and get the most relevant passages with their source. Use it before answering questions about the user\'s own documents. Leave "collection" empty to search every base.',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    inputSchema: z.object({
      query: z.string().min(1),
      collection: z.string().optional(),
      limit: z.number().int().positive().max(10).optional(),
    }),
    summarize: (input) => `Search knowledge${input.collection ? ` (${input.collection})` : ''}: ${input.query}`,
    async execute(input, context) {
      const known = store.collections();
      if (known.length === 0) return 'There are no knowledge bases yet; the user adds them in the app (Hub → คลังความรู้).';
      const collection = input.collection?.trim() || undefined;
      if (collection && !known.some((entry) => entry.name === collection)) {
        return `No knowledge base "${collection}". Available: ${known.map((entry) => `${entry.name} (${entry.title})`).join(', ')}.`;
      }
      const hits = await store.search(input.query, { collection, limit: input.limit ?? 5, signal: context.signal });
      return renderHits(hits);
    },
  });
  return [search as ToolDefinition];
}
