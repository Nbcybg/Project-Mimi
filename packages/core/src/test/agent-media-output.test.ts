import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentEvent, WorkflowView } from '@mimi/shared';
import { MockImageModelV4, MockSpeechModelV4, MockVideoModelV4 } from 'ai/test';
import { mediaFileName } from '../tools/media-tools.ts';
import { makeTestCore, type TestCore } from './core-helpers.ts';
import { scriptedModel, textStep, toolStep } from './helpers.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const response = { timestamp: new Date(0), modelId: 'mock', headers: {} };

function setAgent(target: TestCore, frontmatter: string) {
  fs.mkdirSync(path.join(target.root, 'user', 'agents', 'mimi'), { recursive: true });
  fs.writeFileSync(path.join(target.root, 'user', 'agents', 'mimi', 'agent.md'), `---\nname: mimi\nmodel: test/mimi\n${frontmatter}\n---\nYou are Mimi.`);
}

async function turn(target: TestCore, text: string) {
  const events: AgentEvent[] = [];
  const chat = target.core.chats.directChat('mimi');
  for await (const item of target.core.engine.runTurn({ chatId: chat.id, text })) {
    if (item.type === 'agent-event') events.push(item.event);
  }
  return { events, chat };
}

const attachmentsOf = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === 'attachment' ? [event.attachment] : []));

test('media file names: a slug of the prompt and the extension of the type', () => {
  assert.equal(mediaFileName('A cat on a sofa!', 'image/png', 'image'), 'a-cat-on-a-sofa!.png');
  assert.equal(mediaFileName('', 'audio/wav', 'speech'), 'speech.wav');
  assert.equal(mediaFileName('แมว/ส้ม', 'video/mp4', 'video'), 'แมว-ส้ม.mp4');
});

test('send_file: the agent sends a file from the allowed folder; it shows under its message', async () => {
  const mimi = scriptedModel([toolStep('send_file', { path: 'report.csv' }), textStep('ส่งรายงานให้แล้วค่ะ')]);
  const target = await makeTestCore({ models: { mimi } });
  setAgent(target, 'tools: [send_file]');
  fs.writeFileSync(path.join(target.config.allowedDirs[0]!, 'report.csv'), 'item,qty\nนม,2\n');

  const { events, chat } = await turn(target, 'ขอรายงาน');
  const [sent] = attachmentsOf(events);
  assert.ok(sent, 'the file is streamed to the chat while the turn runs');
  assert.deepEqual([sent.kind, sent.name, sent.mime], ['file', 'report.csv', 'text/csv']);
  const result = events.find((event) => event.type === 'tool-result');
  assert.ok(result?.type === 'tool-result' && result.result.ok);
  assert.match(result.result.output, new RegExp(`attachment id: ${sent.id}`));

  // Stored with the assistant message that called the tool, so the history shows it too.
  const stored = target.core.attachments.get(sent.id)!;
  const [session] = target.core.chats.sessions(chat.id, 1);
  const owner = target.core.deps.messages.get(stored.messageId!)!;
  assert.equal(owner.role, 'assistant');
  assert.equal(owner.thread, session!.thread);
  assert.equal(target.core.attachments.read(sent.id)!.toString('utf8'), 'item,qty\nนม,2\n');
  await target.cleanup();
});

test('send_file: refuses files outside the allowed folders and needs exactly one source', async () => {
  const mimi = scriptedModel([
    toolStep('send_file', { path: '../../secret.txt' }),
    toolStep('send_file', { path: 'a.txt', url: 'https://example.com/a.png' }, 'call-2'),
    textStep('ส่งไม่ได้ค่ะ'),
  ]);
  const target = await makeTestCore({ models: { mimi } });
  setAgent(target, 'tools: [send_file]');
  const { events } = await turn(target, 'ส่งไฟล์');
  const results = events.flatMap((event) => (event.type === 'tool-result' ? [event.result] : []));
  assert.deepEqual(results.map((result) => result.ok), [false, false]);
  assert.match(results[1]!.output, /exactly one/);
  assert.equal(attachmentsOf(events).length, 0);
  await target.cleanup();
});

