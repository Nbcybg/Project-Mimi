-- Schema v13: workflow runs paused at an approval or a long wait, finished later
-- (also after a restart). Approval requests point at the run they resume.

CREATE TABLE workflow_parked (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow    TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  resume_at   TEXT,
  run         TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX workflow_parked_due ON workflow_parked (kind, resume_at);

ALTER TABLE workflow_approvals ADD COLUMN run_id INTEGER;
