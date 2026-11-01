'use strict';
// Updates of the desktop app from the GitHub releases of Mimi (.github/workflows/release.yml
// publishes Mimi-<version>-win-x64.zip and Mimi-<version>-mac-<arch>.zip). The parts that
// need no Electron: tested in packages/core/src/test/desktop-updater.test.ts.
//
// The app asks; nothing installs on its own. On "update": the zip is downloaded and checked
// against the release's SHA256SUMS.txt, unpacked next to the app's own data and, when the
// running app is signed by a publisher, checked to be signed by that same publisher. Then a
// small script waits for the app to quit, puts the new files in place of the old ones and
// starts the app again.

const { execFileSync, spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** The release asset with one `<sha256>  <file>` line per asset (written by release.yml). */
const SUMS_NAME = 'SHA256SUMS.txt';

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
  const sums = (release.assets || []).find((entry) => entry.name === SUMS_NAME);
  return {
    version: String(release.tag_name).replace(/^v/, ''),
    url: asset.browser_download_url,
    name: asset.name,
    size: asset.size || 0,
    notes: release.html_url,
    sumsUrl: sums ? sums.browser_download_url : null,
  };
}

/** The SHA-256 a sums file gives for `name` (sha256sum format, text or binary mode), or null. */
function expectedHash(sums, name) {
  for (const line of String(sums).split(/\r?\n/)) {
    const found = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (found && found[2].trim() === name) return found[1].toLowerCase();
  }
  return null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** Refuses a downloaded zip whose size or SHA-256 differs from what the release published. */
async function checkDownload(zip, update, sums) {
  const expected = expectedHash(sums, update.name);
  if (!expected) throw new Error(`${SUMS_NAME} of this release does not list ${update.name}`);
  const size = fs.statSync(zip).size;
  if (update.size > 0 && size !== update.size) throw new Error(`the download is ${size} bytes, the release says ${update.size}`);
  const actual = await sha256File(zip);
  if (actual !== expected) throw new Error('the download does not match the checksum of the release (damaged or replaced)');
}

/**
 * Who signed an app: on Windows the Authenticode subject of the exe, on macOS the Team ID of
 * the bundle. `signer` is null for an unsigned or ad hoc signed app; `valid` says whether the
 * signature itself checks out.
 */
function signatureOf(target, platform = process.platform, run = spawnSync) {
  if (platform === 'win32') {
    // The path goes through the environment, never into the command text.
    const script = '$s = Get-AuthenticodeSignature -LiteralPath $env:MIMI_SIGNED_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"';
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, MIMI_SIGNED_FILE: target },
    });
    const [status, subject] = String(result.stdout || '').trim().split('|');
    return { valid: status === 'Valid', signer: status === 'Valid' && subject ? subject.trim() : null };
  }
  if (platform === 'darwin') {
    const valid = run('codesign', ['--verify', '--deep', '--strict', target], { encoding: 'utf8' }).status === 0;
    const info = run('codesign', ['-dv', '--verbose=2', target], { encoding: 'utf8' });
    const team = /TeamIdentifier=(\S+)/.exec(`${info.stdout || ''}${info.stderr || ''}`);
    return { valid, signer: team && team[1] !== 'not' ? team[1] : null };
  }
  return { valid: false, signer: null };
}

/**
 * When the running app carries a publisher signature, the update must carry a valid one from
 * the same publisher. An unsigned (or ad hoc) build has nothing to compare against; the
 * checksum is then the only check. Returns whether a signature was required.
 */
function checkSignature({ current, next, platform = process.platform, run = spawnSync }) {
  const mine = signatureOf(current, platform, run);
  if (!mine.signer) return { required: false };
  const theirs = signatureOf(next, platform, run);
  if (!theirs.valid || theirs.signer !== mine.signer) {
    throw new Error(`the update is not signed by the same publisher as this app (${mine.signer})`);
  }
  return { required: true };
}

/** Where the app is installed: the folder with Mimi.exe, or the Mimi.app bundle. */
function installTarget(execPath = process.execPath, platform = process.platform) {
  if (platform === 'darwin') return path.resolve(execPath, '..', '..', '..');
  return path.dirname(execPath);
}

/** Downloads the zip into `stageDir` and unpacks it there; returns the unpacked app's path. */
async function download(update, stageDir, fetchFn = fetch, platform = process.platform) {
  if (!update.sumsUrl) throw new Error(`this release has no ${SUMS_NAME}, so the download cannot be checked`);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const sumsResponse = await fetchFn(update.sumsUrl, { headers: { 'user-agent': 'mimi-desktop' } });
  if (!sumsResponse.ok) throw new Error(`${SUMS_NAME} download failed: HTTP ${sumsResponse.status}`);
  const sums = await sumsResponse.text();
  const zip = path.join(stageDir, update.name);
  const response = await fetchFn(update.url, { headers: { 'user-agent': 'mimi-desktop' } });
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
  const { Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(zip));
  await checkDownload(zip, update, sums);
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
/** `keepQuarantine`: a publisher-signed (notarized) app keeps macOS's download flag; Gatekeeper accepts it. */
function swapScript({ pid, source, target, stageDir, platform = process.platform, keepQuarantine = false }) {
  if (platform === 'win32') {
    return [
      '@echo off',
      ':wait',
      `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
      // /XF: the installer's uninstaller is not in the zip and stays.
      `robocopy "${source}" "${target}" /MIR /XF "Uninstall Mimi.exe" /R:5 /W:1 /NFL /NDL /NJH /NJS /NP >nul`,
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
    ...(keepQuarantine ? [] : [`xattr -dr com.apple.quarantine ${q(target)} 2>/dev/null`]),
    `open ${q(target)}`,
    `rm -rf ${q(stageDir)}`,
    '',
  ].join('\n');
}

/** Writes and starts the swap script, detached so it outlives the app; the caller then quits. */
function startSwap({ source, target, stageDir, pid = process.pid, platform = process.platform, keepQuarantine = false }) {
  const script = path.join(stageDir, platform === 'win32' ? 'update.cmd' : 'update.sh');
  fs.writeFileSync(script, swapScript({ pid, source, target, stageDir, platform, keepQuarantine }), { mode: 0o755 });
  const child =
    platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' });
  child.unref();
}

module.exports = { SUMS_NAME, assetFor, checkDownload, checkSignature, download, expectedHash, findUpdate, installTarget, isNewer, signatureOf, startSwap, swapScript };
