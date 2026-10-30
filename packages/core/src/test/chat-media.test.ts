import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { WorkflowView } from '@mimi/shared';
import { MockLanguageModelV4 } from 'ai/test';
import { AttachmentStore, audioPrompt, PROMPTS } from '../chat/attachments.ts';
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
  first.exec('ALTER TABLE messages DROP COLUMN pinned_at; ALTER TABLE messages DROP COLUMN reactions; ALTER TABLE messages DROP COLUMN speech; ALTER TABLE sessions DROP COLUMN read_at;');
  first.pragma('user_version = 13');
  first.close();
  const again = openDb(file);
  assert.equal(again.pragma('user_version', { simple: true }), 20);
  assert.deepEqual(again.prepare(`SELECT id, kind, text FROM attachments`).all(), [{ id: 'a', kind: 'image', text: 'แมว' }]);
  assert.equal((again.prepare(`SELECT hash FROM attachments`).get() as { hash: string | null }).hash, null);
  again.prepare(`INSERT INTO attachments (id, kind, name, mime, size) VALUES ('b', 'video', 'x.mp4', 'video/mp4', 1)`).run();
  assert.throws(() => again.prepare(`INSERT INTO attachments (id, kind, name, mime, size) VALUES ('c', 'gif', 'x', 'x/y', 1)`).run());
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('attachments are typed by their bytes, not by the upload header', () => {
  const target = openDb(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-files-'));
  const store = new AttachmentStore(target, dir);
  const pdf = store.save({ name: 'note.bin', mime: 'text/plain', data: Buffer.from('%PDF-1.4\nreceipt') });
  assert.deepEqual([pdf.kind, pdf.mime], ['file', 'application/pdf']);
  const png = store.save({ name: 'photo.bin', mime: 'application/octet-stream', data: PNG });
  assert.deepEqual([png.kind, png.mime], ['image', 'image/png']);
  const heic = store.save({
    name: 'photo.heic',
    mime: 'application/octet-stream',
    data: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(8)]),
  });
  assert.deepEqual([heic.kind, heic.mime], ['image', 'image/heic']);
  target.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the same bytes uploaded twice are read by the model once', async () => {
  const mimi = scriptedModel([textStep('ok')]);
  const small = reader();
  const target = await makeTestCore({ models: { mimi }, small });
  const first = target.core.attachments.save({ name: 'a.png', mime: 'image/png', data: PNG });
  const second = target.core.attachments.save({ name: 'b.png', mime: 'image/png', data: PNG });
  assert.equal(first.hash, second.hash);
  await turn(target, { chatId: target.core.chats.directChat('mimi').id, text: 'สองรูป', attachments: [first.id, second.id] });
  assert.equal(small.doGenerateCalls.length, 1);
  assert.deepEqual([target.core.attachments.get(first.id)!.text, target.core.attachments.get(second.id)!.text], [
    'แมวสีส้มนอนบนโซฟา',
    'แมวสีส้มนอนบนโซฟา',
  ]);
  await target.cleanup();
});

