-- Schema v10: notifications are kept (an inbox any device can read later), and the
-- browsers that asked for push messages are remembered.

CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  chat_id     INTEGER,
  trigger_id  INTEGER,
  created_at  TEXT NOT NULL,
  read_at     TEXT
);

CREATE INDEX notifications_unread ON notifications (read_at, id);

CREATE TABLE push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  last_ok_at  TEXT,
  failures    INTEGER NOT NULL DEFAULT 0
);
