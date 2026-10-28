import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { electronDist } from './electron-dist.mjs';

// Builds the macOS app people install: dist/mac/Mimi.app, a window onto a Mimi server
// elsewhere (the accounts gateway, or one core). It holds no core and no database; see
// packages/desktop/remote.cjs for what it keeps on the computer. Inside: Electron, the app
// (packages/desktop) and the PC agent, which runs on Electron's own Node when the user
// turns it on. Running Mimi entirely on this Mac stays possible from the sources: npm run app.
//   npm run build:mac

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUNDLE = path.join(DIST, 'mac', 'Mimi.app');
const CONTENTS = path.join(BUNDLE, 'Contents');
const RESOURCES = path.join(CONTENTS, 'Resources');
const APP = path.join(RESOURCES, 'app');
const CACHE = path.join(DIST, '.cache');
const ROOT_PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = ROOT_PACKAGE.version;
const UPDATE_REPO = String(ROOT_PACKAGE.repository ?? '').replace(/^github:/, '') || null;
const ARCH = process.arch;
const ZIP_NAME = `Mimi-${VERSION}-mac-${ARCH}.zip`;

const log = (line) => console.log(`[build] ${line}`);
const run = (command, args, cwd = DIST) => execFileSync(command, args, { cwd, stdio: 'inherit' });

if (process.platform !== 'darwin') {
  console.error('The mac package is built on macOS.');
  process.exit(1);
}

// 1. Electron, renamed to Mimi.
const electron = await electronDist(CACHE);
fs.rmSync(path.join(DIST, 'mac'), { recursive: true, force: true });
fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
run('ditto', [path.join(electron, 'Electron.app'), BUNDLE]);
fs.renameSync(path.join(CONTENTS, 'MacOS', 'Electron'), path.join(CONTENTS, 'MacOS', 'Mimi'));
// Electron's sample app would open if ours were missing; it has no place here.
fs.rmSync(path.join(RESOURCES, 'default_app.asar'), { force: true });
log(`Electron ${path.basename(electron)} copied`);

// 2. The app: the desktop shell, and the PC agent with what it imports. Tests stay behind.
fs.mkdirSync(APP, { recursive: true });
for (const file of ['remote.cjs', 'remote-lib.cjs', 'updater.cjs', 'preload.cjs', 'connect.html']) {
  fs.copyFileSync(path.join(ROOT, 'packages', 'desktop', file), path.join(APP, file));
}
// updateRepo: where the app looks for newer releases (updater.cjs).
fs.writeFileSync(
  path.join(APP, 'package.json'),
  `${JSON.stringify({ name: 'mimi', productName: 'Mimi', version: VERSION, private: true, main: 'remote.cjs', updateRepo: UPDATE_REPO }, null, 2)}\n`,
);
const skipTests = (src) => !/\.test\.ts$/.test(src) && !path.basename(src).startsWith('._');
for (const pkg of ['shared', 'pc-agent']) {
  const to = path.join(APP, 'node_modules', '@mimi', pkg);
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'packages', pkg, 'package.json'), path.join(to, 'package.json'));
  fs.cpSync(path.join(ROOT, 'packages', pkg, 'src'), path.join(to, 'src'), { recursive: true, filter: skipTests });
}
// The only outside package the PC agent and @mimi/shared use.
fs.cpSync(path.join(ROOT, 'node_modules', 'zod'), path.join(APP, 'node_modules', 'zod'), { recursive: true });
log('app and PC agent copied');

