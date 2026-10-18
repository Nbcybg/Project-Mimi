import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { FlowItem, WorkflowView } from '@mimi/shared';
import { z } from 'zod';
import { SecretStore } from '../app/secrets.ts';
import { applyOperator, contextFor, resolveString } from '../workflows/expressions.ts';
import { normalizeItems, runWorkflow, runWorkflowNode, triggerItems, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { TriggerPool } from '../workflows/trigger-pool.ts';
import { WorkflowStore } from '../workflows/workflow-store.ts';
import { makeTestCore } from './core-helpers.ts';
import { scriptedModel, textStep } from './helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-flow-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('secrets: names only, values stay local, preset keys are namespaced', () => {
  const store = new SecretStore(path.join(tmp, 'secrets.json'));
  store.save({ WEATHER_API_KEY: ' sk-123456789 ', EMPTY: '' });
  assert.deepEqual(store.names(), ['WEATHER_API_KEY']);
  assert.equal(store.get('WEATHER_API_KEY'), 'sk-123456789');
  assert.equal(store.hint('WEATHER_API_KEY'), '••••6789');
  store.save({ WEATHER_API_KEY: '' });
  assert.deepEqual(store.names(), []);

  store.set('preset.manager_sheet.token', 'abc');
  assert.equal(store.has('preset.manager_sheet.token'), true);
  store.removePreset('manager_sheet');
  assert.equal(store.has('preset.manager_sheet.token'), false);
  assert.throws(() => store.set('bad name!', 'x'), /Invalid secret name/);
});

test('expressions: $json lookups, interpolation and operators', () => {
  const context = { $json: { From: 'a@b.c', Subject: 'Invoice 42' }, $index: 0, $now: '2026-10-13T00:00:00Z', $items: [] };
  assert.equal(resolveString('{{ $json.From }}', context), 'a@b.c');
  assert.equal(resolveString('เมลจาก {{ $json.From }}: {{ $json.Subject }}', context), 'เมลจาก a@b.c: Invoice 42');
  assert.equal(resolveString('{{ $json.Subject.includes("Invoice") }}', context), true);
  assert.equal(resolveString('{{ $json.Missing }}', context), null);
  assert.equal(resolveString('{{ $json.Missing }}', context) === null, true);

  assert.equal(applyOperator(5, 'gt', 3), true);
  assert.equal(applyOperator('Invoice 42', 'contains', 'invoice'), true);
  assert.equal(applyOperator('', 'is_empty', ''), true);
  assert.equal(applyOperator('x', 'regex', '(['), false);
});

test('expressions: $vars, $node, $execution, $today and the helpers', () => {
  const context = contextFor({ json: { amount: 120 } }, 0, [{ json: { amount: 120 } }, { json: { amount: 80 } }], {
    $vars: { key: 'secret' },
    $node: { HTTP: { json: { id: 7 }, items: [{ id: 7 }] } },
    $workflow: { name: 'triage', title: 'Triage', agent: 'mimi' },
    $execution: { id: 'run-1', mode: 'webhook' },
    $today: '2026-10-15',
  });
  assert.equal(resolveString('{{ $vars.key }}', context), 'secret');
  assert.equal(resolveString('{{ $node.HTTP.json.id }}', context), 7);
  assert.equal(resolveString('{{ $workflow.title }} / {{ $execution.mode }}', context), 'Triage / webhook');
  assert.equal(resolveString('{{ $today }}', context), '2026-10-15');
  assert.equal(resolveString('{{ $item(1).amount }}', context), 80);
  assert.equal(resolveString('{{ $if($json.amount > 100, "big", "small") }}', context), 'big');
  assert.equal(resolveString('{{ $ifEmpty($json.missing, "fallback") }}', context), 'fallback');
  assert.equal(resolveString('{{ $max(1, 5, 3) }}', context), 5);
  assert.equal(resolveString('{{ $min(4, 2) }}', context), 2);
  assert.equal(resolveString('{{ $average(2, 4) }}', context), 3);
  assert.equal(resolveString('{{ $number("42") + 1 }}', context), 43);
  assert.equal(resolveString('{{ $string(7) }}', context), '7');
});

