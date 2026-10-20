-- Schema v16: voice direction for an assistant reply, stored apart from its text.

ALTER TABLE messages ADD COLUMN speech TEXT;
