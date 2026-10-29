import fs from 'node:fs';
import path from 'node:path';

/** Bytes of every file under `dir` (symlinks are not followed). */
export function directoryBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directoryBytes(file);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(file).size;
      } catch {
        // a file removed while counting
      }
    }
  }
  return total;
}

/**
 * Pictures and models the user owns outside the chat: agent avatars, portraits,
 * sprites, galleries, backdrops, outfits and their VRM files. Chat attachments are
 * counted separately from the database.
 */
export function assetBytes(dirs: string[]): number {
  return dirs.reduce((sum, dir) => sum + directoryBytes(dir), 0);
}