test('trigger pool: built-ins always available, custom entries are files', () => {
  const pool = new TriggerPool(path.join(tmp, 'pool'));
  const names = pool.list().map((entry) => entry.name);
  for (const builtin of ['manual', 'schedule', 'webhook', 'mail', 'poll']) assert.ok(names.includes(builtin));
  assert.ok(pool.get('mail')!.builtin);

  const saved = pool.save({
    name: 'my-feed',
    label: 'My feed',
    description: 'reads my feed',
    kind: 'poll',
    builtin: false,
    fields: [{ key: 'url', label: 'URL', type: 'string', required: true }],
    sample: { value: 1 },
  });
  assert.equal(saved.builtin, false);
  assert.ok(fs.existsSync(path.join(tmp, 'pool', 'my-feed.json')));
  assert.ok(pool.list().some((entry) => entry.name === 'my-feed'));
  assert.throws(() => pool.save({ ...saved, name: 'schedule' }), /built-in/);
  assert.equal(pool.remove('my-feed'), true);
  assert.equal(pool.get('my-feed'), undefined);
});

function workflowView(overrides: Partial<WorkflowView> = {}): WorkflowView {
  return {
    name: 'triage',
    agent: 'mimi',
    title: 'Triage',
    description: '',
    enabled: true,
    trigger: { pool: 'manual', config: {} },
    webhook: null,
    nodes: [{ id: 'n1', type: 'chat', title: 'แจ้ง', config: { text: '{{ $json.Subject }}' }, links: { main: [] } }],
    ...overrides,
  };
}

test('workflow store: per-agent folders, graph validation, webhook keys', () => {
  const store = new WorkflowStore(path.join(tmp, 'flows'));
  const saved = store.save(workflowView());
  assert.ok(saved.webhookKey);
  assert.ok(fs.existsSync(path.join(tmp, 'flows', 'mimi', 'triage.json')));
  assert.equal(store.get('mimi', 'triage')!.name, 'triage');
  assert.equal(store.list('mimi').length, 1);
  assert.equal(store.byWebhookKey(saved.webhookKey!)!.name, 'triage');

  // A link to a missing node and unreachable nodes are rejected.
  const broken = workflowView({
    name: 'broken',
    nodes: [
      { id: 'n1', type: 'chat', config: {}, links: { main: ['ghost'] } },
      { id: 'n2', type: 'chat', config: {}, links: { main: [] } },
    ],
  });
  assert.throws(() => store.save(broken), /unknown node "ghost"/);
  // A cycle that no start reaches is an error too (no loop in the graph).
  assert.throws(
    () => store.save({
      ...broken,
      name: 'orphan',
      nodes: [
        { id: 'n1', type: 'chat', config: {}, links: { main: ['n2'] } },
        { id: 'n2', type: 'chat', config: {}, links: { main: [] } },
        { id: 'n3', type: 'chat', config: {}, links: { main: ['n4'] } },
        { id: 'n4', type: 'chat', config: {}, links: { main: ['n3'] } },
      ],
    }),
    /not reachable/,
  );

  store.save({ ...workflowView(), name: 'renamed' }, 'triage');
  assert.equal(store.get('mimi', 'triage'), undefined);
  assert.equal(store.get('mimi', 'renamed')!.name, 'renamed');
  assert.deepEqual(store.forgetAgent('mimi'), ['renamed']);
  assert.equal(store.list().length, 0);
});

function fakeDeps(calls: string[], runAgent?: (agent: string) => Promise<string>): WorkflowRunnerDeps {
  return {
    runAgent:
      runAgent ??
      (async (agent: string) => {
        calls.push(`agent:${agent}`);
        return agent === 'mimi' ? 'verdict: SPAM' : 'สรุปสั้น ๆ';
      }),
    tool: () => undefined,
    speak: (agent, text) => calls.push(`chat:${agent}:${text}`),
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(tmp, `state-${Math.random().toString(36).slice(2)}.json`)),
    allowedDirs: [],
  };
}

const stored = (view: WorkflowView) => ({ ...view, webhookKey: 'x', webhook: null });

