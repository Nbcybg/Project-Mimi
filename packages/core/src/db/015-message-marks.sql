-- Schema v15: the user can pin a message and react to it (hearts and other emoji).

ALTER TABLE messages ADD COLUMN pinned_at TEXT;
ALTER TABLE messages ADD COLUMN reactions TEXT;
