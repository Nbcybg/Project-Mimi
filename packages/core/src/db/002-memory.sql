-- Schema v2: rolling summaries, byte-stable prompt prefix, cache accounting.

-- The volatile block (current time, status) that was sent with a user message. Stored
-- so the message is replayed byte-identically and the provider's prompt cache keeps hitting.
ALTER TABLE messages ADD COLUMN context TEXT;

ALTER TABLE usage_log ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;

-- 'raw': written from the raw messages of its range; 'summaries': merged from older summaries
-- because the raw range no longer fit the summarizer.
ALTER TABLE summaries ADD COLUMN source TEXT NOT NULL DEFAULT 'raw';
-- Set when a merged summary replaces this one; active summaries have NULL here.
ALTER TABLE summaries ADD COLUMN superseded_by INTEGER REFERENCES summaries (id);

-- Everything that defines the stable prompt prefix of a thread. It only changes at
-- compaction, which is also the only moment memory edits become visible in the prefix.
CREATE TABLE thread_state (
  thread             TEXT PRIMARY KEY,
  epoch              INTEGER NOT NULL DEFAULT 0,
  summarized_through INTEGER NOT NULL DEFAULT 0, -- messages with id <= this live in summaries
  memory_snapshot    TEXT NOT NULL DEFAULT '',
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