test('a file that failed to read is tried again when it is sent once more', async () => {
  let calls = 0;
  const flaky = new MockLanguageModelV4({
    doGenerate: async () => {
      calls++;
      if (calls === 1) throw new Error('provider exploded');
      return {
        content: [{ type: 'text', text: 'แมวสีดำ' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  const mimi = scriptedModel([textStep('ok')]);
  const target = await makeTestCore({ models: { mimi }, small: flaky });
  const cat = target.core.attachments.save({ name: 'cat.png', mime: 'image/png', data: PNG });
  const chat = target.core.chats.directChat('mimi');
  await turn(target, { chatId: chat.id, text: 'ดูนี่', attachments: [cat.id] });
  assert.match(target.core.attachments.get(cat.id)!.text, /could not be read/);
  await turn(target, { chatId: chat.id, text: 'ลองอีกที', attachments: [cat.id] });
  assert.equal(target.core.attachments.get(cat.id)!.text, 'แมวสีดำ');
  const visionCalls = flaky.doGenerateCalls.filter((call) =>
    JSON.stringify(call.prompt).includes('Describe this image'),
  );
  assert.equal(visionCalls.length, 2);
  await target.cleanup();
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
  assert.doesNotMatch(first, /แมวสีส้มนอนบนโซฟา/, 'the description is not duplicated next to the picture');
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

test('a chat model that can read PDFs gets the document itself; one that cannot gets the extracted text', async () => {
  const PDF = Buffer.from('%PDF-1.4\nreceipt');
  const extract = () =>
    replyingModel([(prompt) => (prompt.includes('Extract the content') ? { text: 'ยอดรวม 120 บาท' } : { text: 'nothing' })]);
  const mimi = scriptedModel([textStep('อ่านแล้ว')]);
  const target = await makeTestCore({ models: { mimi }, small: extract(), inputs: ['text', 'pdf'] });
  const doc = target.core.attachments.save({ name: 'receipt.pdf', mime: 'application/pdf', data: PDF });

  await turn(target, { chatId: target.core.chats.directChat('mimi').id, text: 'อ่านใบเสร็จ', attachments: [doc.id] });
  const native = promptOf(mimi, 0);
  assert.match(native, /"mediaType":"application\/pdf"/);
  assert.doesNotMatch(native, /ยอดรวม 120 บาท/, 'the extracted text is not duplicated next to the document');
  await target.cleanup();

  const blind = scriptedModel([textStep('อ่านแล้ว')]);
  const other = await makeTestCore({ models: { mimi: blind }, small: extract() });
  const copy = other.core.attachments.save({ name: 'receipt.pdf', mime: 'application/pdf', data: PDF });
  await turn(other, { chatId: other.core.chats.directChat('mimi').id, text: 'อ่านใบเสร็จ', attachments: [copy.id] });
  const text = promptOf(blind, 0);
  assert.doesNotMatch(text, /"mediaType":"application\/pdf"/);
  assert.match(text, /ยอดรวม 120 บาท/);
  await other.cleanup();
});

test('attachment reading runs a few files at once, in the order they were sent', async () => {
  let active = 0;
  let peak = 0;
  const slow = new MockLanguageModelV4({
    doGenerate: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return {
        content: [{ type: 'text', text: 'รูป' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  const mimi = scriptedModel([textStep('ok')]);
  const target = await makeTestCore({ models: { mimi }, small: slow });
  const ids = Array.from({ length: 5 }, (_, index) =>
    target.core.attachments.save({
      name: `p${index}.png`,
      mime: 'image/png',
      data: Buffer.concat([PNG, Buffer.from(String(index))]),
    }).id,
  );
  await turn(target, { chatId: target.core.chats.directChat('mimi').id, text: 'ห้ารูป', attachments: ids });
  assert.ok(peak > 1, 'more than one file is read at a time');
  assert.ok(peak <= 3, `at most three reads at a time (saw ${peak})`);
  assert.deepEqual(ids.map((id) => target.core.attachments.get(id)!.text), Array(5).fill('รูป'));
  await target.cleanup();
});

test('mixed files share one total text budget and the full text stays on each attachment', async () => {
  const mimi = scriptedModel([textStep('ok')]);
  const target = await makeTestCore({ models: { mimi } });
  const body = 'ก'.repeat(60_000);
  const ids = Array.from({ length: 3 }, (_, index) =>
    target.core.attachments.save({ name: `note${index}.txt`, mime: 'text/plain', data: Buffer.from(body) }).id,
  );
  const chat = target.core.chats.directChat('mimi');
  await turn(target, { chatId: chat.id, text: 'อ่านทุกไฟล์', attachments: ids });
  const [session] = target.core.chats.sessions(chat.id);
  const stored = target.core.deps.messages.page(session!.thread, undefined, 10)[0]!;
  assert.equal((stored.text.match(/\[file cut here:/g) ?? []).length, 3);
  assert.ok(stored.text.length < 130_000, `stored text is ${stored.text.length} chars`);
  for (const id of ids) assert.equal(target.core.attachments.get(id)!.text.length, 60_000, 'the full text is kept');
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

/** A mono 16-bit PCM WAV of `samples` samples, each set to `level`. */
function wav(samples: number, level: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(samples * 2, 40);
  const body = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) body.writeInt16LE(level, i * 2);
  return Buffer.concat([header, body]);
}

const answering = (replies: string[]) => {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: replies[Math.min(call++, replies.length - 1)]! }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  });
};

test('a recording with no sound is "(no speech)" without asking a model, and an empty answer is asked once more', async () => {
  const silence = answering(['should not be asked']);
  const mimi = scriptedModel([textStep('ok'), textStep('ok')]);
  const target = await makeTestCore({ models: { mimi }, small: silence });
  const chat = target.core.chats.directChat('mimi');
  const quiet = target.core.attachments.save({ name: 'voice.wav', mime: 'audio/wav', data: wav(1600, 0) });
  await turn(target, { chatId: chat.id, text: 'ฟังนี่', attachments: [quiet.id] });
  assert.equal(target.core.attachments.get(quiet.id)!.text, '(no speech)');
  assert.equal(silence.doGenerateCalls.length, 0);
  await target.cleanup();

  const hesitant = answering(['', 'สวัสดีค่ะ']);
  const second = await makeTestCore({ models: { mimi: scriptedModel([textStep('ok')]) }, small: hesitant });
  const spoken = second.core.attachments.save({ name: 'voice.wav', mime: 'audio/wav', data: wav(1600, 3000) });
  await turn(second, { chatId: second.core.chats.directChat('mimi').id, text: 'ฟังนี่', attachments: [spoken.id] });
  assert.equal(second.core.attachments.get(spoken.id)!.text, 'สวัสดีค่ะ');
  assert.equal(hesitant.doGenerateCalls.length, 2);
  await second.cleanup();
});

test('a recording is transcribed in the language of the app', () => {
  assert.match(audioPrompt('th'), /Thai script/);
  assert.match(audioPrompt('th'), /never Chinese/);
  assert.match(audioPrompt('en', true), /English/);
  // No language known: the plain prompt, as before.
  assert.equal(audioPrompt(undefined), PROMPTS.audio);
});
