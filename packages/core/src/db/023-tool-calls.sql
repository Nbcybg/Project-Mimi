CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  trace_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  risk TEXT,
  ok INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS tool_calls_created ON tool_calls (created_at);
CREATE INDEX IF NOT EXISTS tool_calls_tool ON tool_calls (tool, ok);
