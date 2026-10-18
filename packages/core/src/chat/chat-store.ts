import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db.ts';

export interface Chat {
  id: number;
  kind: 'direct' | 'group';
  title: string;
  /** Member agents; the first one answers when nobody is addressed. */
  agents: string[];
  createdAt: string;
}

export interface Session {
  id: number;
  chatId: number;
  /** The message thread that holds this session's conversation. */
  thread: string;
  title: string;
  summary: string;
  auto: boolean;
  createdAt: string;
  lastMessageAt: string;
}

interface ChatRow {
  id: number;
  kind: 'direct' | 'group';
  title: string;
  agents: string;
  created_at: string;
}
interface SessionRow {
  id: number;
  chat_id: number;
  thread: string;
  title: string;
  summary: string;
  auto: number;
  created_at: string;
  last_message_at: string;
}

const toChat = (row: ChatRow): Chat => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  agents: JSON.parse(row.agents) as string[],
  createdAt: row.created_at,
});
const toSession = (row: SessionRow): Session => ({
  id: row.id,
  chatId: row.chat_id,
  thread: row.thread,
  title: row.title,
  summary: row.summary,
  auto: row.auto === 1,
  createdAt: row.created_at,
  lastMessageAt: row.last_message_at,
});

/**
 * Chats and their sessions. A chat is who you talk to (one agent, or a group); a
 * session is one stretch of that conversation. Sessions begin by themselves after a
 * long silence, so the user never has to create one.
 */
export class ChatStore {
  private readonly db: Db;
  private readonly now: () => Date;
  /** Called after every change; the session mirror listens here. */
  onChange?: () => void;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  private changed(): void {
    this.onChange?.();
  }

  listChats(): Chat[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM chats c
          ORDER BY (SELECT MAX(s.last_message_at) FROM sessions s WHERE s.chat_id = c.id) DESC, c.id DESC`,
      )
      .all() as ChatRow[];
    return rows.map(toChat);
  }

  getChat(id: number): Chat | undefined {
    const row = this.db.prepare(`SELECT * FROM chats WHERE id = ?`).get(id) as ChatRow | undefined;
    return row && toChat(row);
  }

  createChat(chat: { kind: 'direct' | 'group'; agents: string[]; title?: string }): Chat {
    const agents = [...new Set(chat.agents)];
    if (agents.length === 0) throw new Error('A chat needs at least one agent.');
    if (chat.kind === 'direct' && agents.length !== 1) throw new Error('A one-to-one chat has exactly one agent.');
    if (chat.kind === 'group' && agents.length < 2) throw new Error('A group chat needs at least two agents.');
    const id = Number(
      this.db
        .prepare(`INSERT INTO chats (kind, title, agents) VALUES (?, ?, ?)`)
        .run(chat.kind, chat.title?.trim() ?? '', JSON.stringify(agents)).lastInsertRowid,
    );
    this.changed();
    return this.getChat(id)!;
  }

  /** The one-to-one chat with an agent, created the first time it is needed. */
  directChat(agent: string): Chat {
    const existing = this.listChats().find((chat) => chat.kind === 'direct' && chat.agents[0] === agent);
    return existing ?? this.createChat({ kind: 'direct', agents: [agent] });
  }

  updateChat(id: number, change: { title?: string; agents?: string[] }): Chat {
    const chat = this.getChat(id);
    if (!chat) throw new Error(`No chat #${id}.`);
    const agents = change.agents ? [...new Set(change.agents)] : chat.agents;
    if (chat.kind === 'group' && agents.length < 2) throw new Error('A group chat needs at least two agents.');
    this.db
      .prepare(`UPDATE chats SET title = ?, agents = ? WHERE id = ?`)
      .run(change.title?.trim() ?? chat.title, JSON.stringify(agents), id);
    this.changed();
    return this.getChat(id)!;
  }

  deleteChat(id: number): void {
    this.db.prepare(`DELETE FROM chats WHERE id = ?`).run(id);
    this.changed();
  }

  /** Removes an agent that no longer exists from every chat; chats left without members go too. */
  forgetAgent(agent: string): void {
    for (const chat of this.listChats()) {
      if (!chat.agents.includes(agent)) continue;
      const rest = chat.agents.filter((name) => name !== agent);
      if (rest.length === 0 || (chat.kind === 'group' && rest.length < 2)) this.deleteChat(chat.id);
      else {
        this.db.prepare(`UPDATE chats SET agents = ? WHERE id = ?`).run(JSON.stringify(rest), chat.id);
        this.changed();
      }
    }
  }

