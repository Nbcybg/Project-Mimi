import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

// Builds the portable Windows app: dist/Mimi/ with an embedded Node runtime, the
// production dependencies and an install.cmd that puts a shortcut on the Desktop.
//   npm run build:desktop

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'Mimi');
const APP = path.join(STAGE, 'app');
const NODE_DIR = path.join(STAGE, 'node');
const CACHE = path.join(DIST, '.cache');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const NODE_VERSION = process.version.slice(1);
const ZIP_NAME = `Mimi-${VERSION}-win64.zip`;

const log = (line) => console.log(`[build] ${line}`);
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

if (process.platform !== 'win32') {
  console.error('The desktop package is built on Windows (win-x64).');
  process.exit(1);
}

// 1. A fresh staging folder.
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });

// 2. The app sources; personal data, secrets and leftovers stay behind.
const SKIP_TOP = new Set(['node_modules', '.git', '.claude', '_old', 'dist', 'user', 'data', 'workspace', 'agents', 'skills', 'tools', 'workflows', 'providers', 'design']);
fs.mkdirSync(APP, { recursive: true });
for (const entry of fs.readdirSync(ROOT)) {
  if (SKIP_TOP.has(entry) || entry === '.env' || entry === 'Mimi.lnk' || entry.startsWith('._')) continue;
  fs.cpSync(path.join(ROOT, entry), path.join(APP, entry), {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== 'node_modules' && !base.startsWith('._');
    },
  });
}
log(`sources copied to ${path.relative(ROOT, APP)}`);

// 3. Production dependencies only. Scripts stay off: better-sqlite3 ships prebuilt
// binaries and would otherwise make npm run node-gyp, which needs Visual Studio.
log('installing production dependencies (npm ci --omit=dev)...');
run('cmd.exe', ['/d', '/s', '/c', 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund'], APP);
// Electron (the native window) downloads its program in a script of its own, which --ignore-scripts skipped.
run(process.execPath, [path.join('node_modules', 'electron', 'install.js')], APP);

// 4. The Node runtime, same version as this machine so native modules match.
const runtimeZip = path.join(CACHE, `node-v${NODE_VERSION}-win-x64.zip`);
const runtimeDir = path.join(CACHE, `node-v${NODE_VERSION}-win-x64`);
fs.mkdirSync(CACHE, { recursive: true });
if (!fs.existsSync(runtimeZip)) {
  log(`downloading Node v${NODE_VERSION}...`);
  const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`);
  if (!response.ok || !response.body) throw new Error(`Node download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(runtimeZip));
}
if (!fs.existsSync(runtimeDir)) {
  log('unpacking the Node runtime...');
  run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${runtimeZip}' -DestinationPath '${CACHE}' -Force`,
  ]);
}
fs.mkdirSync(NODE_DIR, { recursive: true });
fs.copyFileSync(path.join(runtimeDir, 'node.exe'), path.join(NODE_DIR, 'node.exe'));
fs.copyFileSync(path.join(runtimeDir, 'LICENSE'), path.join(NODE_DIR, 'LICENSE'));
log(`Node v${NODE_VERSION} bundled`);

// 5. Mimi.exe: a tiny native launcher (no console window) that starts the bundled
// node.exe with the launcher, so the app has one double-clickable program.
const { renderIconIco } = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/app/icon.ts')).href);
const iconFile = path.join(CACHE, 'mimi.ico');
fs.writeFileSync(iconFile, renderIconIco());

const sourceFile = path.join(CACHE, 'MimiLauncher.cs');
fs.writeFileSync(
  sourceFile,
  `using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class MimiLauncher
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(root, "node", "node.exe");
        string app = Path.Combine(root, "app");
        string launcher = Path.Combine(app, "packages", "core", "src", "app", "launcher.ts");
        if (!File.Exists(node) || !File.Exists(launcher))
        {
            MessageBox.Show("Mimi is incomplete: node\\\\node.exe or the app folder is missing.\\nUnzip the whole folder, not just Mimi.exe.", "Mimi", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        try
        {
            var info = new ProcessStartInfo
            {
                FileName = node,
                Arguments = "--env-file-if-exists=.env \\"" + launcher + "\\"",
                WorkingDirectory = app,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            var process = new Process { StartInfo = info };
            process.OutputDataReceived += (sender, line) => { };
            process.ErrorDataReceived += (sender, line) => { };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.WaitForExit();
            if (process.ExitCode != 0)
            {
                MessageBox.Show("Mimi stopped unexpectedly (exit code " + process.ExitCode + ").\\nSee app.log in your Mimi data folder.", "Mimi", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
        catch (Exception error)
        {
            MessageBox.Show("Mimi could not start:\\n" + error.Message, "Mimi", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
`,
  'utf8',
);

