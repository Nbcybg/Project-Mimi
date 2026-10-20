/** A knowledge base: documents cut into chunks that agents and workflows search. */
export interface KnowledgeCollectionView {
  name: string;
  title: string;
  description: string;
  /** `provider/model` of an embedding model; null means keyword search only. */
  embeddingModel: string | null;
  /** Agents allowed to search it; empty = every agent. */
  agents: string[];
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

/** One picture of an agent's situation gallery. */
export interface GalleryItemView {
  /** Short id the agent quotes, e.g. g12; never reused. */
  id: string;
  title: string;
  tags: string[];
  /** When the picture fits; what the agent reads to choose it. */
  description: string;
  mime: string;
  size: number;
  createdAt: string;
  /** Who put it in: the user (upload) or the agent (gallery_add). */
  source: 'user' | 'agent';
  /** True when a small preview exists (the grid uses it). */
  thumb: boolean;
}

/** A backdrop for the chat stage. */
export interface BackgroundView {
  id: string;
  name: string;
  /** Words in an agent's location that make "auto" choose this backdrop. */
  keywords: string[];
  /** Changes whenever the picture does; null when there is none. */
  image: string | null;
}

/** Choices are a backdrop id, "none" (no backdrop) or "auto" (by location); "" = follow the app-wide choice. */
export interface BackgroundSettingsView {
  default: string;
  agents: Record<string, string>;
}

/** An outfit in the wardrobe pool; agents and prompts refer to it by `id` (e.g. wa01). */
export interface WardrobeOutfitView {
  id: string;
  name: string;
  description: string;
  /** Changes whenever the picture does; null when there is none. */
  image: string | null;
  /** This outfit's expression pictures by emoji key, each with a version. */
  sprites: Record<string, string>;
  /** Version stamp of this outfit's own 3D model (model.vrm); null when it has none. */
  model?: string | null;
}
