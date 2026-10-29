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
    /** Sends a message and waits until the server has handled it (replies come in order). */
    async post(message: ClientMessage) {
      send(message);
      await ask({ type: 'chats-list' }, 'chats');
    },
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
  const unopened = await app.ask({ type: 'chats-list' }, 'chats');
  assert.equal(unopened.chats.find((chat) => chat.id === chatId)?.unread, true, 'an unopened reply is marked new');
  const widget = (await (await app.api('/api/widget')).json()) as { chats: Array<{ id: number; unread: number }> };
  assert.equal(widget.chats.find((chat) => chat.id === chatId)?.unread, 1, 'the widget shows the same unread reply');
  const history = await app.ask({ type: 'chat-open', chatId }, 'chat-history');
  assert.deepEqual(
    history.messages.map((message) => [message.role, message.text, message.attachments.length]),
    [['user', 'จำรายการนี้ไว้', 1], ['assistant', 'รับทราบค่ะ', 0], ['user', 'ข้อความที่สอง', 0], ['assistant', 'รับทราบค่ะ', 0]],
  );
  assert.equal(history.session!.title, 'จำรายการนี้ไว้');
  const listed = await app.ask({ type: 'chats-list' }, 'chats');
  assert.deepEqual(listed.chats.map((chat) => [chat.id, chat.preview]), [[chatId, 'รับทราบค่ะ']]);
  assert.equal(listed.chats[0]!.unread, false, 'opening the chat clears the new mark');
  const widgetRead = (await (await app.api('/api/widget')).json()) as { chats: Array<{ id: number; unread: number }> };
  assert.equal(widgetRead.chats.find((chat) => chat.id === chatId)?.unread, 0, 'the widget clears too');

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
  const builtin = skills.skills.find((skill) => skill.name === 'workflow-builder')!;
  assert.equal(builtin.builtin, true);
  assert.match(builtin.body, /workflow_save/);
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

test('wardrobe and emoji pictures over the socket and HTTP', async () => {
  const app = await boot();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const upload = (url: string, type = 'image/png') => app.api(url, { method: 'POST', body: png, headers: { 'content-type': type } });
  const refuse = async (message: ClientMessage, pattern: RegExp) => {
    const error = await app.ask(message, 'error');
    assert.match(error.message, pattern);
  };

  const list = await app.ask({ type: 'wardrobe-save', outfit: { id: 'wa01', name: 'ชุดทำงาน', description: 'เชิ้ตขาว' } }, 'wardrobe');
  assert.deepEqual(list.outfits.map((outfit) => [outfit.id, outfit.name, outfit.sprites]), [['wa01', 'ชุดทำงาน', {}]]);
  await refuse({ type: 'wardrobe-save', outfit: { id: 'mimi' } }, /id of an agent/);
  await refuse({ type: 'agent-save', agent: { name: 'wa01', description: '', canMessage: [], systemPrompt: 'x', tools: [], models: {}, budgets: { maxRounds: 3, maxTokens: 1000 } } }, /id of an outfit/);

  // An outfit's emoji picture: bad type / bad key / unknown owner are refused.
  assert.equal((await upload('/api/sprite/outfit/wa01/1f60a', 'text/html')).status, 400);
  assert.equal((await upload('/api/sprite/outfit/wa01/smile')).status, 400);
  assert.equal((await upload('/api/sprite/outfit/ghost/1f60a')).status, 404);
  assert.equal((await upload('/api/sprite/agent/ghost/1f60a')).status, 404);
  assert.equal((await app.api('/api/sprite/outfit/wa01/1f60a')).status, 404);
  const changed = app.ask(null, 'wardrobe', (reply) => Boolean(reply.outfits[0]?.sprites['1f60a']));
  assert.equal((await upload('/api/sprite/outfit/wa01/1f60a')).status, 200);
  assert.deepEqual(Object.keys((await changed).outfits[0]!.sprites), ['1f60a']);
  const fetched = await app.api('/api/sprite/outfit/wa01/1f60a');
  assert.deepEqual([fetched.headers.get('content-type'), Buffer.from(await fetched.arrayBuffer()).equals(png)], ['image/png', true]);

  // The sprites move with the outfit when its id changes.
  const renamed = await app.ask({ type: 'wardrobe-save', renameFrom: 'wa01', outfit: { id: 'work', name: 'ชุดทำงาน' } }, 'wardrobe');
  assert.deepEqual(renamed.outfits.map((outfit) => [outfit.id, Object.keys(outfit.sprites)]), [['work', ['1f60a']]]);

  // The agent's own set is announced with the agent and moves with a rename.
  const pictured = app.ask(null, 'agents', (reply) => Object.keys(reply.agents.find((agent) => agent.name === 'mimi')?.sprites ?? {}).length > 0);
  assert.equal((await upload('/api/sprite/agent/mimi/2764')).status, 200);
  assert.deepEqual(Object.keys((await pictured).agents.find((agent) => agent.name === 'mimi')!.sprites!), ['2764']);
  const agents = await app.ask({ type: 'agents-list' }, 'agents');
  const mimi = agents.agents.find((agent) => agent.name === 'mimi')!;
  const moved = await app.ask({ type: 'agent-save', renameFrom: 'mimi', agent: { ...mimi, name: 'mimi2', models: {} } }, 'agents');
  assert.deepEqual(Object.keys(moved.agents.find((agent) => agent.name === 'mimi2')!.sprites!), ['2764']);
  assert.equal((await app.api('/api/sprite/agent/mimi2/2764')).status, 200);

  await app.ask({ type: 'wardrobe-delete', id: 'work' }, 'wardrobe');
  assert.equal((await app.api('/api/sprite/outfit/work/1f60a')).status, 404);
  await app.stop();
});

