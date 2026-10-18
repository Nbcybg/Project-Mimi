import fs from 'node:fs';
import path from 'node:path';
import { resolveAllowedPath } from '@mimi/pc-agent';
import type { Db } from '../db/db.ts';
import type { PcLink, ToolExecutor } from '../tools/executor.ts';
import type { ToolContext, ToolDefinition } from '../tools/registry.ts';

/** Files bigger than this are not snapshotted (the rewind says so instead of restoring). */
const MAX_SNAPSHOT = 5 * 1024 * 1024;
const KEEP_DAYS = 30;

interface SnapshotRow {
  id: number;
  path: string;
  existed: number;
  content: Buffer | null;
}

/**
 * What a file looked like before an agent overwrote it, so going back in a chat can
 * put the file back too. Only files written on this machine are covered; a write done
 * by a PC agent on another computer happens out of reach.
 */
export class FileSnapshots {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    db.prepare(`DELETE FROM file_snapshots WHERE created_at < ?`).run(new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString());
  }

  /** Records a file's current state before it is written. */
  remember(thread: string, traceId: string, file: string): void {
    let existed = 0;
    let content: Buffer | null = null;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return;
      existed = 1;
      content = stat.size <= MAX_SNAPSHOT ? fs.readFileSync(file) : null;
    } catch {
      // did not exist yet: going back deletes it
    }
    this.db
      .prepare('INSERT INTO file_snapshots (thread, trace_id, path, existed, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(thread, traceId, file, existed, content, new Date().toISOString());
  }

  /**
   * Puts back every file written in `thread` since `sinceIso`, newest change first, so
   * each file ends as it was before the first of those writes. Returns what happened.
   */
  restoreSince(thread: string, sinceIso: string): { restored: string[]; skipped: string[] } {
    const rows = this.db
      .prepare('SELECT id, path, existed, content FROM file_snapshots WHERE thread = ? AND created_at >= ? ORDER BY id DESC')
      .all(thread, sinceIso) as SnapshotRow[];
    const restored = new Set<string>();
    const skipped = new Set<string>();
    for (const row of rows) {
      try {
        if (!row.existed) fs.rmSync(row.path, { force: true });
        else if (row.content === null) {
          skipped.add(row.path);
          continue;
        } else {
          fs.mkdirSync(path.dirname(row.path), { recursive: true });
          fs.writeFileSync(row.path, row.content);
        }
        restored.add(row.path);
      } catch {
        skipped.add(row.path);
      }
    }
    this.db.prepare('DELETE FROM file_snapshots WHERE thread = ? AND created_at >= ?').run(thread, sinceIso);
    return { restored: [...restored].filter((file) => !skipped.has(file)), skipped: [...skipped] };
  }
}

/**
 * Wraps the executor: before write_file runs on this machine, the file's current state
 * is remembered. Writes routed to a connected PC agent are passed through untouched.
 */
export class SnapshotExecutor implements ToolExecutor {
  private readonly inner: ToolExecutor;
  private readonly snapshots: FileSnapshots;
  private readonly pc: PcLink | undefined;
  private readonly localPcTools: boolean;

  constructor(inner: ToolExecutor, snapshots: FileSnapshots, options: { pc?: PcLink; localPcTools: boolean }) {
    this.inner = inner;
    this.snapshots = snapshots;
    this.pc = options.pc;
    this.localPcTools = options.localPcTools;
  }

  async execute(tool: ToolDefinition, input: unknown, context: ToolContext): Promise<string> {
    const local = tool.target !== 'pc' || (!this.pc?.online && this.localPcTools);
    if (tool.name === 'write_file' && local) {
      const requested = (input as { path?: unknown }).path;
      if (typeof requested === 'string') {
        try {
          this.snapshots.remember(context.thread, context.traceId, resolveAllowedPath(requested, context.allowedDirs));
        } catch {
          // outside the allowed folders: the tool itself refuses it
        }
      }
    }
    return this.inner.execute(tool, input, context);
  }
}
