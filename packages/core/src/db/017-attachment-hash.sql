-- Schema v17: identical files share what the models already read.
ALTER TABLE attachments ADD COLUMN hash TEXT;
CREATE INDEX idx_attachments_hash ON attachments (hash);
