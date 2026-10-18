import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { WorkflowView } from '@mimi/shared';
import { createCore } from '../core.ts';
import { type ParkedRun, resumeWorkflow, runWorkflow, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { testCoreParts } from './core-helpers.ts';
import { FakeBroker } from './helpers.ts';

const flow = (nodes: WorkflowView['nodes']): WorkflowView & { webhookKey: string } => ({
  name: 'pay',
  agent: 'mimi',
  title: 'จ่าย',
  description: '',
  enabled: true,
  trigger: { pool: 'manual', config: {} },
  webhook: null,
  webhookKey: 'x',
  nodes,
});

const APPROVAL_FLOW = flow([
  { id: 'n1', type: 'set', title: 'เตรียม', config: { fields: { amount: 500 } }, links: { main: ['n2'] } },
  { id: 'n2', type: 'approval', title: 'ถาม', config: { message: 'จ่าย {{ $json.amount }}?' }, links: { approved: ['n3'], rejected: ['n4'] } },
  { id: 'n3', type: 'set', title: 'จ่ายแล้ว', config: { fields: { paid: '{{ $node["เตรียม"].json.amount }}' } }, links: { main: [] } },
  { id: 'n4', type: 'set', title: 'ไม่จ่าย', config: { fields: { paid: 0 } }, links: { main: [] } },
]);

function parkingDeps(store: ParkedRun[]): WorkflowRunnerDeps {
  return {
    runAgent: async () => '',
    tool: () => undefined,
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(process.cwd(), `.tmp-state-${process.pid}.json`)),
    allowedDirs: [],
    park: (parked) => {
      // Stored as JSON, exactly as the database would.
      store.push(JSON.parse(JSON.stringify(parked)) as ParkedRun);
      return store.length;
    },
  };
}

test('runner: an approval pauses the run as JSON; the answer picks the branch and the run goes on', async () => {
  const store: ParkedRun[] = [];
  const deps = parkingDeps(store);
  const paused = await runWorkflow(APPROVAL_FLOW, [{ json: {} }], deps);
  assert.deepEqual(paused.suspended, { id: 1, nodeId: 'n2', kind: 'approval' });
  assert.deepEqual(paused.nodes.map((node) => [node.title, node.status]), [['เตรียม', 'ok'], ['ถาม', 'waiting']]);
  assert.deepEqual(store[0]!.wait, { kind: 'approval', agent: 'mimi', text: 'จ่าย 500?', timeoutMs: 3_600_000 });

  const approved = await resumeWorkflow(APPROVAL_FLOW, structuredClone(store[0]!), { kind: 'approval', decision: 'approved', note: 'ok' }, deps);
  assert.equal(approved.ok, true);
  assert.deepEqual(approved.nodes.map((node) => [node.title, node.status]), [['เตรียม', 'ok'], ['ถาม', 'ok'], ['จ่ายแล้ว', 'ok']]);
  assert.equal(approved.nodes[2]!.output[0]!.json.paid, 500, '$node of nodes before the pause still works');
  assert.equal((approved.nodes[2]!.output[0]!.json.approval as { note: string }).note, 'ok');

  const rejected = await resumeWorkflow(APPROVAL_FLOW, structuredClone(store[0]!), { kind: 'approval', decision: 'rejected' }, deps);
  assert.deepEqual(rejected.nodes.map((node) => node.title), ['เตรียม', 'ถาม', 'ไม่จ่าย']);
  fs.rmSync(path.join(process.cwd(), `.tmp-state-${process.pid}.json`), { force: true });
});

