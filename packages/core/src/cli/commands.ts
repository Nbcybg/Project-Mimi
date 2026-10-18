import type { MemoryStore } from '../memory/store.ts';
import type { ModelInfo, ProviderRegistry } from '../providers/registry.ts';
import { formatModelRef } from '../providers/registry.ts';

/** Text output shared by the standalone commands and the in-chat slash commands. */

export const MEMORY_NOTE =
  'Changes reach the assistant\'s always-loaded memory block at the next compaction (or /compact).';

export function formatMemoryList(memory: MemoryStore): string {
  const entries = memory.list();
  if (entries.length === 0) return 'Memory is empty.';
  const width = Math.max(...entries.map((entry) => entry.path.length));
  return entries
    .map(
      (entry) =>
        `${entry.layer === 1 ? '*' : ' '} ${entry.path.padEnd(width)}  ${String(entry.content.length).padStart(5)} chars  ${entry.updatedAt.slice(0, 10)}  ${entry.description}`,
    )
    .concat('', '* = always loaded into the prompt')
    .join('\n');
}

export function formatMemoryEntry(memory: MemoryStore, path: string): string {
  const entry = memory.get(path);
  if (!entry) return `No memory file "${path}".`;
  return `# ${entry.path} (updated ${entry.updatedAt.slice(0, 16)}Z)\n# ${entry.description}\n\n${entry.content}`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(2)}M` : `${Math.round(tokens / 1000)}k`;
}

function formatModel(info: ModelInfo): string {
  const price = info.cost
    ? `$${info.cost.input}/$${info.cost.output} per 1M (cached $${info.cost.cacheRead})`
    : 'price unknown';
  return `  ${formatModelRef(info.ref).padEnd(44)} ${formatTokens(info.contextLimit).padStart(6)} ctx  ${price}${info.imageInput ? '  [image]' : ''}`;
}

/** Models of every provider that has credentials, optionally filtered to one provider. */
export function formatModelList(registry: ProviderRegistry, providerFilter?: string): string {
  const providers = registry
    .available()
    .filter((provider) => !providerFilter || provider.id === providerFilter);
  if (providers.length === 0) {
    return providerFilter
      ? `No usable provider "${providerFilter}" (unknown id or missing API key).`
      : 'No provider has credentials yet. Put an API key in .env.';
  }
  return providers
    .map((provider) => [`${provider.name} (${provider.id})`, ...provider.models.map(formatModel)].join('\n'))
    .join('\n\n');
}