test('runner: agent -> if branches, expressions feed the chat node', async () => {
  const workflow = stored(
    workflowView({
      nodes: [
        { id: 'n1', type: 'agent', title: 'วิเคราะห์', config: { agent: 'mimi', instruction: 'หา spam' }, links: { main: ['n2'] } },
        {
          id: 'n2',
          type: 'if',
          title: 'สแปม?',
          config: { left: '{{ $json.text }}', operator: 'contains', right: 'SPAM' },
          links: { true: ['n4'], false: ['n3'] },
        },
        { id: 'n3', type: 'agent', title: 'สรุป', config: { agent: 'tim', instruction: 'สรุป' }, links: { main: ['n4'] } },
        { id: 'n4', type: 'chat', title: 'แจ้ง', config: { text: '📬 {{ $json.Subject }} → {{ $json.text }}' }, links: { main: [] } },
      ],
    }),
  );
  const calls: string[] = [];

  const spam = await runWorkflow(workflow, [{ json: { Subject: 'hello' } }], fakeDeps(calls));
  assert.equal(spam.ok, true);
  assert.deepEqual(spam.nodes.map((node) => node.id), ['n1', 'n2', 'n4'], 'spam skips the summary');
  assert.deepEqual(calls, ['agent:mimi', 'chat:mimi:📬 hello → verdict: SPAM']);
  // The run view carries every node's input and output.
  assert.deepEqual(spam.nodes[0]!.input[0]!.json, { Subject: 'hello' });
  assert.deepEqual(spam.nodes[0]!.output[0]!.json, { Subject: 'hello', text: 'verdict: SPAM' });
  assert.deepEqual(spam.nodes[2]!.input[0]!.json, { Subject: 'hello', text: 'verdict: SPAM' });

  calls.length = 0;
  const clean = await runWorkflow(
    workflow,
    [{ json: { Subject: 'hello' } }],
    fakeDeps(calls, async (agent) => {
      calls.push(`agent:${agent}`);
      return agent === 'mimi' ? 'normal mail' : 'สรุปสั้น ๆ';
    }),
  );
  assert.deepEqual(clean.nodes.map((node) => node.id), ['n1', 'n2', 'n3', 'n4']);
  assert.deepEqual(calls, ['agent:mimi', 'agent:tim', 'chat:mimi:📬 hello → สรุปสั้น ๆ']);
});

test('runner: set, switch and per-item routing', async () => {
  const workflow = stored(
    workflowView({
      nodes: [
        { id: 'n1', type: 'set', title: 'ติดป้าย', config: { fields: { upper: '{{ $json.Subject.toUpperCase() }}' } }, links: { main: ['n2'] } },
        {
          id: 'n2',
          type: 'switch',
          title: 'แยกประเภท',
          config: { value: '{{ $json.upper }}', cases: ['INVOICE 42'] },
          links: { case0: ['n3'], case1: [], case2: [], fallback: ['n4'] },
        },
        { id: 'n3', type: 'chat', title: 'ใบเสร็จ', config: { text: 'invoice: {{ $json.upper }}' }, links: { main: [] } },
        { id: 'n4', type: 'chat', title: 'อื่น ๆ', config: { text: 'other: {{ $json.Subject }}' }, links: { main: [] } },
      ],
    }),
  );
  const calls: string[] = [];
  const run = await runWorkflow(workflow, [{ json: { Subject: 'Invoice 42' } }, { json: { Subject: 'ชวนกินข้าว' } }], fakeDeps(calls));
  assert.deepEqual(calls, ['chat:mimi:invoice: INVOICE 42', 'chat:mimi:other: ชวนกินข้าว']);
  const switchView = run.nodes.find((node) => node.id === 'n2')!;
  assert.deepEqual(switchView.input.map((item) => item.json.Subject), ['Invoice 42', 'ชวนกินข้าว']);
});

test('runner: if combines several conditions (and/or)', async () => {
  const workflow = stored(
    workflowView({
      nodes: [
        {
          id: 'n1',
          type: 'if',
          title: 'invoice ใหญ่?',
          config: {
            combinator: 'and',
            conditions: [
              { left: '{{ $json.text }}', operator: 'contains', right: 'invoice' },
              { left: '{{ $json.total }}', operator: 'gt', right: 100 },
            ],
          },
          links: { true: ['n2'], false: ['n3'] },
        },
        { id: 'n2', type: 'chat', title: 'ผ่าน', config: { text: 'PASS {{ $json.text }}' }, links: { main: [] } },
        { id: 'n3', type: 'chat', title: 'ไม่ผ่าน', config: { text: 'FAIL {{ $json.text }}' }, links: { main: [] } },
      ],
    }),
  );
  const calls: string[] = [];
  await runWorkflow(
    workflow,
    [{ json: { text: 'invoice 1', total: 200 } }, { json: { text: 'invoice 2', total: 50 } }, { json: { text: 'hello', total: 300 } }],
    fakeDeps(calls),
  );
  assert.deepEqual(calls, ['chat:mimi:PASS invoice 1', 'chat:mimi:FAIL invoice 2', 'chat:mimi:FAIL hello']);

  // filter keeps only what passes, and "or" needs a single hit.
  const filtered = stored(
    workflowView({
      nodes: [
        {
          id: 'n1',
          type: 'filter',
          title: 'or',
          config: {
            combinator: 'or',
            conditions: [
              { left: '{{ $json.a }}', operator: 'equals', right: 'x' },
              { left: '{{ $json.b }}', operator: 'equals', right: 'y' },
            ],
          },
          links: { main: ['n2'] },
        },
        { id: 'n2', type: 'chat', title: 'kept', config: { text: 'kept {{ $json.a }}{{ $json.b }}' }, links: { main: [] } },
      ],
    }),
  );
  calls.length = 0;
  await runWorkflow(filtered, [{ json: { a: 'x', b: 'n' } }, { json: { a: 'n', b: 'y' } }, { json: { a: 'n', b: 'n' } }], fakeDeps(calls));
  assert.deepEqual(calls, ['chat:mimi:kept xn', 'chat:mimi:kept ny']);
});

