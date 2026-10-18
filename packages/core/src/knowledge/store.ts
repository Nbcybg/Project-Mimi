import type { KnowledgeAddResult, KnowledgeCollectionView, KnowledgeDocumentView, KnowledgeHit } from '@mimi/shared';
import type { Db } from '../db/db.ts';

/** Makes one vector per text with the named `provider/model`. */
export type Embedder = (model: string, texts: string[], signal?: AbortSignal) => Promise<number[][]>;

export const COLLECTION_NAME = /^[a-z][a-z0-9_-]*$/;

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 120;
const EMBED_BATCH = 50;
/** Candidates each search method contributes before the two lists are fused. */
const CANDIDATES = 40;
/** Reciprocal rank fusion constant: dampens the weight of the very top ranks. */
const RRF_K = 60;

/** Cuts text into overlapping chunks, preferring paragraph, then line, then sentence breaks. */
export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!clean) return [];
  const pieces: string[] = [];
  const pushPiece = (piece: string) => {
    if (piece.length <= size) {
      pieces.push(piece);
      return;
    }
    // A long paragraph is split at the last good break before the limit.
    let rest = piece;
    while (rest.length > size) {
      const window = rest.slice(0, size);
      const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf(' '));
      const at = cut > size / 2 ? cut + 1 : size;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  };
  for (const paragraph of clean.split(/\n{2,}/)) pushPiece(paragraph.trim());

  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > size) {
      chunks.push(current);
      // The next chunk repeats the end of this one, so an idea split at the seam is still found.
      const tail = current.slice(-overlap);
      const start = tail.indexOf(' ');
      current = `${start > 0 ? tail.slice(start + 1) : tail}\n\n${piece}`;
      if (current.length > size) current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * The FTS5 query for free text: each term as a phrase plus its trigrams, OR-ed, so a
 * Thai query without spaces still matches documents that share most of its pieces.
 */
export function ftsQuery(query: string): string | null {
  const pieces = new Set<string>();
  for (const term of query.toLowerCase().split(/[\s,.;:!?()"'“”‘’[\]{}<>/\\|]+/)) {
    const chars = [...term];
    if (chars.length < 3) continue;
    pieces.add(term);
    if (chars.length > 3) for (let at = 0; at + 3 <= chars.length; at++) pieces.add(chars.slice(at, at + 3).join(''));
  }
  if (pieces.size === 0) return null;
  return [...pieces]
    .slice(0, 80)
    .map((piece) => `"${piece.replace(/"/g, '""')}"`)
    .join(' OR ');
}

function toBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function fromBlob(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let at = 0; at < a.length; at++) {
    dot += a[at]! * b[at]!;
    na += a[at]! * a[at]!;
    nb += b[at]! * b[at]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

interface CollectionRow {
  name: string;
  title: string;
  description: string;
  embedding_model: string | null;
  created_at: string;
}

interface ChunkRow {
  id: number;
  document_id: number;
  collection: string;
  text: string;
  title: string;
  source: string;
}

/** Knowledge bases in SQLite: collections, documents, chunks, keyword index and vectors. */
export class KnowledgeStore {
  private readonly db: Db;
  private readonly embed?: Embedder;

  constructor(db: Db, embed?: Embedder) {
    this.db = db;
    this.embed = embed;
  }

  collections(): KnowledgeCollectionView[] {
    const rows = this.db.prepare('SELECT * FROM kb_collections ORDER BY name').all() as CollectionRow[];
    return rows.map((row) => this.view(row));
  }

  collection(name: string): KnowledgeCollectionView | undefined {
    const row = this.db.prepare('SELECT * FROM kb_collections WHERE name = ?').get(name) as CollectionRow | undefined;
    return row ? this.view(row) : undefined;
  }

  private view(row: CollectionRow): KnowledgeCollectionView {
    const counts = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM kb_documents WHERE collection = @name) AS documents,
                (SELECT COUNT(*) FROM kb_chunks WHERE collection = @name) AS chunks,
                (SELECT COUNT(*) FROM kb_chunks WHERE collection = @name AND embedding IS NOT NULL AND embedded_by = @model) AS embedded`,
      )
      .get({ name: row.name, model: row.embedding_model ?? '' }) as { documents: number; chunks: number; embedded: number };
    return {
      name: row.name,
      title: row.title || row.name,
      description: row.description,
      embeddingModel: row.embedding_model,
      ...counts,
      createdAt: row.created_at,
    };
  }

  /** Creates or edits a collection. Changing the embedding model leaves old vectors unused until re-embedded. */
  saveCollection(input: { name: string; title?: string; description?: string; embeddingModel?: string | null }): KnowledgeCollectionView {
    const name = String(input.name ?? '').trim().toLowerCase();
    if (!COLLECTION_NAME.test(name)) throw new Error('Knowledge base name: lowercase letters, digits, "-" or "_", e.g. "household".');
    const model = String(input.embeddingModel ?? '').trim();
    if (model && !model.includes('/')) throw new Error('The embedding model is written "provider/model", e.g. "google/gemini-embedding-001".');
    this.db
      .prepare(
        `INSERT INTO kb_collections (name, title, description, embedding_model, created_at) VALUES (@name, @title, @description, @model, @now)
         ON CONFLICT (name) DO UPDATE SET title = @title, description = @description, embedding_model = @model`,
      )
      .run({ name, title: String(input.title ?? '').trim(), description: String(input.description ?? '').trim(), model: model || null, now: new Date().toISOString() });
    return this.collection(name)!;
  }

  deleteCollection(name: string): boolean {
    this.db.prepare('DELETE FROM kb_chunks WHERE collection = ?').run(name);
    return this.db.prepare('DELETE FROM kb_collections WHERE name = ?').run(name).changes > 0;
  }

  documents(collection: string): KnowledgeDocumentView[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.document_id = d.id) AS chunk_count
           FROM kb_documents d WHERE d.collection = ? ORDER BY d.id DESC`,
      )
      .all(collection) as Array<{ id: number; collection: string; title: string; source: string; chars: number; chunk_count: number; created_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      collection: row.collection,
      title: row.title,
      source: row.source,
      chars: row.chars,
      chunks: row.chunk_count,
      createdAt: row.created_at,
    }));
  }

  /**
   * Adds a document (replacing an earlier one from the same source). Vectors are made
   * when the collection names an embedding model; if that fails the document is kept
   * for keyword search and the failure comes back as a warning.
   */
  async add(collectionName: string, input: { title: string; text: string; source?: string }, signal?: AbortSignal): Promise<KnowledgeAddResult> {
    const collection = this.collection(collectionName);
    if (!collection) throw new Error(`No knowledge base "${collectionName}".`);
    const chunks = chunkText(input.text);
    if (chunks.length === 0) throw new Error('The document has no text.');
    const source = String(input.source ?? '').trim();
    const title = String(input.title ?? '').trim() || source || chunks[0]!.slice(0, 60);
    const id = this.db.transaction(() => {
      if (source) {
        for (const old of this.db.prepare('SELECT id FROM kb_documents WHERE collection = ? AND source = ?').all(collectionName, source) as Array<{ id: number }>) {
          this.deleteDocument(old.id);
        }
      }
      const documentId = Number(
        this.db
          .prepare('INSERT INTO kb_documents (collection, title, source, chars, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(collectionName, title, source, input.text.length, new Date().toISOString()).lastInsertRowid,
      );
      const insert = this.db.prepare('INSERT INTO kb_chunks (document_id, collection, ord, text) VALUES (?, ?, ?, ?)');
      chunks.forEach((chunk, ord) => insert.run(documentId, collectionName, ord, chunk));
      return documentId;
    })();
    let warning: string | undefined;
    if (collection.embeddingModel) {
      try {
        await this.embedMissing(collectionName, signal, id);
      } catch (error) {
        warning = `Vectors were not made (${(error as Error).message}); the document is found by keyword only.`;
      }
    }
    const document = this.documents(collectionName).find((entry) => entry.id === id)!;
    return { document, ...(warning ? { warning } : {}) };
  }

  deleteDocument(id: number): boolean {
    this.db.prepare('DELETE FROM kb_chunks WHERE document_id = ?').run(id);
    return this.db.prepare('DELETE FROM kb_documents WHERE id = ?').run(id).changes > 0;
  }

  /** Makes vectors for chunks that lack one from the collection's current model; returns how many. */
  async embedMissing(collectionName: string, signal?: AbortSignal, documentId?: number): Promise<number> {
    const collection = this.collection(collectionName);
    const model = collection?.embeddingModel;
    if (!model) return 0;
    if (!this.embed) throw new Error('embeddings are not available here');
    const rows = this.db
      .prepare(
        `SELECT id, text FROM kb_chunks WHERE collection = ? AND (embedding IS NULL OR embedded_by IS NOT ?)
           ${documentId !== undefined ? 'AND document_id = ?' : ''} ORDER BY id`,
      )
      .all(...(documentId !== undefined ? [collectionName, model, documentId] : [collectionName, model])) as Array<{ id: number; text: string }>;
    const store = this.db.prepare('UPDATE kb_chunks SET embedding = ?, embedded_by = ? WHERE id = ?');
    let done = 0;
    for (let at = 0; at < rows.length; at += EMBED_BATCH) {
      const batch = rows.slice(at, at + EMBED_BATCH);
      const vectors = await this.embed(model, batch.map((row) => row.text), signal);
      if (vectors.length !== batch.length) throw new Error(`the model returned ${vectors.length} vectors for ${batch.length} chunks`);
      this.db.transaction(() => batch.forEach((row, index) => store.run(toBlob(vectors[index]!), model, row.id)))();
      done += batch.length;
    }
    return done;
  }

  /**
   * Keyword search always; vector search too for collections with vectors. Both lists
   * are fused by reciprocal rank, so a chunk found by both rises to the top.
   */
  async search(query: string, options: { collection?: string; limit?: number; signal?: AbortSignal } = {}): Promise<KnowledgeHit[]> {
    const text = query.trim();
    if (!text) return [];
    const limit = Math.min(20, Math.max(1, options.limit ?? 5));
    const names = options.collection ? [options.collection] : this.collections().map((entry) => entry.name);
    if (options.collection && !this.collection(options.collection)) throw new Error(`No knowledge base "${options.collection}".`);
    if (names.length === 0) return [];
    const where = `c.collection IN (${names.map(() => '?').join(',')})`;

    const keyword: number[] = [];
    const match = ftsQuery(text);
    if (match) {
      const rows = this.db
        .prepare(`SELECT c.id FROM kb_fts JOIN kb_chunks c ON c.id = kb_fts.rowid WHERE kb_fts MATCH ? AND ${where} ORDER BY bm25(kb_fts) LIMIT ${CANDIDATES}`)
        .all(match, ...names) as Array<{ id: number }>;
      keyword.push(...rows.map((row) => row.id));
    } else {
      // Too short for trigrams: a plain substring scan.
      const rows = this.db
        .prepare(`SELECT c.id FROM kb_chunks c WHERE c.text LIKE ? ESCAPE '\\' AND ${where} LIMIT ${CANDIDATES}`)
        .all(`%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`, ...names) as Array<{ id: number }>;
      keyword.push(...rows.map((row) => row.id));
    }

    const vector: number[] = [];
    if (this.embed) {
      // One query vector per embedding model in play.
      const byModel = new Map<string, string[]>();
      for (const name of names) {
        const model = this.collection(name)?.embeddingModel;
        if (model) byModel.set(model, [...(byModel.get(model) ?? []), name]);
      }
      const scored: Array<{ id: number; score: number }> = [];
      for (const [model, members] of byModel) {
        let queryVector: number[];
        try {
          [queryVector] = (await this.embed(model, [text], options.signal)) as [number[]];
        } catch {
          continue; // keyword results still stand
        }
        const rows = this.db
          .prepare(`SELECT id, embedding FROM kb_chunks WHERE embedding IS NOT NULL AND embedded_by = ? AND collection IN (${members.map(() => '?').join(',')})`)
          .all(model, ...members) as Array<{ id: number; embedding: Buffer }>;
        for (const row of rows) scored.push({ id: row.id, score: cosine(queryVector, fromBlob(row.embedding)) });
      }
      scored.sort((a, b) => b.score - a.score);
      vector.push(...scored.slice(0, CANDIDATES).map((entry) => entry.id));
    }

    const fused = new Map<number, { score: number; keyword: boolean; vector: boolean }>();
    keyword.forEach((id, rank) => {
      const entry = fused.get(id) ?? { score: 0, keyword: false, vector: false };
      fused.set(id, { ...entry, score: entry.score + 1 / (RRF_K + rank + 1), keyword: true });
    });
    vector.forEach((id, rank) => {
      const entry = fused.get(id) ?? { score: 0, keyword: false, vector: false };
      fused.set(id, { ...entry, score: entry.score + 1 / (RRF_K + rank + 1), vector: true });
    });
    const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit);
    if (top.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id, c.document_id, c.collection, c.text, d.title, d.source FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
          WHERE c.id IN (${top.map(() => '?').join(',')})`,
      )
      .all(...top.map(([id]) => id)) as ChunkRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return top.flatMap(([id, entry]) => {
      const row = byId.get(id);
      if (!row) return [];
      return [
        {
          chunkId: id,
          documentId: row.document_id,
          collection: row.collection,
          document: row.title,
          source: row.source,
          text: row.text,
          score: Math.round(entry.score * 10000) / 10000,
          via: entry.keyword && entry.vector ? 'both' : entry.vector ? 'vector' : 'keyword',
        } satisfies KnowledgeHit,
      ];
    });
  }
}

/** Search hits as one block of context for a prompt. */
export function renderHits(hits: KnowledgeHit[]): string {
  if (hits.length === 0) return 'No matching knowledge.';
  return hits.map((hit, index) => `[${index + 1}] ${hit.document}${hit.source ? ` (${hit.source})` : ''}\n${hit.text}`).join('\n\n');
}
