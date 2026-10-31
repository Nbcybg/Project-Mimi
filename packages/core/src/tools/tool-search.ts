import { z } from 'zod';
import { defineTool, type ToolDefinition } from './registry.ts';

/** Marks a search result that the agent loop should turn into live tools for this run. */
export const TOOL_ACTIVATE_MARK = '\u0000mimi-tools\u0000';

export interface SearchableTool {
  name: string;
  description: string;
  risk: string;
  connector?: string;
}

const STOP = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with', 'me', 'my', 'tool']);

function score(tool: SearchableTool, terms: string[]): number {
  const name = tool.name.toLowerCase();
  const text = `${name} ${tool.description.toLowerCase()} ${(tool.connector ?? '').toLowerCase()}`;
  let total = 0;
  for (const term of terms) {
    if (name === term) total += 20;
    else if (name.includes(term)) total += 8;
    else if (text.includes(term)) total += 2;
  }
  return total;
}

/**
 * Search the agent's own tool list and load matches into this run. Only used by agents
 * with `lazy_tools: true`: the model sees this one tool plus the catalog names instead
 * of dozens of JSON schemas.
 */
export function createToolSearchTool(catalog: SearchableTool[]): ToolDefinition<{ query: string; limit?: number }> {
  const byName = new Map(catalog.map((tool) => [tool.name, tool]));
  return defineTool({
    name: 'tool_search',
    description:
      'Find and load the tools this agent may use. Call it with what you want to do (for example "send email" or "read a pdf"); the matching tools become callable from your next message. Tool catalog: ' +
      catalog.map((tool) => `${tool.name} (${tool.risk})`).join(', ').slice(0, 12_000),
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      query: z.string().min(1).describe('What you need to do; several words are matched against tool names and descriptions'),
      limit: z.number().int().min(1).max(25).optional().describe('Default 8'),
    }),
    summarize: (input) => `Search tools: ${input.query.slice(0, 100)}`,
    async execute(input) {
      const terms = input.query
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((term) => term.length > 1 && !STOP.has(term));
      const ranked = catalog
        .map((tool) => ({ tool, score: terms.length === 0 ? 0 : score(tool, terms) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .slice(0, input.limit ?? 8);
      const picked = ranked.length > 0 ? ranked.map((entry) => entry.tool.name) : catalog.slice(0, Math.min(8, catalog.length)).map((tool) => tool.name);
      const live = picked;
      const lines = picked.map((name) => {
        const tool = byName.get(name);
        return `- ${name} [${tool?.risk ?? 'read'}] ${tool?.description.split('. ')[0] ?? ''}`;
      });
      const loaded = live.length > 0 ? `\nLoaded now: ${live.join(', ')}` : '';
      return `${lines.join('\n')}${loaded}\n${TOOL_ACTIVATE_MARK}${JSON.stringify(live)}`;
    },
  });
}
