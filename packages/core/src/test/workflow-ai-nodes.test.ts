import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { FlowItem, JsonValue, WorkflowView } from '@mimi/shared';
import { coerce, parseJsonAnswer } from '../workflows/ai-nodes.ts';
import { runWorkflow, runWorkflowNode, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { makeTestCore } from './core-helpers.ts';
import { replyingModel } from './helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-ai-nodes-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const workflow = (overrides: Partial<WorkflowView> = {}) => ({
  name: 'triage',
  agent: 'mimi',
  title: 'Triage',
  description: '',
  enabled: true,
  trigger: { pool: 'manual', config: {} },
  webhook: null,
  webhookKey: 'x',
  nodes: [],
  ...overrides,
});

function baseDeps(): WorkflowRunnerDeps {
  return {
    runAgent: async () => '',
    tool: () => undefined,
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(tmp, `state-${Math.random().toString(36).slice(2)}.json`)),
    allowedDirs: [],
  };
}

type Call = { model: string; system: string; prompt: string };

/** Deps whose model answers come from `answer(system, prompt)`; every call is recorded. */
function modelDeps(answer: (system: string, prompt: string) => string, seen: Call[]): WorkflowRunnerDeps {
  return {
    ...baseDeps(),
    complete: async ({ model, system, prompt }) => {
      seen.push({ model, system, prompt });
      return answer(system, prompt);
    },
  };
}

test('ai nodes: JSON answers are found in fences and prose, values fit their types', () => {
  assert.deepEqual(parseJsonAnswer('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonAnswer('Sure! {"a": [1, 2]} hope it helps'), { a: [1, 2] });
  assert.throws(() => parseJsonAnswer('no json here'), /did not answer with JSON/);
  assert.equal(coerce('1,250.50 บาท', 'number'), 1250.5);
  assert.equal(coerce('ใช่', 'boolean'), true);
  assert.equal(coerce('maybe', 'boolean'), null);
  assert.deepEqual(coerce('x', 'array'), ['x']);
  assert.equal(coerce({ a: 1 }, 'string'), '{"a":1}');
  assert.equal(coerce('', 'string'), null);
});

test('llm node: one call per item, text or JSON into the named field', async () => {
  const seen: Call[] = [];
  const deps = modelDeps((_system, prompt) => (prompt.includes('JSON') ? '```json\n{"mood": "happy"}\n```' : ` สรุป: ${prompt} `), seen);
  const text = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'llm', config: { model: '@small', system: 'สั้น ๆ', prompt: '{{ $json.Subject }}', name: 'summary' }, links: { main: [] } },
    [{ json: { Subject: 'A' } }, { json: { Subject: 'B' } }],
    deps,
  );
  assert.equal(text.ok, true, text.error);
  assert.deepEqual(text.outputs.main!.map((item) => item.json.summary), ['สรุป: A', 'สรุป: B']);
  assert.deepEqual(seen.map((call) => call.model), ['@small', '@small']);
  assert.equal(seen[0]!.system, 'สั้น ๆ');

  const json = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'llm', config: { prompt: 'answer as JSON', format: 'json' }, links: { main: [] } },
    [{ json: { keep: 1 } }],
    deps,
  );
  assert.deepEqual(json.outputs.main![0]!.json, { keep: 1, text: { mood: 'happy' } });
  assert.match(seen.at(-1)!.system, /valid JSON only/);

  const empty = await runWorkflowNode(workflow(), { id: 'n1', type: 'llm', config: { prompt: '' }, links: { main: [] } }, [], deps);
  assert.match(empty.error!, /prompt is empty/);
  const noModel = await runWorkflowNode(workflow(), { id: 'n1', type: 'llm', config: { prompt: 'x' }, links: { main: [] } }, [], baseDeps());
  assert.match(noModel.error!, /not available/);
});