// 3. Icons: the tray picture and the app icon, drawn in code (the same picture as the Windows build).
const { renderIconPng } = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/app/icon.ts')).href);
fs.mkdirSync(CACHE, { recursive: true });
const baseIcon = path.join(CACHE, 'mimi-256.png');
fs.writeFileSync(baseIcon, renderIconPng());
fs.copyFileSync(baseIcon, path.join(APP, 'icon.png'));
const iconset = path.join(CACHE, 'mimi.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });
const iconNames = {
  16: ['icon_16x16.png'],
  32: ['icon_16x16@2x.png', 'icon_32x32.png'],
  64: ['icon_32x32@2x.png'],
  128: ['icon_128x128.png'],
  256: ['icon_128x128@2x.png', 'icon_256x256.png'],
  512: ['icon_256x256@2x.png', 'icon_512x512.png'],
  1024: ['icon_512x512@2x.png'],
};
for (const [size, names] of Object.entries(iconNames)) {
  const png = path.join(CACHE, `mimi-${size}.png`);
  run('sips', ['-z', size, size, baseIcon, '--out', png], CACHE);
  for (const name of names) fs.copyFileSync(png, path.join(iconset, name));
}
fs.rmSync(path.join(RESOURCES, 'electron.icns'), { force: true });
run('iconutil', ['-c', 'icns', iconset, '-o', path.join(RESOURCES, 'mimi.icns')], CACHE);
log('icons written');

// 4. The bundle's identity and what it asks the user for.
const plist = path.join(CONTENTS, 'Info.plist');
const set = (key, type, value) => {
  try {
    execFileSync('plutil', ['-remove', key, plist], { stdio: 'ignore' });
  } catch {
    // not there yet
  }
  run('plutil', ['-insert', key, `-${type}`, value, plist]);
};
set('CFBundleExecutable', 'string', 'Mimi');
set('CFBundleName', 'string', 'Mimi');
set('CFBundleDisplayName', 'string', 'Mimi');
set('CFBundleIdentifier', 'string', 'app.mimi');
set('CFBundleIconFile', 'string', 'mimi.icns');
set('CFBundleShortVersionString', 'string', VERSION);
set('CFBundleVersion', 'string', VERSION);
set('CFBundleDevelopmentRegion', 'string', 'th');
set('LSUIElement', 'bool', 'true');
set('NSMicrophoneUsageDescription', 'string', 'Mimi ใช้ไมโครโฟนเมื่อคุณพูดในแชต');
set('NSCameraUsageDescription', 'string', 'Mimi ใช้กล้องเมื่อคุณเปิดวิดีโอคอลในแชต');
set('NSAppleEventsUsageDescription', 'string', 'Mimi ใช้เปิดลิงก์และไฟล์ให้คุณ');
run('plutil', ['-lint', plist]);

// 5. Changed files break Electron's signature; sign again (ad hoc, so it runs on this and other Macs
// after "Open" once; a Developer ID signature is needed to pass Gatekeeper without that).
run('codesign', ['--force', '--deep', '--sign', '-', BUNDLE]);
run('codesign', ['--verify', '--deep', '--strict', BUNDLE]);
log('signed (ad hoc)');

fs.writeFileSync(
  path.join(DIST, 'mac', 'README.txt'),
  `Mimi - แอปบน Mac สำหรับต่อเซิร์ฟเวอร์ Mimi\n\n` +
    `วิธีติดตั้ง\n` +
    `1. ลาก Mimi.app ไปไว้ในโฟลเดอร์ Applications\n` +
    `2. เปิด Mimi (ครั้งแรก macOS อาจเตือน ให้คลิกขวาที่ Mimi.app แล้วเลือก Open)\n` +
    `3. ใส่ที่อยู่เซิร์ฟเวอร์ที่ผู้ดูแลให้มา แล้วเข้าสู่ระบบ\n` +
    `4. ไอคอน Mimi อยู่ที่แถบเมนูด้านบน: เปิดแชต, ให้ Mimi ใช้เครื่องนี้ (PC agent), ออกจากระบบอัตโนมัติ, ออกจากระบบ\n\n` +
    `ข้อมูล\n` +
    `- แชต ความจำ ไฟล์ และคีย์ทั้งหมดอยู่บนเซิร์ฟเวอร์ เครื่องนี้เก็บแค่ token การเข้าสู่ระบบ (เข้ารหัสด้วย Keychain)\n` +
    `- ออกจากระบบแล้ว token และไฟล์ชั่วคราวถูกลบ เหลือแค่การตั้งค่า (ที่อยู่เซิร์ฟเวอร์ ขนาดหน้าต่าง)\n` +
    `- เครื่องที่ใช้ร่วมกับคนอื่น: ติ๊ก "เครื่องนี้ไม่ใช่ของฉัน" ตอนเข้าสู่ระบบ แล้ว Mimi จะไม่จำการเข้าสู่ระบบหลังปิดแอป\n` +
    `- ปิดหน้าต่าง = ซ่อนไว้ที่แถบเมนู ออกจากแอปจริง ๆ ที่เมนูของไอคอน Mimi\n` +
    `- ถ้าดาวน์โหลด zip มาจากเครื่องอื่นแล้วเปิดไม่ได้: xattr -dr com.apple.quarantine /Applications/Mimi.app\n`,
  'utf8',
);

// 6. One zip to hand out (ditto keeps symlinks and permissions).
const zipPath = path.join(DIST, ZIP_NAME);
fs.rmSync(zipPath, { force: true });
log(`packing ${ZIP_NAME}...`);
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', BUNDLE, zipPath]);
const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
log(`done: ${path.relative(ROOT, zipPath)} (${sizeMb} MB)`);
