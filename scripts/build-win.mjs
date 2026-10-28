import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { electronDist } from './electron-dist.mjs';

// Builds the Windows app people install: dist/win/Mimi/Mimi.exe, a window onto a Mimi server
// elsewhere (the accounts gateway, or one core), the same app as build-mac.mjs. It holds no
// core and no database; see packages/desktop/remote.cjs for what it keeps on the computer.
// The older all-in-one build with a core on this PC stays: npm run build:desktop.
//   npm run build:win

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'win', 'Mimi');
const APP = path.join(STAGE, 'resources', 'app');
const CACHE = path.join(DIST, '.cache');
const ROOT_PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = ROOT_PACKAGE.version;
const UPDATE_REPO = String(ROOT_PACKAGE.repository ?? '').replace(/^github:/, '') || null;
const ZIP_NAME = `Mimi-${VERSION}-win-${process.arch}.zip`;

const log = (line) => console.log(`[build] ${line}`);
const run = (command, args, cwd = DIST) => execFileSync(command, args, { cwd, stdio: 'inherit' });

if (process.platform !== 'win32') {
  console.error('The Windows package is built on Windows.');
  process.exit(1);
}

// 1. Electron, renamed to Mimi.
const electron = await electronDist(CACHE);
fs.rmSync(path.join(DIST, 'win'), { recursive: true, force: true });
fs.cpSync(electron, STAGE, { recursive: true, filter: (src) => path.basename(src) !== '.complete' });
fs.renameSync(path.join(STAGE, 'electron.exe'), path.join(STAGE, 'Mimi.exe'));
// Electron's sample app would open if ours were missing; it has no place here.
fs.rmSync(path.join(STAGE, 'resources', 'default_app.asar'), { force: true });
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
const skipTests = (src) => !/\.test\.ts$/.test(src) && !path.basename(src).startsWith('._') && path.basename(src) !== '.DS_Store';
for (const pkg of ['shared', 'pc-agent']) {
  const to = path.join(APP, 'node_modules', '@mimi', pkg);
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'packages', pkg, 'package.json'), path.join(to, 'package.json'));
  fs.cpSync(path.join(ROOT, 'packages', pkg, 'src'), path.join(to, 'src'), { recursive: true, filter: skipTests });
}
// The only outside package the PC agent and @mimi/shared use.
fs.cpSync(path.join(ROOT, 'node_modules', 'zod'), path.join(APP, 'node_modules', 'zod'), { recursive: true });
log('app and PC agent copied');

// 3. The window and tray picture, drawn in code (the same picture as the Mac build). The .exe
// keeps Electron's own icon: changing it needs a resource editor this build does not carry.
const { renderIconPng } = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/app/icon.ts')).href);
fs.writeFileSync(path.join(APP, 'icon.png'), renderIconPng());
log('icon written');

// 4. A Start menu and Desktop shortcut for this Windows account, made from where the folder ends up.
fs.writeFileSync(
  path.join(STAGE, 'install.cmd'),
  [
    '@echo off',
    'setlocal',
    'set "TARGET=%~dp0Mimi.exe"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command ^',
    '  "$s = New-Object -ComObject WScript.Shell;" ^',
    '  "foreach ($dir in @([Environment]::GetFolderPath(\'Desktop\'), [Environment]::GetFolderPath(\'Programs\'))) {" ^',
    '  "  $l = $s.CreateShortcut((Join-Path $dir \'Mimi.lnk\')); $l.TargetPath = $env:TARGET; $l.WorkingDirectory = (Split-Path $env:TARGET); $l.Save() }"',
    'echo Mimi shortcuts are on the Desktop and in the Start menu.',
    'pause',
    '',
  ].join('\r\n'),
);
fs.writeFileSync(
  path.join(STAGE, 'README.txt'),
  `Mimi - แอปบน Windows สำหรับต่อเซิร์ฟเวอร์ Mimi\r\n\r\n` +
    `วิธีติดตั้ง\r\n` +
    `1. แตกไฟล์ zip ไปไว้ในที่ที่จะเก็บถาวร เช่น %LOCALAPPDATA%\\Programs\\Mimi\r\n` +
    `2. ดับเบิลคลิก install.cmd เพื่อสร้างทางลัดบน Desktop และ Start menu (หรือเปิด Mimi.exe ตรง ๆ)\r\n` +
    `   ครั้งแรก Windows SmartScreen อาจเตือน (แอปยังไม่ได้ลงนาม) ให้กด "More info" แล้ว "Run anyway"\r\n` +
    `3. ใส่ที่อยู่เซิร์ฟเวอร์ที่ผู้ดูแลให้มา (https://...) แล้วเข้าสู่ระบบ\r\n` +
    `4. ไอคอน Mimi อยู่ที่ถาดระบบมุมขวาล่าง: เปิดแชต, ให้ Mimi ใช้เครื่องนี้ (PC agent), ออกจากระบบอัตโนมัติ, ออกจากระบบ\r\n\r\n` +
    `ข้อมูล\r\n` +
    `- แชต ความจำ ไฟล์ และคีย์ทั้งหมดอยู่บนเซิร์ฟเวอร์ เครื่องนี้เก็บแค่ token การเข้าสู่ระบบ (เข้ารหัสด้วย Windows DPAPI ผูกกับผู้ใช้ Windows)\r\n` +
    `  ที่ %APPDATA%\\Mimi และไฟล์ชั่วคราวของ PC agent ที่ %LOCALAPPDATA%\\Mimi (ลบตอนออกจากระบบ)\r\n` +
    `- เครื่องที่ใช้ร่วมกับคนอื่น: ติ๊ก "เครื่องนี้ไม่ใช่ของฉัน" ตอนเข้าสู่ระบบ แล้ว Mimi จะไม่จำการเข้าสู่ระบบหลังปิดแอป\r\n` +
    `- ปิดหน้าต่าง = ซ่อนไว้ที่ถาดระบบ ออกจากแอปจริง ๆ ที่เมนูของไอคอน Mimi\r\n`,
  'utf8',
);

// 5. One zip to hand out. Windows' own tar (bsdtar) writes zip with -a; a GNU tar earlier on
// PATH (Git Bash) cannot.
const zipPath = path.join(DIST, ZIP_NAME);
fs.rmSync(zipPath, { force: true });
log(`packing ${ZIP_NAME}...`);
run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zipPath, '-C', path.dirname(STAGE), path.basename(STAGE)]);
const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
log(`done: ${path.relative(ROOT, zipPath)} (${sizeMb} MB)`);
