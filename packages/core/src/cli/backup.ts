// `npm run backup` makes a backup now; `npm run restore -- <file>` puts one back.
// Restore runs with the app closed and backs up the current state first.
import path from 'node:path';
import { createBackup, listBackups, restoreBackup } from '../backup/backup.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/db.ts';

const config = loadConfig();
const [command, file] = process.argv.slice(2);

async function running(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

if (command === 'restore') {
  if (!file) {
    console.error('Usage: npm run restore -- <backup file>');
    for (const backup of listBackups(config.backupsDir).slice(0, 10)) console.error(`  ${path.join(config.backupsDir, backup.name)}`);
    process.exit(1);
  }
  if (await running()) {
    console.error('Mimi is running. Close its window first, then run restore again.');
    process.exit(1);
  }
  const db = openDb(config.dbPath);
  const safety = await createBackup({ userDir: config.userDir, db, outDir: config.backupsDir, includeSecrets: true });
  db.close();
  console.log(`Current state saved first: ${path.join(config.backupsDir, safety.name)}`);
  const written = restoreBackup(path.resolve(file), config.userDir);
  console.log(`Restored ${written} files from ${file}. Start Mimi again.`);
} else {
  const db = openDb(config.dbPath);
  const backup = await createBackup({ userDir: config.userDir, db, outDir: config.backupsDir, includeSecrets: command !== '--no-secrets' });
  db.close();
  console.log(`${path.join(config.backupsDir, backup.name)} (${(backup.bytes / 1048576).toFixed(1)} MB)`);
}
