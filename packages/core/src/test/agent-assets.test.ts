import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ServerMessage } from '@mimi/shared';
import { AgentAssets } from '../chat/agent-assets.ts';
import { ModelCatalog } from '../providers/catalog.ts';
import { startServer } from '../server/server.ts';
import { testCoreParts } from './core-helpers.ts';

const CATALOG = new ModelCatalog({
  lab: {
    name: 'Lab',
    npm: '@ai-sdk/openai-compatible',
    api: 'http://127.0.0.1:1/v1',
    env: [],
    models: { flash: { name: 'Flash' } },
  },
});

const FAKE_VRM = Buffer.from('vrm-bytes');
const FAKE_FBX = Buffer.from('fbx-bytes');

test('agent assets: model and motions live in the agent folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-assets-'));
  const assets = new AgentAssets(dir);
  fs.mkdirSync(path.join(dir, 'mimi'), { recursive: true });

  // Model: save, version stamp, read, remove.
  assert.equal(assets.modelVersion('mimi'), null);
  assets.saveModel('mimi', FAKE_VRM);
  const version = assets.modelVersion('mimi');
  assert.ok(version);
  assert.deepEqual(assets.readModel('mimi'), FAKE_VRM);
  assert.ok(fs.existsSync(path.join(dir, 'mimi', 'model.vrm')));

  // Motions: clean names, save several, list sorted.
  assert.equal(AgentAssets.cleanMotionName('Idle Wave.FBX'), 'idle-wave');
  assert.equal(AgentAssets.cleanMotionName('  !!Sit Down---  '), 'sit-down');
  assets.saveMotion('mimi', 'idle', FAKE_FBX);
  assets.saveMotion('mimi', 'wave', FAKE_FBX);
  assert.deepEqual(
    assets.motions('mimi').map((entry) => entry.name),
    ['idle', 'wave'],
  );
  assert.deepEqual(assets.readMotion('mimi', 'idle'), FAKE_FBX);
  assert.equal(assets.readMotion('mimi', 'ghost'), undefined);
  assert.throws(() => assets.saveMotion('mimi', '..', FAKE_FBX), /invalid motion name/);
  assets.removeMotion('mimi', 'idle');
  assert.deepEqual(
    assets.motions('mimi').map((entry) => entry.name),
    ['wave'],
  );

  // Rename moves the files; forget deletes them all.
  fs.mkdirSync(path.join(dir, 'newbie'), { recursive: true });
  assets.rename('mimi', 'newbie');
  assert.ok(fs.existsSync(path.join(dir, 'newbie', 'model.vrm')));
  assert.ok(fs.existsSync(path.join(dir, 'newbie', 'motion', 'wave.fbx')));
  assets.forget('newbie');
  assert.equal(fs.existsSync(path.join(dir, 'newbie', 'model.vrm')), false);
  assert.equal(fs.existsSync(path.join(dir, 'newbie', 'motion')), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the model and motion API: upload, download, list and delete with the token', async (t) => {
  const parts = testCoreParts({ settings: { model: 'lab/flash', provider: { lab: {} } } });
  for (const folder of fs.readdirSync(parts.config.agentsDir)) {
    fs.rmSync(path.join(parts.config.agentsDir, folder), { recursive: true, force: true });
  }
  const server = await startServer(
    { ...parts.config, token: 'asset-token', host: '127.0.0.1', port: 0 },
    { settings: parts.settings, catalog: CATALOG },
  );
  const http = `http://127.0.0.1:${server.port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  t.after(async () => {
    socket.close();
    await server.close();
    fs.rmSync(parts.root, { recursive: true, force: true });
  });
  const inbox: ServerMessage[] = [];
  let wake: (() => void) | null = null;
  socket.addEventListener('message', (event) => {
    inbox.push(JSON.parse(String(event.data)) as ServerMessage);
    wake?.();
  });
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  socket.send(JSON.stringify({ type: 'hello', role: 'client', token: 'asset-token' }));
  const api = (pathname: string, init: RequestInit = {}, token: string | null = 'asset-token') =>
    fetch(`${http}${pathname}`, {
      ...init,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    });
  const ask = async <T extends ServerMessage['type']>(type: T, match: (reply: Extract<ServerMessage, { type: T }>) => boolean = () => true) => {
    const from = inbox.length;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = inbox.slice(from).find((reply): reply is Extract<ServerMessage, { type: T }> => reply.type === type && match(reply as never));
      if (found) return found;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    throw new Error(`no "${type}" reply`);
  };
  /** ขอรายการ agents ล่าสุดจาก server (ตอบกลับมาหลังจากที่เริ่มรอแล้วเสมอ) */
  const listAgents = (match: (reply: Extract<ServerMessage, { type: 'agents' }>) => boolean = () => true) => {
    socket.send(JSON.stringify({ type: 'agents-list' }));
    return ask('agents', match);
  };

  // Nothing until there is an agent; every request needs the token.
  assert.equal((await api('/api/agent-model/mimi', {}, null)).status, 401);
  assert.equal((await api('/api/agent-model/mimi')).status, 404);
  socket.send(
    JSON.stringify({
      type: 'agent-save',
      agent: { name: 'mimi', description: '', systemPrompt: 'คุณคือมิมิ', models: {}, tools: [], canMessage: [], budgets: { maxRounds: 12, maxTokens: 200_000 } },
    }),
  );
  await ask('agents');

  // Model round-trip; the new version stamp reaches every client.
  assert.equal((await api('/api/agent-model/mimi')).status, 404);
  const saved = await api('/api/agent-model/mimi', { method: 'POST', headers: { 'content-type': 'model/vrm' }, body: FAKE_VRM });
  assert.equal(saved.status, 200);
  const model = await api('/api/agent-model/mimi');
  assert.deepEqual(Buffer.from(await model.arrayBuffer()), FAKE_VRM);
  assert.equal(model.headers.get('content-type'), 'application/octet-stream');
  const agents = await listAgents((reply) => (reply as { agents?: Array<{ model?: string | null }> }).agents?.[0]?.model !== null);
  assert.ok(agents.agents[0]!.model);

  // Motions: upload with a messy name (the server cleans it), list them, download one, delete.
  assert.equal((await api('/api/agent-motion/mimi/Idle Wave', { method: 'POST', body: FAKE_FBX })).status, 200);
  assert.equal((await api('/api/agent-motion/mimi/wave', { method: 'POST', body: FAKE_FBX })).status, 200);
  const motions = (await (await api('/api/agent-motions/mimi')).json()) as { motions: Array<{ name: string }> };
  assert.deepEqual(
    motions.motions.map((entry) => entry.name),
    ['idle-wave', 'wave'],
  );
  const fbx = await api('/api/agent-motion/mimi/idle-wave');
  assert.deepEqual(Buffer.from(await fbx.arrayBuffer()), FAKE_FBX);
  assert.match(fbx.headers.get('content-disposition') ?? '', /attachment/);
  assert.equal((await api('/api/agent-motion/mimi/wave', { method: 'DELETE' })).status, 200);
  assert.deepEqual(
    ((await (await api('/api/agent-motions/mimi')).json()) as { motions: Array<{ name: string }> }).motions.map((entry) => entry.name),
    ['idle-wave'],
  );

  // An idle motion must exist before the agent can name it.
  socket.send(
    JSON.stringify({
      type: 'agent-save',
      renameFrom: 'mimi',
      agent: { name: 'mimi', description: '', systemPrompt: 'คุณคือมิมิ', models: {}, tools: [], canMessage: [], budgets: { maxRounds: 12, maxTokens: 200_000 }, character: 'vrm', idleMotion: 'ghost' },
    }),
  );
  assert.match((await ask('error')).message, /has not been uploaded/);

  // Deleting the agent removes model and motions from disk.
  socket.send(JSON.stringify({ type: 'agent-delete', name: 'mimi' }));
  await ask('agents');
  assert.equal(fs.existsSync(path.join(parts.config.agentsDir, 'mimi')), false);
});
