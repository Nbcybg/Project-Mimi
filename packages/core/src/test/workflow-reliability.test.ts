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
import { IdempotencyStore, webhookEventId } from '../workflows/idempotency.ts';
import { RunCancelledError, RunQueue } from '../workflows/run-queue.ts';
import { runWorkflow, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { makeTestCore } from './core-helpers.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function workflow(nodes: WorkflowView['nodes'], trigger: WorkflowView['trigger'] = { pool: 'manual', config: {} }): WorkflowView {
  return {
    name: 'reliable',
    agent: 'mimi',
    title: 'Reliable',
    description: '',
    enabled: true,
    trigger,
    webhook: null,
    nodes,
  };
}

function deps(overrides: Partial<WorkflowRunnerDeps> = {}): WorkflowRunnerDeps {
  return {
    runAgent: async () => 'ok',
    tool: () => undefined,
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(os.tmpdir(), `mimi-reliability-${process.pid}-${Math.random().toString(36).slice(2)}.json`)),
    allowedDirs: [],
    ...overrides,
  };
}

function hangingFetch(): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const fail = () => reject(new Error('aborted'));
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    })) as typeof fetch;
}

test('run queue: FIFO per workflow while another workflow starts', async () => {
  const queue = new RunQueue({ globalConcurrency: 4, perAgent: 4, perWorkflow: 1 });
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue({
    agent: 'mimi',
    workflow: 'flow',
    task: async () => {
      events.push('start:first');
      await gate;
      events.push('end:first');
    },
  });
  const second = queue.enqueue({
    agent: 'mimi',
    workflow: 'flow',
    task: async () => {
      events.push('start:second');
    },
  });
  const other = queue.enqueue({
    agent: 'tim',
    workflow: 'other',
    task: async () => {
      events.push('start:other');
    },
  });
  await tick();
  assert.deepEqual(events, ['start:first', 'start:other']);
  release();
  await Promise.all([first.promise, second.promise, other.promise]);
  assert.deepEqual(events, ['start:first', 'start:other', 'end:first', 'start:second']);
});

test('run queue: the global limit caps runs across agents', async () => {
  const queue = new RunQueue({ globalConcurrency: 1, perAgent: 5, perWorkflow: 5 });
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.enqueue({
    agent: 'mimi',
    workflow: 'one',
    task: async () => {
      events.push('start:one');
      await gate;
    },
  });
  const second = queue.enqueue({
    agent: 'tim',
    workflow: 'two',
    task: async () => {
      events.push('start:two');
    },
  });
  await tick();
  assert.deepEqual(events, ['start:one']);
  release();
  await Promise.all([first.promise, second.promise]);
  assert.deepEqual(events, ['start:one', 'start:two']);
});

test('run queue: a queued run cancels without starting and a running run is aborted', async () => {
  const queue = new RunQueue({ globalConcurrency: 1, perAgent: 4, perWorkflow: 4 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = queue.enqueue({
    agent: 'mimi',
    workflow: 'flow',
    task: (signal) =>
      new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        void gate.then(resolve);
      }),
  });
  await tick();
  const queued = queue.enqueue({
    agent: 'mimi',
    workflow: 'flow',
    task: async () => {
      assert.fail('a cancelled run must not start');
    },
  });
  assert.equal(queued.cancel(), true);
  await assert.rejects(queued.promise, RunCancelledError);

  assert.equal(running.cancel(), true);
  await assert.rejects(running.promise, RunCancelledError);
  release();
  await tick();
  assert.equal(queue.activeCount, 0);
  assert.equal(queue.pendingCount, 0);
});

test('runner: a node timeout fails the node gracefully', async () => {
  const started = Date.now();
  const run = await runWorkflow(
    workflow([{ id: 'n1', type: 'http', title: 'slow', config: { url: 'https://example.com/slow', method: 'GET' }, links: { main: [] } }]),
    [{ json: {} }],
    deps({ fetchFn: hangingFetch() }),
    undefined,
    'manual',
    0,
    { nodeTimeoutMs: 25 },
  );
  assert.equal(run.ok, false);
  assert.match(run.nodes[0]!.error!, /node "slow" timed out after 25ms/);
  assert.ok(Date.now() - started < 2000);
});

test('runner: a run timeout stops the whole run', async () => {
  const started = Date.now();
  const run = await runWorkflow(
    workflow([
      {
        id: 'n1',
        type: 'http',
        title: 'slow',
        config: { url: 'https://example.com/slow', method: 'GET' },
        links: { main: [] },
      },
    ]),
    [{ json: {} }],
    deps({ fetchFn: hangingFetch() }),
    undefined,
    'manual',
    0,
    { runTimeoutMs: 25 },
  );
  assert.equal(run.ok, false);
  assert.match(run.result, /workflow run timed out after 25ms/);
  assert.ok(Date.now() - started < 2000);
});

