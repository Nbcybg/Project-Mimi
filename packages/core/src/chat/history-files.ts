import fs from 'node:fs';
import path from 'node:path';
import type { StoredMessage } from '@mimi/shared';
import type { MessagesRepo } from '../db/messages-repo.ts';

/**
 * The raw message log mirrored as `history/<thread>.jsonl`, one complete message per
 * line. The database stays the source of truth; the files make the conversation
 * readable, greppable and easy to back up. Threads other than sessions (scheduled
 * tasks, skill jobs) get their own file too.
 */
export class HistoryFiles {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(thread: string): string {
    const safe = thread.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'main';
    return path.join(this.dir, `${safe}.jsonl`);
  }

  append(message: StoredMessage): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file(message.thread), `${JSON.stringify(message)}\n`, 'utf8');
  }

  /**
   * Exports whatever the files are missing: a thread with no file gets its whole log,
   * an existing file gets the messages appended since its last line.
   */
  sync(messages: MessagesRepo): void {
    for (const thread of messages.threads()) {
      for (const message of messages.full(thread, this.lastId(this.file(thread)))) {
        this.append(message);
      }
    }
  }

  /** The id of the last line, or 0 when the file is missing or unreadable. */
  private lastId(file: string): number {
    if (!fs.existsSync(file)) return 0;
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    try {
      const parsed = JSON.parse(lines[lines.length - 1]!) as { id?: unknown };
      return typeof parsed.id === 'number' ? parsed.id : 0;
    } catch {
      return 0;
    }
  }
}
