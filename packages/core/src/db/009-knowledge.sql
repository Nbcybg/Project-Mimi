-- Schema v9: knowledge bases. Chunks are searched by keyword (FTS5 trigram, which
-- works for Thai without word breaks) and, when a collection has an embedding model,
-- by vector similarity too.

CREATE TABLE kb_collections (
  name            TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  embedding_model TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE kb_documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  collection  TEXT NOT NULL REFERENCES kb_collections (name) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT '',
  chars       INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX kb_documents_by_collection ON kb_documents (collection, id);

CREATE TABLE kb_chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES kb_documents (id) ON DELETE CASCADE,
  collection  TEXT NOT NULL,
  ord         INTEGER NOT NULL,
  text        TEXT NOT NULL,
  embedding   BLOB,
  embedded_by TEXT
);

CREATE INDEX kb_chunks_by_document ON kb_chunks (document_id, ord);
CREATE INDEX kb_chunks_by_collection ON kb_chunks (collection);

CREATE VIRTUAL TABLE kb_fts USING fts5 (text, tokenize = 'trigram');

-- The keyword index follows the chunk table.
CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  DELETE FROM kb_fts WHERE rowid = old.id;
END;