test('backgrounds over the socket and HTTP', async () => {
  const app = await boot();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const upload = (url: string, type = 'image/png') => app.api(url, { method: 'POST', body: png, headers: { 'content-type': type } });

  const saved = await app.ask({ type: 'background-save', background: { id: 'cafe', name: 'คาเฟ่', keywords: ['คาเฟ่'] } }, 'backgrounds');
  assert.deepEqual(saved.items.map((item) => [item.id, item.keywords, item.image]), [['cafe', ['คาเฟ่'], null]]);
  assert.equal((await upload('/api/background-image/ghost')).status, 404);
  assert.equal((await upload('/api/background-image/cafe', 'text/html')).status, 400);
  assert.equal((await app.api('/api/background-image/cafe')).status, 404);
  const pictured = app.ask(null, 'backgrounds', (reply) => Boolean(reply.items[0]?.image));
  assert.equal((await upload('/api/background-image/cafe')).status, 200);
  await pictured;
  const fetched = await app.api('/api/background-image/cafe');
  assert.deepEqual([fetched.headers.get('content-type'), Buffer.from(await fetched.arrayBuffer()).equals(png)], ['image/png', true]);

  const chosen = await app.ask({ type: 'background-select', agent: 'mimi', choice: 'cafe' }, 'backgrounds', (reply) => reply.settings.agents.mimi === 'cafe');
  assert.deepEqual(chosen.settings, { default: '', agents: { mimi: 'cafe' } });
  const error = await app.ask({ type: 'background-select', choice: 'ghost' }, 'error');
  assert.match(error.message, /No background/);

  // The choice follows an agent rename and goes when the backdrop does.
  const agents = await app.ask({ type: 'agents-list' }, 'agents');
  const mimi = agents.agents.find((agent) => agent.name === 'mimi')!;
  await app.ask({ type: 'agent-save', renameFrom: 'mimi', agent: { ...mimi, name: 'mimi2', models: {} } }, 'agents');
  assert.deepEqual((await app.ask({ type: 'backgrounds-list' }, 'backgrounds')).settings.agents, { mimi2: 'cafe' });
  const gone = await app.ask({ type: 'background-delete', id: 'cafe' }, 'backgrounds');
  assert.deepEqual([gone.items, gone.settings.agents], [[], {}]);
  await app.stop();
});

