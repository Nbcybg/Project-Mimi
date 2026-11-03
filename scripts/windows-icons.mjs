import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Writes the icons of the native Windows app (apps/windows/src/Mimi.App/Assets/) from the icon
// drawn in code, the same picture as the desktop, web and Android apps: Mimi.ico for the .exe,
// the window and the tray (16–256 px), Mimi.png for in-app use.
//   node scripts/windows-icons.mjs

const ROOT = path.resolve(import.meta.dirname, '..');
const { renderIconPng } = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/app/icon.ts')).href);
const OUT = path.join(ROOT, 'apps', 'windows', 'src', 'Mimi.App', 'Assets');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

const images = SIZES.map((size) => renderIconPng(size));
// ICO: a 6-byte header, one 16-byte entry per image, then the PNGs themselves.
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((png, i) => {
  const at = 6 + 16 * i;
  const size = SIZES[i];
  header.writeUInt8(size >= 256 ? 0 : size, at); // 0 = 256
  header.writeUInt8(size >= 256 ? 0 : size, at + 1);
  header.writeUInt16LE(1, at + 4); // planes
  header.writeUInt16LE(32, at + 6); // bits per pixel
  header.writeUInt32LE(png.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += png.length;
});
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'Mimi.ico'), Buffer.concat([header, ...images]));
fs.writeFileSync(path.join(OUT, 'Mimi.png'), renderIconPng(256));
console.log(`windows icons: Mimi.ico (${SIZES.join(', ')} px), Mimi.png`);
