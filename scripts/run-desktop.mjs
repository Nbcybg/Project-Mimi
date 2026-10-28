import { spawn } from 'node:child_process';
import path from 'node:path';
import { electronDist, electronExecutable } from './electron-dist.mjs';

// npm run desktop: the remote desktop app (packages/desktop/remote.cjs) from the sources,
// for trying it against a Mimi server. The packaged app is made by npm run build:mac.

const ROOT = path.resolve(import.meta.dirname, '..');
const electron = electronExecutable(await electronDist(path.join(ROOT, 'dist', '.cache')));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set by tools that are themselves Electron apps; it would make this a plain Node
const child = spawn(electron, [path.join(ROOT, 'packages', 'desktop', 'remote.cjs'), ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
