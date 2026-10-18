import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createBackup, listBackups, pruneBackups, readBackup, restoreBackup } from '../backup/backup.ts';
import { openDb } from '../db/db.ts';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-backup-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function userFolder(root: string) {
  const user = path.join(root, 'user');
  fs.mkdirSync(path.join(user, 'agents', 'mimi'), { recursive: true });
  fs.mkdirSync(path.join(user, 'data', 'app-window', 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(user, 'agents', 'mimi', 'agent.md'), '---\nname: mimi\n---\nเลขา');
  fs.writeFileSync(path.join(user, 'profile.json'), '{"fields":[]}');
  fs.writeFileSync(path.join(user, 'data', 'auth.json'), '{"key":"sk-test"}');
  fs.writeFileSync(path.join(user, 'data', 'app-window', 'Cache', 'big.bin'), Buffer.alloc(1000));
  const deep = path.join(user, 'workflows', 'mimi', 'a-very-long-folder-name-that-goes-on-and-on-for-quite-a-while-to-test-prefixes');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'a-workflow-file-with-an-equally-long-name-so-the-path-passes-one-hundred-bytes.json'), '{"name":"x"}');
  const db = openDb(path.join(user, 'data', 'mimi.db'));
  db.prepare("INSERT INTO notifications (kind, title, body, created_at) VALUES ('info', 'จำไว้', 'ข้อความ', '2026-10-19')").run();
  return { user, db };
}

test('backup: a .tar.gz of the user folder with a consistent database, without the browser profile', async () => {
  const { user, db } = userFolder(path.join(tmp, 'a'));
  const out = path.join(tmp, 'a', 'backups');
  const made = await createBackup({ userDir: user, db, outDir: out, includeSecrets: true, now: new Date('2026-10-19T01:02:03Z') });
  assert.equal(made.name, 'mimi-backup-2026-10-19T01-02-03.tar.gz');
  const names = readBackup(path.join(out, made.name)).map((entry) => entry.name).sort();
  assert.ok(names.includes('user/agents/mimi/agent.md'));
  assert.ok(names.includes('user/data/auth.json'));
  assert.ok(names.includes('user/data/mimi.db'));
  assert.ok(names.some((name) => name.endsWith('one-hundred-bytes.json')), 'long paths survive');
  assert.ok(!names.some((name) => name.includes('app-window')), 'the browser profile is left out');
  assert.ok(!names.some((name) => name.endsWith('-wal') || name.endsWith('-shm')));

  // Windows / Linux tar can read it too.
  const tarExe = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
  const listing = execFileSync(tarExe, ['-tzf', path.join(out, made.name)], { encoding: 'utf8' });
  assert.match(listing, /user\/agents\/mimi\/agent\.md/);

  const plain = await createBackup({ userDir: user, db, outDir: out, includeSecrets: false, now: new Date('2026-10-19T02:00:00Z') });
  assert.match(plain.name, /-nosecrets\.tar\.gz$/);
  assert.ok(!readBackup(path.join(out, plain.name)).some((entry) => entry.name.endsWith('auth.json')));
  assert.equal(listBackups(out).length, 2);
  pruneBackups(out, 1);
  assert.equal(listBackups(out).length, 1);
  db.close();
});

test('restore: files come back, the database too, and nothing escapes the user folder', async () => {
  const { user, db } = userFolder(path.join(tmp, 'b'));
  const out = path.join(tmp, 'b', 'backups');
  const made = await createBackup({ userDir: user, db, outDir: out, includeSecrets: true });
  db.close();
  // Damage: an agent is lost and the database emptied.
  fs.rmSync(path.join(user, 'agents'), { recursive: true });
  fs.rmSync(path.join(user, 'data', 'mimi.db'));
  const written = restoreBackup(path.join(out, made.name), user);
  assert.ok(written >= 4);
  assert.equal(fs.readFileSync(path.join(user, 'agents', 'mimi', 'agent.md'), 'utf8'), '---\nname: mimi\n---\nเลขา');
  const reopened = openDb(path.join(user, 'data', 'mimi.db'));
  assert.equal((reopened.prepare('SELECT title FROM notifications').get() as { title: string }).title, 'จำไว้');
  reopened.close();
  assert.throws(() => restoreBackup(path.join(user, 'profile.json'), user));
});
