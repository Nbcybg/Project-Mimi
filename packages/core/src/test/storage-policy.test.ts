import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AppSettings } from '../app/app-settings.ts';
import { AttachmentQuotaError, AttachmentStore } from '../chat/attachments.ts';
import { chatCsv } from '../chat/chat-export.ts';
import { openDb } from '../db/db.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-storage-'));
}

test('storage quotas default and survive a restart', () => {
  const dir = tempDir();
  const file = path.join(dir, 'app-settings.json');
  const first = AppSettings.load(file);
  assert.deepEqual(first.storage, { mediaQuotaBytes: 2_048 * 1024 * 1024, chatQuotaBytes: 1_024 * 1024 * 1024 });
  first.setStorage({ mediaQuotaMb: 3_000, chatQuotaMb: 200 });
  assert.deepEqual(AppSettings.load(file).storage, { mediaQuotaBytes: 3_000 * 1024 * 1024, chatQuotaBytes: 200 * 1024 * 1024 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('media quota refuses an upload, and expiry removes bytes while keeping the row', () => {
  const db = openDb(':memory:');
  const dir = tempDir();
  let quota = 100;
  const store = new AttachmentStore(db, dir, { quotaBytes: () => quota });
  const first = store.save({ name: 'a.png', mime: 'image/png', data: Buffer.alloc(60, 1), caption: 'รูปแรก' });
  assert.deepEqual(store.usage(), { files: 1, bytes: 60 });
  assert.throws(() => store.save({ name: 'b.png', mime: 'image/png', data: Buffer.alloc(60, 2) }), AttachmentQuotaError);

  quota = 1_000;
  const second = store.save({ name: 'b.png', mime: 'image/png', data: Buffer.alloc(60, 2) });
  assert.deepEqual(store.usage(), { files: 2, bytes: 120 });

  const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  assert.deepEqual(store.expireOlderThan(7, later), { files: 2, bytes: 120 });
  assert.deepEqual(store.usage(), { files: 0, bytes: 0 });
  assert.equal(store.read(first.id), undefined);
  assert.equal(store.read(second.id), undefined);
  assert.ok(store.get(first.id)!.deletedAt);
  assert.equal(store.get(first.id)!.caption, 'รูปแรก');
  assert.equal(fs.existsSync(path.join(dir, first.id)), false);
  // Once the bytes are gone the quota has room again.
  assert.ok(store.save({ name: 'c.png', mime: 'image/png', data: Buffer.alloc(60, 3) }));

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chat CSV keeps messages and expired media as rows, not as files', () => {
  const db = openDb(':memory:');
  const dir = tempDir();
  const store = new AttachmentStore(db, dir);
  const chatId = Number(db.prepare(`INSERT INTO chats (kind, title, agents) VALUES ('direct', '', '["mimi"]')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO sessions (chat_id, thread, title) VALUES (?, 'thread-1', 'Session 1')`).run(chatId);
  const messageId = Number(
    db
      .prepare(`INSERT INTO messages (thread, trace_id, agent, role, content, text) VALUES ('thread-1', 'trace', 'mimi', 'user', '"hello"', 'hello')`)
      .run().lastInsertRowid,
  );
  const photo = store.save({ name: 'cat.png', mime: 'image/png', data: Buffer.alloc(10, 1), caption: 'แมวที่บ้าน' });
  store.link([photo.id], messageId);
  db.prepare(`INSERT INTO messages (thread, trace_id, agent, role, content, text) VALUES ('thread-1', 'trace', 'mimi', 'assistant', '"ok"', 'ok')`).run();
  store.expireOlderThan(7, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));

  const all = chatCsv(db)!;
  assert.match(all.filename, /^mimi-chats-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(all.csv, /"hello"/);
  assert.match(all.csv, /"cat\.png"/);
  assert.match(all.csv, /"แมวที่บ้าน"/);
  assert.match(all.csv, /expired_attachments/);
  assert.match(all.csv, /"cat\.png \(image\/png, 10 bytes\)"/);
  assert.equal(chatCsv(db, 999), null);
  const one = chatCsv(db, chatId)!;
  assert.equal(one.filename.startsWith(`mimi-chat-${chatId}-`), true);
  assert.match(one.csv, /"hello"/);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
