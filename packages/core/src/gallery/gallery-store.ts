import fs from 'node:fs';
import path from 'node:path';
import type { GalleryItemView } from '@mimi/shared';

const AGENT_NAME = /^[a-z][a-z0-9_-]*$/;
const GALLERY_DIR = 'gallery';
const INDEX_FILE = 'index.json';
const MAX_ITEMS = 5000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_THUMB_BYTES = 512 * 1024;
const TITLE_LIMIT = 120;
const DESCRIPTION_LIMIT = 1000;
const TAG_LIMIT = 20;
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

interface Index {
  nextId: number;
  items: GalleryItemView[];
}

export interface GalleryAdd {
  title?: string;
  tags?: string[];
  description?: string;
  mime: string;
  data: Buffer;
  source: 'user' | 'agent';
}

const clean = (text: unknown, limit: number) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const cleanTags = (tags: unknown) =>
  [...new Set((Array.isArray(tags) ? tags : []).map((tag) => clean(tag, 40).toLowerCase()).filter(Boolean))].slice(0, TAG_LIMIT);

/**
 * The situation gallery of each agent: pictures (hundreds to thousands) that can be laid
 * over the chat like the event pictures of a visual novel. Kept inside the agent's own
 * folder as `agents/<name>/gallery/` - the pictures, optional small previews, and one
 * `index.json` with each picture's title, tags and description (what the agent reads
 * when it looks for a picture that fits the moment).
 */
export class GalleryStore {
  private readonly agentsDir: string;
  private readonly cache = new Map<string, { mtimeMs: number; index: Index }>();

  constructor(agentsDir: string) {
    this.agentsDir = agentsDir;
  }

  private folder(agent: string): string {
    if (!AGENT_NAME.test(agent)) throw new Error('Unknown agent.');
    return path.join(this.agentsDir, agent, GALLERY_DIR);
  }

  private index(agent: string): Index {
    const file = path.join(this.folder(agent), INDEX_FILE);
    if (!fs.existsSync(file)) return { nextId: 1, items: [] };
    const mtimeMs = fs.statSync(file).mtimeMs;
    const cached = this.cache.get(agent);
    if (cached && cached.mtimeMs === mtimeMs) return cached.index;
    let index: Index = { nextId: 1, items: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Index>;
      index = { nextId: Number(raw.nextId) || 1, items: Array.isArray(raw.items) ? raw.items : [] };
    } catch {
      // a broken index shows an empty gallery; the pictures stay on disk
    }
    this.cache.set(agent, { mtimeMs, index });
    return index;
  }

