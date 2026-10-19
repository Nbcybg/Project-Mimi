import fs from 'node:fs';
import path from 'node:path';
import type { BackgroundSettingsView, BackgroundView } from '@mimi/shared';

export const BACKGROUND_ID = /^[a-z][a-z0-9_-]*$/;
const NAME_LIMIT = 80;
const KEYWORD_LIMIT = 20;
const META_FILE = 'background.json';
const SETTINGS_FILE = 'settings.json';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** What a choice may be besides a picture's id. */
export const BACKGROUND_NONE = 'none';
export const BACKGROUND_AUTO = 'auto';

export interface BackgroundInput {
  id: string;
  name?: string;
  keywords?: string[];
}

/**
 * Backdrops for the chat stage, like the scenes of a visual novel. Each is a folder
 * `backgrounds/<id>/` (background.json + picture). `settings.json` records the app-wide
 * choice and one per agent: a picture id, "none", or "auto" (pick by the agent's location:
 * the first backdrop with a keyword the location contains).
 */
export class BackgroundStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private folder(id: string): string | undefined {
    return BACKGROUND_ID.test(id) ? path.join(this.dir, id) : undefined;
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

  private view(id: string): BackgroundView | undefined {
    const folder = this.folder(id);
    const metaFile = folder && path.join(folder, META_FILE);
    if (!metaFile || !fs.existsSync(metaFile)) return undefined;
    let meta: { name?: unknown; keywords?: unknown } = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as typeof meta;
    } catch {
      // a hand-edited broken file still lists, so it can be fixed in the app
    }
    const image = this.findImage(id);
    return {
      id,
      name: typeof meta.name === 'string' && meta.name ? meta.name : id,
      keywords: Array.isArray(meta.keywords) ? meta.keywords.filter((word): word is string => typeof word === 'string') : [],
      image: image ? String(Math.round(fs.statSync(image.file).mtimeMs)) : null,
    };
  }

  list(): BackgroundView[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && BACKGROUND_ID.test(entry.name))
      .map((entry) => this.view(entry.name))
      .filter((background): background is BackgroundView => background !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  has(id: string): boolean {
    return this.view(id) !== undefined;
  }

  save(input: BackgroundInput): BackgroundView {
    const id = String(input.id ?? '').trim();
    if (!BACKGROUND_ID.test(id)) throw new Error('Background id: lowercase letters, digits, "-" or "_", starting with a letter (e.g. cafe).');
    if (id === BACKGROUND_NONE || id === BACKGROUND_AUTO) throw new Error(`"${id}" is reserved.`);
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);
    const keywords = [...new Set((input.keywords ?? []).map((word) => String(word).replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, KEYWORD_LIMIT);
    const folder = this.folder(id)!;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, META_FILE), `${JSON.stringify({ name, keywords }, null, 2)}\n`, 'utf8');
    return this.view(id)!;
  }

  /** Moves a backdrop to a new id; choices that named the old id follow it. */
  rename(from: string, to: string): BackgroundView {
    const source = this.folder(from);
    if (!source || !this.has(from)) throw new Error(`No background "${from}".`);
    if (from === to) return this.view(from)!;
    if (this.has(to)) throw new Error(`A background "${to}" already exists.`);
    const current = this.view(from)!;
    this.save({ id: to, name: current.name, keywords: current.keywords });
    const target = this.folder(to)!;
    for (const entry of fs.readdirSync(source)) {
      if (entry !== META_FILE) fs.renameSync(path.join(source, entry), path.join(target, entry));
    }
    fs.rmSync(source, { recursive: true, force: true });
    this.rewriteSettings((choice) => (choice === from ? to : choice));
    return this.view(to)!;
  }

  /** Deleting a backdrop clears every choice that used it. */
  remove(id: string): boolean {
    const folder = this.folder(id);
    if (!folder || !this.has(id)) return false;
    fs.rmSync(folder, { recursive: true, force: true });
    this.rewriteSettings((choice) => (choice === id ? '' : choice));
    return true;
  }

  readImage(id: string): { data: Buffer; mime: string } | undefined {
    const found = this.findImage(id);
    return found && { data: fs.readFileSync(found.file), mime: found.mime };
  }

  saveImage(id: string, mime: string, data: Buffer): void {
    const folder = this.folder(id);
    if (!folder || !this.has(id)) throw new Error(`No background "${id}". Save it first.`);
    const extension = IMAGE_TYPES[mime.toLowerCase()];
    if (!extension) throw new Error('Use a PNG, JPEG, WebP or GIF image.');
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new Error('The image must be smaller than 12 MB.');
    this.removeImage(id);
    fs.writeFileSync(path.join(folder, `image.${extension}`), data);
  }

  removeImage(id: string): void {
    for (let found = this.findImage(id); found; found = this.findImage(id)) fs.rmSync(found.file);
  }

  // ---------- choices ----------

  settings(): BackgroundSettingsView {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, SETTINGS_FILE), 'utf8')) as { default?: unknown; agents?: unknown };
      const agents: Record<string, string> = {};
      if (raw.agents && typeof raw.agents === 'object') {
        for (const [name, choice] of Object.entries(raw.agents)) if (typeof choice === 'string') agents[name] = choice;
      }
      return { default: typeof raw.default === 'string' ? raw.default : '', agents };
    } catch {
      return { default: '', agents: {} };
    }
  }

  private writeSettings(settings: BackgroundSettingsView): BackgroundSettingsView {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return settings;
  }

  private checkChoice(choice: string): string {
    if (choice === '' || choice === BACKGROUND_NONE || choice === BACKGROUND_AUTO) return choice;
    if (!this.has(choice)) throw new Error(`No background "${choice}".`);
    return choice;
  }

  /** `agent` unset = the app-wide choice; an empty choice for an agent = follow the app-wide one. */
  select(agent: string | undefined, choice: string): BackgroundSettingsView {
    const value = this.checkChoice(choice);
    const settings = this.settings();
    if (agent === undefined) settings.default = value;
    else if (value === '') delete settings.agents[agent];
    else settings.agents[agent] = value;
    return this.writeSettings(settings);
  }

  private rewriteSettings(change: (choice: string) => string): void {
    if (!fs.existsSync(path.join(this.dir, SETTINGS_FILE))) return;
    const settings = this.settings();
    settings.default = change(settings.default);
    for (const [name, choice] of Object.entries(settings.agents)) {
      const next = change(choice);
      if (next) settings.agents[name] = next;
      else delete settings.agents[name];
    }
    this.writeSettings(settings);
  }

  renameAgent(from: string, to: string): void {
    const settings = this.settings();
    if (!(from in settings.agents)) return;
    settings.agents[to] = settings.agents[from]!;
    delete settings.agents[from];
    this.writeSettings(settings);
  }

  forgetAgent(name: string): void {
    const settings = this.settings();
    if (!(name in settings.agents)) return;
    delete settings.agents[name];
    this.writeSettings(settings);
  }
}
