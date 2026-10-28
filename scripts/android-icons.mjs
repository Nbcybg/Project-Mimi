import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Writes the Android launcher icons (android/app/src/main/res/mipmap-*/ic_launcher.png) from the
// icon drawn in code, the same picture as the desktop and web apps.
//   node scripts/android-icons.mjs

const ROOT = path.resolve(import.meta.dirname, '..');
const { renderIconPng } = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/app/icon.ts')).href);
const SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(SIZES)) {
  const dir = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', `mipmap-${density}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), renderIconPng(size));
}
console.log(`android icons: ${Object.keys(SIZES).join(', ')}`);
