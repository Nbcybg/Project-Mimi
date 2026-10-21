import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ClientMessage, ServerMessage, ToolContext, ToolDefinition } from '@mimi/shared';
import { ModelCatalog } from '../providers/catalog.ts';
import { startServer } from '../server/server.ts';
import { ensureOverseer, OVERSEER_NAME } from '../overseer/overseer.ts';
import { makeTestCore, testCoreParts } from './core-helpers.ts';

const context: ToolContext = { traceId: 'overseer-test', thread: 'main', agent: OVERSEER_NAME, allowedDirs: [] };

test('overseer: created on first use, then authors agents, tools, presets and skills', async () => {
  const testCore = await makeTestCore();
  try {
    const { core, config } = testCore;
    const file = path.join(config.agentsDir, OVERSEER_NAME, 'agent.md');
    assert.equal(fs.existsSync(file), false, 'the Overseer is not seeded at startup');

    const overseer = ensureOverseer(config.agentsDir);
    assert.equal(overseer.name, OVERSEER_NAME);
    assert.ok(fs.existsSync(file));
    assert.equal(ensureOverseer(config.agentsDir).name, OVERSEER_NAME);

    const tools = core.deps.extraTools?.(overseer, { agent: overseer }) ?? [];
    const tool = (name: string): ToolDefinition<any> => {
      const found = tools.find((entry) => entry.name === name);
      assert.ok(found, `tool ${name} is available to the Overseer`);
      return found;
    };
    const run = (name: string, input: unknown) => tool(name).execute(input, context);

    const state = await run('overseer_state', {});
    assert.match(state, /"name": "mimi"/);
    assert.match(state, /"nodeTypes"/);
    assert.match(state, /Google Drive is read-only/);

    await run('agent_save', { name: 'mimi', addTools: ['read_document'], addSkills: ['night-quiz'] });
    let mimi = core.agents.get('mimi');
    assert.ok(mimi.tools.includes('read_document'));
    assert.ok(mimi.skills.includes('night-quiz'));

    await run('tool_save', {
      tool: {
        name: 'vat7',
        description: 'Add 7% VAT to an amount',
        kind: 'code',
        params: [{ key: 'amount', type: 'number', description: 'Amount before VAT' }],
        settings: [],
        config: { code: 'return { total: Number(input.amount) * 1.07 };' },
      },
    });
    assert.equal(core.tools.get('vat7')?.risk, 'shell');

    await run('preset_save', { preset: { name: 'vat7-main', tool: 'vat7', settings: {} } });
    assert.ok(core.tools.presetViews().some((preset) => preset.name === 'vat7-main'));

    // A code tool is shell-risk; an agent with untrusted readers (read_document) cannot take it.
    await run('agent_save', { name: 'tim', addTools: ['vat7-main'] });
    assert.ok(core.agents.get('tim').tools.includes('vat7-main'));

    await run('skill_save', {
      skill: {
        name: 'tax-helper',
        description: 'Explain Thai VAT and add 7%',
        body: 'Read the amount, add 7% VAT and show both the base and the total.',
      },
    });
    assert.ok(core.skills().some((skill) => skill.name === 'tax-helper'));

    await run('agent_save', { name: 'mimi', addSkills: ['tax-helper'] });
    assert.ok(core.agents.get('mimi').skills.includes('tax-helper'));

    // Deleting a tool removes its preset from the agents that listed it.
    await run('tool_delete', { name: 'vat7' });
    assert.equal(core.tools.get('vat7'), undefined);
    assert.ok(!core.agents.get('tim').tools.includes('vat7-main'));

    // The reserved id cannot be created or renamed through the authoring tool.
    await assert.rejects(() => run('agent_save', { name: OVERSEER_NAME, systemPrompt: 'nope' }), /reserved/);

    // The skill delete path also cleans up agent references.
    await run('skill_delete', { name: 'tax-helper' });
    assert.ok(!core.agents.get('mimi').skills.includes('tax-helper'));

    // Workflow tools are present and can target another agent's workflows.
    const savedFlow = String(
      await run('workflow_save', {
        agent: 'tim',
        workflow: {
          name: 'tim-daily',
          title: 'Tim daily',
          trigger: { pool: 'manual', config: {} },
          nodes: [{ id: 'mark', type: 'set', title: 'Mark', config: { fields: { ok: true } }, links: { main: [] } }],
        },
      }),
    );
    assert.match(savedFlow, /agent "tim"/);
    assert.equal(core.workflows.get('tim', 'tim-daily')?.enabled, false);
    assert.equal(core.workflows.get('overseer', 'tim-daily'), undefined);
    assert.match(String(await run('workflow_list', { agent: 'tim' })), /tim-daily/);
    await run('workflow_delete', { agent: 'tim', name: 'tim-daily' });
    assert.equal(core.workflows.get('tim', 'tim-daily'), undefined);
  } finally {
    await testCore.cleanup();
  }
});

