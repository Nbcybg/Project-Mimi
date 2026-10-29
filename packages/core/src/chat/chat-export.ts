import type { Db } from '../db/db.ts';
import { stripAttachments } from './attachments.ts';

interface MessageRow {
  chat_id: number;
  chat_kind: string;
  chat_title: string;
  chat_agents: string;
  session_id: number;
  session_title: string;
  message_id: number;
  created_at: string;
  role: string;
  agent: string;
  text: string;
}

interface AttachmentRow {
  message_id: number;
  name: string;
  mime: string;
  size: number;
  caption: string | null;
  deleted_at: string | null;
}

const HEADER = [
  'chat_id',
  'chat_kind',
  'chat_title',
  'session_id',
  'session_title',
  'message_id',
  'created_at',
  'role',
  'agent',
  'text',
  'attachments',
  'attachment_captions',
  'expired_attachments',
];

/** CSV field: always quoted, so commas, quotes and new lines inside a message survive. */
function field(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

/**
 * The whole conversation as CSV, one row per user/assistant message. Media bytes are
 * not included: the file name, caption and whether it expired are.
 */
export function chatCsv(db: Db, chatId?: number): { csv: string; filename: string } | null {
  if (chatId !== undefined) {
    const exists = db.prepare(`SELECT 1 FROM chats WHERE id = ?`).get(chatId);
    if (!exists) return null;
  }
  const where = chatId === undefined ? '' : 'WHERE c.id = ?';
  const params = chatId === undefined ? [] : [chatId];
  const rows = db
    .prepare(
      `SELECT c.id AS chat_id, c.kind AS chat_kind, c.title AS chat_title, c.agents AS chat_agents,
              s.id AS session_id, s.title AS session_title,
              m.id AS message_id, m.created_at, m.role, m.agent, m.text
         FROM messages m
         JOIN sessions s ON s.thread = m.thread
         JOIN chats c ON c.id = s.chat_id
         ${where}
        ${where ? 'AND' : 'WHERE'} m.role IN ('user', 'assistant')
        ORDER BY m.id`,
    )
    .all(...params) as MessageRow[];

  const attachments = new Map<number, AttachmentRow[]>();
  const found = db
    .prepare(
      `SELECT a.message_id, a.name, a.mime, a.size, a.caption, a.deleted_at
         FROM attachments a
         JOIN messages m ON m.id = a.message_id
         JOIN sessions s ON s.thread = m.thread
         JOIN chats c ON c.id = s.chat_id
         ${where}
        ${where ? 'AND' : 'WHERE'} m.role IN ('user', 'assistant')
        ORDER BY a.created_at, a.id`,
    )
    .all(...params) as AttachmentRow[];
  for (const row of found) {
    const list = attachments.get(row.message_id) ?? [];
    list.push(row);
    attachments.set(row.message_id, list);
  }

  const lines = [HEADER.map(field).join(',')];
  for (const row of rows) {
    const files = attachments.get(row.message_id) ?? [];
    const title = row.chat_title || safeAgents(row.chat_agents);
    lines.push(
      [
        row.chat_id,
        row.chat_kind,
        title,
        row.session_id,
        row.session_title,
        row.message_id,
        row.created_at,
        row.role,
        row.agent,
        stripAttachments(row.text),
        files.map((file) => file.name).join(' | '),
        files.map((file) => file.caption ?? '').join(' | '),
        files.filter((file) => file.deleted_at).map((file) => `${file.name} (${file.mime}, ${file.size} bytes)`).join(' | '),
      ]
        .map(field)
        .join(','),
    );
  }

  const day = new Date().toISOString().slice(0, 10);
  return {
    csv: lines.join('\r\n'),
    filename: chatId === undefined ? `mimi-chats-${day}.csv` : `mimi-chat-${chatId}-${day}.csv`,
  };
}

function safeAgents(raw: string): string {
  try {
    const names = JSON.parse(raw) as unknown;
    return Array.isArray(names) ? names.map(String).join(', ') : String(raw);
  } catch {
    return raw;
  }
}