test('situation gallery over HTTP and the socket', async () => {
  const app = await boot();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const post = (url: string, body: Buffer, type: string) => app.api(url, { method: 'POST', body, headers: { 'content-type': type } });

  assert.equal((await post('/api/gallery/ghost', png, 'image/png')).status, 404);
  assert.equal((await post('/api/gallery/mimi', png, 'text/html')).status, 400);
  const changed = app.ask(null, 'gallery-changed');
  const created = await post(`/api/gallery/mimi?title=${encodeURIComponent('ฝนตก')}&tags=rain,cafe&description=quiet`, png, 'image/png');
  assert.equal(created.status, 200);
  const item = (await created.json()) as { id: string; title: string; tags: string[]; thumb: boolean };
  assert.deepEqual([item.id, item.title, item.tags, item.thumb], ['g1', 'ฝนตก', ['rain', 'cafe'], false]);
  assert.equal((await changed).agent, 'mimi');

  assert.equal((await post('/api/gallery/mimi/g1/thumb', png, 'image/png')).status, 400);
  assert.equal((await post('/api/gallery/mimi/g1/thumb', jpeg, 'image/jpeg')).status, 200);
  const thumb = await app.api('/api/gallery/mimi/g1/thumb');
  assert.deepEqual([thumb.headers.get('content-type'), Buffer.from(await thumb.arrayBuffer()).equals(jpeg)], ['image/jpeg', true]);
  const full = await app.api('/api/gallery/mimi/g1');
  assert.deepEqual([full.headers.get('content-type'), Buffer.from(await full.arrayBuffer()).equals(png)], ['image/png', true]);
  assert.equal((await app.api('/api/gallery/mimi/g9')).status, 404);

  const listed = await app.ask({ type: 'gallery-list', agent: 'mimi', query: 'rain' }, 'gallery');
  assert.deepEqual([listed.total, listed.items.map((entry) => [entry.id, entry.thumb])], [1, [['g1', true]]]);
  await app.ask({ type: 'gallery-update', agent: 'mimi', id: 'g1', title: 'Rainy', tags: ['rain'], description: 'x' }, 'gallery-changed');
  assert.equal((await app.ask({ type: 'gallery-list', agent: 'mimi' }, 'gallery')).items[0]!.title, 'Rainy');

  // Showing is a status; deleting the picture on show clears it; a rename carries the gallery along.
  await app.ask({ type: 'status-set', agent: 'mimi', key: 'situation', value: 'g1' }, 'status');
  const agents = await app.ask({ type: 'agents-list' }, 'agents');
  const mimi = agents.agents.find((agent) => agent.name === 'mimi')!;
  await app.ask({ type: 'agent-save', renameFrom: 'mimi', agent: { ...mimi, name: 'mimi2', models: {} } }, 'agents');
  assert.equal((await app.ask({ type: 'gallery-list', agent: 'mimi2' }, 'gallery')).total, 1);
  assert.equal((await app.api('/api/gallery/mimi2/g1')).status, 200);
  await app.ask({ type: 'status-set', agent: 'mimi2', key: 'situation', value: 'g1' }, 'status');
  await app.ask({ type: 'gallery-delete', agent: 'mimi2', id: 'g1' }, 'gallery-changed');
  assert.equal(app.server.core.status.get('mimi2').situation, undefined);
  assert.equal((await app.ask({ type: 'gallery-list', agent: 'mimi2' }, 'gallery')).total, 0);
  await app.stop();
});

test('agent messages notify the user only when that chat is not on screen', async () => {
  const app = await boot();
  await app.ask(null, 'welcome');
  const chatId = (await app.ask({ type: 'chat-create', kind: 'direct', agents: ['mimi'] }, 'chat-history')).chat.id;
  const messageNotices = () => app.inbox.filter((message) => message.type === 'notification' && message.notification.kind === 'message');
  const send = (message: ClientMessage) => app.ask(message, 'busy', (reply) => reply.chatId === null);

  // Looking at the chat: the reply shows up there, no notification.
  await app.post({ type: 'presence', chatId, visible: true });
  await send({ type: 'chat-send', chatId, text: 'สวัสดี' });
  assert.equal(messageNotices().length, 0);

  // Another chat open (or the window hidden): the reply raises one.
  await app.post({ type: 'presence', chatId: chatId + 100, visible: true });
  await send({ type: 'chat-send', chatId, text: 'อีกเรื่อง' });
  const [notice] = messageNotices();
  assert.ok(notice && notice.type === 'notification');
  assert.deepEqual([notice.notification.chatId, notice.notification.body], [chatId, 'รับทราบค่ะ']);
  assert.ok(notice.notification.id, 'kept in the inbox');

  // notify_user posts in the agent's own chat and always notifies.
  const tool = app.server.core.tools.get('notify_user');
  assert.ok(tool);
  const result = await tool.execute({ message: 'มีอีเมลด่วนจากลูกค้า', title: 'อีเมลใหม่' }, { traceId: 't', thread: 'x', agent: 'mimi', allowedDirs: [] });
  assert.match(String(result), /Notified the user/);
  const last = await app.ask(null, 'notification', (reply) => reply.notification.title === 'อีเมลใหม่');
  assert.deepEqual([last.notification.title, last.notification.body, last.notification.chatId], ['อีเมลใหม่', 'มีอีเมลด่วนจากลูกค้า', chatId]);
  const history = await app.ask({ type: 'chat-open', chatId }, 'chat-history');
  assert.equal(history.messages.at(-1)?.text, 'มีอีเมลด่วนจากลูกค้า');
  await app.stop();
});

