import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';
import { openDb } from '../db/db.ts';
import { MessagesRepo } from '../db/messages-repo.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-db-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a fresh database is created at the latest schema version', () => {
  const db = openDb(path.join(tmp, 'nested', 'fresh.db'));
  assert.equal(db.pragma('user_version', { simple: true }), 14);
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[];
  for (const name of ['agent_messages', 'agent_runs', 'memories', 'messages', 'summaries', 'thread_state', 'triggers', 'usage_log']) {
    assert.ok(tables.some((table) => table.name === name), `missing table ${name}`);
  }
  db.close();
});

test('a phase-1 database is upgraded in place and keeps its messages', () => {
  const file = path.join(tmp, 'v1.db');
  const v1 = new Database(file);
  v1.exec(fs.readFileSync(path.join(import.meta.dirname, '../db/schema.sql'), 'utf8'));
  v1.pragma('user_version = 1');
  v1.prepare(`INSERT INTO messages (trace_id, agent, role, content, text) VALUES ('t', 'mimi', 'user', '"สวัสดี"', 'สวัสดี')`).run();
  v1.prepare(`INSERT INTO usage_log (trace_id, agent, capability, provider, model) VALUES ('t', 'mimi', 'chat', 'deepseek', 'm')`).run();
  v1.close();

  const db = openDb(file);
  assert.equal(db.pragma('user_version', { simple: true }), 14);
  const [message] = new MessagesRepo(db).after('main', 0);
  assert.deepEqual(
    { text: message!.text, content: message!.content, context: message!.context },
    { text: 'สวัสดี', content: 'สวัสดี', context: undefined },
  );
  assert.deepEqual(db.prepare(`SELECT cache_write_tokens FROM usage_log`).get(), { cache_write_tokens: 0 });
  db.close();

  // Opening again must not re-run migrations.
  openDb(file).close();
});
