-- Schema v11: a knowledge base can be limited to some agents (JSON list; empty = all).

ALTER TABLE kb_collections ADD COLUMN agents TEXT NOT NULL DEFAULT '[]';