test('an outfit can carry its own VRM model', async () => {
  const app = await boot();
  await app.ask({ type: 'wardrobe-save', outfit: { id: 'swim', name: 'ชุดว่ายน้ำ' } }, 'wardrobe');
  const vrm = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(16, 1)]);
  const post = (body: Buffer, id = 'swim') => app.api(`/api/wardrobe-model/${id}`, { method: 'POST', body, headers: { 'content-type': 'model/vrm' } });
  assert.equal((await post(Buffer.from('<html>'))).status, 400, 'not a glTF binary');
  assert.equal((await post(vrm, 'ghost')).status, 404);
  assert.equal((await app.api('/api/wardrobe-model/swim')).status, 404);
  const changed = app.ask(null, 'wardrobe', (reply) => Boolean(reply.outfits[0]?.model));
  assert.equal((await post(vrm)).status, 200);
  assert.ok((await changed).outfits[0]!.model);
  const fetched = await app.api('/api/wardrobe-model/swim');
  assert.ok(Buffer.from(await fetched.arrayBuffer()).equals(vrm));
  assert.equal((await app.api('/api/wardrobe-model/swim', {}, null)).status, 401);
  const removed = app.ask(null, 'wardrobe', (reply) => reply.outfits[0]?.model === null);
  assert.equal((await app.api('/api/wardrobe-model/swim', { method: 'DELETE' })).status, 200);
  await removed;
  await app.stop();
});

test('pin and react: marks come back in the history and are broadcast; pins list the whole chat', async () => {
  const app = await boot();
  await app.ask(null, 'welcome');
  const opened = await app.ask({ type: 'chat-create', kind: 'direct', agents: ['mimi'] }, 'chat-history');
  const chatId = opened.chat.id;
  await app.finished({ type: 'chat-send', chatId, text: 'ข้อความของฉัน' });
  await app.ask(null, 'busy', (reply) => reply.chatId === null);
  const history = await app.ask({ type: 'chat-open', chatId }, 'chat-history');
  const [mine, answer] = history.messages;
  assert.deepEqual([mine!.pinned, mine!.reactions, history.pins], [false, [], []]);

  const pinned = await app.ask({ type: 'message-pin', messageId: answer!.id, pinned: true }, 'message-marks');
  assert.deepEqual([pinned.messageId, pinned.pinned, pinned.pins.map((pin) => [pin.id, pin.role, pin.text])], [answer!.id, true, [[answer!.id, 'assistant', 'รับทราบค่ะ']]]);
  const loved = await app.ask({ type: 'message-react', messageId: answer!.id, emoji: '❤️' }, 'message-marks', (reply) => reply.reactions.length > 0);
  assert.deepEqual([loved.pinned, loved.reactions], [true, ['❤️']]);
  await app.ask({ type: 'message-react', messageId: answer!.id, emoji: '👍' }, 'message-marks', (reply) => reply.reactions.length === 2);

  // The log remembers them, and a second ❤️ takes the first back.
  const again = await app.ask({ type: 'chat-open', chatId }, 'chat-history');
  assert.deepEqual([again.messages[1]!.pinned, again.messages[1]!.reactions, again.pins!.length], [true, ['❤️', '👍'], 1]);
  const taken = await app.ask({ type: 'message-react', messageId: answer!.id, emoji: '❤️' }, 'message-marks', (reply) => reply.reactions.length === 1);
  assert.deepEqual(taken.reactions, ['👍']);
  const unpinned = await app.ask({ type: 'message-pin', messageId: answer!.id, pinned: false }, 'message-marks', (reply) => !reply.pinned);
  assert.deepEqual(unpinned.pins, []);

  assert.match((await app.ask({ type: 'message-react', messageId: answer!.id, emoji: '' }, 'error')).message, /one emoji/);
  assert.match((await app.ask({ type: 'message-pin', messageId: 99999, pinned: true }, 'error')).message, /message of a chat/);
  await app.stop();
});