const csc =
  [
    path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((candidate) => fs.existsSync(candidate)) ?? null;
if (!csc) throw new Error('The .NET Framework C# compiler (csc.exe) was not found; it ships with Windows.');
log('compiling Mimi.exe...');
run(csc, [
  '/nologo',
  '/target:winexe',
  '/platform:x64',
  '/optimize+',
  `/win32icon:${iconFile}`,
  '/r:System.Windows.Forms.dll',
  `/out:${path.join(STAGE, 'Mimi.exe')}`,
  sourceFile,
]);
log('Mimi.exe written');

// 6. The user-facing scripts.
fs.writeFileSync(
  path.join(STAGE, 'install.cmd'),
  `@echo off\r\nsetlocal\r\npowershell.exe -NoProfile -NonInteractive -Command "$shell = New-Object -ComObject WScript.Shell; $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mimi.lnk')); $link.TargetPath = '%~dp0Mimi.exe'; $link.WorkingDirectory = '%~dp0'; $link.IconLocation = '%~dp0Mimi.exe'; $link.Description = 'Mimi - personal agent'; $link.Save()"\r\nif errorlevel 1 pause\r\n`,
  'utf8',
);
fs.writeFileSync(
  path.join(STAGE, 'start.cmd'),
  `@echo off\r\nsetlocal\r\ncd /d "%~dp0app"\r\n"%~dp0node\\node.exe" --env-file-if-exists=.env "%~dp0app\\packages\\core\\src\\app\\launcher.ts"\r\nif errorlevel 1 pause\r\n`,
  'utf8',
);
fs.writeFileSync(
  path.join(STAGE, 'README.txt'),
  `Mimi - แอปผู้ช่วยส่วนตัว\r\n\r\n` +
    `วิธีติดตั้ง\r\n` +
    `1. แตกไฟล์ zip นี้ไว้ที่โฟลเดอร์ถาวร เช่น C:\\Mimi (อย่าไว้ใน Downloads)\r\n` +
    `2. ดับเบิลคลิก Mimi.exe เพื่อเปิดแอป (ครั้งแรกอาจถูก SmartScreen ถาม ให้กด More info -> Run anyway)\r\n` +
    `3. อยากได้ไอคอนบน Desktop: ดับเบิลคลิก install.cmd ครั้งเดียว\r\n` +
    `4. ใส่ API key ของ provider ในหน้า Settings\r\n\r\n` +
    `หมายเหตุ\r\n` +
    `- ข้อมูลทั้งหมด (แชท, memory, key) อยู่ในโฟลเดอร์ Documents\\Mimi สำรองข้อมูล = คัดลอกโฟลเดอร์นี้\r\n` +
    `- กดปิดหน้าต่าง = ซ่อนไว้ที่ถาด (tray) ออกจากแอปจริง ๆ ที่เมนูของไอคอน Mimi\r\n` +
    `- start.cmd เปิดแอปแบบเห็น log ไว้ใช้แก้ปัญหา\r\n`,
  'utf8',
);
log('install.cmd / start.cmd / README.txt written');

// 7. One zip that users can download.
const zipPath = path.join(DIST, ZIP_NAME);
fs.rmSync(zipPath, { force: true });
log(`packing ${ZIP_NAME}...`);
run('tar.exe', ['-a', '-cf', zipPath, '-C', DIST, 'Mimi']);

const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
log(`done: ${path.relative(ROOT, zipPath)} (${sizeMb} MB)`);
