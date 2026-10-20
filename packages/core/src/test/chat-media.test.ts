import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { WorkflowView } from '@mimi/shared';
import { filesMatch } from '../core.ts';
import { openDb } from '../db/db.ts';
import { makeTestCore, type TestCore } from './core-helpers.ts';
import { replyingModel, scriptedModel, textStep } from './helpers.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

async function turn(target: TestCore, input: { chatId: number; text: string; attachments?: string[] }) {
  for await (const _item of target.core.engine.runTurn(input));
}

const promptOf = (model: { doStreamCalls: Array<{ prompt: unknown }> }, call: number) =>
  JSON.stringify(model.doStreamCalls[call]!.prompt);

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const workflow = (overrides: Partial<WorkflowView> = {}): WorkflowView => ({
  name: 'flow',
  agent: 'mimi',
  title: 'Flow',
  description: '',
  enabled: true,
  trigger: { pool: 'manual', config: {} },
  webhook: null,
  nodes: [],
  ...overrides,
});

/** The small model plays the vision / transcript model: it says what it was asked to read. */
const reader = () =>
  replyingModel([
    (prompt) =>
      prompt.includes('Describe this video')
        ? { text: 'คนเดินเล่นริมทะเล แล้วพูดว่า สวัสดี' }
        : prompt.includes('Describe this image')
          ? { text: 'แมวสีส้มนอนบนโซฟา' }
          : { text: 'nothing' },
  ]);

test('attachments: a video is its own kind and the vision model describes it once', async () => {
  const mimi = scriptedModel([textStep('ดูแล้วค่ะ')]);
  const small = reader();
  const target = await makeTestCore({ models: { mimi }, small });
  const clip = target.core.attachments.save({ name: 'beach.mp4', mime: 'video/mp4', data: Buffer.from('fake mp4') });
  assert.equal(clip.kind, 'video');
  const chat = target.core.chats.directChat('mimi');

  await turn(target, { chatId: chat.id, text: 'ดูคลิปนี้', attachments: [clip.id] });
  assert.match(promptOf(mimi, 0), /kind=\\"video\\" name=\\"beach.mp4\\">\\nคนเดินเล่นริมทะเล/);
  const call = JSON.stringify(small.doGenerateCalls.find((entry) => JSON.stringify(entry.prompt).includes('Describe this video'))!.prompt);
  assert.match(call, /"mediaType":"video\/mp4"/);
  assert.equal(target.core.attachments.get(clip.id)!.text, 'คนเดินเล่นริมทะเล แล้วพูดว่า สวัสดี');
  await target.cleanup();
});

test('schema v14 keeps the attachments that were there and accepts videos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-v14-'));
  const file = path.join(dir, 'mimi.db');
  const first = openDb(file);
  first.prepare(`INSERT INTO attachments (id, kind, name, mime, size, text) VALUES ('a', 'image', 'cat.png', 'image/png', 7, 'แมว')`).run();
  // Back to how a v13 file looks: the columns of v16 do not exist yet.
  first.exec('ALTER TABLE messages DROP COLUMN pinned_at; ALTER TABLE messages DROP COLUMN reactions; ALTER TABLE messages DROP COLUMN speech;');
  first.pragma('user_version = 13');
  first.close();
  const again = openDb(file);
  assert.equal(again.pragma('user_version', { simple: true }), 16);
  assert.deepEqual(again.prepare(`SELECT id, kind, text FROM attachments`).all(), [{ id: 'a', kind: 'image', text: 'แมว' }]);
  again.prepare(`INSERT INTO attachments (id, kind, name, mime, size) VALUES ('b', 'video', 'x.mp4', 'video/mp4', 1)`).run();
  assert.throws(() => again.prepare(`INSERT INTO attachments (id, kind, name, mime, size) VALUES ('c', 'gif', 'x', 'x/y', 1)`).run());
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a chat model that can see gets the picture itself, also on later turns; one that cannot gets the description', async () => {
  const mimi = scriptedModel([textStep('แมวน่ารัก'), textStep('ใช่ค่ะ')]);
  const target = await makeTestCore({ models: { mimi }, small: reader(), imageInput: true });
  const cat = target.core.attachments.save({ name: 'cat.png', mime: 'image/png', data: PNG });
  const chat = target.core.chats.directChat('mimi');

  await turn(target, { chatId: chat.id, text: 'ดูนี่', attachments: [cat.id] });
  const first = promptOf(mimi, 0);
  assert.match(first, /"type":"file"/);
  assert.match(first, /"mediaType":"image\/png"/);
  assert.match(first, /แมวสีส้มนอนบนโซฟา/, 'the description stays next to the picture');
  await turn(target, { chatId: chat.id, text: 'สีอะไรนะ' });
  assert.match(promptOf(mimi, 1), /"mediaType":"image\/png"/, 'the picture is still there on the next turn');
  await target.cleanup();

  const blind = scriptedModel([textStep('แมวสีส้ม')]);
  const other = await makeTestCore({ models: { mimi: blind }, small: reader() });
  const photo = other.core.attachments.save({ name: 'cat.png', mime: 'image/png', data: PNG });
  await turn(other, { chatId: other.core.chats.directChat('mimi').id, text: 'ดูนี่', attachments: [photo.id] });
  assert.doesNotMatch(promptOf(blind, 0), /"type":"file"/);
  assert.match(promptOf(blind, 0), /แมวสีส้มนอนบนโซฟา/);
  await other.cleanup();
});

