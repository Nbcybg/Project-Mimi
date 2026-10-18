import type { MessageRole, StoredMessage } from '@mimi/shared';
import type { Db } from './db.ts';

export interface NewMessage {
  thread: string;
  traceId: string;
  agent: string;
  role: MessageRole;
  content: unknown;
  text: string;
  /** Volatile prompt block sent along with a user message. */
  context?: string;
}

interface MessageRow {
  id: number;
  thread: string;
  trace_id: string;
  agent: string;
  role: MessageRole;
  content: string;
  text: string;
  context: string | null;
  reply_to: number | null;
  forward_from: string | null;
  forward_chat: string | null;
  created_at: string;
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    thread: row.thread,
    traceId: row.trace_id,
    agent: row.agent,
    role: row.role,
    content: JSON.parse(row.content),
    text: row.text,
    context: row.context ?? undefined,
    replyTo: row.reply_to ?? undefined,
    forwardFrom: row.forward_from ?? undefined,
    forwardChat: row.forward_chat ?? undefined,
    createdAt: row.created_at,
  };
}

/** Quotes a term for FTS5 so user input is never parsed as query syntax. */
function ftsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/** The raw message log. Rows are only ever appended; rewinding hides rows instead of deleting them. */
export class MessagesRepo {
  private readonly db: Db;
  /** Called after a message is appended; the history mirror listens here. */
  onAppend?: (message: StoredMessage) => void;

  constructor(db: Db) {
    this.db = db;
  }

  append(message: NewMessage): number {
    const result = this.db
      .prepare(
        `INSERT INTO messages (thread, trace_id, agent, role, content, text, context)
         VALUES (@thread, @traceId, @agent, @role, @content, @text, @context)`,
      )
      .run({
        ...message,
        content: JSON.stringify(message.content),
        context: message.context ?? null,
      });
    const id = Number(result.lastInsertRowid);
    const stored = this.get(id);
    if (stored) this.onAppend?.(stored);
    return id;
  }

  /** Records that a stored message replies to another one, or came in as a forward. */
  setMeta(id: number, meta: { replyTo?: number; forwardFrom?: string; forwardChat?: string }): void {
    this.db
      .prepare(
        `UPDATE messages
            SET reply_to = COALESCE(@replyTo, reply_to),
                forward_from = COALESCE(@forwardFrom, forward_from),
                forward_chat = COALESCE(@forwardChat, forward_chat)
          WHERE id = @id`,
      )
      .run({
        id,
        replyTo: meta.replyTo ?? null,
        forwardFrom: meta.forwardFrom ?? null,
        forwardChat: meta.forwardChat ?? null,
      });
  }

  /** Messages of a thread with id > `afterId`, oldest first. */
  after(thread: string, afterId: number): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE thread = ? AND id > ? AND hidden_at IS NULL ORDER BY id`)
      .all(thread, afterId) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Every thread that has messages, including hidden ones and background threads. */
  threads(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT thread FROM messages ORDER BY thread`).all() as Array<{ thread: string }>;
    return rows.map((row) => row.thread);
  }

  /** The whole raw log of a thread with id > `afterId`, oldest first; hidden rows included. */
  full(thread: string, afterId = 0): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE thread = ? AND id > ? ORDER BY id`)
      .all(thread, afterId) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Messages of a thread with `fromId <= id <= toId`, oldest first. */
  range(thread: string, fromId: number, toId: number, limit = 1000): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE thread = ? AND id BETWEEN ? AND ? AND hidden_at IS NULL ORDER BY id LIMIT ?`)
      .all(thread, fromId, toId, limit) as MessageRow[];
    return rows.map(toMessage);
  }

  /** What a chat client shows: the spoken messages before `beforeId`, oldest first. */
  page(thread: string, beforeId: number | undefined, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
          WHERE thread = ? AND role IN ('user', 'assistant') AND text != '' AND id < ? AND hidden_at IS NULL
          ORDER BY id DESC LIMIT ?`,
      )
      .all(thread, beforeId ?? Number.MAX_SAFE_INTEGER, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  /**
   * Like `page`, but assistant steps that only called tools are included too, so a
   * client can show what the agent did between its messages.
   */
  timeline(thread: string, beforeId: number | undefined, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
          WHERE thread = ? AND id < ? AND hidden_at IS NULL
            AND ((role = 'user' AND text != '') OR role = 'assistant')
          ORDER BY id DESC LIMIT ?`,
      )
      .all(thread, beforeId ?? Number.MAX_SAFE_INTEGER, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  byTrace(traceId: string): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE trace_id = ? AND hidden_at IS NULL ORDER BY id`)
      .all(traceId) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * Full-text search, newest first. Every whitespace-separated term must appear.
   * The index is trigram based, so terms shorter than 3 characters use a plain scan.
   * Pass several threads to search across sessions.
   */
  search(thread: string | string[], query: string, limit = 20): StoredMessage[] {
    const terms = query.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const indexed = terms.filter((term) => [...term].length >= 3);
    const scanned = terms.filter((term) => [...term].length < 3);

    const threads = Array.isArray(thread) ? thread : [thread];
    if (threads.length === 0) return [];
    const where = [`m.thread IN (${threads.map(() => '?').join(', ')})`, 'm.hidden_at IS NULL'];
    const params: unknown[] = [...threads];
    if (indexed.length > 0) {
      where.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
      params.push(indexed.map(ftsTerm).join(' AND '));
    }
    for (const term of scanned) {
      where.push(`m.text LIKE ? ESCAPE '\\'`);
      params.push(`%${term.replace(/[\\%_]/g, '\\$&')}%`);
    }
    const rows = this.db
      .prepare(`SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`)
      .all(...params, limit) as MessageRow[];
    return rows.map(toMessage);
  }
  /** Hides a message and everything after it in its thread (rewind). Returns how many rows were hidden. */
  hideFrom(thread: string, fromId: number): number {
    return this.db
      .prepare(
        `UPDATE messages SET hidden_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE thread = ? AND id >= ? AND hidden_at IS NULL`,
      )
      .run(thread, fromId).changes;
  }

  get(id: number): StoredMessage | undefined {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = ? AND hidden_at IS NULL`).get(id) as
      | MessageRow
      | undefined;
    return row && toMessage(row);
  }
}