test('runner: switch has unlimited cases, and a rules mode', async () => {
  const byValue = stored(
    workflowView({
      nodes: [
        {
          id: 'n1',
          type: 'switch',
          title: 'แยก',
          config: { mode: 'value', value: '{{ $json.k }}', cases: ['a', 'b', 'c', 'd'] },
          links: { case0: ['n2'], case3: ['n3'], fallback: ['n4'] },
        },
        { id: 'n2', type: 'chat', title: 'A', config: { text: 'A {{ $json.k }}' }, links: { main: [] } },
        { id: 'n3', type: 'chat', title: 'D', config: { text: 'D {{ $json.k }}' }, links: { main: [] } },
        { id: 'n4', type: 'chat', title: 'F', config: { text: 'F {{ $json.k }}' }, links: { main: [] } },
      ],
    }),
  );
  const calls: string[] = [];
  await runWorkflow(byValue, [{ json: { k: 'd' } }, { json: { k: 'a' } }, { json: { k: 'z' } }], fakeDeps(calls));
  assert.deepEqual([...calls].sort(), ['chat:mimi:A a', 'chat:mimi:D d', 'chat:mimi:F z']);

  const byRules = stored(
    workflowView({
      nodes: [
        {
          id: 'n1',
          type: 'switch',
          title: 'rules',
          config: {
            mode: 'rules',
            cases: [
              { left: '{{ $json.n }}', operator: 'gt', right: 100 },
              { left: '{{ $json.n }}', operator: 'lt', right: 0 },
            ],
          },
          links: { case0: ['n2'], case1: ['n3'], fallback: ['n4'] },
        },
        { id: 'n2', type: 'chat', title: 'big', config: { text: 'big {{ $json.n }}' }, links: { main: [] } },
        { id: 'n3', type: 'chat', title: 'neg', config: { text: 'neg {{ $json.n }}' }, links: { main: [] } },
        { id: 'n4', type: 'chat', title: 'mid', config: { text: 'mid {{ $json.n }}' }, links: { main: [] } },
      ],
    }),
  );
  calls.length = 0;
  await runWorkflow(byRules, [{ json: { n: 200 } }, { json: { n: -5 } }, { json: { n: 50 } }], fakeDeps(calls));
  assert.deepEqual([...calls].sort(), ['chat:mimi:big 200', 'chat:mimi:mid 50', 'chat:mimi:neg -5']);
});

test('runner: sort, limit, aggregate and remove_duplicates work without a code node', async () => {
  const pipeline = stored(
    workflowView({
      nodes: [
        { id: 'n1', type: 'sort', title: 'เรียง', config: { field: '{{ $json.n }}', direction: 'desc', type: 'number' }, links: { main: ['n2'] } },
        { id: 'n2', type: 'limit', title: 'เอา 2', config: { max: 2, keep: 'first' }, links: { main: ['n3'] } },
        { id: 'n3', type: 'aggregate', title: 'รวม', config: { mode: 'sum', field: '{{ $json.n }}', name: 'total' }, links: { main: ['n4'] } },
        { id: 'n4', type: 'chat', title: 'แจ้ง', config: { text: 'total {{ $json.total }}' }, links: { main: [] } },
      ],
    }),
  );
  const calls: string[] = [];
  const run = await runWorkflow(pipeline, [{ json: { n: 3 } }, { json: { n: 9 } }, { json: { n: 5 } }], fakeDeps(calls));
  assert.deepEqual(run.nodes.find((node) => node.id === 'n1')!.output.map((item) => item.json.n), [9, 5, 3]);
  assert.deepEqual(calls, ['chat:mimi:total 14']);

  const dedup = stored(
    workflowView({
      nodes: [
        { id: 'n1', type: 'remove_duplicates', title: 'ตัดซ้ำ', config: { fields: ['id'], keep: 'last' }, links: { main: ['n2'] } },
        { id: 'n2', type: 'aggregate', title: 'join', config: { mode: 'join', field: '{{ $json.name }}', separator: ', ', name: 'names' }, links: { main: ['n3'] } },
        { id: 'n3', type: 'chat', title: 'แจ้ง', config: { text: '{{ $json.names }}' }, links: { main: [] } },
      ],
    }),
  );
  calls.length = 0;
  await runWorkflow(dedup, [{ json: { id: 1, name: 'a' } }, { json: { id: 2, name: 'b' } }, { json: { id: 1, name: 'c' } }], fakeDeps(calls));
  assert.deepEqual(calls, ['chat:mimi:b, c']);

  // collect puts every value of a field into one item.
  const collect = await runWorkflowNode(
    stored(workflowView({})),
    { id: 'n9', type: 'aggregate', config: { mode: 'collect', fields: ['name'] }, links: { main: [] } },
    [{ json: { name: 'a' } }, { json: { name: 'b' } }],
    fakeDeps([]),
  );
  assert.deepEqual(collect.outputs.main![0]!.json, { name: ['a', 'b'] });
});

