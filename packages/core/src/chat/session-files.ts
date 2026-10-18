import fs from 'node:fs';
import path from 'node:path';
import type { Chat, ChatStore, Session } from './chat-store.ts';

function writeJson(file: string, value: unknown): void {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === source) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, 'utf8');
}

function chatView(chat: Chat) {
  return { id: chat.id, kind: chat.kind, title: chat.title, agents: chat.agents, createdAt: chat.createdAt };
}

function sessionView(session: Session) {
  return {
    id: session.id,
    chatId: session.chatId,
    thread: session.thread,
    title: session.title,
    summary: session.summary,
    auto: session.auto,
    createdAt: session.createdAt,
    lastMessageAt: session.lastMessageAt,
  };
}

/**
 * Chats and sessions mirrored as files: `sessions/<chatId>/chat.json` plus one
 * `<sessionId>.json` per session. The database stays the source of truth; the files
 * make the chat list readable, syncable and easy to back up.
 */
export class SessionFiles {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  sync(chats: ChatStore): void {
    const all = chats.listChats();
    const known = new Map<number, Set<number>>();
    for (const chat of all) {
      writeJson(path.join(this.dir, String(chat.id), 'chat.json'), chatView(chat));
      known.set(chat.id, new Set());
    }
    for (const session of chats.allSessions(1_000_000)) {
      const ids = known.get(session.chatId);
      if (!ids) continue;
      ids.add(session.id);
      writeJson(path.join(this.dir, String(session.chatId), `${session.id}.json`), sessionView(session));
    }
    this.prune(known);
  }

  /** Removes folders of deleted chats and files of deleted sessions. */
  private prune(known: Map<number, Set<number>>): void {
    if (!fs.existsSync(this.dir)) return;
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      const chatId = Number(entry.name);
      if (!entry.isDirectory() || !Number.isInteger(chatId)) continue;
      const ids = known.get(chatId);
      const folder = path.join(this.dir, entry.name);
      if (!ids) {
        fs.rmSync(folder, { recursive: true, force: true });
        continue;
      }
      for (const file of fs.readdirSync(folder)) {
        const sessionId = /^(\d+)\.json$/.exec(file);
        if (sessionId && !ids.has(Number(sessionId[1]))) fs.rmSync(path.join(folder, file));
      }
    }
  }
}
