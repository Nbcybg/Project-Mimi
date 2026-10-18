-- Schema v7: the run history of workflows, with each node's input and output.

CREATE TABLE workflow_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow    TEXT NOT NULL,
  mode        TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  result      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  node_count  INTEGER NOT NULL,
  nodes       TEXT NOT NULL
);

CREATE INDEX workflow_runs_by_workflow ON workflow_runs (workflow, id);