test('runner: expressions read $vars, $node and $execution during a run', async () => {
  const workflow = stored(
    workflowView({
      vars: { greeting: 'สวัสดี' },
      nodes: [
        { id: 'n1', type: 'set', title: 'ตั้ง', config: { fields: { stamp: '{{ $execution.mode }}', hi: '{{ $vars.greeting }}' } }, links: { main: ['n2'] } },
        { id: 'n2', type: 'chat', title: 'อ่าน', config: { text: '{{ $node["ตั้ง"].json.hi }} ({{ $node.n1.json.stamp }}) {{ $today }}' }, links: { main: [] } },
      ],
    }),
  );
  const calls: string[] = [];
  await runWorkflow(workflow, [{ json: {} }], fakeDeps(calls), undefined, 'webhook');
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /^chat:mimi:สวัสดี \(webhook\) \d{4}-\d{2}-\d{2}$/);
});

test('runner: a HTTP node turns a JSON response into items', async () => {
  const workflow = stored(
    workflowView({
      nodes: [
        { id: 'n1', type: 'http', title: 'เรียก API', config: { method: 'GET', url: 'https://api.example.com/{{ $json.Id }}' }, links: { main: ['n2'] } },
        { id: 'n2', type: 'chat', title: 'แจ้ง', config: { text: 'ได้ {{ $json.name }}' }, links: { main: [] } },
      ],
    }),
  );
  const calls: string[] = [];
  const deps = fakeDeps(calls);
  deps.fetchFn = (async (url: string | URL | Request) => {
    calls.push(`fetch:${String(url)}`);
    return new Response(JSON.stringify({ name: 'ผลลัพธ์' }), { status: 200 });
  }) as typeof fetch;
  const run = await runWorkflow(workflow, [{ json: { Id: 7 } }], deps);
  assert.equal(run.ok, true);
  assert.deepEqual(calls, ['fetch:https://api.example.com/7', 'chat:mimi:ได้ ผลลัพธ์']);
});

test('trigger items: manual input, schedule timestamp, poll response, webhook body', async () => {
  const pool = new TriggerPool(path.join(tmp, 'pool2'));
  const deps = fakeDeps([]);
  deps.fetchFn = (async () => new Response('[{"a":1},{"a":2}]', { status: 200 })) as typeof fetch;

  const manual = stored(workflowView({ trigger: { pool: 'manual', config: {} } }));
  assert.deepEqual((await triggerItems(manual, pool, deps, { input: { From: 'x@y.z' } }))[0]!.json, { From: 'x@y.z' });

  const schedule = stored(workflowView({ trigger: { pool: 'schedule', config: { cron: '0 8 * * *' } } }));
  const at = await triggerItems(schedule, pool, deps);
  assert.match(String(at[0]!.json.timestamp), /^\d{4}-/);

  const poll = stored(workflowView({ trigger: { pool: 'poll', config: { url: 'https://api.example.com/feed' } } }));
  assert.deepEqual((await triggerItems(poll, pool, deps)).map((item) => item.json.a), [1, 2]);

  const webhook = stored(workflowView({ trigger: { pool: 'webhook', config: {} } }));
  assert.deepEqual((await triggerItems(webhook, pool, deps, { body: { event: 'x' } }))[0]!.json, { event: 'x' });
  assert.deepEqual(normalizeItems('plain text'), [{ json: { value: 'plain text' } }]);
});

