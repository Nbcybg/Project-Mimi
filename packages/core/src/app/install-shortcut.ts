import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { renderIconIco } from './icon.ts';
import { localAppDir } from './user-home.ts';

// npm run app:install
// Puts a "Mimi" shortcut on the Desktop (and one in the project folder) that starts
// the app without a console window.

if (process.platform !== 'win32') {
  console.log('Shortcuts are only created on Windows. Start the app with: npm run app');
  process.exit(0);
}

const config = loadConfig();
// The icon is the app's, not the user's: it lives in the machine-local folder.
const iconDir = localAppDir(config.dataDir);
fs.mkdirSync(iconDir, { recursive: true });
const iconFile = path.join(iconDir, 'mimi.ico');
fs.writeFileSync(iconFile, renderIconIco());

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const launcher = path.join(config.rootDir, 'packages/core/src/app/launcher.ts');
// PowerShell only as a hidden host for node: no script file, so execution policy does not apply.
const command = `Set-Location -LiteralPath ${quote(config.rootDir)}; & ${quote(process.execPath)} --env-file-if-exists=.env ${quote(launcher)}`;
const targets = [path.join(os.homedir(), 'Desktop', 'Mimi.lnk'), path.join(config.rootDir, 'Mimi.lnk')];

const script = targets
  .map(
    (target, index) => `
$s${index} = $shell.CreateShortcut(${quote(target)})
$s${index}.TargetPath = (Get-Command powershell.exe).Source
$s${index}.Arguments = ${quote(`-NoProfile -WindowStyle Hidden -Command "${command}"`)}
$s${index}.WorkingDirectory = ${quote(config.rootDir)}
$s${index}.IconLocation = ${quote(iconFile)}
$s${index}.WindowStyle = 7
$s${index}.Description = 'Mimi - personal agent'
$s${index}.Save()`,
  )
  .join('\n');

const result = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', `$shell = New-Object -ComObject WScript.Shell\n${script}`],
  { encoding: 'utf8' },
);
if (result.status !== 0) {
  console.error(`Could not create the shortcut:\n${result.stderr || result.stdout}`);
  process.exit(1);
}
console.log(`Created:\n${targets.map((target) => `  ${target}`).join('\n')}\nDouble-click "Mimi" to start the app.`);
