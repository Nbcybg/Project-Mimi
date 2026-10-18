-- Schema v12: files as they were before an agent wrote them, so a rewind can restore them.

CREATE TABLE file_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread      TEXT NOT NULL,
  trace_id    TEXT NOT NULL,
  path        TEXT NOT NULL,
  existed     INTEGER NOT NULL,
  content     BLOB,
  created_at  TEXT NOT NULL
);

CREATE INDEX file_snapshots_by_thread ON file_snapshots (thread, created_at);
