import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { packPcAgent, copyPcAgentPackages } from './pack-pc-agent.mjs';
import { signWindows } from './signing.mjs';

// Builds the native Windows app (apps/windows, WinUI 3 — no Electron, no WebView) into the same
// shapes the Electron build hands out, so its updater and installer work the same way:
//   dist/win-native/Mimi/Mimi.exe                      the app folder (.NET and Windows App SDK inside)
//   dist/win-native/Mimi-<version>-win-<arch>.zip      what the app updates itself from (Desktop/Updater.cs)
//   dist/win-native/Mimi-<version>-win-<arch>-setup.exe  per-user installer (NSIS, when makensis is found)
// The PC agent stays a Node program (docs/native README Q7): its sources and node.exe go in the folder.
//   node scripts/build-win-native.mjs [--arch x64|arm64]
// Needs the .NET 10 SDK (DOTNET, else dotnet on PATH). Nothing is signed unless WIN_CSC_* is set (signing.mjs).

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist', 'win-native');
const STAGE = path.join(OUT, 'Mimi');
const PROJECT = path.join(ROOT, 'apps', 'windows', 'src', 'Mimi.App', 'Mimi.App.csproj');
const ROOT_PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = ROOT_PACKAGE.version;
const NUMERIC = VERSION.split('-')[0].split('.').concat('0', '0', '0').slice(0, 3).join('.');
const UPDATE_REPO = String(ROOT_PACKAGE.repository ?? '').replace(/^github:/, '');
const argAt = process.argv.indexOf('--arch');
const ARCH = argAt > 0 ? process.argv[argAt + 1] : process.arch === 'arm64' ? 'arm64' : 'x64';
const ZIP_NAME = `Mimi-${VERSION}-win-${ARCH}.zip`;
const SETUP_NAME = `Mimi-${VERSION}-win-${ARCH}-setup.exe`;
const UNINSTALLER = 'Uninstall Mimi.exe';
const DOTNET = process.env.DOTNET || 'dotnet';

const log = (line) => console.log(`[build] ${line}`);

if (process.platform !== 'win32') {
  console.error('The Windows app is built on Windows.');
  process.exit(1);
}
if (!['x64', 'arm64'].includes(ARCH)) {
  console.error(`--arch must be x64 or arm64, not ${ARCH}`);
  process.exit(1);
}

// 1. The icon drawn in code, then the app itself: Release, self-contained, Mimi's name/icon/version in the exe.
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'windows-icons.mjs')], { stdio: 'inherit' });
fs.rmSync(OUT, { recursive: true, force: true });
log(`dotnet publish (${ARCH}, ${VERSION})...`);
execFileSync(
  DOTNET,
  [
    'publish', PROJECT,
    '-c', 'Release',
    '-r', `win-${ARCH}`,
    `-p:Platform=${ARCH === 'arm64' ? 'ARM64' : 'x64'}`,
    '--self-contained', 'true',
    `-p:Version=${NUMERIC}`,
    `-p:InformationalVersion=${VERSION}`,
    `-p:UpdateRepo=${UPDATE_REPO}`,
    '-p:DebugType=none',
    '-o', STAGE,
  ],
  { stdio: 'inherit', cwd: ROOT },
);
if (!fs.existsSync(path.join(STAGE, 'Mimi.exe'))) throw new Error('dotnet publish did not produce Mimi.exe');
log('app published');