test('single-node test: sample input in, per-output items out, errors reported', async () => {
  const workflow = stored(workflowView({}));
  const calls: string[] = [];
  const deps = fakeDeps(calls);

  const chat = await runWorkflowNode(
    workflow,
    { id: 'n1', type: 'chat', config: { text: 'ได้ {{ $json.Subject }}' }, links: { main: [] } },
    [{ json: { Subject: 'hi' } }],
    deps,
  );
  assert.equal(chat.ok, true);
  assert.deepEqual(calls, ['chat:mimi:ได้ hi']);
  assert.equal(chat.outputs.main!.length, 1);
  assert.deepEqual(chat.input[0]!.json, { Subject: 'hi' });

  // if with two items: one goes to true, one to false.
  const branch = await runWorkflowNode(
    workflow,
    { id: 'n2', type: 'if', config: { left: '{{ $json.text }}', operator: 'contains', right: 'spam' }, links: { true: [], false: [] } },
    [{ json: { text: 'SPAM mail' } }, { json: { text: 'ok' } }],
    deps,
  );
  assert.deepEqual([branch.outputs.true?.length, branch.outputs.false?.length], [1, 1]);

  const bad = await runWorkflowNode(workflow, { id: 'n3', type: 'tool', config: { tool: 'nope', input: {} }, links: { main: [] } }, [], deps);
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /unknown tool "nope"/);
});

