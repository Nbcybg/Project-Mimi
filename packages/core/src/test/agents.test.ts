import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentView, ClientMessage, ServerMessage } from '@mimi/shared';
import { ModelCatalog } from '../providers/catalog.ts';
import { startServer } from '../server/server.ts';
import { testCoreParts } from './core-helpers.ts';

/** A provider that needs no key, with a few models to assign to capabilities. */
const CATALOG = new ModelCatalog({
  lab: {
    name: 'Lab',
    npm: '@ai-sdk/openai-compatible',
    api: 'http://127.0.0.1:1/v1',
    env: [],
    models: {
      'chat-cheap': { name: 'Chat Cheap' },
      'chat-strong': { name: 'Chat Strong' },
      'eyes': { name: 'Eyes', modalities: { input: ['text', 'image'], output: ['text'] } },
      'ears': { name: 'Ears' },
    },
  },
});

async function open(url: string) {
  const socket = new WebSocket(url);
  const inbox: ServerMessage[] = [];
  let wake: (() => void) | null = null;
  socket.addEventListener('message', (event) => {
    inbox.push(JSON.parse(String(event.data)) as ServerMessage);
    wake?.();
  });
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
  send({ type: 'hello', role: 'client', token: 'app-token' });
  const ask = async <T extends ServerMessage['type']>(message: ClientMessage | null, type: T) => {
    const from = message ? inbox.length : 0;
    if (message) send(message);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = inbox.slice(from).find((reply) => reply.type === type);
      if (found) return found as Extract<ServerMessage, { type: T }>;
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
  return { ask, close: () => socket.close() };
}

const draft = (overrides: Partial<AgentView>): AgentView => ({
  name: 'mimi',
  description: 'เลขาส่วนตัว',
  systemPrompt: 'คุณคือมิมิ เลขาส่วนตัว',
  models: {},
  tools: [],
  canMessage: [],
  budgets: { maxRounds: 12, maxTokens: 200_000 },
  ...overrides,
});

test('the app starts with no agents; they are created, edited, renamed and deleted from the client', async () => {
  // Naming "lab" in the settings file marks this key-less provider as one the user wants.
  const parts = testCoreParts({ settings: { model: 'lab/chat-cheap', provider: { lab: {} } } });
  for (const folder of fs.readdirSync(parts.config.agentsDir)) {
    fs.rmSync(path.join(parts.config.agentsDir, folder), { recursive: true, force: true });
  }
  const server = await startServer(
    { ...parts.config, token: 'app-token', host: '127.0.0.1', port: 0 },
    { settings: parts.settings, catalog: CATALOG },
  );
  const client = await open(`ws://127.0.0.1:${server.port}/ws`);
  const agentFile = (name: string) => path.join(parts.config.agentsDir, name, 'agent.md');

  // Nothing is shipped: no agents, and a message has nobody to go to.
  const welcome = await client.ask(null, 'welcome');
  assert.deepEqual({ agents: welcome.agents, defaultAgent: welcome.defaultAgent }, { agents: [], defaultAgent: '' });
  assert.match((await client.ask({ type: 'send', text: 'hello' }, 'error')).message, /There is no agent yet/);
  const empty = await client.ask({ type: 'agents-list' }, 'agents');
  assert.deepEqual({ agents: empty.agents, defaultAgent: empty.defaultAgent }, { agents: [], defaultAgent: null });
  assert.ok(empty.tools.some((tool) => tool.name === 'read_file' && tool.risk === 'read'));
  assert.ok(empty.tools.some((tool) => tool.name === 'run_shell' && tool.risk === 'shell'));
  const settings = (await client.ask({ type: 'settings-get' }, 'settings')).settings;
  assert.deepEqual({ agents: settings.agents, ready: settings.ready, chat: settings.defaults.model }, { agents: 0, ready: false, chat: 'lab/chat-cheap' });
  assert.ok(settings.models.some((model) => model.ref === 'lab/eyes' && model.label.includes('[image]')));

  // One agent, a different model for each capability.
  const models = { model: 'lab/chat-cheap', vision_model: 'lab/eyes', transcript_model: 'lab/ears', small_model: 'lab/chat-cheap' };
  const created = await client.ask(
    { type: 'agent-save', agent: draft({ name: 'Mimi', models, tools: ['read_memory', 'create_trigger'] }) },
    'agents',
  );
  assert.deepEqual({ saved: created.saved, defaultAgent: created.defaultAgent }, { saved: 'mimi', defaultAgent: 'mimi' });
  assert.deepEqual(created.agents[0], {
    ...draft({ models, tools: ['read_memory', 'create_trigger'] }),
    displayName: '',
    skills: [],
    status: {},
    avatar: null,
    portrait: null,
  });
  const source = fs.readFileSync(agentFile('mimi'), 'utf8');
  for (const line of ['model: lab/chat-cheap', 'vision_model: lab/eyes', 'transcript_model: lab/ears', 'small_model: lab/chat-cheap']) {
    assert.ok(source.includes(line), line);
  }
  const mimi = server.core.agents.get('mimi');
  const route = (capability: 'chat' | 'vision' | 'transcript' | 'summarize', agent = mimi) => {
    const ref = server.core.models.resolve(capability, agent.models);
    return `${ref.provider}/${ref.model}`;
  };
  assert.deepEqual([route('chat'), route('vision'), route('transcript'), route('summarize')], ['lab/chat-cheap', 'lab/eyes', 'lab/ears', 'lab/chat-cheap']);
  assert.equal((await client.ask({ type: 'settings-get' }, 'settings')).settings.ready, true);

  // A second agent that leaves capabilities empty inherits the defaults set in the app.
  await client.ask({ type: 'settings-save', defaults: { vision_model: 'lab/eyes', transcript_model: '' } }, 'settings');
  await client.ask(
    { type: 'agent-save', agent: draft({ name: 'tim', description: 'พ่อบ้าน', systemPrompt: 'คุณคือทิม', models: { model: 'lab/chat-strong' }, canMessage: ['mimi'] }) },
    'agents',
  );
  const tim = server.core.agents.get('tim');
  assert.deepEqual(
    [route('chat', tim), route('vision', tim), route('transcript', tim), route('summarize', tim)],
    ['lab/chat-strong', 'lab/eyes', 'lab/chat-strong', 'lab/chat-strong'],
    'own chat model; default vision; the rest fall back to the chat model',
  );

  // Invalid definitions are refused and nothing is written.
  const refuse = async (agent: AgentView, pattern: RegExp) => {
    assert.match((await client.ask({ type: 'agent-save', agent }, 'error')).message, pattern);
  };
  await refuse(draft({ name: 'x1', models: { vision_model: 'lab/no-such-model' } }), /Unknown model "lab\/no-such-model"/);
  await refuse(draft({ name: 'x2', tools: ['no_such_tool'] }), /Unknown tool "no_such_tool"/);
  await refuse(draft({ name: 'x3', tools: ['gmail_read', 'run_shell'] }), /cannot have both "gmail_read".*"run_shell"/);
  await refuse(draft({ name: 'x4', canMessage: ['ghost'] }), /Agent "ghost" does not exist/);
  await refuse(draft({ name: 'x5', systemPrompt: '   ' }), /body is empty/);
  await refuse(draft({ name: 'bad name!' }), /name/);
  await refuse(draft({ name: 'tim' }), /An agent named "tim" already exists/);
  assert.deepEqual(fs.readdirSync(parts.config.agentsDir).sort(), ['mimi', 'tim']);

  // Rename: the old file goes, and peers keep their contact under the new name.
  const renamed = await client.ask({ type: 'agent-save', renameFrom: 'mimi', agent: draft({ name: 'secretary', models }) }, 'agents');
  assert.deepEqual(renamed.agents.map((agent) => agent.name), ['secretary', 'tim']);
  assert.equal(fs.existsSync(agentFile('mimi')), false);
  assert.deepEqual(renamed.agents.find((agent) => agent.name === 'tim')!.canMessage, ['secretary']);

  // Delete: gone from disk and from the others' contact lists.
  const deleted = await client.ask({ type: 'agent-delete', name: 'secretary' }, 'agents');
  assert.deepEqual(deleted.agents.map((agent) => [agent.name, agent.canMessage]), [['tim', []]]);
  assert.equal(deleted.defaultAgent, 'tim');
  assert.equal(fs.existsSync(agentFile('secretary')), false);

  client.close();
  await server.close();
  fs.rmSync(parts.root, { recursive: true, force: true });
});

test('nothing is shipped: the repository has no agents and no persona file', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../../..');
  const agentsDir = path.join(repoRoot, 'user', 'agents');
  const shipped = fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir, { withFileTypes: true }).map((entry) => entry.name).filter((name) => ['mimi', 'tim', 'karlen'].includes(name))
    : [];
  assert.deepEqual(shipped, [], 'the three agents that used to be seeded are gone');
  assert.equal(fs.existsSync(path.join(repoRoot, 'user', 'persona.md')), false);
});
