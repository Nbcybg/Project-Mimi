-- Schema v5: triggers may also come from a webhook instead of a schedule, and they
-- carry an updated_at stamp so file-based sync can tell which side is newer.

CREATE TABLE triggers_v5 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('reminder', 'agent_task')),
  fire_at       TEXT,                   -- one-shot time, or
  cron          TEXT,                   -- recurring schedule, or
  webhook_key   TEXT,                   -- unguessable key for POST /api/webhook/<key>
  payload       TEXT NOT NULL DEFAULT '{}',
  agent         TEXT,
  repeat        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'fired', 'cancelled')),
  device_synced INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  title         TEXT NOT NULL DEFAULT '',
  next_fire_at  TEXT,
  last_fired_at TEXT,
  last_result   TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (fire_at IS NOT NULL OR cron IS NOT NULL OR webhook_key IS NOT NULL)
);

INSERT INTO triggers_v5
  (id, kind, fire_at, cron, payload, agent, repeat, status, device_synced, created_at, title, next_fire_at, last_fired_at, last_result, updated_at)
  SELECT id, kind, fire_at, cron, payload, agent, repeat, status, device_synced, created_at,
         COALESCE(title, ''), next_fire_at, last_fired_at, last_result,
         COALESCE(last_fired_at, created_at)
    FROM triggers;

DROP TABLE triggers;
ALTER TABLE triggers_v5 RENAME TO triggers;

CREATE INDEX idx_triggers_next ON triggers (status, next_fire_at);
CREATE UNIQUE INDEX idx_triggers_webhook ON triggers (webhook_key) WHERE webhook_key IS NOT NULL;
