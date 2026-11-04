import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The core for a native app's "เซิร์ฟเวอร์ในเครื่องนี้" (apps/windows Desktop/LocalCore.cs → native-host.ts):
//   <stage>/core/package.json, mimi.json, packages/{core,shared,pc-agent}, node_modules (production only)
// Run with the node.exe the build puts beside the app. No Electron, no user data, no tests.
//   import { packCore } from './pack-core.mjs'; packCore(ROOT, STAGE, { platform: 'win32-x64' });

const PACKAGES = ['core', 'shared', 'pc-agent'];
const SKIP = new Set(['node_modules', 'test', 'tests', '__tests__', 'fixtures', 'e2e']);

export function packCore(root, stage, { platform = `${process.platform}-${process.arch}`, log = (line) => console.log(`[build] ${line}`) } = {}) {
  const target = path.join(stage, 'core');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(target, 'packages'), { recursive: true });

  // Only the workspaces the core needs: the desktop (Electron) workspace stays out.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  manifest.workspaces = PACKAGES.map((name) => `packages/${name}`);
  delete manifest.devDependencies;
  fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of ['package-lock.json', 'mimi.json', '.npmrc']) {
    if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(target, file));
  }
  for (const name of PACKAGES) {
    fs.cpSync(path.join(root, 'packages', name), path.join(target, 'packages', name), {
      recursive: true,
      filter: (source) => {
        const base = path.basename(source);
        return !SKIP.has(base) && !base.startsWith('._') && !/\.(test|spec)\.[cm]?[jt]s$/.test(base);
      },
    });
  }
  log('core sources copied');

  // Production dependencies; scripts stay off (better-sqlite3 ships its binaries in prebuilds/).
  const npmArgs = ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'];
  if (process.platform === 'win32') execFileSync('cmd.exe', ['/d', '/s', '/c', `npm ${npmArgs.join(' ')}`], { cwd: target, stdio: 'inherit' });
  else execFileSync('npm', npmArgs, { cwd: target, stdio: 'inherit' });
  if (!fs.existsSync(path.join(target, 'node_modules', 'better-sqlite3'))) throw new Error('the core\'s dependencies did not install (better-sqlite3 missing)');
  // better-sqlite3 carries a binary for every system: only this build's stays (e.g. win32-x64).
  const prebuilds = path.join(target, 'node_modules', 'better-sqlite3', 'prebuilds');
  if (fs.existsSync(path.join(prebuilds, `${platform}.node`))) {
    for (const file of fs.readdirSync(prebuilds)) if (file !== `${platform}.node`) fs.rmSync(path.join(prebuilds, file), { force: true });
  }
  log('core dependencies installed');
  return target;
}
