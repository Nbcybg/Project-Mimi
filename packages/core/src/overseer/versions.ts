import fs from 'node:fs';
import path from 'node:path';

/** How many old versions of one item are kept. */
const KEEP = 10;

export type VersionKind = 'agent' | 'tool' | 'preset' | 'skill' | 'workflow';

export interface VersionEntry<T = unknown> {
  id: string;
  at: string;
  data: T;
}

interface VersionFile<T> extends VersionEntry<T> {
  kind: VersionKind;
  name: string;
}

/**
 * Snapshots of the Overseer's own writes. Saving an agent, tool, preset, skill or
 * workflow puts the previous version here first, so a bad change can be restored.
 * Files live under user/snapshots/<kind>/<name>/<timestamp>.json.
 */
export class VersionStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private folder(kind: VersionKind, name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
    return path.join(this.dir, kind, safe);
  }

  /** Stores `data` unless it is identical to the newest snapshot. Returns the snapshot id. */
  save(kind: VersionKind, name: string, data: unknown): string | null {
    const folder = this.folder(kind, name);
    const json = JSON.stringify(data);
    const existing = this.list(kind, name, 1)[0];
    if (existing && JSON.stringify(existing.data) === json) return existing.id;
    fs.mkdirSync(folder, { recursive: true });
    const at = new Date().toISOString();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const file: VersionFile<unknown> = { id, at, kind, name, data };
    fs.writeFileSync(path.join(folder, `${id}.json`), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    this.prune(folder);
    return id;
  }

  list(kind: VersionKind, name: string, limit = KEEP): VersionEntry[] {
    const folder = this.folder(kind, name);
    if (!fs.existsSync(folder)) return [];
    const entries: VersionEntry[] = [];
    for (const file of fs.readdirSync(folder).filter((entry) => entry.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')) as VersionFile<unknown>;
        if (parsed && typeof parsed.id === 'string' && parsed.data !== undefined) {
          entries.push({ id: parsed.id, at: parsed.at, data: parsed.data });
        }
      } catch {
        // a half-written snapshot must not hide the good ones
      }
    }
    return entries.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, limit);
  }

  get<T>(kind: VersionKind, name: string, id: string): VersionEntry<T> | undefined {
    if (!/^[a-z0-9-]+$/i.test(id)) return undefined;
    const file = path.join(this.folder(kind, name), `${id}.json`);
    if (!fs.existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as VersionFile<T>;
      return { id: parsed.id, at: parsed.at, data: parsed.data };
    } catch {
      return undefined;
    }
  }

  private prune(folder: string): void {
    const files = fs
      .readdirSync(folder)
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .reverse();
    for (const old of files.slice(KEEP)) {
      try {
        fs.rmSync(path.join(folder, old));
      } catch {
        // a file in use stays until the next save
      }
    }
  }
}
