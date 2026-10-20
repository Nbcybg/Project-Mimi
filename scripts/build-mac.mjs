import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

// Builds the portable macOS app: dist/mac/Mimi.app with an embedded Node runtime,
// the production dependencies and an icon. On an Intel Mac this is a mac-x64 build.
//   npm run build:mac

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUNDLE = path.join(DIST, 'mac', 'Mimi.app');
const CONTENTS = path.join(BUNDLE, 'Contents');
const MACOS = path.join(CONTENTS, 'MacOS');
const RESOURCES = path.join(CONTENTS, 'Resources');
const APP = path.join(RESOURCES, 'app');
const NODE_DIR = path.join(RESOURCES, 'node');
const CACHE = path.join(DIST, '.cache');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const NODE_VERSION = process.version.slice(1);
const ARCH = process.arch;
const ZIP_NAME = `Mimi-${VERSION}-mac-${ARCH}.zip`;

const log = (line) => console.log(`[build] ${line}`);
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

if (process.platform !== 'darwin') {
  console.error('The mac package is built on macOS.');
  process.exit(1);
}

// 1. A fresh bundle.
fs.rmSync(BUNDLE, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });
fs.mkdirSync(MACOS, { recursive: true });

// 2. The app sources; personal data, secrets and leftovers stay behind.
const SKIP_TOP = new Set(['node_modules', '.git', 'dist', 'user', 'data', 'workspace', 'agents', 'skills', 'tools', 'workflows', 'providers', 'design']);
for (const entry of fs.readdirSync(ROOT)) {
  if (SKIP_TOP.has(entry) || entry === '.env' || entry.startsWith('._')) continue;
  fs.cpSync(path.join(ROOT, entry), path.join(APP, entry), {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== 'node_modules' && !base.startsWith('._');
    },
  });
}
log(`sources copied to ${path.relative(ROOT, APP)}`);

// 3. Production dependencies only. Install scripts run: Electron downloads its
// program and better-sqlite3 fetches (or compiles) the binary for this Node.
const npm = fs.existsSync(path.join(path.dirname(process.execPath), 'npm')) ? path.join(path.dirname(process.execPath), 'npm') : 'npm';
log('installing production dependencies (npm ci --omit=dev)...');
run(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], APP);
if (!fs.existsSync(path.join(APP, 'node_modules', 'electron', 'dist'))) {
  log('downloading Electron...');
  run(process.execPath, [path.join('node_modules', 'electron', 'install.js')], APP);
}

// 4. The Node runtime, same version and architecture as this machine so native modules match.
const runtimeName = `node-v${NODE_VERSION}-darwin-${ARCH}`;
const runtimeDir = path.join(CACHE, runtimeName);
const runtimeTar = path.join(CACHE, `${runtimeName}.tar.gz`);
fs.mkdirSync(CACHE, { recursive: true });
if (!fs.existsSync(runtimeDir)) {
  if (!fs.existsSync(runtimeTar)) {
    log(`downloading Node v${NODE_VERSION} (${ARCH})...`);
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${runtimeName}.tar.gz`);
    if (!response.ok || !response.body) throw new Error(`Node download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(runtimeTar));
  }
  log('unpacking the Node runtime...');
  run('tar', ['-xzf', runtimeTar, '-C', CACHE]);
}
fs.mkdirSync(NODE_DIR, { recursive: true });
fs.copyFileSync(path.join(runtimeDir, 'bin', 'node'), path.join(NODE_DIR, 'node'));
fs.copyFileSync(path.join(runtimeDir, 'LICENSE'), path.join(NODE_DIR, 'LICENSE'));
fs.chmodSync(path.join(NODE_DIR, 'node'), 0o755);
log(`Node v${NODE_VERSION} bundled`);