test('core: an agent workflow runs from its trigger row and by hand with input', async () => {  const mimi = scriptedModel([textStep('ประมวลผลเสร็จแล้ว')]);
  const target = await makeTestCore({ models: { mimi } });
  const view = workflowView({
    title: 'รายงานเช้า',
    trigger: { pool: 'schedule', config: { cron: '0 8 * * *' } },
    nodes: [
      { id: 'n1', type: 'agent', title: 'ทำงาน', config: { agent: 'mimi', instruction: 'สรุปงาน' }, links: { main: ['n2'] } },
      { id: 'n2', type: 'chat', title: 'แจ้ง', config: { text: '📋 {{ $json.text }}' }, links: { main: [] } },
    ],
  });
  const workflow = target.core.workflows.save(view);
  target.core.syncWorkflowSchedule(workflow);
  const trigger = target.core.triggers.byWorkflow('mimi/triage')!;
  assert.ok(trigger);
  assert.equal(trigger.cron, '0 8 * * *');

  target.core.db.prepare(`UPDATE triggers SET next_fire_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(trigger.id);
  await target.core.scheduler.tick();
  const chat = target.core.chats.directChat('mimi');
  const [session] = target.core.chats.sessions(chat.id, 1);
  const messages = target.core.deps.messages.page(session!.thread, undefined, 10);
  assert.equal(messages.at(-1)!.text, '📋 ประมวลผลเสร็จแล้ว');

  // Disabling removes the schedule; the manual run still works with its own input.
  target.core.syncWorkflowSchedule({ ...workflow, enabled: false });
  assert.equal(target.core.triggers.byWorkflow('mimi/triage'), undefined);
  const manual = await target.core.runWorkflow('mimi', 'triage', { note: 'จากมือ' });
  assert.equal(manual.ok, true);
  assert.ok(manual.nodes.length >= 2);
  assert.equal(manual.nodes[0]!.input[0]!.json.note, 'จากมือ');
  await target.cleanup();
});

test('runner: retries, onError continue and the error branch', async () => {
  const calls: string[] = [];
  let attempts = 0;
  const flaky = {
    name: 'flaky',
    description: 'fails twice, then works',
    risk: 'read' as const,
    target: 'core' as const,
    inputSchema: z.object({}),
    summarize: () => 'flaky',
    execute: async () => {
      attempts++;
      if (attempts < 3) throw new Error('boom');
      return 'finally ok';
    },
  };
  const deps = fakeDeps(calls);
  deps.tool = (name) => (name === 'flaky' ? flaky : undefined);

  const retried = stored(
    workflowView({
      nodes: [
        { id: 'n1', type: 'tool', title: 'flaky', config: { tool: 'flaky', input: {} }, retries: 2, links: { main: ['n2'] } },
        { id: 'n2', type: 'chat', title: 'แจ้ง', config: { text: 'ได้ {{ $json.text }}' }, links: { main: [] } },
      ],
    }),
  );
  const run = await runWorkflow(retried, [{ json: {} }], deps);
  assert.equal(run.ok, true);
  assert.deepEqual(calls, ['chat:mimi:ได้ finally ok']);

  // Still failing after the retries: continue passes the input on.
  attempts = -100;
  const continued = stored(
    workflowView({
      nodes: [
        { id: 'n1', type: 'tool', title: 'พัง', config: { tool: 'flaky', input: {} }, retries: 1, onError: 'continue', links: { main: ['n2'] } },
        { id: 'n2', type: 'chat', title: 'ต่อ', config: { text: 'ต่อ {{ $json.n }}' }, links: { main: [] } },
      ],
    }),
  );
  calls.length = 0;
  const continuedRun = await runWorkflow(continued, [{ json: { n: 7 } }], deps);
  assert.equal(continuedRun.ok, true);
  assert.equal(continuedRun.nodes[0]!.status, 'error');
  assert.match(continuedRun.nodes[0]!.error!, /boom \(2 attempts\)/);
  assert.deepEqual(calls, ['chat:mimi:ต่อ 7']);

  // branch sends the items to the "error" output instead.
  const branched = stored(
    workflowView({
      nodes: [
        { id: 'n1', type: 'tool', title: 'พัง', config: { tool: 'flaky', input: {} }, onError: 'branch', links: { error: ['n2'] } },
        { id: 'n2', type: 'chat', title: 'แจ้งเตือน', config: { text: 'พลาด: {{ $json.n }}' }, links: { main: [] } },
      ],
    }),
  );
  calls.length = 0;
  const branchedRun = await runWorkflow(branched, [{ json: { n: 9 } }], deps);
  assert.equal(branchedRun.ok, true);
  assert.deepEqual(calls, ['chat:mimi:พลาด: 9']);
});

test('runner: merge joins branches by position and by key', async () => {
  const calls: string[] = [];
  const combined = stored(
    workflowView({
      nodes: [
        { id: 'n1', type: 'set', title: 'A', config: { fields: { a: '{{ $json.n }}' } }, links: { main: ['n3'] } },
        { id: 'n2', type: 'set', title: 'B', config: { fields: { b: '{{ $json.m }}' } }, links: { main: ['n3'] } },
        { id: 'n3', type: 'merge', title: 'combine', config: { mode: 'combine' }, links: { main: ['n4'] } },
        { id: 'n4', type: 'chat', title: 'แจ้ง', config: { text: '{{ $json.a }}-{{ $json.b }}' }, links: { main: [] } },
      ],
    }),
  );
  await runWorkflow(combined, [{ json: { n: 1, m: 'x' } }, { json: { n: 2, m: 'y' } }], fakeDeps(calls));
  assert.deepEqual(calls, ['chat:mimi:1-x', 'chat:mimi:2-y']);

  const byKey = stored(
    workflowView({
      nodes: [
        { id: 'n1', type: 'set', title: 'A', config: { fields: { id: '{{ $json.id }}', a: '{{ $json.n }}' } }, links: { main: ['n3'] } },
        { id: 'n2', type: 'set', title: 'B', config: { fields: { id: '{{ $json.id }}', b: '{{ $json.m }}' } }, links: { main: ['n3'] } },
        { id: 'n3', type: 'merge', title: 'by_key', config: { mode: 'by_key', key: 'id' }, links: { main: ['n4'] } },
        { id: 'n4', type: 'chat', title: 'แจ้ง', config: { text: '{{ $json.a }}{{ $json.b }}' }, links: { main: [] } },
      ],
    }),
  );
  calls.length = 0;
  await runWorkflow(byKey, [{ json: { id: 1, n: 'a1', m: 'b1' } }], fakeDeps(calls));
  assert.deepEqual(calls, ['chat:mimi:a1b1']);
});

test('runner: wait holds the items, and an abort ends the wait', async () => {
  const workflow = stored(
    workflowView({
      nodes: [
        { id: 'n1', type: 'wait', title: 'รอ', config: { amount: 0.05, unit: 'seconds' }, links: { main: ['n2'] } },
        { id: 'n2', type: 'chat', title: 'ต่อ', config: { text: 'หลังรอ {{ $json.n }}' }, links: { main: [] } },
      ],
    }),
  );
  const calls: string[] = [];
  const started = Date.now();
  const run = await runWorkflow(workflow, [{ json: { n: 1 } }], fakeDeps(calls));
  assert.equal(run.ok, true);
  assert.ok(Date.now() - started >= 40, 'waited about 50ms');
  assert.deepEqual(calls, ['chat:mimi:หลังรอ 1']);

  const controller = new AbortController();
  const aborting = stored(
    workflowView({ nodes: [{ id: 'n1', type: 'wait', title: 'รอ', config: { amount: 5, unit: 'seconds' }, links: { main: [] } }] }),
  );
  setTimeout(() => controller.abort(), 50);
  const aborted = await runWorkflow(aborting, [{ json: {} }], fakeDeps([]), controller.signal);
  assert.equal(aborted.ok, false);
  assert.match(aborted.nodes[0]!.error!, /aborted/);
});

test('runner: the workflow node runs another workflow of the same agent', async () => {
  const calls: string[] = [];
  const deps = fakeDeps(calls);
  deps.runSubWorkflow = async (agent, name, items, depth) => {
    calls.push(`sub:${agent}/${name}@${depth}:${JSON.stringify(items.map((item) => item.json))}`);
    return [{ json: { text: 'ผลจาก sub' } }];
  };
  const workflow = stored(
    workflowView({
      nodes: [
        { id: 'n1', type: 'workflow', title: 'เรียก sub', config: { workflow: 'child', input: { n: '{{ $json.n }}' } }, links: { main: ['n2'] } },
        { id: 'n2', type: 'chat', title: 'แจ้ง', config: { text: 'ได้ {{ $json.text }}' }, links: { main: [] } },
      ],
    }),
  );
  const run = await runWorkflow(workflow, [{ json: { n: 5 } }], deps);
  assert.equal(run.ok, true);
  assert.deepEqual(calls, ['sub:mimi/child@1:[{"n":5}]', 'chat:mimi:ได้ ผลจาก sub']);

  // Without a runner for sub-workflows the node fails with a clear message.
  const failed = await runWorkflow(workflow, [{ json: { n: 1 } }], fakeDeps([]));
  assert.equal(failed.ok, false);
  assert.match(failed.nodes[0]!.error!, /sub-workflows are not available/);
});

test('runner: the respond node shapes the webhook answer and passes items on', async () => {
  const workflow = stored(
    workflowView({
      nodes: [
        {
          id: 'n1',
          type: 'respond',
          title: 'ตอบ',
          config: { status: 201, headers: { 'x-source': 'mimi' }, body: { received: true, subject: '{{ $json.Subject }}' } },
          links: { main: ['n2'] },
        },
        { id: 'n2', type: 'set', title: 'ต่อ', config: { fields: { done: 'yes' } }, links: { main: [] } },
      ],
    }),
  );
  const run = await runWorkflow(workflow, [{ json: { Subject: 'hi' } }], fakeDeps([]));
  assert.equal(run.ok, true);
  assert.deepEqual(run.response, { status: 201, headers: { 'x-source': 'mimi' }, body: { received: true, subject: 'hi' } });
  assert.deepEqual(run.nodes.at(-1)!.output[0]!.json, { Subject: 'hi', done: 'yes' }, 'items keep flowing after responding');

  // Defaults: status 200, no headers, the items themselves as body.
  const bare = await runWorkflow(
    stored(workflowView({ nodes: [{ id: 'n1', type: 'respond', title: 'ตอบ', config: {}, links: { main: [] } }] })),
    [{ json: { a: 1 } }],
    fakeDeps([]),
  );
  assert.deepEqual(bare.response, { status: 200, headers: {}, body: { a: 1 } });

  // No respond node: the run has no custom response.
  const none = await runWorkflow(
    stored(workflowView({ nodes: [{ id: 'n1', type: 'set', title: 'x', config: { fields: { b: 2 } }, links: { main: [] } }] })),
    [{ json: {} }],
    fakeDeps([]),
  );
  assert.equal(none.response, undefined);
});

test('core: a failed workflow runs its error workflow once', async () => {
  const target = await makeTestCore({});
  target.core.workflows.save(
    workflowView({
      name: 'broken',
      title: 'พัง',
      errorWorkflow: 'alerter',
      nodes: [{ id: 'n1', type: 'tool', title: 'ไม่รู้จัก', config: { tool: 'nope', input: {} }, links: { main: [] } }],
    }),
  );
  target.core.workflows.save(
    workflowView({
      name: 'alerter',
      title: 'แจ้งเตือน',
      nodes: [{ id: 'n1', type: 'chat', title: 'แจ้ง', config: { text: 'พัง: {{ $json.error }} ({{ $json.node }})' }, links: { main: [] } }],
    }),
  );
  const run = await target.core.runWorkflow('mimi', 'broken', {});
  assert.equal(run.ok, false);
  const chat = target.core.chats.directChat('mimi');
  const [session] = target.core.chats.sessions(chat.id, 1);
  const messages = target.core.deps.messages.page(session!.thread, undefined, 10);
  assert.match(messages.at(-1)!.text, /^พัง: tool node: unknown tool "nope" \(n1\)$/);
  await target.cleanup();
});
