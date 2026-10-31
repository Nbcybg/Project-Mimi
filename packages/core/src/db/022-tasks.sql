-- A task is the unit of work: goal, recipe, level, steps, gates, verification, receipt.
-- JSON columns keep the recipe-defined shapes without a schema migration per recipe.
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  goal         TEXT NOT NULL,
  recipe       TEXT NOT NULL,
  level        TEXT NOT NULL,
  status       TEXT NOT NULL,
  agent        TEXT NOT NULL,
  input        TEXT NOT NULL DEFAULT '{}',
  steps        TEXT NOT NULL DEFAULT '[]',
  gates        TEXT NOT NULL DEFAULT '[]',
  plan         TEXT,
  verification TEXT,
  receipt      TEXT,
  undo_receipt TEXT,
  undo         TEXT,
  trace_id     TEXT NOT NULL,
  thread       TEXT NOT NULL,
  chat_id      INTEGER,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks (thread, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_trace ON tasks (trace_id);