test('only the newest six images go to the model as pictures', async () => {
  const mimi = scriptedModel([textStep('ok')]);
  const target = await makeTestCore({ models: { mimi }, small: reader(), imageInput: true });
  const ids = Array.from({ length: 8 }, (_, index) =>
    target.core.attachments.save({ name: `p${index}.png`, mime: 'image/png', data: PNG }).id,
  );
  await turn(target, { chatId: target.core.chats.directChat('mimi').id, text: 'อัลบั้ม', attachments: ids });
  const files = promptOf(mimi, 0).match(/"type":"file"/g) ?? [];
  assert.equal(files.length, 6);
  await target.cleanup();
});

test('chat trigger: file rules', () => {
  assert.equal(filesMatch('any', []), true);
  assert.equal(filesMatch('none', []), true);
  assert.equal(filesMatch('none', ['image']), false);
  assert.equal(filesMatch('some', []), false);
  assert.equal(filesMatch('some', ['file']), true);
  assert.equal(filesMatch('image', ['audio', 'image']), true);
  assert.equal(filesMatch('video', ['image']), false);
});

test('core: a chat trigger takes a message with a picture and gets the file and what it shows', async () => {
  const target = await makeTestCore({ small: reader() });
  target.core.workflows.save(
    workflow({
      name: 'receipt',
      trigger: { pool: 'chat', config: { match: 'any', files: 'image', reply: 'workflow_only' } },
      nodes: [
        {
          id: 'n1',
          type: 'chat',
          title: 'ตอบ',
          config: { text: 'ได้ {{ $json.files.length }} รูป ({{ $json.files[0].kind }}): {{ $json.files[0].text }}' },
          links: { main: [] },
        },
      ],
    }),
  );
  const chat = target.core.chats.directChat('mimi');
  assert.equal(target.core.chatTriggers(chat.id, 'สวัสดี').consumed, false, 'text only: not for this workflow');

  const cat = target.core.attachments.save({ name: 'cat.png', mime: 'image/png', data: PNG });
  const hit = target.core.chatTriggers(chat.id, '', [cat.id]);
  assert.equal(hit.consumed, true);
  const posted = target.core.postUserMessage(chat.id, '', [cat.id]);
  assert.equal(target.core.attachments.get(cat.id)!.messageId, posted.id, 'the picture belongs to the posted message');
  hit.run();
  const [session] = target.core.chats.sessions(chat.id, 1);
  const replies = () =>
    target.core.deps.messages.page(session!.thread, undefined, 10).filter((message) => message.role === 'assistant');
  await until(() => replies().length > 0);
  assert.equal(replies()[0]!.text, 'ได้ 1 รูป (image): แมวสีส้มนอนบนโซฟา');
  await target.cleanup();
});

test('extract_file node reads a file sent in the chat by its id', async () => {
  const target = await makeTestCore({ small: reader() });
  const sheet = target.core.attachments.save({ name: 'list.csv', mime: 'text/csv', data: Buffer.from('item,qty\nนม,2\nไข่,10\n') });
  const clip = target.core.attachments.save({ name: 'clip', mime: 'video/mp4', data: Buffer.from('fake mp4') });
  target.core.workflows.save(
    workflow({
      name: 'read',
      nodes: [
        { id: 'n1', type: 'extract_file', title: 'csv', config: { attachment: sheet.id }, links: { main: [] } },
        { id: 'n2', type: 'extract_file', title: 'video', config: { attachment: clip.id }, links: { main: [] } },
      ],
    }),
  );
  const run = await target.core.runWorkflow('mimi', 'read');
  assert.equal(run.ok, true, run.result);
  const out = (id: string) => run.nodes.find((node) => node.id === id)!.output.map((item) => item.json);
  assert.deepEqual(out('n1'), [{ item: 'นม', qty: '2' }, { item: 'ไข่', qty: '10' }]);
  assert.equal(out('n2')[0]!.text, 'คนเดินเล่นริมทะเล แล้วพูดว่า สวัสดี');

  target.core.workflows.save(workflow({ name: 'gone', nodes: [{ id: 'n1', type: 'extract_file', title: 'x', config: { attachment: 'nope' }, links: { main: [] } }] }));
  const failed = await target.core.runWorkflow('mimi', 'gone');
  assert.equal(failed.ok, false);
  assert.match(failed.result, /no chat file "nope"/);
  await target.cleanup();
});
