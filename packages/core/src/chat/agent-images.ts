import fs from 'node:fs';
import path from 'node:path';
import { SpriteSet } from '../wardrobe/sprite-set.ts';

/** `avatar` is the small profile picture; `portrait` is the large picture shown behind a chat. */
export const IMAGE_SLOTS = ['avatar', 'portrait'] as const;
export type ImageSlot = (typeof IMAGE_SLOTS)[number];

const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const AGENT_NAME = /^[a-z][a-z0-9_-]*$/;
const SPRITES_DIR = 'sprites';

export function isImageSlot(value: string): value is ImageSlot {
  return (IMAGE_SLOTS as readonly string[]).includes(value);
}

/**
 * The pictures of the agents, kept inside each agent's own folder as
 * `agents/<name>/<slot>.<ext>`, so an agent folder is the whole agent.
 */
export class AgentImages {
  private readonly agentsDir: string;

  constructor(agentsDir: string) {
    this.agentsDir = agentsDir;
  }

  private folder(agent: string): string | undefined {
    return AGENT_NAME.test(agent) ? path.join(this.agentsDir, agent) : undefined;
  }

  private find(agent: string, slot: ImageSlot): { file: string; mime: string } | undefined {
    const folder = this.folder(agent);
    if (!folder) return undefined;
    for (const [mime, extension] of Object.entries(TYPES)) {
      const file = path.join(folder, `${slot}.${extension}`);
      if (fs.existsSync(file)) return { file, mime };
    }
    return undefined;
  }

  /** The agent's own expression pictures (used when the outfit has none for an emoji). */
  sprites(agent: string): SpriteSet | undefined {
    const folder = this.folder(agent);
    return folder ? new SpriteSet(path.join(folder, SPRITES_DIR)) : undefined;
  }

  read(agent: string, slot: ImageSlot): { data: Buffer; mime: string } | undefined {
    const found = this.find(agent, slot);
    return found && { data: fs.readFileSync(found.file), mime: found.mime };
  }

  /** Changes whenever the picture does, so clients know when to fetch it again; null when there is none. */
  version(agent: string, slot: ImageSlot): string | null {
    const found = this.find(agent, slot);
    return found ? String(Math.round(fs.statSync(found.file).mtimeMs)) : null;
  }

  save(agent: string, slot: ImageSlot, mime: string, data: Buffer): void {
    const folder = this.folder(agent);
    if (!folder) throw new Error('Unknown agent.');
    const extension = TYPES[mime.toLowerCase()];
    if (!extension) throw new Error('Use a PNG, JPEG, WebP or GIF image.');
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new Error('The image must be smaller than 8 MB.');
    this.remove(agent, slot);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${slot}.${extension}`), data);
  }

  remove(agent: string, slot: ImageSlot): void {
    for (let found = this.find(agent, slot); found; found = this.find(agent, slot)) fs.rmSync(found.file);
  }

  forget(agent: string): void {
    for (const slot of IMAGE_SLOTS) this.remove(agent, slot);
  }

  /** Moves the pictures when an agent is renamed; the new folder must already exist. */
  rename(from: string, to: string): void {
    const target = this.folder(to);
    if (!target) return;
    for (const slot of IMAGE_SLOTS) {
      const found = this.find(from, slot);
      if (!found) continue;
      this.remove(to, slot);
      fs.mkdirSync(target, { recursive: true });
      fs.renameSync(found.file, path.join(target, `${slot}${path.extname(found.file)}`));
    }
    const sprites = this.folder(from) && path.join(this.folder(from)!, SPRITES_DIR);
    if (sprites && fs.existsSync(sprites)) {
      fs.mkdirSync(target, { recursive: true });
      fs.renameSync(sprites, path.join(target, SPRITES_DIR));
    }
  }
}