  sessions(chatId: number, limit = 50): Session[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE chat_id = ? ORDER BY id DESC LIMIT ?`)
      .all(chatId, limit) as SessionRow[];
    return rows.map(toSession);
  }

  getSession(id: number): Session | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    return row && toSession(row);
  }

  sessionByThread(thread: string): Session | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE thread = ?`).get(thread) as SessionRow | undefined;
    return row && toSession(row);
  }

  newSession(chatId: number, auto: boolean): Session {
    const stamp = this.now().toISOString();
    const id = Number(
      this.db
        .prepare(`INSERT INTO sessions (chat_id, thread, auto, created_at, last_message_at) VALUES (?, ?, ?, ?, ?)`)
        .run(chatId, `s-${randomUUID()}`, auto ? 1 : 0, stamp, stamp).lastInsertRowid,
    );
    this.changed();
    return this.getSession(id)!;
  }

  /**
   * The session a new message belongs to. If the chat has been silent for longer than
   * `idleMs`, a new session starts by itself; `previous` is then the one that just ended.
   */
  currentSession(chatId: number, idleMs: number): { session: Session; previous: Session | null; started: boolean } {
    const [latest] = this.sessions(chatId, 1);
    if (!latest) return { session: this.newSession(chatId, true), previous: null, started: true };
    const idle = this.now().getTime() - new Date(latest.lastMessageAt).getTime();
    // A session nobody has written in yet is reused, however old it is.
    const empty = latest.lastMessageAt === latest.createdAt && !this.hasMessages(latest.thread);
    if (idle <= idleMs || empty) return { session: latest, previous: null, started: false };
    return { session: this.newSession(chatId, true), previous: latest, started: true };
  }

  private hasMessages(thread: string): boolean {
    return this.db.prepare(`SELECT 1 FROM messages WHERE thread = ? LIMIT 1`).get(thread) !== undefined;
  }

  /** The session before `session` in the same chat, whose summary carries context forward. */
  previousSession(session: Session): Session | undefined {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT 1`)
      .get(session.chatId, session.id) as SessionRow | undefined;
    return row && toSession(row);
  }

  /** Recent sessions of every chat `agent` takes part in, newest first, with the chat they belong to. */
  sessionsFor(agent: string, limit = 30): Array<{ session: Session; chat: Chat }> {
    const chats = new Map(
      this.listChats()
        .filter((chat) => chat.agents.includes(agent))
        .map((chat) => [chat.id, chat]),
    );
    if (chats.size === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE chat_id IN (${[...chats.keys()].map(() => '?').join(', ')})
          ORDER BY last_message_at DESC, id DESC LIMIT ?`,
      )
      .all(...chats.keys(), limit) as SessionRow[];
    return rows.map((row) => ({ session: toSession(row), chat: chats.get(row.chat_id)! }));
  }

  /** Every session, newest first: what a search across all chats covers. */
  allSessions(limit = 2000): Session[] {
    const rows = this.db.prepare(`SELECT * FROM sessions ORDER BY id DESC LIMIT ?`).all(limit) as SessionRow[];
    return rows.map(toSession);
  }

  /** Keeps an agent in its chats under a new name. */
  renameAgent(from: string, to: string): void {
    for (const chat of this.listChats()) {
      if (!chat.agents.includes(from)) continue;
      const agents = chat.agents.map((name) => (name === from ? to : name));
      this.db.prepare(`UPDATE chats SET agents = ? WHERE id = ?`).run(JSON.stringify(agents), chat.id);
      this.changed();
    }
  }

  touch(sessionId: number): void {
    this.db.prepare(`UPDATE sessions SET last_message_at = ? WHERE id = ?`).run(this.now().toISOString(), sessionId);
    this.changed();
  }

  describe(sessionId: number, change: { title?: string; summary?: string }): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    this.db
      .prepare(`UPDATE sessions SET title = ?, summary = ? WHERE id = ?`)
      .run(change.title ?? session.title, change.summary ?? session.summary, sessionId);
    this.changed();
  }
}
