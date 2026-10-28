import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// The Electron program for this machine, downloaded once into dist/.cache by Electron's own
// downloader and checked against the checksums shipped with the electron package (so its
// install script, which npm leaves unapproved, is not needed). Used by build-mac.mjs and
// run-desktop.mjs.

const require = createRequire(import.meta.url);

/** The folder holding Electron.app (macOS) or electron.exe (Windows) for this machine. */
export async function electronDist(cacheDir) {
  const { version } = require('electron/package.json');
  const target = path.join(cacheDir, `electron-v${version}-${process.platform}-${process.arch}`);
  const marker = path.join(target, '.complete');
  if (fs.existsSync(marker)) return target;
  const { downloadArtifact } = require('@electron/get');
  const zip = await downloadArtifact({
    version,
    artifactName: 'electron',
    platform: process.platform,
    arch: process.arch,
    checksums: require('electron/checksums.json'),
    cacheRoot: path.join(cacheDir, 'electron-download'),
  });
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  // ditto keeps the app bundle's symlinks and permissions on macOS.
  if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', zip, target]);
  // Windows' own tar (bsdtar) reads zip; a GNU tar earlier on PATH (Git Bash) does not.
  else execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', target]);
  fs.writeFileSync(marker, version);
  return target;
}

/** The Electron executable inside {@link electronDist}. */
export function electronExecutable(dist) {
  return process.platform === 'darwin' ? path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron') : path.join(dist, 'electron.exe');
}
