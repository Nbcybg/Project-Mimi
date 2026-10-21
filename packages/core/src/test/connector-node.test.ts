import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { WorkflowView } from '@mimi/shared';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { slackConnector } from '../connectors/services/slack.ts';
import type { ConnectorAuthResolver } from '../connectors/types.ts';
import { type WorkflowRunnerDeps, runWorkflow, WorkflowState } from '../workflows/runner.ts';
import { WorkflowStore } from '../workflows/workflow-store.ts';
import { makeTestCore } from './core-helpers.ts';

const TOKEN = 'xoxb-node-test-token';

function flow(nodes: WorkflowView['nodes']): WorkflowView & { webhookKey: string } {
  return {
    name: 'slack-flow',
    agent: 'mimi',
    title: 'Slack flow',
    description: '',
    enabled: true,
    trigger: { pool: 'manual', config: {} },
    webhook: null,
    webhookKey: 'x',
    nodes,
  };
}

function runtimeWith(fetchFn: typeof fetch): ConnectorRuntimeImpl {
  const auth: ConnectorAuthResolver = { resolve: () => ({ botToken: TOKEN }) };
  return new ConnectorRuntimeImpl({ registry: new ConnectorRegistry([slackConnector]), auth, fetchFn });
}

function deps(runtime: ConnectorRuntimeImpl, calls: string[], permissions?: Record<string, 'allow' | 'ask' | 'deny'>): WorkflowRunnerDeps {
  return {
    runAgent: async () => '',
    tool: () => undefined,
    connector: runtime,
    speak: (_agent, text) => calls.push(text),
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(os.tmpdir(), `mimi-connector-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`)),
    allowedDirs: [],
    ...(permissions ? { permissions } : {}),
  };
}

test('connector node: resolves expressions, calls Slack and passes items on', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ ok: true, message: { type: 'message', text: `sent: ${String(bodies.at(-1)!.text)}`, ts: '1712345678.000001' } });
  }) as typeof fetch;

  const calls: string[] = [];
  const run = await runWorkflow(
    flow([
      {
        id: 'n1',
        type: 'connector',
        title: 'ส่ง',
        config: {
          connector: 'slack',
          operation: 'send_message',
          allow: true,
          input: { channel: 'C0123456', text: '{{ $json.text }}' },
        },
        links: { main: ['n2'] },
      },
      { id: 'n2', type: 'chat', title: 'แจ้ง', config: { text: '{{ $json.text }}' }, links: { main: [] } },
    ]),
    [{ json: { text: 'hello from workflow' } }],
    deps(runtimeWith(fetchFn), calls),
  );

  assert.equal(run.ok, true, run.result);
  assert.deepEqual(bodies, [{ channel: 'C0123456', text: 'hello from workflow', unfurl_links: false }]);
  assert.deepEqual(calls, ['sent: hello from workflow']);
  assert.deepEqual(run.nodes[0]!.output[0]!.json, {
    type: 'message',
    text: 'sent: hello from workflow',
    ts: '1712345678.000001',
  });
});

test('connector node: write operations need consent, reads do not', async () => {
  let requests = 0;
  const fetchFn = (async () => {
    requests++;
    return Response.json({ ok: true, channels: [{ id: 'C1', name: 'general' }] });
  }) as typeof fetch;
  const runtime = runtimeWith(fetchFn);

  const read = await runWorkflow(
    flow([{ id: 'n1', type: 'connector', config: { connector: 'slack', operation: 'list_channels', input: {} }, links: { main: [] } }]),
    [{ json: {} }],
    deps(runtime, []),
  );
  assert.equal(read.ok, true, read.result);
  assert.equal(requests, 1);
  assert.equal(read.nodes[0]!.output[0]!.json.name, 'general');

  const write = await runWorkflow(
    flow([
      { id: 'n1', type: 'connector', config: { connector: 'slack', operation: 'send_message', input: { channel: 'C1', text: 'hi' } }, links: { main: [] } },
    ]),
    [{ json: {} }],
    deps(runtime, []),
  );
  assert.equal(write.ok, false);
  assert.match(write.nodes[0]!.error!, /อนุญาต/);
  assert.equal(requests, 1, 'nothing was sent without consent');

  const allowed = await runWorkflow(
    flow([
      { id: 'n1', type: 'connector', config: { connector: 'slack', operation: 'send_message', input: { channel: 'C1', text: 'hi' } }, links: { main: [] } },
    ]),
    [{ json: {} }],
    deps(runtime, [], { slack_send_message: 'allow' }),
  );
  assert.equal(allowed.ok, true, allowed.result);

  const denied = await runWorkflow(
    flow([
      {
        id: 'n1',
        type: 'connector',
        config: { connector: 'slack', operation: 'send_message', allow: true, input: { channel: 'C1', text: 'hi' } },
        links: { main: [] },
      },
    ]),
    [{ json: {} }],
    deps(runtime, [], { slack_send_message: 'deny' }),
  );
  assert.equal(denied.ok, false);
  assert.match(denied.nodes[0]!.error!, /denied/);
});

