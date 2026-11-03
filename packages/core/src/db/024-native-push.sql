-- Schema v24: native apps (Android through FCM, iOS / macOS through APNs) receive push
-- messages too. The token is the address; `id` (a hash of it) is what the device list shows.

CREATE TABLE IF NOT EXISTS native_push_tokens (
  id           TEXT PRIMARY KEY,
  platform     TEXT NOT NULL,
  token        TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL DEFAULT '',
  app_version  TEXT,
  bundle_id    TEXT,
  sandbox      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  last_ok_at   TEXT,
  failures     INTEGER NOT NULL DEFAULT 0
);
