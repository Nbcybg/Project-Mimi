/** A knowledge base: documents cut into chunks that agents and workflows search. */
export interface KnowledgeCollectionView {
  name: string;
  title: string;
  description: string;
  /** `provider/model` of an embedding model; null means keyword search only. */
  embeddingModel: string | null;
  documents: number;
  chunks: number;
  /** Chunks that have a vector from the current embedding model. */
  embedded: number;
  createdAt: string;
}

export interface KnowledgeDocumentView {
  id: number;
  collection: string;
  title: string;
  /** Where it came from: a file path, a URL, "chat", or empty for typed text. */
  source: string;
  chars: number;
  chunks: number;
  createdAt: string;
}

export interface KnowledgeHit {
  chunkId: number;
  documentId: number;
  collection: string;
  document: string;
  source: string;
  text: string;
  /** Fused rank score (higher is better). */
  score: number;
  /** Which search found it. */
  via: 'keyword' | 'vector' | 'both';
}

/** What adding a document reports back. */
export interface KnowledgeAddResult {
  document: KnowledgeDocumentView;
  /** Set when the vectors could not be made; the document is still found by keyword. */
  warning?: string;
}

/** One fact the user keeps about themselves (Settings → โปรไฟล์ของฉัน). */
export interface UserProfileField {
  /** Stable id, e.g. "home_address". */
  key: string;
  /** What the user calls it, e.g. "ที่อยู่บ้าน". */
  label: string;
  value: string;
  /** "*" = every agent; otherwise only the agents named (an empty list hides it from all). */
  visibleTo: '*' | string[];
  /** The value stays on this machine (user/data), not in user/profile.json that may be synced. */
  localOnly?: boolean;
}

export interface UserProfileView {
  fields: UserProfileField[];
}
