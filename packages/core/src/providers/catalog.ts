import fs from 'node:fs';
import path from 'node:path';
import { type ProviderDef, ProviderDefSchema } from './settings.ts';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface CatalogOptions {
  /** Where the downloaded catalog is cached. */
  cachePath: string;
  url?: string;
  /** Never touch the network; use the cache only. */
  offline?: boolean;
  /** Re-download even if the cache is fresh. */
  refresh?: boolean;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * The models.dev catalog: providers, their SDK package and env vars, and per-model
 * limits, prices and capabilities. Entries are validated lazily so one odd record
 * upstream cannot break the rest.
 */
export class ModelCatalog {
  private readonly raw: Record<string, unknown>;
  private readonly cache = new Map<string, ProviderDef | null>();

  constructor(raw: Record<string, unknown> = {}) {
    this.raw = raw;
  }

  get isEmpty(): boolean {
    return Object.keys(this.raw).length === 0;
  }

  providerIds(): string[] {
    return Object.keys(this.raw);
  }

  provider(id: string): ProviderDef | undefined {
    if (!this.cache.has(id)) {
      const parsed = ProviderDefSchema.safeParse(this.raw[id]);
      this.cache.set(id, parsed.success ? parsed.data : null);
    }
    return this.cache.get(id) ?? undefined;
  }
}

function readCache(cachePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Loads the catalog from the local cache, refreshing it from models.dev when it is
 * missing or older than a day. A failed download falls back to whatever is cached.
 */
export async function loadCatalog(options: CatalogOptions): Promise<ModelCatalog> {
  const { cachePath } = options;
  const now = options.now?.() ?? Date.now();
  const cached = readCache(cachePath);
  const age = cached ? now - fs.statSync(cachePath).mtimeMs : Infinity;
  if (options.offline || (cached && age < MAX_AGE_MS && !options.refresh)) {
    return new ModelCatalog(cached ?? {});
  }

  try {
    const response = await (options.fetchFn ?? fetch)(options.url ?? MODELS_DEV_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('unexpected payload');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, text);
    return new ModelCatalog(parsed as Record<string, unknown>);
  } catch {
    return new ModelCatalog(cached ?? {});
  }
}
