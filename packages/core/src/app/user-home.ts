import fs from 'node:fs';
import path from 'node:path';
import { documentsDir } from '../config.ts';

/**
 * Machine-local caches of the desktop app (the browser profiles of its windows). They are
 * large, rebuild themselves and mean nothing on another computer, so they stay out of the
 * user's Documents: %LOCALAPPDATA%\Mimi on Windows, the data folder elsewhere.
 */
export function localAppDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  // A user folder picked with MIMI_USER (a second install, a test) keeps its caches to itself.
  return env.LOCALAPPDATA && !env.MIMI_USER ? path.join(env.LOCALAPPDATA, 'Mimi') : dataDir;
}

function move(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    // Another drive: copy, then remove the original.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Moves an install's old "<app>/user" folder (and "<app>/backups") to "Documents/Mimi", so
 * the app folder holds only the app. Runs once, with the app closed; does nothing when
 * MIMI_USER picks a folder, when there is nothing to move, or when Documents/Mimi exists.
 * Returns the new folder, or null when nothing moved.
 */
export function moveUserDataToDocuments(rootDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.MIMI_USER || env.MIMI_ROOT) return null;
  const legacy = path.join(rootDir, 'user');
  const target = path.join(documentsDir(env), 'Mimi');
  if (fs.existsSync(target) || !fs.existsSync(path.join(legacy, 'data'))) return null;

  // The window profiles go to the machine-local folder instead of Documents.
  const local = localAppDir(path.join(legacy, 'data'), env);
  for (const entry of fs.readdirSync(path.join(legacy, 'data'))) {
    if (!entry.startsWith('app-window')) continue;
    const destination = path.join(local, entry);
    if (local === path.join(legacy, 'data') || fs.existsSync(destination)) continue;
    move(path.join(legacy, 'data', entry), destination);
  }
  move(legacy, target);
  const backups = path.join(rootDir, 'backups');
  if (fs.existsSync(backups) && !fs.existsSync(path.join(target, 'backups'))) move(backups, path.join(target, 'backups'));
  return target;
}
