import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ConnectorSpec, WorkflowRunResult, WorkflowView } from '@mimi/shared';
import { openDb } from '../db/db.ts';
import { type WorkflowRunnerDeps, WorkflowState, runWorkflow } from '../workflows/runner.ts';
import { WorkflowRunStore } from '../workflows/run-history.ts';
import { makeTestCore } from './core-helpers.ts';

function result(ok: boolean, items = 1): WorkflowRunResult {
  const list = Array.from({ length: items }, (_, n) => ({ json: { n } }));
  return {
    name: 'triage',
    ok,
    result: ok ? 'done' : 'error: boom',
    nodes: [{ id: 'n1', title: 'step', type: 'set', status: ok ? 'ok' : 'error', input: list, output: list }],
  };
}

test('run history: newest first, records keep node input/output, long lists are cut', () => {
  const store = new WorkflowRunStore(openDb(':memory:'));
  const first = store.record('mimi/triage', 'manual', new Date(Date.now() - 1500), result(true));
  const second = store.record('mimi/triage', 'schedule', new Date(), result(false, 30));
  store.record('mimi/other', 'webhook', new Date(), result(true));

  const list = store.list('mimi/triage');
  assert.deepEqual(list.map((run) => [run.id, run.mode, run.ok]), [[second, 'schedule', false], [first, 'manual', true]]);
  assert.ok(list[1]!.durationMs >= 1400);
  assert.equal(list[0]!.nodeCount, 1);

  const stored = store.get(second)!;
  assert.equal(stored.result, 'error: boom');
  // 20 items kept, then a note about the rest.
  assert.equal(stored.nodes[0]!.input.length, 21);
  assert.match(String(stored.nodes[0]!.input[20]!.json._omitted), /10 more items/);
  assert.equal(store.get(9999), undefined);

  store.forget('mimi/triage');
  assert.deepEqual(store.list('mimi/triage'), []);
  assert.equal(store.list('mimi/other').length, 1);
});

test('run history: only the last 50 runs of a workflow are kept', () => {
  const store = new WorkflowRunStore(openDb(':memory:'));
  for (let n = 0; n < 55; n++) store.record('mimi/triage', 'poll', new Date(), result(true));
  const all = store.list('mimi/triage', 100);
  assert.equal(all.length, 50);
  assert.equal(all.at(-1)!.id, 6);
});

test('run history: agent/trigger are explicit and errors/items are redacted', () => {
  const store = new WorkflowRunStore(openDb(':memory:'));
  const run: WorkflowRunResult = {
    name: 'triage',
    ok: false,
    result: 'failed Authorization: Bearer abcdefgh12345 api_key=secretvalue',
    nodes: [{
      id: 'n1',
      title: 'send',
      type: 'connector',
      status: 'error',
      error: 'connector failed: token=xoxb-1234567890-abcdef',
      trace: { connector: 'slack', operation: 'send_message', requestId: 'run-1:n1', errorCode: 'invalid_auth' },
      attempts: 2,
      input: [{ json: { token: 'xoxb-1234567890-abcdef', ok: 'keep', headers: { authorization: 'Bearer abcdefgh12345' } } }],
      output: [],
    }],
  };
  const id = store.record('mimi/triage', 'webhook', new Date(), run);
  const summary = store.list('mimi/triage')[0]!;
  assert.equal(summary.agent, 'mimi');
  assert.equal(summary.trigger, 'webhook');
  assert.equal(summary.workflow, 'mimi/triage');
  assert.doesNotMatch(summary.result, /abcdefgh|secretvalue/);

  const stored = store.get(id)!;
  const node = stored.nodes[0]!;
  assert.match(node.error ?? '', /\[redacted\]/);
  assert.doesNotMatch(node.error ?? '', /xoxb/);
  assert.equal(node.input[0]!.json.token, '[redacted]');
  assert.equal(node.input[0]!.json.ok, 'keep');
  assert.equal((node.input[0]!.json.headers as Record<string, string>).authorization, '[redacted]');
  assert.deepEqual(node.trace, run.nodes[0]!.trace);
  assert.equal(node.attempts, 2);
});

test('runner: node errors carry connector trace, error code and attempts', async () => {
  const spec = {
    key: 'demo',
    title: 'Demo',
    description: '',
    auth: { kind: 'none' },
    fields: [],
    operations: [{ key: 'send', title: 'Send', description: '', risk: 'write', fields: [] }],
  } as unknown as ConnectorSpec;
  const deps: WorkflowRunnerDeps = {
    runAgent: async () => '',
    tool: () => undefined,
    connector: {
      get: () => spec,
      execute: async () => {
        const error = new Error('provider failed code=invalid_auth token=supersecret12345') as Error & { code: string };
        error.code = 'invalid_auth';
        throw error;
      },
    },
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(os.tmpdir(), `mimi-trace-${process.pid}-${Math.random().toString(36).slice(2)}.json`)),
    allowedDirs: [],
  };
  const flow: WorkflowView = {
    name: 'obs',
    agent: 'mimi',
    title: 'Observability',
    description: '',
    enabled: true,
    trigger: { pool: 'manual', config: {} },
    webhook: null,
    nodes: [{
      id: 'n1',
      type: 'connector',
      title: 'send',
      config: { connector: 'demo', operation: 'send', allow: true },
      retries: 1,
      links: { main: [] },
    }],
  };
  const run = await runWorkflow(flow, [{ json: {} }], deps);
  const node = run.nodes[0]!;
  assert.equal(node.status, 'error');
  assert.equal(node.attempts, 2);
  assert.match(node.error ?? '', /\[redacted\]/);
  assert.doesNotMatch(node.error ?? '', /supersecret/);
  assert.equal(node.trace?.connector, 'demo');
  assert.equal(node.trace?.operation, 'send');
  assert.equal(node.trace?.errorCode, 'invalid_auth');
  assert.match(node.trace?.requestId ?? '', /:n1$/);
});

test('core: every top-level run is stored and the result carries its id', async () => {
  const target = await makeTestCore({});
  target.core.workflows.save({
    name: 'note',
    agent: 'mimi',
    title: 'Note',
    description: '',
    enabled: true,
    trigger: { pool: 'manual', config: {} },
    webhook: null,
    nodes: [{ id: 'n1', type: 'set', title: 'mark', config: { fields: { seen: true } }, links: { main: [] } }],
  });
  const run = await target.core.runWorkflow('mimi', 'note', { Subject: 'hi' });
  assert.equal(run.ok, true);
  assert.ok(run.runId);
  const stored = target.core.workflowRuns.get(run.runId!)!;
  assert.equal(stored.workflow, 'mimi/note');
  assert.equal(stored.mode, 'manual');
  assert.deepEqual(stored.nodes[0]!.output[0]!.json, { Subject: 'hi', seen: true });
  await target.cleanup();
});
