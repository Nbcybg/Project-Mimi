import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Fills in what packages/ui needs but does not keep in git, so the page runs from the app
// bundle with no server behind it:
//   vendor/   three.js, three-vrm and the three addons the page imports (from node_modules)
//   icon.png  the app icon (drawn by packages/core/src/app/icon.ts)
// Run it after `npm install` and before packing an app:  node scripts/sync-ui.mjs

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'packages', 'ui');
const VENDOR = path.join(UI, 'vendor');

// ESM entry points (the "import" condition), as the browser's import map needs them.
const threeEntry = fileURLToPath(import.meta.resolve('three')); // build/three.module.js
const threeBuild = path.dirname(threeEntry);
const threeRoot = path.resolve(threeBuild, '..');
const vrmEntry = fileURLToPath(import.meta.resolve('@pixiv/three-vrm'));

fs.rmSync(VENDOR, { recursive: true, force: true });
fs.mkdirSync(VENDOR, { recursive: true });
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

copy(threeEntry, path.join(VENDOR, 'three.module.js'));
copy(path.join(threeBuild, 'three.core.js'), path.join(VENDOR, 'three.core.js'));
copy(vrmEntry, path.join(VENDOR, 'three-vrm.module.js'));

// The addons the page imports as "three/addons/<file>" (the import map in index.html points
// them at vendor/addons/), plus whatever those files import from their own folders.
const addonsRoot = path.join(threeRoot, 'examples', 'jsm');
const wanted = new Set();
for (const file of fs.readdirSync(UI)) {
  if (!file.endsWith('.js')) continue;
  for (const [, addon] of fs.readFileSync(path.join(UI, file), 'utf8').matchAll(/three\/addons\/([A-Za-z0-9/_.-]+)/g)) {
    wanted.add(path.join(addonsRoot, addon));
  }
}
const seen = new Set();
const queue = [...wanted];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const source = fs.readFileSync(file, 'utf8');
  for (const [, spec] of source.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(path.resolve(path.dirname(file), spec));
}
for (const file of seen) copy(file, path.join(VENDOR, 'addons', path.relative(addonsRoot, file)));

const { renderIconPng } = await import(pathToFileURL(path.join(ROOT, 'packages', 'core', 'src', 'app', 'icon.ts')).href);
fs.writeFileSync(path.join(UI, 'icon.png'), renderIconPng());

console.log(`packages/ui synced: vendor (${3 + seen.size} files), icon.png`);
