import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentEvent, WorkflowRunResult, WorkflowView } from '@mimi/shared';
import { createWorkflowTool, parseToolInputs, workflowToolCallers, workflowToolResult } from '../workflows/workflow-tools.ts';
import { makeTestCore, type TestCore } from './core-helpers.ts';
import { scriptedModel, textStep, toolStep } from './helpers.ts';

const expense = (config: Record<string, string> = {}, overrides: Partial<WorkflowView> = {}): WorkflowView => ({
  name: 'expense',
  agent: 'mimi',
  title: 'บันทึกรายจ่าย',
  description: '',
  enabled: true,
  trigger: {
    pool: 'agent_tool',
    config: { when: 'บันทึกรายจ่าย ใช้เมื่อผู้ใช้บอกว่าจ่ายเงิน', inputs: 'item: ซื้ออะไร\namount (number): กี่บาท\nnote?: หมายเหตุ', ask: 'no', ...config },
  },
  webhook: null,
  nodes: [{ id: 'n1', type: 'set', title: 'จด', config: { fields: { saved: '{{ $json.item }} {{ $json.amount }} บาท โดย {{ $json.agent }}' } }, links: { main: [] } }],
  ...overrides,
});

function setAgent(target: TestCore, name: string) {
  fs.mkdirSync(path.join(target.root, 'user', 'agents', name), { recursive: true });
  fs.writeFileSync(path.join(target.root, 'user', 'agents', name, 'agent.md'), `---\nname: ${name}\nmodel: test/${name}\n---\nYou are ${name}.`);
}

async function turn(target: TestCore, agent: string, text: string) {
  const events: AgentEvent[] = [];
  const chat = target.core.chats.directChat(agent);
  for await (const item of target.core.engine.runTurn({ chatId: chat.id, text })) {
    if (item.type === 'agent-event') events.push(item.event);
  }
  return events.flatMap((event) => (event.type === 'tool-result' ? [event.result] : []));
}

const toolNames = (model: { doStreamCalls: Array<{ tools?: Array<{ name: string }> }> }, call = 0) =>
  (model.doStreamCalls[call]!.tools ?? []).map((tool) => tool.name);

test('tool inputs: name, optional mark, type and description per line', () => {
  assert.deepEqual(parseToolInputs('item: ซื้ออะไร\namount (number): กี่บาท\nnote?: หมายเหตุ\npaid (boolean)?\n\nไม่ใช่ชื่อ\nitem: ซ้ำ'), [
    { name: 'item', type: 'string', optional: false, description: 'ซื้ออะไร' },
    { name: 'amount', type: 'number', optional: false, description: 'กี่บาท' },
    { name: 'note', type: 'string', optional: true, description: 'หมายเหตุ' },
    { name: 'paid', type: 'boolean', optional: true, description: '' },
  ]);
  assert.deepEqual(workflowToolCallers(expense({ agents: 'tim, karen tim' })), ['mimi', 'tim', 'karen']);
});

test('the result for the agent: respond body first, else the last node; a paused run says so', () => {
  const flow = expense();
  const base: WorkflowRunResult = {
    name: 'expense',
    ok: true,
    result: '',
    nodes: [
      { id: 'n1', title: 'a', type: 'set', status: 'ok', input: [], output: [{ json: { a: 1 } }] },
      { id: 'n2', title: 'b', type: 'set', status: 'ok', input: [], output: [{ json: { b: 2 } }, { json: { b: 3 } }] },
    ],
  };
  assert.match(workflowToolResult(flow, base), /finished\. Result:\n\[\{"b":2\},\{"b":3\}\]/);
  assert.match(workflowToolResult(flow, { ...base, response: { status: 200, headers: {}, body: 'บันทึกแล้ว' } }), /Result:\nบันทึกแล้ว$/);
  assert.match(workflowToolResult(flow, { ...base, suspended: { id: 1, nodeId: 'n2', kind: 'approval' } }), /waiting for the user's approval/);
});

test('a tool workflow that calls itself (through an agent) is refused, not looped', async () => {
  let tool: ReturnType<typeof createWorkflowTool>;
  let inner = '';
  tool = createWorkflowTool(expense(), async () => {
    inner = await tool.execute({ item: 'x', amount: 1 }, { traceId: 't', thread: 'x', agent: 'mimi', allowedDirs: [] }).catch((error: Error) => error.message);
    return { name: 'expense', ok: true, result: '', nodes: [] };
  });
  await tool.execute({ item: 'x', amount: 1 }, { traceId: 't', thread: 'x', agent: 'mimi', allowedDirs: [] });
  assert.match(inner, /already running and would call itself/);
});

test('core: the agent sees its tool workflows and calls one; the run is in the history', async () => {
  const mimi = scriptedModel([toolStep('workflow_expense', { item: 'กาแฟ', amount: 65 }), textStep('จดแล้วค่ะ')]);
  const tim = scriptedModel([textStep('ครับ')]);
  const target = await makeTestCore({ models: { mimi, tim } });
  setAgent(target, 'mimi');
  setAgent(target, 'tim');
  target.core.workflows.save(expense());
  target.core.workflows.save(expense({}, { name: 'off', enabled: false }));

  const [result] = await turn(target, 'mimi', 'จ่ายค่ากาแฟ 65');
  assert.ok(result?.ok, result?.output);
  assert.match(result.output, /"saved":"กาแฟ 65 บาท โดย mimi"/);
  assert.ok(toolNames(mimi).includes('workflow_expense'));
  assert.ok(!toolNames(mimi).includes('workflow_off'), 'a disabled workflow is not offered');
  const tool = mimi.doStreamCalls[0]!.tools!.find((entry) => entry.name === 'workflow_expense') as { description?: string };
  assert.match(tool.description ?? '', /ใช้เมื่อผู้ใช้บอกว่าจ่ายเงิน/);
  assert.equal(target.core.workflowRuns.list('mimi/expense')[0]!.mode, 'tool');

  await turn(target, 'tim', 'สวัสดี');
  assert.ok(!toolNames(tim).includes('workflow_expense'), 'another agent only sees it when the trigger lists it');
  await target.cleanup();
});

test('core: an agent the trigger lists can call it; "ask" asks first; a failed run fails the tool', async () => {
  const tim = scriptedModel([toolStep('workflow_expense', { item: 'ข้าว', amount: 50 }), toolStep('workflow_broken', { item: 'x', amount: 1 }, 'call-2'), textStep('ok')]);
  const target = await makeTestCore({ models: { tim } });
  setAgent(target, 'mimi');
  setAgent(target, 'tim');
  target.core.workflows.save(expense({ agents: 'tim', ask: 'ask' }));
  target.core.workflows.save(
    expense({ agents: 'tim' }, { name: 'broken', nodes: [{ id: 'n1', type: 'code', title: 'พัง', config: { code: 'throw new Error("ชีตเต็ม")' }, links: { main: [] } }] }),
  );
  const results = await turn(target, 'tim', 'จ่ายค่าข้าว');
  assert.equal(results[0]!.ok, true);
  assert.match(results[0]!.output, /ข้าว 50 บาท โดย tim/);
  assert.deepEqual(target.broker.requests.map((request) => request.tool), ['workflow_expense']);
  assert.equal(results[1]!.ok, false);
  assert.match(results[1]!.output, /failed/);
  await target.cleanup();
});
