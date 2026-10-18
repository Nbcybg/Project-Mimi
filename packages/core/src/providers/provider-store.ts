import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ProviderDefSchema, type ProviderDef } from './settings.ts';

/** A provider connected in the app: its definition and the model ids it offers. */
export interface StoredProvider {
  def: ProviderDef;
  models: string[];
}

/** Same rule the connect flow enforces: lowercase, digits, ".", "_" and "-". */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;

const fileSchema = z.object({
  def: ProviderDefSchema,
  models: z.array(z.string()).default([]),
});

/**
 * Provider definitions as files next to `agents/` and `skills/`, so a synced folder
 * carries them to another machine: `providers/<id>.json`. API keys never live here —
 * they stay in `user/data/auth.json` on the machine that entered them.
 */
export class ProviderStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  ids(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -5))
      .filter((id) => PROVIDER_ID.test(id))
      .sort();
  }

  get(id: string): StoredProvider | undefined {
    if (!PROVIDER_ID.test(id)) return undefined;
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`${file}: not valid JSON: ${(error as Error).message}`);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${file}: invalid provider definition:\n${z.prettifyError(parsed.error)}`);
    return parsed.data as StoredProvider;
  }

  list(): Record<string, StoredProvider> {
    const out: Record<string, StoredProvider> = {};
    for (const id of this.ids()) {
      const entry = this.get(id);
      if (entry) out[id] = entry;
    }
    return out;
  }

  defs(): Record<string, ProviderDef> {
    return Object.fromEntries(Object.entries(this.list()).map(([id, provider]) => [id, provider.def]));
  }

  listed(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(this.list()).map(([id, provider]) => [id, provider.models]));
  }

  save(id: string, provider: StoredProvider): void {
    if (!PROVIDER_ID.test(id)) throw new Error(`Invalid provider id "${id}".`);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${id}.json`), `${JSON.stringify(provider, null, 2)}\n`, 'utf8');
  }

  remove(id: string): boolean {
    const file = path.join(this.dir, `${id}.json`);
    if (!PROVIDER_ID.test(id) || !fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  /** One-time copy of providers from the old app-settings store; files already there win. */
  migrate(providers: Record<string, StoredProvider>): number {
    let copied = 0;
    for (const [id, provider] of Object.entries(providers)) {
      if (!PROVIDER_ID.test(id) || fs.existsSync(path.join(this.dir, `${id}.json`))) continue;
      this.save(id, provider);
      copied++;
    }
    return copied;
  }
}
