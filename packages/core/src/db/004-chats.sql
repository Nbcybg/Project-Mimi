-- Schema v4: chats (one-to-one and group), sessions, attachments, agent state.

-- A conversation the user can open: one agent (direct) or several (group).
CREATE TABLE chats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  title      TEXT NOT NULL DEFAULT '',
  agents     TEXT NOT NULL, -- JSON array of agent names; the first one answers when nobody is addressed
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A session is one stretch of a chat with its own context window. New ones start by
-- themselves after a long silence; each maps to exactly one message thread.
CREATE TABLE sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         INTEGER NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  thread          TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL DEFAULT '',
  summary         TEXT NOT NULL DEFAULT '', -- written when the session is closed
  auto            INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_message_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_sessions_chat ON sessions (chat_id, id);

-- Rewinding a conversation hides messages; the raw log itself is never deleted.
ALTER TABLE messages ADD COLUMN hidden_at TEXT;

-- Files the user sent. `text` holds what the models can read of it: an image
-- description, a voice transcript, or the extracted text of a document.
CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  message_id INTEGER REFERENCES messages (id),
  kind       TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'file')),
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_attachments_message ON attachments (message_id);

-- What an agent is doing right now: location, outfit, current_task, mood.
CREATE TABLE agent_status (
  agent      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (agent, key)
);

-- An agent's own notes, kept by key.
CREATE TABLE memos (
  agent      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (agent, key)
);