// 5. The icon, drawn in code (the same picture as the Windows build).
const { renderIconPng } = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/app/icon.ts')).href);
const iconset = path.join(CACHE, 'mimi.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });
const baseIcon = path.join(CACHE, 'mimi-256.png');
fs.writeFileSync(baseIcon, renderIconPng());
const iconSizes = [16, 32, 64, 128, 256, 512, 1024];
const iconNames = {
  16: ['icon_16x16.png'],
  32: ['icon_16x16@2x.png', 'icon_32x32.png'],
  64: ['icon_32x32@2x.png'],
  128: ['icon_128x128.png'],
  256: ['icon_128x128@2x.png', 'icon_256x256.png'],
  512: ['icon_256x256@2x.png', 'icon_512x512.png'],
  1024: ['icon_512x512@2x.png'],
};
for (const size of iconSizes) {
  const png = path.join(CACHE, `mimi-${size}.png`);
  run('sips', ['-z', String(size), String(size), baseIcon, '--out', png], CACHE);
  for (const name of iconNames[size]) fs.copyFileSync(png, path.join(iconset, name));
}
run('iconutil', ['-c', 'icns', iconset, '-o', path.join(RESOURCES, 'mimi.icns')], CACHE);
log('icon.icns written');

// 6. The bundle metadata and the program Finder starts.
fs.writeFileSync(
  path.join(CONTENTS, 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>th</string>
  <key>CFBundleDisplayName</key><string>Mimi</string>
  <key>CFBundleExecutable</key><string>Mimi</string>
  <key>CFBundleIconFile</key><string>mimi.icns</string>
  <key>CFBundleIdentifier</key><string>app.mimi</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Mimi</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Mimi ใช้เปิดลิงก์และไฟล์ให้คุณ</string>
  <key>NSCameraUsageDescription</key><string>Mimi ใช้กล้องเมื่อคุณเปิดวิดีโอคอลในแชต</string>
  <key>NSMicrophoneUsageDescription</key><string>Mimi ใช้ไมโครโฟนเมื่อคุณพูดในแชต</string>
</dict>
</plist>
`,
  'utf8',
);

const launcher = `#!/bin/bash
set -euo pipefail
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
mkdir -p "$HOME/Library/Logs"
cd "$RES/app"
exec "$RES/node/node" --env-file-if-exists=.env "$RES/app/packages/core/src/app/launcher.ts" >> "$HOME/Library/Logs/Mimi.log" 2>&1
`;
const launcherPath = path.join(MACOS, 'Mimi');
fs.writeFileSync(launcherPath, launcher, 'utf8');
fs.chmodSync(launcherPath, 0o755);

// A visible-log start for troubleshooting.
fs.writeFileSync(
  path.join(DIST, 'mac', 'Start Mimi (debug).command'),
  `#!/bin/bash
cd "$(dirname "$0")/Mimi.app/Contents/Resources/app"
exec "./../node/node" --env-file-if-exists=.env "packages/core/src/app/launcher.ts"
`,
  'utf8',
);
fs.chmodSync(path.join(DIST, 'mac', 'Start Mimi (debug).command'), 0o755);

fs.writeFileSync(
  path.join(DIST, 'mac', 'README.txt'),
  `Mimi - แอปผู้ช่วยส่วนตัว (macOS Intel)\n\n` +
    `วิธีติดตั้ง\n` +
    `1. ลาก Mimi.app ไปไว้ในโฟลเดอร์ Applications\n` +
    `2. เปิด Mimi จาก Launchpad หรือ Finder (ถ้าครั้งแรก macOS ขึ้นเตือน ให้คลิกขวาที่ Mimi.app แล้วเลือก Open)\n` +
    `3. ไอคอน Mimi จะอยู่ที่แถบเมนูด้านบน คลิกเพื่อเปิดแชต/ตั้งค่า\n` +
    `4. ใส่ API key ของ provider ในหน้า Settings\n\n` +
    `หมายเหตุ\n` +
    `- ข้อมูลทั้งหมด (แชท, memory, key) อยู่ในโฟลเดอร์ Documents/Mimi สำรองข้อมูล = คัดลอกโฟลเดอร์นี้\n` +
    `- ปิดหน้าต่าง = ซ่อนไว้ที่แถบเมนู ออกจากแอปจริง ๆ ที่เมนูของไอคอน Mimi\n` +
    `- ถ้าดาวน์โหลดไฟล์ zip มาจากเครื่องอื่นแล้วเปิดไม่ได้ ให้รัน:\n` +
    `  xattr -dr com.apple.quarantine /Applications/Mimi.app\n` +
    `- ไฟล์ "Start Mimi (debug).command" เปิดแอปแบบเห็น log ไว้ใช้แก้ปัญหา\n`,
  'utf8',
);
log('Mimi.app and README.txt written');

// 7. One zip that users can download (ditto keeps symlinks and permissions).
const zipPath = path.join(DIST, ZIP_NAME);
fs.rmSync(zipPath, { force: true });
log(`packing ${ZIP_NAME}...`);
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', BUNDLE, zipPath], DIST);

const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
log(`done: ${path.relative(ROOT, zipPath)} (${sizeMb} MB)`);
