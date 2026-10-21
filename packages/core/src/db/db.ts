import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Ordered schema migrations; index + 1 is the resulting `user_version`. */
const MIGRATIONS = [
  'schema.sql',
  '002-memory.sql',
  '003-triggers.sql',
  '004-chats.sql',
  '005-trigger-webhooks.sql',
  '006-chat-meta.sql',
  '007-workflow-runs.sql',
  '008-workflow-approvals.sql',
  '009-knowledge.sql',
  '010-notifications.sql',
  '011-knowledge-agents.sql',
  '012-file-snapshots.sql',
  '013-parked-runs.sql',
  '014-video-attachments.sql',
  '015-message-marks.sql',
  '016-speech.sql',
  '017-attachment-hash.sql',
];

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const file = MIGRATIONS[version]!;
    const sql = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

/** Opens (and migrates) the database. Pass `:memory:` for tests. */
export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