test('runner: the node-execution cap fails a runaway workflow explicitly', async () => {
  const nodes: WorkflowView['nodes'] = Array.from({ length: 1001 }, (_, index) => ({
    id: `n${index}`,
    type: 'set',
    title: `Step ${index}`,
    config: { fields: { step: index } },
    links: { main: index === 1000 ? [] : [`n${index + 1}`] },
  }));
  const run = await runWorkflow(workflow(nodes), [{ json: {} }], deps());
  assert.equal(run.ok, false);
  assert.equal(run.nodes.length, 1000);
  assert.match(run.result, /workflow stopped after 1000 node executions \(possible loop\)/);
});

test('idempotency: claims expire and the store stays bounded', () => {
  let now = 1000;
  const store = new IdempotencyStore({ ttlMs: 100, maxEntries: 2, now: () => now });
  assert.equal(store.claim('a'), true);
  assert.equal(store.claim('a'), false);
  now += 101;
  assert.equal(store.claim('a'), true);
  assert.equal(store.claim('b'), true);
  assert.equal(store.claim('c'), true);
  assert.equal(store.size, 2);
  assert.equal(store.has('a'), false);
  assert.equal(store.has('c'), true);
  assert.equal(store.release('c'), true);
  assert.equal(store.claim('c'), true);
});

test('idempotency: keys survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-idempotency-'));
  try {
    const file = path.join(dir, 'keys.json');
    const first = new IdempotencyStore({ file });
    assert.equal(first.claim('evt-1'), true);
    const second = new IdempotencyStore({ file });
    assert.equal(second.claim('evt-1'), false);
    assert.equal(second.claim('evt-2'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idempotency: a webhook event id comes from known headers or body fields', () => {
  assert.equal(webhookEventId({ 'X-GitHub-Delivery': 'delivery-1' }), 'delivery-1');
  assert.equal(webhookEventId({ 'Idempotency-Key': ['key-1', 'key-2'] }), 'key-1');
  assert.equal(webhookEventId({}, '{"event_id":"evt-1"}'), 'evt-1');
  assert.equal(webhookEventId({}, '{"id":"not-an-event-id"}'), undefined);
});

test('core: a duplicate webhook event does not run the workflow twice', async () => {
  const target = await makeTestCore({});
  try {
    target.core.workflows.save({
      name: 'hooked',
      agent: 'mimi',
      title: 'Hooked',
      description: '',
      enabled: true,
      trigger: { pool: 'webhook', config: {} },
      webhook: null,
      nodes: [{ id: 'n1', type: 'set', title: 'note', config: { fields: { seen: true } }, links: { main: [] } }],
    });
    const first = await target.core.runWorkflow('mimi', 'hooked', { a: 1 }, { eventId: 'evt-1' });
    const second = await target.core.runWorkflow('mimi', 'hooked', { a: 1 }, { eventId: 'evt-1' });
    assert.equal(first.ok, true, first.result);
    assert.equal(second.ok, true);
    assert.match(second.result, /duplicate webhook/);
    assert.equal(target.core.workflowRuns.list('mimi/hooked').length, 1);
    const third = await target.core.runWorkflow('mimi', 'hooked', { a: 1 }, { eventId: 'evt-2' });
    assert.equal(third.ok, true);
    assert.equal(target.core.workflowRuns.list('mimi/hooked').length, 2);
  } finally {
    await target.cleanup();
  }
});

test('connector node: retried writes carry one stable idempotency key', async () => {
  const keys: Array<string | null> = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get('idempotency-key'));
    if (keys.length === 1) return Response.json({ ok: false, error: 'rate_limited' });
    return Response.json({ ok: true, message: { text: 'sent once' } });
  }) as typeof fetch;
  const auth: ConnectorAuthResolver = { resolve: () => ({ botToken: 'xoxb-reliability-token' }) };
  const runtime = new ConnectorRuntimeImpl({ registry: new ConnectorRegistry([slackConnector]), auth, fetchFn });
  const run = await runWorkflow(
    workflow([
      {
        id: 'n1',
        type: 'connector',
        title: 'send',
        config: { connector: 'slack', operation: 'send_message', allow: true, input: { channel: 'C1', text: 'hi' } },
        retries: 1,
        links: { main: [] },
      },
    ]),
    [{ json: {} }],
    deps({ connector: runtime }),
  );
  assert.equal(run.ok, true, run.result);
  assert.equal(keys.length, 2);
  assert.match(keys[0]!, /^mimi-/);
  assert.equal(keys[1], keys[0]);
});
