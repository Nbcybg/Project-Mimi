import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentEvent, ClientMessage, ServerMessage } from '@mimi/shared';
import { ModelCatalog } from '../providers/catalog.ts';
import { startServer } from '../server/server.ts';
import { testCoreParts } from './core-helpers.ts';
import { fakeModels, replyingModel, scriptedModel, textStep } from './helpers.ts';

const TOKEN = 'chat-token';
const CATALOG = new ModelCatalog({
  lab: {
    name: 'Lab',
    npm: '@ai-sdk/openai-compatible',
    api: 'http://127.0.0.1:1/v1',
    env: [],
    models: { flash: { name: 'Flash' }, pro: { name: 'Pro' } },
  },
});

async function boot() {
  const mimi = scriptedModel([textStep('รับทราบค่ะ')]);
  const parts = testCoreParts({ settings: { model: 'lab/flash', provider: { lab: {} } } });
  const server = await startServer(
    { ...parts.config, token: TOKEN, host: '127.0.0.1', port: 0 },
    {
      settings: parts.settings,
      catalog: CATALOG,
      models: fakeModels({ chat: mimi, small: replyingModel([{ text: 'nothing' }]), byModel: { mimi } }),
    },
  );
  const http = `http://127.0.0.1:${server.port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const inbox: ServerMessage[] = [];
  let wake: (() => void) | null = null;
  socket.addEventListener('message', (event) => {
    inbox.push(JSON.parse(String(event.data)) as ServerMessage);
    wake?.();
  });
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
  send({ type: 'hello', role: 'client', token: TOKEN });

  /** Sends `message` (if any) and waits for the first later reply that matches. */
  const ask = async <T extends ServerMessage['type']>(
    message: ClientMessage | null,
    type: T,
    match: (reply: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ) => {
    const from = message ? inbox.length : 0;
    if (message) send(message);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = inbox
        .slice(from)
        .find((reply): reply is Extract<ServerMessage, { type: T }> => reply.type === type && match(reply as never));
      if (found) return found;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    throw new Error(`no "${type}" reply; got ${inbox.slice(from).map((reply) => reply.type).join(', ')}`);
  };
  const finished = (message: ClientMessage) =>
    ask(message, 'chat-event', (reply) => (reply.event as AgentEvent).type === 'run-finish');
  const api = (pathname: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(`${http}${pathname}`, {
      ...init,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    });

  return {
    server,
    inbox,
    ask,
    finished,
    api,
    root: parts.root,
    async stop() {
      socket.close();
      await server.close();
      fs.rmSync(parts.root, { recursive: true, force: true });
    },
  };
}

test('chats over the socket: create, send with a file, search, go back', async () => {
  const app = await boot();
  await app.ask(null, 'welcome');

  const opened = await app.ask({ type: 'chat-create', kind: 'direct', agents: ['mimi'] }, 'chat-history');
  const chatId = opened.chat.id;
  assert.deepEqual([opened.chat.kind, opened.chat.agents, opened.session, opened.messages], ['direct', ['mimi'], null, []]);
  assert.match((await app.ask({ type: 'chat-create', kind: 'group', agents: ['mimi', 'ghost'] }, 'error')).message, /Agent "ghost" does not exist/);

  // Files travel over HTTP with the token; the message only names them.
  assert.equal((await app.api('/api/upload?name=x.txt', { method: 'POST', body: 'x' }, null)).status, 401);
  assert.equal((await app.api('/api/upload?name=x.txt', { method: 'POST', body: 'x' }, 'wrong')).status, 401);
  const upload = await app.api('/api/upload?name=list.txt', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'ไข่ 12 ฟอง',
  });
  const file = (await upload.json()) as { id: string; kind: string; name: string };
  assert.deepEqual([upload.status, file.kind, file.name], [200, 'file', 'list.txt']);
  const download = await app.api(`/api/files/${file.id}`);
  assert.equal(await download.text(), 'ไข่ 12 ฟอง');
  assert.equal(download.headers.get('content-type'), 'application/octet-stream', 'never served as a page');
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment/);
  assert.equal((await app.api(`/api/files/${file.id}`, {}, null)).status, 401);
  assert.equal((await app.api('/api/files/00000000-0000-0000-0000-000000000000')).status, 404);

  await app.finished({ type: 'chat-send', chatId, text: 'จำรายการนี้ไว้', attachments: [file.id] });
  const session = await app.ask(null, 'chat-session');
  const echoed = await app.ask(null, 'chat-message');
  assert.deepEqual(
    [session.started, echoed.message.text, echoed.message.attachments.map((entry) => entry.name)],
    [true, 'จำรายการนี้ไว้', ['list.txt']],
  );
  assert.ok(app.inbox.some((message) => message.type === 'busy' && message.chatId === chatId));
  await app.ask(null, 'busy', (reply) => reply.chatId === null);

  await app.finished({ type: 'chat-send', chatId, text: 'ข้อความที่สอง' });
  await app.ask(null, 'busy', (reply) => reply.chatId === null);
  const history = await app.ask({ type: 'chat-open', chatId }, 'chat-history');
  assert.deepEqual(
    history.messages.map((message) => [message.role, message.text, message.attachments.length]),
    [['user', 'จำรายการนี้ไว้', 1], ['assistant', 'รับทราบค่ะ', 0], ['user', 'ข้อความที่สอง', 0], ['assistant', 'รับทราบค่ะ', 0]],
  );
  assert.equal(history.session!.title, 'จำรายการนี้ไว้');
  const listed = await app.ask({ type: 'chats-list' }, 'chats');
  assert.deepEqual(listed.chats.map((chat) => [chat.id, chat.preview]), [[chatId, 'รับทราบค่ะ']]);

  const found = await app.ask({ type: 'search', query: 'ที่สอง' }, 'search-results');
  assert.deepEqual(found.hits.map((hit) => [hit.chatId, hit.role, hit.snippet]), [[chatId, 'user', 'ข้อความที่สอง']]);
  const inFile = await app.ask({ type: 'search', query: 'ไข่ 12' }, 'search-results');
  assert.equal(inFile.hits.length, 1, 'what a file said is searchable through its message');

  // Going back hides the message and everything after it, and hands its text back.
  const second = history.messages[2]!;
  const rewound = await app.ask({ type: 'rewind', sessionId: history.session!.id, messageId: second.id }, 'rewound');
  assert.equal(rewound.text, 'ข้อความที่สอง');
  const after = await app.ask({ type: 'chat-open', chatId, sessionId: history.session!.id }, 'chat-history');
  assert.deepEqual(after.messages.map((message) => message.text), ['จำรายการนี้ไว้', 'รับทราบค่ะ']);
  assert.match(
    (await app.ask({ type: 'rewind', sessionId: history.session!.id, messageId: history.messages[1]!.id }, 'error')).message,
    /one of your own messages/,
  );

  // A session started by hand takes the next message.
  const fresh = await app.ask({ type: 'session-new', chatId }, 'chat-history');
  assert.notEqual(fresh.session!.id, history.session!.id);
  assert.deepEqual([fresh.messages.length, fresh.sessions.length], [0, 2]);
  await app.stop();
});

test('hubs over the socket: model pool, skills, status and agent pictures', async () => {
  const app = await boot();
  await app.ask(null, 'welcome');

  // Model pool: a named preset can be used wherever a model is chosen.
  const saved = await app.ask(
    { type: 'preset-save', preset: { name: 'Creative', model: 'lab/pro', temperature: 1.2, topP: 0.9, topK: 40 } },
    'settings',
  );
  assert.deepEqual(saved.settings.presets, [{ name: 'creative', model: 'lab/pro', temperature: 1.2, topP: 0.9, topK: 40 }]);
  const refuse = async (message: ClientMessage, pattern: RegExp) =>
    assert.match((await app.ask(message, 'error')).message, pattern);
  await refuse({ type: 'preset-save', preset: { name: 'bad', model: 'lab/none' } }, /Unknown model "lab\/none"/);
  await refuse({ type: 'preset-save', preset: { name: 'hot', model: 'lab/pro', temperature: 9 } }, /Temperature must be between 0 and 2/);

  // Skills: saved to the hub, optionally with their own model, then given to an agent.
  const skills = await app.ask(
    { type: 'skill-save', skill: { name: 'report', description: 'Write a report', model: 'creative', tools: ['read_memory'], body: 'REPORT RULES' } },
    'skills',
  );
  assert.equal(skills.saved, 'report');
  assert.deepEqual(skills.skills.find((skill) => skill.name === 'report'), {
    name: 'report',
    description: 'Write a report',
    model: 'creative',
    tools: ['read_memory'],
    body: 'REPORT RULES',
  });
  assert.match(fs.readFileSync(path.join(app.root, 'user', 'skills', 'report.md'), 'utf8'), /model: creative\ntools:\n  - read_memory/);
  await refuse({ type: 'skill-save', skill: { name: 'x', description: 'x', model: 'nope', tools: [], body: 'x' } }, /Unknown model preset "nope"/);
  await refuse({ type: 'skill-save', skill: { name: 'y', description: 'y', model: '', tools: ['no_tool'], body: 'y' } }, /Unknown tool "no_tool"/);

  const agents = await app.ask({ type: 'agents-list' }, 'agents');
  const mimi = agents.agents.find((agent) => agent.name === 'mimi')!;
  const withSkill = await app.ask(
    { type: 'agent-save', renameFrom: 'mimi', agent: { ...mimi, displayName: 'มีมี่', models: { model: 'creative' }, skills: ['report'] } },
    'agents',
  );
  const updated = withSkill.agents.find((agent) => agent.name === 'mimi')!;
  assert.deepEqual([updated.displayName, updated.skills, updated.models.model], ['มีมี่', ['report'], 'creative']);
  await refuse({ type: 'agent-save', renameFrom: 'mimi', agent: { ...mimi, models: { model: 'creative' }, skills: ['ghost'] } }, /Skill "ghost" does not exist/);
  await refuse({ type: 'preset-delete', name: 'creative' }, /still used by: agent mimi, skill report/);

  // Renaming a skill follows it into the agents; deleting takes it away from them.
  await app.ask({ type: 'skill-save', renameFrom: 'report', skill: { name: 'brief', description: 'Write a brief', model: '', tools: [], body: 'BRIEF' } }, 'skills');
  assert.deepEqual(app.server.core.agents.get('mimi').skills, ['brief']);
  await app.ask({ type: 'skill-delete', name: 'brief' }, 'skills');
  assert.deepEqual(app.server.core.agents.get('mimi').skills, []);

  // Status: set by hand here, by the agent's own tool in a chat; every client hears about it.
  const status = await app.ask({ type: 'status-set', agent: 'mimi', key: 'location', value: 'ห้องสมุด' }, 'status');
  assert.deepEqual([status.agent, status.status], ['mimi', { location: 'ห้องสมุด' }]);
  await refuse({ type: 'status-set', agent: 'ghost', key: 'mood', value: 'x' }, /Unknown agent or status key/);

  // Pictures: uploaded over HTTP, announced through the agents message.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal((await app.api('/api/agent-image/mimi/avatar', { method: 'POST', body: png, headers: { 'content-type': 'text/html' } })).status, 400);
  assert.equal((await app.api('/api/agent-image/ghost/avatar', { method: 'POST', body: png, headers: { 'content-type': 'image/png' } })).status, 404);
  const pictured = app.ask(null, 'agents', (reply) => Boolean(reply.agents.find((agent) => agent.name === 'mimi')?.avatar));
  assert.equal((await app.api('/api/agent-image/mimi/avatar', { method: 'POST', body: png, headers: { 'content-type': 'image/png' } })).status, 200);
  assert.equal((await pictured).agents.find((agent) => agent.name === 'mimi')!.portrait, null);
  const image = await app.api('/api/agent-image/mimi/avatar');
  assert.deepEqual([image.headers.get('content-type'), Buffer.from(await image.arrayBuffer()).equals(png)], ['image/png', true]);
  assert.equal((await app.api('/api/agent-image/mimi/portrait')).status, 404);

  // Deleting an agent takes its chats, status and pictures with it.
  await app.ask({ type: 'chat-create', kind: 'direct', agents: ['mimi'] }, 'chat-history');
  const chats = await app.ask({ type: 'agent-delete', name: 'mimi' }, 'chats');
  assert.deepEqual(chats.chats, []);
  assert.deepEqual(app.server.core.status.get('mimi'), {});
  assert.equal((await app.api('/api/agent-image/mimi/avatar')).status, 404);
  await app.stop();
});
