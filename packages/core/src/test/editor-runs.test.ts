import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { WorkflowView } from '@mimi/shared';
import { createCore } from '../core.ts';
import { runWorkflow, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { WorkflowStore } from '../workflows/workflow-store.ts';
import { testCoreParts } from './core-helpers.ts';
import { FakeBroker } from './helpers.ts';

const flow = (nodes: WorkflowView['nodes']): WorkflowView => ({
  name: 'w',
  agent: 'mimi',
  title: 'w',
  description: '',
  enabled: true,
  trigger: { pool: 'manual', config: {} },
  webhook: null,
  nodes,
});

function deps(): WorkflowRunnerDeps {
  return {
    runAgent: async () => '',
    tool: () => undefined,
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(os.tmpdir(), `mimi-editor-state-${process.pid}.json`)),
    allowedDirs: [],
  };
}

const NODES: WorkflowView['nodes'] = [
  { id: 'n1', type: 'set', title: 'a', config: { fields: { a: 1 } }, links: { main: ['n2'] } },
  { id: 'n2', type: 'if', title: 'check', config: { left: '{{ $json.a }}', operator: 'equals', right: '2' }, links: { true: ['n3'], false: ['n4'] } },
  { id: 'n3', type: 'set', title: 'yes', config: { fields: { went: 'yes', from: '{{ $node["a"].json.a }}' } }, links: { main: [] } },
  { id: 'n4', type: 'set', title: 'no', config: { fields: { went: 'no' } }, links: { main: [] } },
];

test('runner: a switched-off node passes its items on through its linked output', async () => {
  const nodes = structuredClone(NODES);
  nodes[1]!.disabled = true;
  const run = await runWorkflow(flow(nodes), [{ json: {} }], deps());
  assert.deepEqual(run.nodes.map((node) => [node.title, node.note ?? '']), [['a', ''], ['check', 'disabled'], ['yes', '']]);
  assert.equal(run.nodes.at(-1)!.output[0]!.json.went, 'yes');
});

test('runner: pinned output is used only when the run asks for pins', async () => {
  const nodes = structuredClone(NODES);
  nodes[0]!.pinned = [{ a: 2, pinned: true }];
  const plain = await runWorkflow(flow(nodes), [{ json: {} }], deps());
  assert.equal(plain.nodes.at(-1)!.title, 'no', 'a trigger run ignores pins');
  const pinned = await runWorkflow(flow(nodes), [{ json: {} }], deps(), undefined, 'manual', 0, { usePins: true });
  assert.equal(pinned.nodes[0]!.note, 'pinned');
  assert.equal(pinned.nodes.at(-1)!.title, 'yes');
  assert.equal(pinned.nodes.at(-1)!.output[0]!.json.from, 2);
});

test('runner: starting at a node runs it and what follows, with earlier outputs kept for $node', async () => {
  const run = await runWorkflow(flow(structuredClone(NODES)), [], deps(), undefined, 'manual', 0, {
    startAt: { nodeId: 'n2', input: [{ json: { a: 2 } }], outputs: { a: { json: { a: 7 }, items: [{ a: 7 }] } } },
  });
  assert.deepEqual(run.nodes.map((node) => node.title), ['check', 'yes']);
  assert.equal(run.nodes[1]!.output[0]!.json.from, 7);
});

test('store: notes, switched-off nodes and pins are kept; bad notes are refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-editor-'));
  try {
    const store = new WorkflowStore(dir);
    const nodes = structuredClone(NODES);
    nodes[2]!.disabled = true;
    nodes[0]!.pinned = [{ a: 1 }];
    store.save({ ...flow(nodes), notes: [{ id: 'note1', text: 'อธิบาย', position: [10, 20], color: 'yellow' }] });
    const saved = store.get('mimi', 'w')!;
    assert.equal(saved.notes![0]!.text, 'อธิบาย');
    assert.equal(saved.nodes[2]!.disabled, true);
    assert.deepEqual(saved.nodes[0]!.pinned, [{ a: 1 }]);
    assert.throws(() => store.save({ ...flow(nodes), notes: [{ id: 'BAD ID', text: '', position: [0, 0] }] }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('core: run again from a node of a stored run', async () => {
  const parts = testCoreParts();
  const core = await createCore(parts.config, new FakeBroker(true), parts.coreOptions);
  try {
    core.workflows.save(flow(structuredClone(NODES)));
    const first = await core.runWorkflow('mimi', 'w', {});
    assert.equal(first.nodes.at(-1)!.title, 'no');
    // n3 never ran in the first run: it got no input.
    await assert.rejects(core.runWorkflowFrom('mimi', 'w', 'n3', first.runId!), /got no input/);
  } finally {
    await core.close();
    fs.rmSync(parts.root, { recursive: true, force: true });
  }
});

test('core: run from a node reuses its input; the run lands in the history', async () => {
  const parts = testCoreParts();
  const core = await createCore(parts.config, new FakeBroker(true), parts.coreOptions);
  try {
    core.workflows.save(flow(structuredClone(NODES)));
    const first = await core.runWorkflow('mimi', 'w', {});
    const again = await core.runWorkflowFrom('mimi', 'w', 'n4', first.runId!);
    assert.deepEqual(again.nodes.map((node) => node.title), ['no']);
    assert.equal(core.workflowRuns.list('mimi/w').length, 2);
    assert.equal(core.workflowRuns.list('mimi/w')[0]!.mode, 'จากกลางทาง');
  } finally {
    await core.close();
    fs.rmSync(parts.root, { recursive: true, force: true });
  }
});
