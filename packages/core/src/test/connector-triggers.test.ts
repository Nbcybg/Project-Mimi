import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ConnectorRequest, ConnectorSpec, TriggerPoolView, WorkflowView } from '@mimi/shared';
import {
  connectorTriggerId,
  pollConnectorTrigger,
  verifyConnectorWebhook,
} from '../workflows/connector-triggers.ts';
import {
  connectorTriggerPoolName,
  connectorTriggerViews,
  findConnectorTrigger,
} from '../connectors/trigger-adapter.ts';
import { TriggerPool } from '../workflows/trigger-pool.ts';
import { triggerItems, type WorkflowRunnerDeps } from '../workflows/runner.ts';

const spec: ConnectorSpec = {
  key: 'test_api',
  label: 'Test API',
  category: 'test',
  description: 'test-only connector',
  baseUrl: 'https://api.example.test',
  auth: { kind: 'apiKey', fields: [{ key: 'token', label: 'Token', type: 'secret' }] },
  operations: [
    {
      key: 'list_items',
      label: 'List items',
      method: 'GET',
      path: '/items',
      risk: 'read',
      fields: [
        { key: 'cursor', label: 'Cursor', type: 'string', required: false },
        { key: 'limit', label: 'Limit', type: 'number', required: false },
      ],
    },
  ],
  triggers: [
    {
      key: 'new_items',
      label: 'New items',
      kind: 'poll',
      operation: 'list_items',
      input: { limit: 10 },
      idField: 'id',
      cursor: { responsePath: 'meta.next', param: 'cursor' },
      sample: { id: 'item_1', name: 'Example' },
    },
    {
      key: 'events',
      label: 'Events',
      kind: 'webhook',
      fields: [{ key: 'signingSecretName', label: 'Secret name', type: 'string', required: true }],
      signature: {
        header: 'x-test-signature',
        algorithm: 'sha256',
        prefix: 'sha256=',
        signedPayload: '{{timestamp}}:{{body}}',
        timestampHeader: 'x-test-timestamp',
        secretField: 'signingSecretName',
        toleranceSeconds: 300,
      },
      sample: { event: 'created' },
    },
  ],
};

test('adapter: connector triggers become namespaced pool entries', () => {
  assert.equal(connectorTriggerPoolName('test_api', 'new_items'), 'connector:test_api:new_items');
  const found = findConnectorTrigger([spec], 'connector:test_api:events');
  assert.equal(found?.trigger.key, 'events');
  assert.equal(findConnectorTrigger([spec], 'connector:test_api:missing'), undefined);

  const views = connectorTriggerViews([spec]);
  assert.equal(views.length, 2);
  const poll = views.find((entry) => entry.name === 'connector:test_api:new_items')!;
  assert.equal(poll.kind, 'poll');
  assert.equal(poll.builtin, true);
  assert.ok(poll.fields.some((field) => field.key === 'everyMinutes'));
  assert.deepEqual(poll.sample, { id: 'item_1', name: 'Example' });
});

test('pool: connector triggers are listed and resolved without touching disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-trigger-pool-'));
  try {
    const pool = new TriggerPool(dir, () => [spec]);
    const listed = pool.list();
    assert.ok(listed.some((entry) => entry.name === 'connector:test_api:events'));
    assert.equal(pool.get('connector:test_api:events')?.kind, 'webhook');
    assert.equal(pool.get('connector:test_api:missing'), undefined);
    assert.throws(() => pool.save({ ...connectorTriggerViews([spec])[0]!, name: 'connector:x:y' }), /reserved/);
    assert.equal(pool.remove('connector:test_api:events'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('poll: merges input, sends the cursor and returns the next cursor', async () => {
  const calls: ConnectorRequest[] = [];
  const result = await pollConnectorTrigger(
    {
      execute: async (request) => {
        calls.push(request);
        return { items: [{ json: { id: 'item_2' } }], raw: { meta: { next: 'cursor-2' } } };
      },
    },
    spec,
    spec.triggers![0]!,
    { input: { limit: 25 }, account: 'acct_1' },
    'cursor-1',
  );

  assert.deepEqual(calls[0]!.input, { limit: 25, cursor: 'cursor-1' });
  assert.equal(calls[0]!.account, 'acct_1');
  assert.equal(result.cursor, 'cursor-2');
  assert.equal(result.items[0]!.json.id, 'item_2');
});

test('poll: ids fall back to the whole item when idField is missing', () => {
  const trigger = spec.triggers![0]!;
  assert.equal(connectorTriggerId(trigger, { json: { id: 'abc' } }), 'abc');
  assert.match(connectorTriggerId(trigger, { json: { name: 'no id' } }), /no id/);
});

test('webhook: verifies an HMAC signature and rejects stale or wrong ones', () => {
  const secretName = 'test_webhook_secret';
  const secret = 'super-secret-value';
  const body = '{"event":"created"}';
  const timestamp = '1700000000';
  const signature = createHmac('sha256', secret).update(`${timestamp}:${body}`).digest('hex');
  const headers = {
    'x-test-signature': `sha256=${signature}`,
    'x-test-timestamp': timestamp,
  };
  const config = { signingSecretName: secretName };
  const lookup = (name: string) => (name === secretName ? secret : undefined);
  const now = Number(timestamp) * 1000;

  assert.deepEqual(verifyConnectorWebhook(spec.triggers![1]!, config, headers, body, lookup, now), { ok: true });
  assert.equal(verifyConnectorWebhook(spec.triggers![1]!, config, { ...headers, 'x-test-signature': 'sha256=no' }, body, lookup, now).ok, false);
  assert.equal(verifyConnectorWebhook(spec.triggers![1]!, config, headers, body, lookup, now + 301_000).ok, false);
  assert.match(verifyConnectorWebhook(spec.triggers![1]!, {}, headers, body, lookup, now).error!, /missing secret name/);
});

test('runner: connector webhook uses its sample and connector poll calls the runtime', async () => {
  const workflow: WorkflowView = {
    name: 'test',
    agent: 'mimi',
    title: 'Test',
    description: '',
    enabled: true,
    trigger: { pool: 'connector:test_api:new_items', config: {} },
    webhook: null,
    nodes: [],
  };
  const pool = new TriggerPool(path.join(os.tmpdir(), 'mimi-trigger-pool-unused'), () => [spec]);
  const deps = {
    connector: {
      get: (key: string) => (key === 'test_api' ? spec : undefined),
      execute: async () => ({ items: [{ json: { id: 'item_9' } }], raw: { meta: { next: 'n2' } } }),
    },
  } as unknown as WorkflowRunnerDeps;

  const polled = await triggerItems(workflow, pool, deps);
  assert.equal(polled[0]!.json.id, 'item_9');

  const webhookWorkflow = {
    ...workflow,
    trigger: { pool: 'connector:test_api:events', config: {} },
  };
  const sample = await triggerItems(webhookWorkflow, pool, deps);
  assert.deepEqual(sample[0]!.json, spec.triggers![1]!.sample);
});

test('view contract: connector trigger fields are node fields', () => {
  const view: TriggerPoolView = connectorTriggerViews([spec])[1]!;
  assert.deepEqual(view.fields.map((field) => field.type), ['string']);
});
