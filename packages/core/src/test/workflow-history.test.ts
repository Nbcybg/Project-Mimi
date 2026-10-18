import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkflowRunResult } from '@mimi/shared';
import { openDb } from '../db/db.ts';
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
