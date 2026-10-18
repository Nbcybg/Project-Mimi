-- Schema v1. Timestamps are UTC ISO-8601 strings.

-- Layer 3 memory: the raw message log. Rows are never deleted.
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread     TEXT NOT NULL DEFAULT 'main',
  trace_id   TEXT NOT NULL,
  agent      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content    TEXT NOT NULL,            -- JSON: provider-layer message content
  text       TEXT NOT NULL DEFAULT '', -- plain text for display + full-text search
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_messages_thread ON messages (thread, id);
CREATE INDEX idx_messages_trace ON messages (trace_id);

-- Trigram tokenizer: Thai has no word boundaries, so substring matching is what works.
CREATE VIRTUAL TABLE messages_fts USING fts5 (
  text,
  content = 'messages',
  content_rowid = 'id',
  tokenize = 'trigram'
);
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;

-- Layer 1 (always loaded) and layer 2 (on demand) memory files.
CREATE TABLE memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL UNIQUE,     -- e.g. profile, preferences, projects/mimi
  layer       INTEGER NOT NULL CHECK (layer IN (1, 2)),
  description TEXT NOT NULL DEFAULT '', -- one-line entry shown in the memory index
  content     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Rolling summaries; each covers a contiguous range of raw messages.
CREATE TABLE summaries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  thread          TEXT NOT NULL DEFAULT 'main',
  from_message_id INTEGER NOT NULL REFERENCES messages (id),
  to_message_id   INTEGER NOT NULL REFERENCES messages (id),
  content         TEXT NOT NULL,        -- structured by topic
  token_estimate  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_summaries_thread ON summaries (thread, to_message_id);

-- Mesh: agent-to-agent messages. The core routes these between inboxes.
CREATE TABLE agent_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id        TEXT NOT NULL,
  from_agent      TEXT NOT NULL,
  to_agent        TEXT NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'delegate' CHECK (mode IN ('delegate', 'handoff')),
  task            TEXT NOT NULL,
  context         TEXT NOT NULL DEFAULT '',
  expected_result TEXT NOT NULL DEFAULT '',
  reply_to        INTEGER REFERENCES agent_messages (id),
  result          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'replied', 'failed', 'timeout')),
  hop_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_agent_messages_inbox ON agent_messages (to_agent, status);
CREATE INDEX idx_agent_messages_trace ON agent_messages (trace_id);

CREATE TABLE triggers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('reminder', 'agent_task')),
  fire_at       TEXT,                   -- one-shot time, or
  cron          TEXT,                   -- recurring schedule
  payload       TEXT NOT NULL DEFAULT '{}',
  agent         TEXT,
  repeat        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'fired', 'cancelled')),
  device_synced INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (fire_at IS NOT NULL OR cron IS NOT NULL)
);
CREATE INDEX idx_triggers_status ON triggers (status, fire_at);

-- One row per agent loop run.
CREATE TABLE agent_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id      TEXT NOT NULL,
  agent         TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  rounds        INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'running',
  error         TEXT,
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_agent_runs_trace ON agent_runs (trace_id);

-- One row per model call.
CREATE TABLE usage_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER REFERENCES agent_runs (id),
  trace_id      TEXT NOT NULL,
  agent         TEXT NOT NULL,
  capability    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_usage_log_created ON usage_log (created_at);