test('classify node: each item goes to its category output, unknown answers to fallback', async () => {
  const seen: Call[] = [];
  const deps = modelDeps((_system, prompt) => {
    if (prompt.includes('invoice')) return '{"category": "ใบแจ้งหนี้"}';
    if (prompt.includes('sale')) return '"Spam".';
    return '{"category": "none"}';
  }, seen);
  const categories = [{ name: 'ใบแจ้งหนี้', description: 'เรียกเก็บเงิน' }, 'spam'];
  const result = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'classify', config: { input: '{{ $json.Subject }}', categories }, links: { main: [] } },
    [{ json: { Subject: 'invoice 42' } }, { json: { Subject: 'big sale' } }, { json: { Subject: 'hello' } }],
    deps,
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.outputs.cat0!.map((item) => item.json.category), ['ใบแจ้งหนี้']);
  assert.deepEqual(result.outputs.cat1!.map((item) => item.json.Subject), ['big sale']);
  assert.deepEqual(result.outputs.fallback!.map((item) => item.json.category), [null]);
  assert.match(seen[0]!.system, /"ใบแจ้งหนี้": เรียกเก็บเงิน/);

  // Inside a run, the category outputs route like any branch.
  const run = await runWorkflow(
    workflow({
      nodes: [
        { id: 'n1', type: 'classify', config: { input: '{{ $json.Subject }}', categories }, links: { cat0: ['n2'], fallback: ['n3'] } },
        { id: 'n2', type: 'set', title: 'bill', config: { fields: { route: 'bill' } }, links: { main: [] } },
        { id: 'n3', type: 'set', title: 'other', config: { fields: { route: 'other' } }, links: { main: [] } },
      ],
    }),
    [{ json: { Subject: 'invoice 7' } }],
    deps,
  );
  assert.deepEqual(run.nodes.map((node) => node.title), ['n1', 'bill']);

  const none = await runWorkflowNode(workflow(), { id: 'n1', type: 'classify', config: { categories: [] }, links: { main: [] } }, [], deps);
  assert.match(none.error!, /at least one category/);
});

test('extract node: typed fields, one retry for a bad answer, optional target field', async () => {
  const seen: Call[] = [];
  let calls = 0;
  const deps = modelDeps(() => {
    calls++;
    // The first answer misses the required amount; the retry gives it as text with a comma.
    return calls === 1 ? '{"vendor": "การไฟฟ้า"}' : 'Here: {"vendor": "การไฟฟ้า", "amount": "1,250 บาท", "paid": "no", "extra": 1}';
  }, seen);
  const attributes: JsonValue = [
    { name: 'vendor', type: 'string', description: 'ผู้เรียกเก็บ' },
    { name: 'amount', type: 'number', required: true },
    { name: 'paid', type: 'boolean' },
    { name: 'due', type: 'string' },
  ];
  const result = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'extract', config: { input: '{{ $json.Content }}', attributes, instruction: 'เงินเป็นบาท' }, links: { main: [] } },
    [{ json: { Content: 'ค่าไฟ 1,250 บาท', Id: 3 } }],
    deps,
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.outputs.main![0]!.json, { Content: 'ค่าไฟ 1,250 บาท', Id: 3, vendor: 'การไฟฟ้า', amount: 1250, paid: false, due: null });
  assert.equal(seen.length, 2);
  assert.match(seen[0]!.system, /"amount" \(number, required\)/);
  assert.match(seen[1]!.prompt, /missing required keys: amount/);

  calls = 1;
  const targeted = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'extract', config: { input: 'x', attributes, target: 'bill' }, links: { main: [] } },
    [{ json: { Id: 4 } }],
    deps,
  );
  assert.deepEqual(targeted.outputs.main![0]!.json, { Id: 4, bill: { vendor: 'การไฟฟ้า', amount: 1250, paid: false, due: null } });
});