test('runner: a long wait pauses until a time; a short one still waits in memory', async () => {
  const store: ParkedRun[] = [];
  const deps = parkingDeps(store);
  const waiting = flow([
    { id: 'n1', type: 'wait', title: 'รอ 2 วัน', config: { amount: 2, unit: 'days' }, links: { main: ['n2'] } },
    { id: 'n2', type: 'set', title: 'ต่อ', config: { fields: { done: true } }, links: { main: [] } },
  ]);
  const before = Date.now();
  const paused = await runWorkflow(waiting, [{ json: { a: 1 } }], deps);
  assert.equal(paused.suspended!.kind, 'wait');
  const at = Date.parse(paused.suspended!.resumeAt!);
  assert.ok(at >= before + 2 * 86_400_000 - 1000 && at <= Date.now() + 2 * 86_400_000 + 1000);
  const done = await resumeWorkflow(waiting, store[0]!, { kind: 'wait' }, deps);
  assert.deepEqual(done.nodes.at(-1)!.output[0]!.json, { a: 1, done: true });

  const short = flow([{ id: 'n1', type: 'wait', title: 'สั้น', config: { amount: 1, unit: 'seconds' }, links: { main: [] } }]);
  const quick = await runWorkflow(short, [{ json: {} }], deps);
  assert.equal(quick.suspended, undefined);
  assert.equal(store.length, 1, 'nothing stored for a short wait');
  fs.rmSync(path.join(process.cwd(), `.tmp-state-${process.pid}.json`), { force: true });
});

test('core: a paused approval survives a restart and finishes when answered; timeouts resume too', async () => {
  const parts = testCoreParts();
  const config = { ...parts.config, dbPath: path.join(parts.root, 'user', 'data', 'mimi.db') };
  let core = await createCore(config, new FakeBroker(true), parts.coreOptions);
  try {
    core.workflows.save({ ...APPROVAL_FLOW, webhook: null });
    const paused = await core.runWorkflow('mimi', 'pay', {});
    assert.equal(paused.suspended!.kind, 'approval');
    const chat = core.chats.directChat('mimi');
    const [session] = core.chats.sessions(chat.id, 1);
    const question = core.deps.messages.page(session!.thread, undefined, 5).at(-1)!;
    assert.equal(question.text, 'จ่าย 500?');
    const approvalId = core.approvals.byMessages([question.id]).get(question.id)!.id;

    // Restart: a new core on the same database still knows the request and the run.
    await core.close();
    core = await createCore(config, new FakeBroker(true), parts.coreOptions);
    assert.equal(core.approvals.byMessages([question.id]).get(question.id)!.status, 'pending');
    assert.equal(core.parkedRuns.list('mimi/pay').length, 1);
    assert.equal(core.approvals.decide(approvalId, true), true);
    // The resume runs in the background; wait for the run to land in the history.
    for (let n = 0; n < 100 && core.workflowRuns.list('mimi/pay').length < 2; n++) await new Promise((resolve) => setTimeout(resolve, 20));
    const [latest] = core.workflowRuns.list('mimi/pay');
    assert.match(latest!.mode, /ต่อ/);
    assert.equal(core.workflowRuns.get(latest!.id)!.nodes.at(-1)!.title, 'จ่ายแล้ว');
    assert.equal(core.parkedRuns.list().length, 0);
    assert.equal(core.approvals.decide(approvalId, true), false, 'answered once');

    // Nobody answers before the time is up: the run goes the timeout way.
    core.workflows.save({
      ...flow([
        { id: 'n1', type: 'approval', title: 'ถาม', config: { message: 'ตอบไหม?', timeoutMinutes: 1 }, links: { timeout: ['n2'] } },
        { id: 'n2', type: 'set', title: 'หมดเวลา', config: { fields: { late: true } }, links: { main: [] } },
      ]),
      name: 'late',
      webhook: null,
    });
    await core.runWorkflow('mimi', 'late', {});
    const expired = core.approvals.expireParked(new Date(Date.now() + 2 * 60_000));
    assert.equal(expired.length, 1);
    const finished = await core.resumeParked(expired[0]!, { kind: 'approval', decision: 'timeout' });
    assert.equal(finished!.nodes.at(-1)!.title, 'หมดเวลา');
  } finally {
    await core.close();
    fs.rmSync(parts.root, { recursive: true, force: true });
  }
});
