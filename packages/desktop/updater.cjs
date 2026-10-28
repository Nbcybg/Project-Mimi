'use strict';
// Updates of the desktop app from the GitHub releases of Mimi (.github/workflows/release.yml
// publishes Mimi-<version>-win-x64.zip and Mimi-<version>-mac-<arch>.zip). The parts that
// need no Electron: tested in packages/core/src/test/desktop-updater.test.ts.
//
// The app asks; nothing installs on its own. On "update": the zip is downloaded and unpacked
// next to the app's own data, a small script waits for the app to quit, puts the new files in
// place of the old ones and starts the app again.

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 1.2.10 > 1.2.9; a leading "v" and anything after "-" are ignored. */
function isNewer(candidate, current) {
  const parts = (text) => String(text).replace(/^v/, '').split('-')[0].split('.').map((part) => Number(part) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** The release asset for this computer, e.g. Mimi-0.6.0-win-x64.zip; null when there is none. */
function assetFor(release, platform = process.platform, arch = process.arch) {
  const tag = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : null;
  if (!tag) return null;
  const pattern = new RegExp(`-${tag}-${arch}\\.zip$`, 'i');
  return (release.assets || []).find((asset) => pattern.test(asset.name)) || null;
}

/** The latest release when it is newer than `current` and has a build for this computer; else null. */
async function findUpdate(repo, current, fetchFn = fetch, platform = process.platform, arch = process.arch) {
  const response = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'mimi-desktop' },
  });
  if (!response.ok) return null;
  const release = await response.json();
  if (release.draft || release.prerelease || !isNewer(release.tag_name, current)) return null;
  const asset = assetFor(release, platform, arch);
  if (!asset) return null;
  return { version: String(release.tag_name).replace(/^v/, ''), url: asset.browser_download_url, name: asset.name, size: asset.size || 0, notes: release.html_url };
}

/** Where the app is installed: the folder with Mimi.exe, or the Mimi.app bundle. */
function installTarget(execPath = process.execPath, platform = process.platform) {
  if (platform === 'darwin') return path.resolve(execPath, '..', '..', '..');
  return path.dirname(execPath);
}

/** Downloads the zip into `stageDir` and unpacks it there; returns the unpacked app's path. */
async function download(update, stageDir, fetchFn = fetch, platform = process.platform) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const zip = path.join(stageDir, update.name);
  const response = await fetchFn(update.url, { headers: { 'user-agent': 'mimi-desktop' } });
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
  const { Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(zip));
  const out = path.join(stageDir, 'new');
  fs.mkdirSync(out);
  if (platform === 'darwin') execFileSync('ditto', ['-x', '-k', zip, out]);
  else execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', out]);
  fs.rmSync(zip, { force: true });
  const unpacked = path.join(out, platform === 'darwin' ? 'Mimi.app' : 'Mimi');
  const check = platform === 'darwin' ? path.join(unpacked, 'Contents', 'MacOS', 'Mimi') : path.join(unpacked, 'Mimi.exe');
  if (!fs.existsSync(check)) throw new Error('the downloaded update does not contain the app');
  return unpacked;
}

/** The script that swaps the app once process `pid` has quit, then starts it again. */
function swapScript({ pid, source, target, stageDir, platform = process.platform }) {
  if (platform === 'win32') {
    return [
      '@echo off',
      ':wait',
      `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
      `robocopy "${source}" "${target}" /MIR /R:5 /W:1 /NFL /NDL /NJH /NJS /NP >nul`,
      `start "" "${path.join(target, 'Mimi.exe')}"`,
      `rmdir /s /q "${stageDir}"`,
      '',
    ].join('\r\n');
  }
  const q = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
  return [
    '#!/bin/sh',
    `while kill -0 ${pid} 2>/dev/null; do sleep 1; done`,
    `rm -rf ${q(`${target}.old`)}`,
    `if mv ${q(target)} ${q(`${target}.old`)} && ditto ${q(source)} ${q(target)}; then rm -rf ${q(`${target}.old`)}; else rm -rf ${q(target)}; mv ${q(`${target}.old`)} ${q(target)}; fi`,
    `xattr -dr com.apple.quarantine ${q(target)} 2>/dev/null`,
    `open ${q(target)}`,
    `rm -rf ${q(stageDir)}`,
    '',
  ].join('\n');
}

/** Writes and starts the swap script, detached so it outlives the app; the caller then quits. */
function startSwap({ source, target, stageDir, pid = process.pid, platform = process.platform }) {
  const script = path.join(stageDir, platform === 'win32' ? 'update.cmd' : 'update.sh');
  fs.writeFileSync(script, swapScript({ pid, source, target, stageDir, platform }), { mode: 0o755 });
  const child =
    platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' });
  child.unref();
}

module.exports = { assetFor, download, findUpdate, installTarget, isNewer, startSwap, swapScript };