// 2. The PC agent beside the app (the same layout as the Electron build: pc-agent/, shared/, node_modules/),
// and the Node that runs it. Node 24+ runs its TypeScript directly.
packPcAgent(ROOT, STAGE);
copyPcAgentPackages(ROOT, STAGE);
if (ARCH === (process.arch === 'arm64' ? 'arm64' : 'x64')) {
  fs.mkdirSync(path.join(STAGE, 'node'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(STAGE, 'node', 'node.exe'));
  log(`PC agent + node ${process.version} copied`);
} else {
  console.warn(`[build] node.exe of this computer is ${process.arch}: the ${ARCH} build runs the PC agent with the node on PATH`);
}

// 3. Authenticode (when a certificate is set), before packing, so the zip the app updates from carries it.
const signed = signWindows([path.join(STAGE, 'Mimi.exe')]);

fs.writeFileSync(
  path.join(STAGE, 'README.txt'),
  `Mimi สำหรับ Windows (แอป native) ${VERSION}\r\n\r\n` +
    `1. แตกไฟล์ zip ไปไว้ในที่ที่จะเก็บถาวร เช่น %LOCALAPPDATA%\\Programs\\Mimi แล้วเปิด Mimi.exe\r\n` +
    (signed
      ? `   ครั้งแรก Windows SmartScreen อาจถามยืนยัน ให้ดูว่าผู้เผยแพร่ถูกต้องแล้วกด Run\r\n`
      : `   ครั้งแรก Windows SmartScreen อาจเตือน (แอปยังไม่ได้ลงนาม) ให้กด "More info" แล้ว "Run anyway"\r\n`) +
    `2. ใส่ที่อยู่เซิร์ฟเวอร์ (https://...) แล้วเข้าสู่ระบบ\r\n` +
    `3. ไอคอน Mimi อยู่ที่ถาดระบบ: เปิดแชต, Mimiamp, PC agent, ออกจากระบบอัตโนมัติ, ออกจากระบบ\r\n\r\n` +
    `- แชต ความจำ ไฟล์ และคีย์อยู่บนเซิร์ฟเวอร์ เครื่องนี้เก็บแค่การตั้งค่า (%APPDATA%\\Mimi\\config.json) และ token\r\n` +
    `  ที่เข้ารหัสด้วย Windows DPAPI (%APPDATA%\\Mimi\\session.dpapi) — ลบเมื่อออกจากระบบ\r\n` +
    `- ปิดหน้าต่าง = ซ่อนไว้ที่ถาดระบบ ออกจากแอปจริง ๆ ที่เมนูของไอคอน Mimi\r\n`,
  'utf8',
);

// 4. The zip (Windows' own bsdtar writes zip with -a).
const zipPath = path.join(OUT, ZIP_NAME);
execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zipPath, '-C', OUT, 'Mimi'], { stdio: 'inherit' });
log(`done: ${path.relative(ROOT, zipPath)} (${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB)`);

// 5. The installer: per Windows account (no admin), into %LOCALAPPDATA%\Programs\Mimi — the same place,
// registry entry and uninstaller name as the Electron installer, so it installs over it.
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
  const icon = path.join(ROOT, 'apps', 'windows', 'src', 'Mimi.App', 'Assets', 'Mimi.ico');
  const key = String.raw`HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Mimi"`;
  const closeMimi = String.raw`  nsExec::Exec '"$SYSDIR\taskkill.exe" /IM Mimi.exe /F'`;
  const uninstaller = path.win32.join('$INSTDIR', UNINSTALLER);
  const nsi = String.raw`Unicode true
ManifestDPIAware true
!include "MUI2.nsh"
Name "Mimi"
OutFile "${path.join(OUT, SETUP_NAME)}"
InstallDir "$LOCALAPPDATA\Programs\Mimi"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${NUMERIC}.0"
VIAddVersionKey /LANG=0 "ProductName" "Mimi"
VIAddVersionKey /LANG=0 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "FileDescription" "Mimi installer"
!define MUI_ICON "${icon}"
!define MUI_UNICON "${icon}"
!define MUI_WELCOMEPAGE_TEXT "ติดตั้ง Mimi ${VERSION} สำหรับผู้ใช้ Windows คนนี้ (ไม่ต้องใช้สิทธิ์ผู้ดูแล)$\r$\n$\r$\nถ้า Mimi เปิดอยู่ ตัวติดตั้งจะปิดให้ก่อน"
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
  ; An Electron install in the same folder goes first (its files would stay beside the new ones).
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  SetOutPath "$INSTDIR"
  File /r /x README.txt "${STAGE}\*"
  WriteUninstaller "${uninstaller}"
  CreateShortCut "$SMPROGRAMS\Mimi.lnk" "$INSTDIR\Mimi.exe" "" "$INSTDIR\Mimi.exe"
  CreateShortCut "$DESKTOP\Mimi.lnk" "$INSTDIR\Mimi.exe" "" "$INSTDIR\Mimi.exe"
  WriteRegStr ${key} "DisplayName" "Mimi"
  WriteRegStr ${key} "DisplayVersion" "${VERSION}"
  WriteRegStr ${key} "Publisher" "Mimi"
  WriteRegStr ${key} "DisplayIcon" "$INSTDIR\Mimi.exe"
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
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "app.mimi"
  RMDir /r "$INSTDIR"
  DeleteRegKey ${key}
SectionEnd
`.replaceAll('\n', '\r\n');
  const nsiPath = path.join(OUT, 'mimi-setup.nsi');
  // A BOM tells makensis the script is UTF-8 (the Thai text).
  fs.writeFileSync(nsiPath, `\ufeff${nsi}`, 'utf8');
  log(`making ${SETUP_NAME}...`);
  execFileSync(makensis, ['/V2', nsiPath], { stdio: 'inherit' });
  signWindows([path.join(OUT, SETUP_NAME)]);
  log(`done: dist/win-native/${SETUP_NAME} (${(fs.statSync(path.join(OUT, SETUP_NAME)).size / 1048576).toFixed(1)} MB)`);
}