test('generate_image, text_to_speech and generate_video use the agent\'s media models and send what they make', async () => {
  const prompts: string[] = [];
  const image = new MockImageModelV4({
    doGenerate: async (options) => {
      prompts.push(String(options.prompt));
      return { images: [PNG], warnings: [], response };
    },
  });
  const speech = new MockSpeechModelV4({
    doGenerate: async (options) => {
      prompts.push(options.text);
      return { audio: new Uint8Array([82, 73, 70, 70]), warnings: [], response };
    },
  });
  const video = new MockVideoModelV4({
    doGenerate: async (options) => {
      prompts.push(String(options.prompt));
      return { videos: [{ type: 'binary', data: new Uint8Array([0, 0, 0, 24]), mediaType: 'video/mp4' }], warnings: [], response };
    },
  });
  const mimi = scriptedModel([
    toolStep('generate_image', { prompt: 'an orange cat' }),
    toolStep('text_to_speech', { text: 'สวัสดีค่ะ' }, 'call-2'),
    toolStep('generate_video', { prompt: 'waves on a beach' }, 'call-3'),
    textStep('เสร็จแล้วค่ะ'),
  ]);
  const target = await makeTestCore({ models: { mimi }, media: { image, speech, video } });
  setAgent(target, 'tools: [generate_image, text_to_speech, generate_video]');

  const { events } = await turn(target, 'ทำให้หน่อย');
  const sent = attachmentsOf(events);
  assert.deepEqual(
    sent.map((file) => [file.kind, file.name]),
    [
      ['image', 'an-orange-cat.png'],
      ['audio', 'สวัสดีค่ะ.mp3'],
      ['video', 'waves-on-a-beach.mp4'],
    ],
  );
  assert.deepEqual(prompts, ['an orange cat', 'สวัสดีค่ะ', 'waves on a beach']);
  assert.equal(sent[0]!.text, 'Picture made from the prompt: an orange cat');
  const logged = target.core.db.prepare(`SELECT capability FROM usage_log WHERE capability IN ('image', 'speech', 'video') ORDER BY id`).all();
  assert.deepEqual(logged.map((row) => (row as { capability: string }).capability), ['image', 'speech', 'video']);
  await target.cleanup();
});

test('generate_image without an image model says where to pick one', async () => {
  const mimi = scriptedModel([toolStep('generate_image', { prompt: 'a cat' }), textStep('ทำไม่ได้ค่ะ')]);
  const target = await makeTestCore({ models: { mimi } });
  setAgent(target, 'tools: [generate_image]');
  const { events } = await turn(target, 'วาดแมว');
  const result = events.find((event) => event.type === 'tool-result');
  assert.ok(result?.type === 'tool-result');
  assert.equal(result.result.ok, false);
  assert.match(result.result.output, /not available|image/i);
  await target.cleanup();
});

test('workflow chat node posts files: a chat file id (from a tool answer) and a path', async () => {
  const target = await makeTestCore({});
  const made = target.core.attachments.save({ name: 'cat.png', mime: 'image/png', data: Buffer.from(PNG) });
  fs.writeFileSync(path.join(target.config.allowedDirs[0]!, 'note.txt'), 'hello');
  const workflow: WorkflowView = {
    name: 'post',
    agent: 'mimi',
    title: 'Post',
    description: '',
    enabled: true,
    trigger: { pool: 'manual', config: {} },
    webhook: null,
    nodes: [
      {
        id: 'n1',
        type: 'chat',
        title: 'ส่ง',
        config: { text: 'รูปกับโน้ตค่ะ', files: `Sent image "cat.png" to the chat. attachment id: ${made.id}\nnote.txt` },
        links: { main: [] },
      },
    ],
  };
  target.core.workflows.save(workflow);
  const run = await target.core.runWorkflow('mimi', 'post');
  assert.equal(run.ok, true, run.result);
  const chat = target.core.chats.directChat('mimi');
  const [session] = target.core.chats.sessions(chat.id, 1);
  const [message] = target.core.deps.messages.page(session!.thread, undefined, 5);
  assert.equal(message!.text, 'รูปกับโน้ตค่ะ');
  const files = target.core.attachments.forMessages([message!.id]).get(message!.id)!;
  assert.deepEqual(files.map((file) => [file.kind, file.name]), [['image', 'cat.png'], ['file', 'note.txt']]);

  target.core.workflows.save({ ...workflow, name: 'missing', nodes: [{ ...workflow.nodes[0]!, config: { files: 'nope.txt' } }] });
  const failed = await target.core.runWorkflow('mimi', 'missing');
  assert.equal(failed.ok, false);
  assert.match(failed.result, /not a file/);
  await target.cleanup();
});