test('split_out node: arrays become items, with or without the parent fields', async () => {
  const items: FlowItem[] = [
    { json: { order: 1, lines: [{ sku: 'a' }, { sku: 'b' }], tags: ['x', 'y'] } },
    { json: { order: 2, lines: [] } },
    { json: { order: 3 } },
  ];
  const plain = await runWorkflowNode(workflow(), { id: 'n1', type: 'split_out', config: { field: 'lines' }, links: { main: [] } }, items, baseDeps());
  assert.deepEqual(plain.outputs.main!.map((item) => item.json), [{ sku: 'a' }, { sku: 'b' }]);

  const withParent = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'split_out', config: { field: 'tags', include: 'all' }, links: { main: [] } },
    items.slice(0, 1),
    baseDeps(),
  );
  assert.deepEqual(withParent.outputs.main!.map((item) => item.json), [
    { order: 1, lines: [{ sku: 'a' }, { sku: 'b' }], tags: 'x' },
    { order: 1, lines: [{ sku: 'a' }, { sku: 'b' }], tags: 'y' },
  ]);

  const expression = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'split_out', config: { field: '{{ $json.data.nums }}', name: 'n' }, links: { main: [] } },
    [{ json: { data: { nums: [1, 2, 3] } } }],
    baseDeps(),
  );
  assert.deepEqual(expression.outputs.main!.map((item) => item.json.n), [1, 2, 3]);
});

test('loop node: batches run the sub-workflow, in parallel when asked, errors stop or skip', async () => {
  const batches: number[][] = [];
  let active = 0;
  let peak = 0;
  const deps: WorkflowRunnerDeps = {
    ...baseDeps(),
    runSubWorkflow: async (_agent, name, items) => {
      assert.equal(name, 'per-item');
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      const ns = items.map((item) => Number(item.json.n));
      batches.push(ns);
      if (ns.includes(4)) throw new Error('four is bad');
      return items.map((item) => ({ json: { ...item.json, doubled: Number(item.json.n) * 2 } }));
    },
  };
  const items = [1, 2, 3, 5, 6].map((n) => ({ json: { n } }));
  const result = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'loop', config: { workflow: 'per-item', batchSize: 2, parallel: 2 }, links: { main: [] } },
    items,
    deps,
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.outputs.main!.map((item) => item.json.doubled), [2, 4, 6, 10, 12]);
  assert.equal(batches.length, 3);
  assert.equal(peak, 2);

  const failing = [{ json: { n: 1 } }, { json: { n: 4 } }];
  const stopped = await runWorkflowNode(workflow(), { id: 'n1', type: 'loop', config: { workflow: 'per-item' }, links: { main: [] } }, failing, deps);
  assert.match(stopped.error!, /loop round 2: four is bad/);

  const skipped = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'loop', config: { workflow: 'per-item', onItemError: 'skip' }, links: { main: [] } },
    failing,
    deps,
  );
  assert.deepEqual(skipped.outputs.main!.map((item) => item.json), [{ n: 1, doubled: 2 }, { n: 4, error: 'four is bad' }]);
});

test('core: llm and extract nodes call the agent model and log usage', async () => {
  const mimi = replyingModel([{ text: 'สวัสดีจาก model' }, { text: '{"amount": 99}' }]);
  const target = await makeTestCore({ models: { mimi } });
  const draft = workflow();
  const llm = await target.core.testWorkflowNode(draft, { id: 'n1', type: 'llm', config: { prompt: 'ทักทาย' }, links: { main: [] } }, []);
  assert.equal(llm.ok, true, llm.error);
  assert.equal(llm.outputs.main![0]!.json.text, 'สวัสดีจาก model');
  const extract = await target.core.testWorkflowNode(
    draft,
    { id: 'n1', type: 'extract', config: { input: 'ยอด 99', attributes: [{ name: 'amount', type: 'number' }] }, links: { main: [] } },
    [],
  );
  assert.equal(extract.ok, true, extract.error);
  assert.equal(extract.outputs.main![0]!.json.amount, 99);
  const logged = target.core.db.prepare('SELECT agent, capability FROM usage_log ORDER BY id').all();
  assert.deepEqual(logged.map((row) => ({ ...(row as object) })), [
    { agent: 'mimi', capability: 'chat' },
    { agent: 'mimi', capability: 'chat' },
  ]);
  await target.cleanup();
});
