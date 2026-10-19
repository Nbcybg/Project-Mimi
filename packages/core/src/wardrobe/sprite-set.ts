import fs from 'node:fs';
import path from 'node:path';

/**
 * A sprite key names an emoji by its code points in lowercase hex, joined by "-" and
 * without the emoji-presentation selector (U+FE0F): 😊 -> "1f60a", ❤️ -> "2764",
 * 👩‍💻 -> "1f469-200d-1f4bb". It is a safe file name and the same for every client.
 */
export const SPRITE_KEY = /^[0-9a-f]{2,6}(?:-[0-9a-f]{2,6}){0,9}$/;
const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SPRITES = 300;

/** The expression pictures of one agent or one outfit: a folder of `<key>.<ext>` files. */
export class SpriteSet {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private find(key: string): { file: string; mime: string } | undefined {
    if (!SPRITE_KEY.test(key)) return undefined;
    for (const [mime, extension] of Object.entries(TYPES)) {
      const file = path.join(this.dir, `${key}.${extension}`);
      if (fs.existsSync(file)) return { file, mime };
    }
    return undefined;
  }

  /** Key -> version (changes with the picture), for every sprite in the set. */
  list(): Record<string, string> {
    const sprites: Record<string, string> = {};
    if (!fs.existsSync(this.dir)) return sprites;
    for (const entry of fs.readdirSync(this.dir)) {
      const key = path.parse(entry).name;
      const found = this.find(key);
      if (found && path.basename(found.file) === entry) sprites[key] = String(Math.round(fs.statSync(found.file).mtimeMs));
    }
    return sprites;
  }

  read(key: string): { data: Buffer; mime: string } | undefined {
    const found = this.find(key);
    return found && { data: fs.readFileSync(found.file), mime: found.mime };
  }

  save(key: string, mime: string, data: Buffer): void {
    if (!SPRITE_KEY.test(key)) throw new Error('Not an emoji key.');
    const extension = TYPES[mime.toLowerCase()];
    if (!extension) throw new Error('Use a PNG, JPEG, WebP or GIF image.');
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new Error('The image must be smaller than 8 MB.');
    if (!this.find(key) && Object.keys(this.list()).length >= MAX_SPRITES) throw new Error(`A set holds at most ${MAX_SPRITES} pictures.`);
    this.remove(key);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${key}.${extension}`), data);
  }

  remove(key: string): void {
    for (let found = this.find(key); found; found = this.find(key)) fs.rmSync(found.file);
  }
}
