import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { MemoryEntry } from './store.ts';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The memory table mirrored as readable files: `memory/<path>.md`, one Markdown file
 * per memory entry with its index description in the frontmatter. The database stays
 * the source of truth; the files make memory syncable and easy to back up.
 */
export class MemoryFiles {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(filePath: string): string {
    return path.join(this.dir, `${filePath}.md`);
  }

  private render(entry: MemoryEntry): string {
    const frontmatter = stringifyYaml({
      description: entry.description,
      updated_at: entry.updatedAt,
    }).trimEnd();
    return `---\n${frontmatter}\n---\n${entry.content.trim()}\n`;
  }

  write(entry: MemoryEntry): void {
    const file = this.file(entry.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, this.render(entry), 'utf8');
  }

  remove(filePath: string): void {
    fs.rmSync(this.file(filePath), { force: true });
  }

  /** Exports every entry and drops files whose entry is gone. */
  sync(entries: MemoryEntry[]): void {
    const known = new Set(entries.map((entry) => entry.path));
    for (const entry of entries) {
      const file = this.file(entry.path);
      const source = this.render(entry);
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== source) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source, 'utf8');
      }
    }
    for (const relative of this.paths()) {
      if (!known.has(relative)) fs.rmSync(this.file(relative));
    }
  }

  /** The paths of every mirrored file, relative to the memory folder, without `.md`. */
  paths(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith('.md')) files.push(file);
      }
    };
    walk(this.dir);
    return files.map((file) => path.relative(this.dir, file).replaceAll(path.sep, '/').slice(0, -3));
  }

  /** Reads a mirrored file back into a memory entry; used when the file is imported by hand. */
  read(filePath: string): { description: string; content: string } | undefined {
    const file = this.file(filePath);
    if (!fs.existsSync(file)) return undefined;
    const source = fs.readFileSync(file, 'utf8');
    const match = FRONTMATTER.exec(source);
    let description = '';
    if (match) {
      try {
        const parsed = parseYaml(match[1]!) as { description?: unknown } | null;
        if (parsed && typeof parsed.description === 'string') description = flatten(parsed.description);
      } catch {
        // a hand-broken frontmatter still leaves the content readable
      }
    }
    return { description, content: source.replace(FRONTMATTER, '').trim() };
  }
}
