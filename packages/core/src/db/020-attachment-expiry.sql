-- Schema v20: media can be expired. The row stays so the chat and the CSV export
-- still know the file existed, while the bytes are removed from the disk.
ALTER TABLE attachments ADD COLUMN deleted_at TEXT;
