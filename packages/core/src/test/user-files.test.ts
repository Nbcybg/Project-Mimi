import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HistoryFiles } from '../chat/history-files.ts';
import { createCore } from '../core.ts';
import { openDb } from '../db/db.ts';
import { MessagesRepo } from '../db/messages-repo.ts';
import { FakeBroker } from './helpers.ts';
import { makeTestCore, testCoreParts } from './core-helpers.ts';

const userFile = (root: string, ...parts: string[]) => path.join(root, 'user', ...parts);

test('mirrors: memory, sessions and history are written as files under user/', async () => {
  const target = await makeTestCore();
  try {
    // Memory: one Markdown file per entry, deleted with the entry.
    target.core.memory.write({ path: 'profile', content: '- Name: Ton' });
    target.core.memory.write({ path: 'projects/garden', description: 'Backyard garden', content: 'Planted chili.' });
    const profile = fs.readFileSync(userFile(target.root, 'memory/profile.md'), 'utf8');
    assert.match(profile, /description: "?Who the user is/);
    assert.match(profile, /- Name: Ton/);
    assert.match(fs.readFileSync(userFile(target.root, 'memory/projects/garden.md'), 'utf8'), /Planted chili\./);
    target.core.memory.delete('projects/garden');
    assert.equal(fs.existsSync(userFile(target.root, 'memory/projects/garden.md')), false);

    // Sessions: a folder per chat holding the chat and each session.
    const chat = target.core.chats.directChat('mimi');
    const { session } = target.core.chats.currentSession(chat.id, 60_000);
    assert.deepEqual(JSON.parse(fs.readFileSync(userFile(target.root, 'sessions', String(chat.id), 'chat.json'), 'utf8')).agents, ['mimi']);
    const sessionFile = JSON.parse(fs.readFileSync(userFile(target.root, 'sessions', String(chat.id), `${session.id}.json`), 'utf8'));
    assert.deepEqual([sessionFile.thread, sessionFile.chatId], [session.thread, chat.id]);

    // History: one JSONL line per message of the thread.
    const append = (text: string) =>
      target.core.deps.messages.append({ thread: session.thread, traceId: 't1', agent: 'mimi', role: 'user', content: [{ type: 'text', text }], text });
    append('สวัสดี');
    append('อีกครั้ง');
    const lines = fs.readFileSync(userFile(target.root, 'history', `${session.thread}.jsonl`), 'utf8').trim().split('\n');
    assert.deepEqual(lines.map((line) => (JSON.parse(line) as { text: string }).text), ['สวัสดี', 'อีกครั้ง']);

    // Deleting the chat takes its mirror folder with it.
    target.core.chats.deleteChat(chat.id);
    assert.equal(fs.existsSync(userFile(target.root, 'sessions', String(chat.id))), false);
  } finally {
    await target.cleanup();
  }
});

test('mirrors: a memory file dropped into user/memory by hand is imported at startup', async () => {
  const parts = testCoreParts();
  fs.mkdirSync(path.join(parts.root, 'user', 'memory', 'people'), { recursive: true });
  fs.writeFileSync(
    path.join(parts.root, 'user', 'memory', 'people', 'nok.md'),
    '---\ndescription: Friend Nok\n---\nLikes tea.',
  );
  const core = await createCore(parts.config, new FakeBroker(true), parts.coreOptions);
  try {
    assert.equal(core.memory.get('people/nok')?.content, 'Likes tea.');
    assert.equal(core.memory.get('people/nok')?.description, 'Friend Nok');
  } finally {
    await core.close();
    fs.rmSync(parts.root, { recursive: true, force: true });
  }
});

test('history files: a database written before the mirror existed is exported once, without duplicates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-history-'));
  try {
    const db = openDb(':memory:');
    const messages = new MessagesRepo(db);
    const files = new HistoryFiles(dir);
    const append = (text: string) =>
      messages.append({ thread: 's-one', traceId: 't1', agent: 'mimi', role: 'user', content: [{ type: 'text', text }], text });

    append('one');
    append('two');
    files.sync(messages);
    const file = path.join(dir, 's-one.jsonl');
    assert.deepEqual(
      fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { text: string }).text),
      ['one', 'two'],
    );

    append('three');
    files.sync(messages);
    assert.deepEqual(
      fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { text: string }).text),
      ['one', 'two', 'three'],
      'the second sync only appends the tail',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
