-- Schema v14: attachments can be videos. SQLite cannot change a CHECK constraint,
-- so the table is rebuilt with the same rows.

CREATE TABLE attachments_v14 (
  id         TEXT PRIMARY KEY,
  message_id INTEGER REFERENCES messages (id),
  kind       TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'file')),
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO attachments_v14 (id, message_id, kind, name, mime, size, text, created_at)
  SELECT id, message_id, kind, name, mime, size, text, created_at FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_v14 RENAME TO attachments;
CREATE INDEX idx_attachments_message ON attachments (message_id);
