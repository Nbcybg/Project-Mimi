import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { ConnectorSpec, WorkflowView } from '@mimi/shared';
import { z } from 'zod';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { connectorSpecs } from '../connectors/services/index.ts';
import { defineTool } from '../tools/registry.ts';
import { RunQueue } from '../workflows/run-queue.ts';
import { runWorkflow, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { fakeFetch } from './helpers/fake-fetch.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-perf-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function deps(extra: Partial<WorkflowRunnerDeps> = {}): WorkflowRunnerDeps {
  return {
    runAgent: async () => 'agent answer',
    tool: () => undefined,
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(root, `state-${Math.random().toString(36).slice(2)}.json`)),
    allowedDirs: [root],
    timezone: 'Asia/Bangkok',
    ...extra,
  };
}

function report(name: string, ms: number, extra = ''): void {
  console.log(`[perf] ${name}: ${ms.toFixed(1)}ms${extra}`);
}

function workflowOf(nodes: WorkflowView['nodes']): WorkflowView {
  return {
    name: 'perf',
    agent: 'mimi',
    title: 'Perf',
    description: '',
    enabled: true,
    trigger: { pool: 'manual', config: {} },
    webhook: null,
    nodes,
  };
}

test('performance: 50 connectors register and list under one second', () => {
  const started = performance.now();
  const registry = new ConnectorRegistry(connectorSpecs);
  const specs = registry.list();
  const routes = registry.operations();
  const tools = registry.toolNames();
  const ms = performance.now() - started;

  assert.equal(specs.length, 50);
  assert.ok(routes.length >= 214);
  assert.ok(tools.length >= 214);
  assert.ok(ms < 1000, `registration took ${ms.toFixed(1)}ms`);
  report('50 connectors register/list', ms, ` (${routes.length} operations)`);
});

test('performance: 100-node workflow handles 1,000 items', async () => {
  const nodes: WorkflowView['nodes'] = Array.from({ length: 100 }, (_, index) => ({
    id: `n${index}`,
    type: 'set',
    title: `Step ${index}`,
    config: { fields: { [`step${index}`]: index } },
    links: { main: index === 99 ? [] : [`n${index + 1}`] },
  }));
  const items = Array.from({ length: 1000 }, (_, index) => ({ json: { i: index } }));
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const run = await runWorkflow(workflowOf(nodes), items, deps());
  const ms = performance.now() - started;
  const heapMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

  assert.equal(run.ok, true, run.result);
  assert.equal(run.nodes.length, 100);
  assert.equal(run.nodes.at(-1)!.id, 'n99');
  assert.equal(run.nodes.at(-1)!.output.length, 1000);
  assert.ok(ms < 5000, `100-node graph took ${ms.toFixed(1)}ms`);
  assert.ok(heapMb < 512, `heap grew by ${heapMb.toFixed(1)}MB`);
  report('100-node graph x 1,000 items', ms, ` (${heapMb.toFixed(1)}MB heap delta)`);
});

test('performance: pagination walks 20 pages and 1,000 items', async () => {
  const spec: ConnectorSpec = {
    key: 'perf_api',
    label: 'Perf API',
    category: 'test',
    description: 'performance only',
    baseUrl: 'https://api.example.test/v1',
    auth: { kind: 'apiKey', fields: [{ key: 'token', label: 'Token', type: 'secret' }] },
    operations: [{ key: 'list', label: 'List', method: 'GET', path: '/items', risk: 'read', fields: [], paginated: true }],
    pagination: { mode: 'page', pageParam: 'page', itemsPath: 'data', maxPages: 20, maxItems: 1000 },
  };
  const api = fakeFetch((call) => {
    const page = Number(new URL(call.url).searchParams.get('page') ?? 1);
    return Response.json({ data: Array.from({ length: 50 }, (_, index) => ({ id: (page - 1) * 50 + index })) });
  });
  const client = new ConnectorRuntimeImpl({
    registry: new ConnectorRegistry([spec]),
    auth: { resolve: () => ({ token: 'perf-token' }) },
    fetchFn: api.fetchFn,
  });
  const started = performance.now();
  const result = await client.execute({ connector: 'perf_api', operation: 'list', input: {} });
  const ms = performance.now() - started;

  assert.equal(api.calls.length, 20);
  assert.equal(result.items.length, 1000);
  assert.ok(ms < 3000, `pagination took ${ms.toFixed(1)}ms`);
  report('20 pages / 1,000 items', ms);
});

test('performance: 100 queued runs respect global concurrency', async () => {
  const queue = new RunQueue({ globalConcurrency: 8, perAgent: 100, perWorkflow: 100 });
  let active = 0;
  let peak = 0;
  const started = performance.now();
  const runs = Array.from({ length: 100 }, (_, index) =>
    queue.enqueue({
      agent: `agent-${index % 2}`,
      workflow: `workflow-${index}`,
      task: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return index;
      },
    }),
  );
  const values = await Promise.all(runs.map((run) => run.promise));
  const ms = performance.now() - started;

  assert.deepEqual(values, Array.from({ length: 100 }, (_, index) => index));
  assert.ok(peak <= 8, `peak concurrency was ${peak}`);
  assert.ok(ms < 5000, `queue took ${ms.toFixed(1)}ms`);
  report('100 queued runs', ms, ` (peak ${peak})`);
});

test('stress: rate limit waits and node timeout stays bounded', async () => {
  const spec: ConnectorSpec = {
    key: 'rate_api',
    label: 'Rate API',
    category: 'test',
    description: 'rate limit only',
    baseUrl: 'https://api.example.test/v1',
    auth: { kind: 'apiKey', fields: [{ key: 'token', label: 'Token', type: 'secret' }] },
    operations: [{ key: 'list', label: 'List', method: 'GET', path: '/items', risk: 'read', fields: [] }],
    rateLimit: { requests: 10, perMs: 1000, burst: 10 },
  };
  const api = fakeFetch(() => Response.json([]));
  let clock = 0;
  const sleeps: number[] = [];
  const client = new ConnectorRuntimeImpl({
    registry: new ConnectorRegistry([spec]),
    auth: { resolve: () => ({ token: 'rate-token' }) },
    fetchFn: api.fetchFn,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  for (let index = 0; index < 30; index++) {
    await client.execute({ connector: 'rate_api', operation: 'list', input: {} });
  }
  assert.equal(api.calls.length, 30);
  assert.deepEqual(sleeps, Array.from({ length: 20 }, () => 100));

  const slow = defineTool({
    name: 'slow',
    description: 'Never finishes in time.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'slow',
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return 'late';
    },
  });
  const runStarted = performance.now();
  const run = await runWorkflow(
    workflowOf([{ id: 'n1', type: 'tool', title: 'Slow', config: { tool: 'slow', input: {} }, links: { main: [] } }]),
    [{ json: {} }],
    deps({ tool: (name) => (name === 'slow' ? slow : undefined), nodeTimeoutMs: 10 }),
  );
  const runMs = performance.now() - runStarted;

  assert.equal(run.ok, false);
  assert.match(run.result ?? '', /timed out after 10ms/);
  assert.ok(runMs < 1000, `timeout took ${runMs.toFixed(1)}ms`);
  report('rate-limit 30 requests + 10ms timeout', runMs, ` (sleeps ${sleeps.join(',')}ms)`);
});