test('overseer: a new agent gets the default chat model and can be read back', async () => {
  const testCore = await makeTestCore();
  try {
    const { core, config } = testCore;
    const overseer = ensureOverseer(config.agentsDir);
    const tools = core.deps.extraTools?.(overseer, { agent: overseer }) ?? [];
    const run = async (name: string, input: unknown) => {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool);
      return tool.execute(input, context);
    };

    await run('agent_save', {
      name: 'researcher',
      displayName: 'นักวิจัย',
      description: 'ค้นคว้าและสรุป',
      systemPrompt: 'You are a careful researcher. Reply in Thai.',
      addTools: ['read_document'],
    });
    const researcher = core.agents.get('researcher');
    assert.equal(researcher.models.model, 'test/chat');
    assert.ok(researcher.tools.includes('read_document'));

    const view = JSON.parse(await run('agent_get', { name: 'researcher' }));
    assert.equal(view.displayName, 'นักวิจัย');
    assert.match(view.systemPrompt, /careful researcher/);
  } finally {
    await testCore.cleanup();
  }
});


async function openSocket(url: string) {
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

const CATALOG = new ModelCatalog({
  lab: {
    name: 'Lab',
    npm: '@ai-sdk/openai-compatible',
    api: 'http://127.0.0.1:1/v1',
    env: [],
    models: { 'chat-cheap': { name: 'Chat Cheap' } },
  },
});

test('server: Overseer setup is lazy, saves a model and reserves the name', async () => {
  const parts = testCoreParts({ settings: { model: 'lab/chat-cheap', provider: { lab: {} } } });
  const server = await startServer(
    { ...parts.config, token: 'app-token', host: '127.0.0.1', port: 0 },
    { settings: parts.settings, catalog: CATALOG },
  );
  const client = await openSocket(`ws://127.0.0.1:${server.port}/ws`);
  const file = path.join(parts.config.agentsDir, OVERSEER_NAME, 'agent.md');
  try {
    const welcome = await client.ask(null, 'welcome');
    assert.ok(!welcome.agents.some((agent) => agent.name === OVERSEER_NAME));
    assert.equal(fs.existsSync(file), false);

    const first = await client.ask({ type: 'overseer-get' }, 'overseer');
    assert.deepEqual({ configured: first.overseer.configured, providerConnected: first.overseer.providerConnected }, { configured: false, providerConnected: false });
    assert.ok(fs.existsSync(file));

    const saved = await client.ask({ type: 'overseer-save', model: 'lab/chat-cheap' }, 'overseer');
    assert.deepEqual({ saved: saved.saved, configured: saved.overseer.configured, providerConnected: saved.overseer.providerConnected }, { saved: true, configured: true, providerConnected: true });
    assert.match(fs.readFileSync(file, 'utf8'), /model: lab\/chat-cheap/);

    const agents = await client.ask({ type: 'agents-list' }, 'agents');
    assert.ok(agents.agents.some((agent) => agent.name === OVERSEER_NAME));
    assert.equal((await client.ask({ type: 'settings-get' }, 'settings')).settings.agents, 3);

    const reserved = await client.ask({ type: 'agent-save', agent: { name: OVERSEER_NAME, description: 'x', systemPrompt: 'x', models: {}, tools: [], canMessage: [], budgets: { maxRounds: 1, maxTokens: 1 } } }, 'error');
    assert.match(reserved.message, /reserved/);
    const undeletable = await client.ask({ type: 'agent-delete', name: OVERSEER_NAME }, 'error');
    assert.match(undeletable.message, /cannot be deleted/);
  } finally {
    client.close();
    await server.close();
    await server.core.close();
    fs.rmSync(parts.root, { recursive: true, force: true });
  }
});