  private write(agent: string, index: Index): void {
    const folder = this.folder(agent);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, INDEX_FILE);
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(index), 'utf8');
    fs.renameSync(temp, file);
    this.cache.set(agent, { mtimeMs: fs.statSync(file).mtimeMs, index });
  }

  private fileOf(agent: string, item: GalleryItemView, thumb = false): string {
    return path.join(this.folder(agent), thumb ? `${item.id}.thumb.jpg` : `${item.id}.${IMAGE_TYPES[item.mime] ?? 'bin'}`);
  }

  count(agent: string): number {
    return this.index(agent).items.length;
  }

  get(agent: string, id: string): GalleryItemView | undefined {
    return this.index(agent).items.find((item) => item.id === id);
  }

  /** Newest first; with a query, best matches first. */
  list(agent: string, options: { query?: string; offset?: number; limit?: number } = {}): { total: number; items: GalleryItemView[] } {
    const matches = this.search(agent, options.query ?? '');
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.min(200, Math.max(1, options.limit ?? 60));
    return { total: matches.length, items: matches.slice(offset, offset + limit) };
  }

  /** Items matching every word of the query in title, tags or description (title and tags weigh more). */
  search(agent: string, query: string): GalleryItemView[] {
    const items = this.index(agent).items;
    const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (words.length === 0) return [...items].reverse();
    const scored: Array<{ item: GalleryItemView; score: number; order: number }> = [];
    items.forEach((item, order) => {
      const title = item.title.toLowerCase();
      const tags = item.tags.join(' ');
      const description = item.description.toLowerCase();
      let score = 0;
      for (const word of words) {
        const hit = (title.includes(word) ? 3 : 0) + (tags.includes(word) ? 3 : 0) + (description.includes(word) ? 1 : 0);
        if (hit === 0) return;
        score += hit;
      }
      scored.push({ item, score, order });
    });
    return scored.sort((a, b) => b.score - a.score || b.order - a.order).map((entry) => entry.item);
  }

  add(agent: string, input: GalleryAdd): GalleryItemView {
    const extension = IMAGE_TYPES[input.mime.toLowerCase()];
    if (!extension) throw new Error('Use a PNG, JPEG, WebP or GIF image.');
    if (input.data.length === 0 || input.data.length > MAX_IMAGE_BYTES) throw new Error('The image must be smaller than 12 MB.');
    const index = this.index(agent);
    if (index.items.length >= MAX_ITEMS) throw new Error(`A gallery holds at most ${MAX_ITEMS} pictures.`);
    const id = `g${index.nextId}`;
    const item: GalleryItemView = {
      id,
      title: clean(input.title, TITLE_LIMIT) || id,
      tags: cleanTags(input.tags),
      description: clean(input.description, DESCRIPTION_LIMIT),
      mime: input.mime.toLowerCase(),
      size: input.data.length,
      createdAt: new Date().toISOString(),
      source: input.source,
      thumb: false,
    };
    fs.mkdirSync(this.folder(agent), { recursive: true });
    fs.writeFileSync(this.fileOf(agent, item), input.data);
    this.write(agent, { nextId: index.nextId + 1, items: [...index.items, item] });
    return item;
  }

  update(agent: string, id: string, patch: { title?: string; tags?: string[]; description?: string }): GalleryItemView {
    const index = this.index(agent);
    const item = index.items.find((entry) => entry.id === id);
    if (!item) throw new Error(`No picture "${id}" in the gallery.`);
    const next = {
      ...item,
      ...(patch.title !== undefined ? { title: clean(patch.title, TITLE_LIMIT) || item.id } : {}),
      ...(patch.tags !== undefined ? { tags: cleanTags(patch.tags) } : {}),
      ...(patch.description !== undefined ? { description: clean(patch.description, DESCRIPTION_LIMIT) } : {}),
    };
    this.write(agent, { ...index, items: index.items.map((entry) => (entry.id === id ? next : entry)) });
    return next;
  }

  remove(agent: string, id: string): boolean {
    const index = this.index(agent);
    const item = index.items.find((entry) => entry.id === id);
    if (!item) return false;
    for (const file of [this.fileOf(agent, item), this.fileOf(agent, item, true)]) fs.rmSync(file, { force: true });
    this.write(agent, { ...index, items: index.items.filter((entry) => entry.id !== id) });
    return true;
  }

  /** `thumb` falls back to the full picture when no preview was made. */
  readImage(agent: string, id: string, thumb = false): { data: Buffer; mime: string } | undefined {
    const item = this.get(agent, id);
    if (!item) return undefined;
    if (thumb && item.thumb) {
      const file = this.fileOf(agent, item, true);
      if (fs.existsSync(file)) return { data: fs.readFileSync(file), mime: 'image/jpeg' };
    }
    const file = this.fileOf(agent, item);
    return fs.existsSync(file) ? { data: fs.readFileSync(file), mime: item.mime } : undefined;
  }

  /** A small JPEG preview made by the client, so a grid of hundreds stays light. */
  saveThumb(agent: string, id: string, mime: string, data: Buffer): void {
    const index = this.index(agent);
    const item = index.items.find((entry) => entry.id === id);
    if (!item) throw new Error(`No picture "${id}" in the gallery.`);
    if (mime.toLowerCase() !== 'image/jpeg') throw new Error('A preview must be a JPEG.');
    if (data.length === 0 || data.length > MAX_THUMB_BYTES) throw new Error('A preview must be smaller than 512 KB.');
    fs.writeFileSync(this.fileOf(agent, item, true), data);
    this.write(agent, { ...index, items: index.items.map((entry) => (entry.id === id ? { ...entry, thumb: true } : entry)) });
  }
}
