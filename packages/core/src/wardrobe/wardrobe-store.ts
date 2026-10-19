import fs from 'node:fs';
import path from 'node:path';
import type { WardrobeOutfitView } from '@mimi/shared';
import { RESERVED_NAMES } from '../loop/prompt-vars.ts';
import { SpriteSet } from './sprite-set.ts';

/** Same shape as an agent id, so `{{wa01}}` reads the same as `{{tim}}`. */
export const OUTFIT_ID = /^[a-z][a-z0-9_-]*$/;
const NAME_LIMIT = 80;
const DESCRIPTION_LIMIT = 1000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const META_FILE = 'outfit.json';
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface OutfitInput {
  id: string;
  name?: string;
  description?: string;
}

/**
 * The wardrobe: a pool of outfits shared by every agent. Each outfit is a folder
 * `wardrobe/<id>/` holding `outfit.json` (name, description) and its picture, so an
 * outfit - and later its set of expression pictures - moves as one folder.
 */
export class WardrobeStore {
  private readonly dir: string;
  /** Ids already taken by something else that shares the `{{...}}` namespace (agent ids). */
  private readonly taken: () => string[];

  constructor(dir: string, taken: () => string[] = () => []) {
    this.dir = dir;
    this.taken = taken;
  }

  private folder(id: string): string | undefined {
    return OUTFIT_ID.test(id) ? path.join(this.dir, id) : undefined;
  }

  private findImage(id: string): { file: string; mime: string } | undefined {
    const folder = this.folder(id);
    if (!folder) return undefined;
    for (const [mime, extension] of Object.entries(IMAGE_TYPES)) {
      const file = path.join(folder, `image.${extension}`);
      if (fs.existsSync(file)) return { file, mime };
    }
    return undefined;
  }

  private view(id: string): WardrobeOutfitView | undefined {
    const folder = this.folder(id);
    const metaFile = folder && path.join(folder, META_FILE);
    if (!metaFile || !fs.existsSync(metaFile)) return undefined;
    let meta: { name?: unknown; description?: unknown } = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as typeof meta;
    } catch {
      // a hand-edited broken file still lists, so the user can fix it in the app
    }
    const image = this.findImage(id);
    return {
      id,
      name: typeof meta.name === 'string' && meta.name ? meta.name : id,
      description: typeof meta.description === 'string' ? meta.description : '',
      image: image ? String(Math.round(fs.statSync(image.file).mtimeMs)) : null,
      sprites: new SpriteSet(path.join(folder, 'sprites')).list(),
    };
  }

  list(): WardrobeOutfitView[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && OUTFIT_ID.test(entry.name))
      .map((entry) => this.view(entry.name))
      .filter((outfit): outfit is WardrobeOutfitView => outfit !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): WardrobeOutfitView | undefined {
    return this.view(id);
  }

  has(id: string): boolean {
    return this.view(id) !== undefined;
  }

  /** The expression pictures of this outfit; they live in its folder and move with it. */
  sprites(id: string): SpriteSet | undefined {
    const folder = this.folder(id);
    return folder && this.has(id) ? new SpriteSet(path.join(folder, 'sprites')) : undefined;
  }

  /** Creates or updates an outfit. Renaming is done with `rename`, not by saving a new id. */
  save(input: OutfitInput): WardrobeOutfitView {
    const id = String(input.id ?? '').trim();
    if (!OUTFIT_ID.test(id)) throw new Error('Outfit id: lowercase letters, digits, "-" or "_", starting with a letter (e.g. wa01).');
    if ((RESERVED_NAMES as readonly string[]).includes(id)) throw new Error(`"${id}" is reserved for prompts.`);
    if (this.taken().includes(id)) throw new Error(`"${id}" is already the id of an agent; {{${id}}} cannot mean both.`);
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);
    const description = String(input.description ?? '').trim().slice(0, DESCRIPTION_LIMIT);
    const folder = this.folder(id)!;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, META_FILE), `${JSON.stringify({ name, description }, null, 2)}\n`, 'utf8');
    return this.view(id)!;
  }

  /** Moves an outfit to a new id (its picture goes with it). Prompts that used the old id are not rewritten. */
  rename(from: string, to: string): WardrobeOutfitView {
    const source = this.folder(from);
    if (!source || !this.has(from)) throw new Error(`No outfit "${from}".`);
    if (from === to) return this.view(from)!;
    if (this.has(to)) throw new Error(`An outfit "${to}" already exists.`);
    const current = this.view(from)!;
    this.save({ id: to, name: current.name, description: current.description });
    const target = this.folder(to)!;
    for (const entry of fs.readdirSync(source)) {
      if (entry === META_FILE) continue;
      fs.renameSync(path.join(source, entry), path.join(target, entry));
    }
    fs.rmSync(source, { recursive: true, force: true });
    return this.view(to)!;
  }

  remove(id: string): boolean {
    const folder = this.folder(id);
    if (!folder || !this.has(id)) return false;
    fs.rmSync(folder, { recursive: true, force: true });
    return true;
  }

  readImage(id: string): { data: Buffer; mime: string } | undefined {
    const found = this.findImage(id);
    return found && { data: fs.readFileSync(found.file), mime: found.mime };
  }

  saveImage(id: string, mime: string, data: Buffer): void {
    const folder = this.folder(id);
    if (!folder || !this.has(id)) throw new Error(`No outfit "${id}". Save it first.`);
    const extension = IMAGE_TYPES[mime.toLowerCase()];
    if (!extension) throw new Error('Use a PNG, JPEG, WebP or GIF image.');
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new Error('The image must be smaller than 8 MB.');
    this.removeImage(id);
    fs.writeFileSync(path.join(folder, `image.${extension}`), data);
  }

  removeImage(id: string): void {
    for (let found = this.findImage(id); found; found = this.findImage(id)) fs.rmSync(found.file);
  }

  /** `{{id}}` -> "name (description)", for the prompt table. */
  promptEntries(): Record<string, string> {
    const entries: Record<string, string> = {};
    for (const outfit of this.list()) {
      entries[outfit.id] = outfit.description ? `${outfit.name} (${outfit.description.replace(/\s+/g, ' ')})` : outfit.name;
    }
    return entries;
  }

  /** What an agent is told it can wear. Empty when the wardrobe is empty. */
  renderIndex(): string {
    const outfits = this.list();
    if (outfits.length === 0) return '';
    return [
      '## Wardrobe',
      'Outfits you can wear. When you change clothes, call status_set with key "outfit" and the outfit id as the value (e.g. "wa01").',
      ...outfits.map((outfit) => `- ${outfit.id}: ${outfit.name}${outfit.description ? ` - ${outfit.description.replace(/\s+/g, ' ')}` : ''}`),
    ].join('\n');
  }
}
