-- Schema v19: a file can carry the user's own caption, so each picture in a
-- batch can be described separately.
ALTER TABLE attachments ADD COLUMN caption TEXT NOT NULL DEFAULT '';
