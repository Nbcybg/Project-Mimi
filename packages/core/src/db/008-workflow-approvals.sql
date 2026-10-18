-- Schema v8: approval requests a workflow posts into a chat and waits on.

CREATE TABLE workflow_approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow    TEXT NOT NULL,
  agent       TEXT NOT NULL,
  chat_id     INTEGER,
  message_id  INTEGER,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  note        TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  decided_at  TEXT
);

CREATE INDEX workflow_approvals_by_message ON workflow_approvals (message_id);