test('connector node: API errors follow onError and retries', async () => {
  let attempts = 0;
  const fetchFn = (async () => {
    attempts++;
    if (attempts === 1) return Response.json({ ok: false, error: 'channel_not_found' });
    return Response.json({ ok: true, message: { text: 'second try' } });
  }) as typeof fetch;

  const retried = await runWorkflow(
    flow([
      {
        id: 'n1',
        type: 'connector',
        config: { connector: 'slack', operation: 'send_message', allow: true, input: { channel: 'C1', text: 'hi' } },
        retries: 1,
        links: { main: ['n2'] },
      },
      { id: 'n2', type: 'chat', config: { text: 'ได้ {{ $json.text }}' }, links: { main: [] } },
    ]),
    [{ json: {} }],
    deps(runtimeWith(fetchFn), []),
  );
  assert.equal(retried.ok, true, retried.result);
  assert.equal(attempts, 2);
  assert.equal(retried.nodes[0]!.output[0]!.json.text, 'second try');

  const failing = (async () => Response.json({ ok: false, error: 'channel_not_found' })) as typeof fetch;
  const calls: string[] = [];
  const continued = await runWorkflow(
    flow([
      {
        id: 'n1',
        type: 'connector',
        config: { connector: 'slack', operation: 'send_message', allow: true, input: { channel: 'C1', text: 'hi' } },
        onError: 'continue',
        links: { main: ['n2'] },
      },
      { id: 'n2', type: 'chat', config: { text: 'ต่อ {{ $json.n }}' }, links: { main: [] } },
    ]),
    [{ json: { n: 7 } }],
    deps(runtimeWith(failing), calls),
  );
  assert.equal(continued.ok, true, continued.result);
  assert.equal(continued.nodes[0]!.status, 'error');
  assert.match(continued.nodes[0]!.error!, /channel_not_found/);
  assert.deepEqual(calls, ['ต่อ 7']);
});

test('workflow store accepts a connector node and keeps its config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-connector-store-'));
  try {
    const store = new WorkflowStore(dir);
    const saved = store.save(
      flow([
        { id: 'n1', type: 'connector', title: 'Slack', config: { connector: 'slack', operation: 'list_channels', input: {} }, links: { main: [] } },
      ]),
    );
    const loaded = store.get('mimi', saved.name)!;
    assert.equal(loaded.nodes[0]!.type, 'connector');
    assert.deepEqual(loaded.nodes[0]!.config, { connector: 'slack', operation: 'list_channels', input: {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('core: Slack operations reach the tool pool with Quick Work metadata', async () => {
  const target = await makeTestCore({});
  try {
    const views = target.core.tools.views().filter((tool) => tool.connector === 'slack');
    assert.deepEqual(views.map((tool) => tool.operation).sort(), [
      'add_reaction',
      'list_channels',
      'list_messages',
      'list_users',
      'send_message',
      'update_message',
    ]);
    assert.ok(views.every((tool) => tool.familyLabel === 'Slack'));
    const connectors = target.core.connectors.list().map((connector) => connector.key);
    assert.equal(connectors.length, 10);
    assert.ok(connectors.includes('slack'));
    assert.ok(target.core.tools.names().includes('slack_send_message'));
  } finally {
    await target.cleanup();
  }
});
