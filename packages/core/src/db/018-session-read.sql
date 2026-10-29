-- Schema v18: a session remembers when it was last read, so the app can mark
-- conversations that got new messages while nobody was looking as "ใหม่".
ALTER TABLE sessions ADD COLUMN read_at TEXT;
