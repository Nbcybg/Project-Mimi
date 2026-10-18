import type { Db } from '../db/db.ts';

export interface MemoryEntry {
  path: string;
  /** 1 = always in the prompt (profile, preferences); 2 = opened on demand. */
  layer: 1 | 2;
  description: string;
  content: string;
  updatedAt: string;
}

export interface MemoryWrite {
  path: string;
  description?: string;
  content: string;
}

export interface MemoryLimits {
  /** Hard cap for each layer-1 file. */
  profileMaxChars: number;
  fileMaxChars: number;
}

/** A rejected memory write; the message is safe to show to the user or hand to a model. */
export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryError';
  }
}

export const LAYER1_PATHS = ['profile', 'preferences'] as const;
const PATH_PATTERN = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*){0,3}$/;
const DESCRIPTION_MAX_CHARS = 200;
const DEFAULT_LIMITS: MemoryLimits = { profileMaxChars: 4000, fileMaxChars: 20_000 };

const LAYER1_DESCRIPTIONS: Record<string, string> = {
  profile: 'Who the user is: identity, work, family, standing facts',
  preferences: 'How the user wants things done: tone, formats, habits',
};

function layerOf(path: string): 1 | 2 {
  return (LAYER1_PATHS as readonly string[]).includes(path) ? 1 : 2;
}

interface MemoryRow {
  path: string;
  layer: 1 | 2;
  description: string;
  content: string;
  updated_at: string;
}

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    path: row.path,
    layer: row.layer,
    description: row.description,
    content: row.content,
    updatedAt: row.updated_at,
  };
}

/**
 * Layer 1 + 2 memory. Layer 1 (`profile`, `preferences`) is always in the prompt
 * and size-capped; everything else is a topic file listed in a one-line index
 * and opened on demand.
 */
export class MemoryStore {
  private readonly db: Db;
  private readonly limits: MemoryLimits;
  /** Called after a file is written or replaced; the memory mirror listens here. */
  onChange?: (entry: MemoryEntry) => void;
  /** Called after a file is deleted; the memory mirror listens here. */
  onDelete?: (path: string) => void;

  constructor(db: Db, limits: Partial<MemoryLimits> = {}) {
    this.db = db;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  list(): MemoryEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM memories ORDER BY layer, path`)
      .all() as MemoryRow[];
    return rows.map(toEntry);
  }

  get(path: string): MemoryEntry | undefined {
    const row = this.db.prepare(`SELECT * FROM memories WHERE path = ?`).get(path) as
      | MemoryRow
      | undefined;
    return row && toEntry(row);
  }

  /** Creates or replaces a memory file. Throws MemoryError when a rule is violated. */
  write(write: MemoryWrite): MemoryEntry {
    const path = write.path.trim();
    if (!PATH_PATTERN.test(path)) {
      throw new MemoryError(
        `Invalid memory path "${write.path}". Use lowercase names like "profile" or "projects/garden".`,
      );
    }
    const layer = layerOf(path);
    const content = write.content.trim();
    if (!content) throw new MemoryError('Memory content is empty; delete the file instead.');
    const max = layer === 1 ? this.limits.profileMaxChars : this.limits.fileMaxChars;
    if (content.length > max) {
      throw new MemoryError(
        `"${path}" would be ${content.length} characters; the limit is ${max}. Condense it${layer === 1 ? ' or move details into a topic file' : ''}.`,
      );
    }
    const existing = this.get(path);
    const description = (write.description ?? existing?.description ?? LAYER1_DESCRIPTIONS[path] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, DESCRIPTION_MAX_CHARS);
    if (layer === 2 && !description) {
      throw new MemoryError(`"${path}" needs a one-line description for the memory index.`);
    }

    this.db
      .prepare(
        `INSERT INTO memories (path, layer, description, content)
         VALUES (@path, @layer, @description, @content)
         ON CONFLICT (path) DO UPDATE SET
           description = excluded.description,
           content = excluded.content,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run({ path, layer, description, content });
    const entry = this.get(path)!;
    this.onChange?.(entry);
    return entry;
  }

  /** Adds a line to a file, creating it if needed. */
  append(path: string, line: string, description?: string): MemoryEntry {
    const existing = this.get(path.trim());
    const content = existing ? `${existing.content}\n${line.trim()}` : line.trim();
    return this.write({ path, description, content });
  }

  delete(path: string): boolean {
    const removed = this.db.prepare(`DELETE FROM memories WHERE path = ?`).run(path.trim()).changes > 0;
    if (removed) this.onDelete?.(path.trim());
    return removed;
  }

  /**
   * Renders the always-loaded block: layer-1 files in full plus a one-line index of
   * the rest. Deterministic for a given memory state, so it can be snapshotted.
   */
  renderSnapshot(): string {
    const entries = this.list();
    const lines = ['## Memory'];
    for (const path of LAYER1_PATHS) {
      const entry = entries.find((candidate) => candidate.path === path);
      lines.push(`<memory path="${path}">`, entry?.content ?? '(empty)', '</memory>');
    }
    const index = entries.filter((entry) => entry.layer === 2);
    lines.push('', '### Memory index');
    if (index.length === 0) lines.push('(no topic files yet)');
    for (const entry of index) lines.push(`- ${entry.path}: ${entry.description}`);
    return lines.join('\n');
  }
}
