import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { electronDist } from './electron-dist.mjs';

// Builds the Windows app people install: dist/win/Mimi/Mimi.exe, a window onto a Mimi server
// elsewhere (the accounts gateway, or one core), the same app as build-mac.mjs. It holds no
// core and no database; see packages/desktop/remote.cjs for what it keeps on the computer.
// The older all-in-one build with a core on this PC stays: npm run build:desktop.
// Two files to hand out: Mimi-<version>-win-x64-setup.exe (an installer, made with NSIS when
// makensis is found: MAKENSIS, PATH or Program Files) and the zip the app updates itself from.
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
const SETUP_NAME = `Mimi-${VERSION}-win-${process.arch}-setup.exe`;
// The updater (updater.cjs) mirrors a new version over the install folder but leaves this file.
const UNINSTALLER = 'Uninstall Mimi.exe';

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
for (const file of ['remote.cjs', 'remote-lib.cjs', 'updater.cjs', 'preload.cjs', 'connect.html', 'browser-shell.cjs', 'browser-prompt-preload.cjs', 'browser-prompt.html']) {
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
const icoPng = renderIconPng(256);
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2); // type: icon
icoHeader.writeUInt16LE(1, 4); // one image
icoHeader.writeUInt16LE(1, 10); // planes (width/height 0 = 256)
icoHeader.writeUInt16LE(32, 12); // bits per pixel
icoHeader.writeUInt32LE(icoPng.length, 14);
icoHeader.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(STAGE, 'Mimi.ico'), Buffer.concat([icoHeader, icoPng]));
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

// 6. The installer: per Windows account (no admin), always into %LOCALAPPDATA%ProgramsMimi,
// with Start menu and Desktop shortcuts and an entry in "Apps" to uninstall. The sign-in
// (%APPDATA%Mimi) is left alone, so a reinstall or an update stays signed in.
function findMakensis() {
  const candidates = [
    process.env.MAKENSIS,
    ...String(process.env.PATH ?? '').split(path.delimiter).map((dir) => dir && path.join(dir, 'makensis.exe')),
    ...[process.env['ProgramFiles(x86)'], process.env.ProgramFiles].map((dir) => dir && path.join(dir, 'NSIS', 'makensis.exe')),
  ];
  return candidates.find((file) => file && fs.existsSync(file)) ?? null;
}
const makensis = findMakensis();
if (!makensis) {
  console.warn('[build] makensis not found (install NSIS or set MAKENSIS): no installer this time, only the zip');
} else {
  const numeric = `${VERSION.split('-')[0].split('.').concat('0', '0', '0').slice(0, 3).join('.')}.0`;
  const icon = path.join(STAGE, 'Mimi.ico');
  const key = String.raw`HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mimi"`;
  const closeMimi = String.raw`  nsExec::Exec '"$SYSDIR\taskkill.exe" /IM Mimi.exe /F'`;
  const uninstaller = path.win32.join('$INSTDIR', UNINSTALLER);
  const nsi = String.raw`Unicode true
ManifestDPIAware true
!include "MUI2.nsh"
Name "Mimi"
OutFile "${path.join(DIST, SETUP_NAME)}"
InstallDir "$LOCALAPPDATA\Programs\Mimi"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${numeric}"
VIAddVersionKey /LANG=0 "ProductName" "Mimi"
VIAddVersionKey /LANG=0 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "FileDescription" "Mimi installer"
!define MUI_ICON "${icon}"
!define MUI_UNICON "${icon}"
!define MUI_WELCOMEPAGE_TEXT "ติดตั้ง Mimi ${VERSION} สำหรับผู้ใช้ Windows คนนี้ (ไม่ต้องใช้สิทธิ์ผู้ดูแล)$\r$\n$\r$\nถ้า Mimi เปิดอยู่ ตัวติดตั้งจะปิดให้ก่อน การเข้าสู่ระบบยังอยู่เหมือนเดิม"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Mimi.exe"
!define MUI_FINISHPAGE_RUN_TEXT "เปิด Mimi"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Thai"
Section
${closeMimi}
  Sleep 1000
  SetOutPath "$INSTDIR"
  File /r /x install.cmd /x README.txt "${STAGE}\*"
  WriteUninstaller "${uninstaller}"
  CreateShortCut "$SMPROGRAMS\Mimi.lnk" "$INSTDIR\Mimi.exe" "" "$INSTDIR\Mimi.ico"
  CreateShortCut "$DESKTOP\Mimi.lnk" "$INSTDIR\Mimi.exe" "" "$INSTDIR\Mimi.ico"
  WriteRegStr ${key} "DisplayName" "Mimi"
  WriteRegStr ${key} "DisplayVersion" "${VERSION}"
  WriteRegStr ${key} "Publisher" "Mimi"
  WriteRegStr ${key} "DisplayIcon" "$INSTDIR\Mimi.ico"
  WriteRegStr ${key} "InstallLocation" "$INSTDIR"
  WriteRegStr ${key} "UninstallString" '"${uninstaller}"'
  WriteRegDWORD ${key} "NoModify" 1
  WriteRegDWORD ${key} "NoRepair" 1
SectionEnd
Section "Uninstall"
${closeMimi}
  Sleep 1000
  Delete "$SMPROGRAMS\Mimi.lnk"
  Delete "$DESKTOP\Mimi.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey ${key}
SectionEnd
`.replaceAll('\n', '\r\n');
  const nsiPath = path.join(DIST, 'win', 'mimi-setup.nsi');
  // A BOM tells makensis the script is UTF-8 (the Thai text).
  fs.writeFileSync(nsiPath, `﻿${nsi}`, 'utf8');
  log(`making ${SETUP_NAME}...`);
  execFileSync(makensis, ['/V2', nsiPath], { stdio: 'inherit' });
  const setupMb = (fs.statSync(path.join(DIST, SETUP_NAME)).size / 1024 / 1024).toFixed(1);
  log(`done: dist/${SETUP_NAME} (${setupMb} MB)`);
}
