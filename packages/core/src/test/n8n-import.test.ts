import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { WorkflowView } from '@mimi/shared';
import { convertExpression, importN8n, REDACTED } from '../workflows/n8n-import.ts';
import { runWorkflow, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { WorkflowStore } from '../workflows/workflow-store.ts';
import { makeTestCore } from './core-helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-n8n-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const FAKE_KEY = `sk-${'a1b2c3d4'.repeat(4)}`;

/** Shaped like an n8n AI-secretary export: two triggers, an AI agent with sub-nodes, a loop. */
const EXPORT = {
  name: 'AI Secretary',
  nodes: [
    { name: 'Telegram Trigger', type: 'n8n-nodes-base.telegramTrigger', typeVersion: 1.1, parameters: { updates: ['message'] }, credentials: { telegramApi: { id: '1', name: 'bot' } } },
    {
      name: 'Is command?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2,
      parameters: {
        conditions: {
          combinator: 'and',
          conditions: [{ leftValue: '={{ $json.message.text }}', rightValue: '/', operator: { type: 'string', operation: 'startsWith' } }],
        },
      },
    },
    {
      name: 'AI Secretary',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 1.7,
      parameters: { promptType: 'define', text: "={{ $('Telegram Trigger').item.json.message.text }}", options: { systemMessage: 'คุณคือมิมิ เลขาส่วนตัว' } },
    },
    { name: 'DeepSeek', type: '@n8n/n8n-nodes-langchain.lmChatDeepSeek', parameters: { model: 'deepseek-v4-flash' } },
    { name: 'Memory', type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', parameters: {} },
    { name: 'Gmail Tool', type: 'n8n-nodes-base.gmailTool', parameters: {} },
    {
      name: 'Reply',
      type: 'n8n-nodes-base.telegram',
      parameters: { chatId: "={{ $('Telegram Trigger').item.json.message.chat.id }}", text: '={{ $json.output }}', additionalFields: { parse_mode: 'HTML' } },
    },
    { name: 'Command help', type: 'n8n-nodes-base.telegram', parameters: { operation: 'sendPhoto', chatId: '1' } },
    { name: 'Every morning', type: 'n8n-nodes-base.scheduleTrigger', parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 7, triggerAtMinute: 30 }] } } },
    {
      name: 'Get weather',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      parameters: {
        method: 'GET',
        url: 'https://api.example.com/weather',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Authorization', value: `Bearer ${FAKE_KEY}` }, { name: 'Accept', value: 'application/json' }] },
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'city', value: 'Bangkok' }] },
      },
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 2000,
    },
    {
      name: 'Shape',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      parameters: { assignments: { assignments: [{ name: 'summary', value: '={{ $json.temp }} องศา', type: 'string' }, { name: 'n', value: '3', type: 'number' }] } },
    },
    { name: 'Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, parameters: {} },
    {
      name: 'Double',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: { jsCode: 'return $input.all().map((item) => ({ json: { ...item.json, n: item.json.n * 2 } }));' },
    },
    { name: 'Python bit', type: 'n8n-nodes-base.code', parameters: { language: 'python', pythonCode: 'return items' } },
    { name: 'Old step', type: 'n8n-nodes-base.noOp', disabled: true, parameters: {} },
    { name: 'Notion', type: 'n8n-nodes-base.notion', parameters: { apiKey: FAKE_KEY } },
    { name: 'Note', type: 'n8n-nodes-base.stickyNote', parameters: { content: 'Morning brief flow' } },
  ],
  connections: {
    'Telegram Trigger': { main: [[{ node: 'Is command?', type: 'main', index: 0 }]] },
    'Is command?': { main: [[{ node: 'Command help', type: 'main', index: 0 }], [{ node: 'AI Secretary', type: 'main', index: 0 }]] },
    'AI Secretary': { main: [[{ node: 'Reply', type: 'main', index: 0 }]] },
    DeepSeek: { ai_languageModel: [[{ node: 'AI Secretary', type: 'ai_languageModel', index: 0 }]] },
    Memory: { ai_memory: [[{ node: 'AI Secretary', type: 'ai_memory', index: 0 }]] },
    'Gmail Tool': { ai_tool: [[{ node: 'AI Secretary', type: 'ai_tool', index: 0 }]] },
    'Every morning': { main: [[{ node: 'Get weather', type: 'main', index: 0 }]] },
    'Get weather': { main: [[{ node: 'Shape', type: 'main', index: 0 }]] },
    Shape: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
    Loop: { main: [[{ node: 'Old step', type: 'main', index: 0 }], [{ node: 'Double', type: 'main', index: 0 }]] },
    Double: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
    'Old step': { main: [[{ node: 'Notion', type: 'main', index: 0 }]] },
  },
};

const options = { agent: 'mimi', existingNames: ['ai-secretary-telegram-trigger'], hasTool: (name: string) => name.startsWith('gmail_') };

test('n8n expressions: $() references, $input, chatInput, Luxon warnings', () => {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  assert.equal(convertExpression("={{ $('Get mail').item.json.Subject }}", warn), '{{ $node["Get mail"].json.Subject }}');
  assert.equal(convertExpression("={{ $('A').first().json.x }}", warn), '{{ $node["A"].json.x }}');
  assert.equal(convertExpression("={{ $('A').all().length }}", warn), '{{ $node["A"].items.map((json) => ({ json })).length }}');
  assert.equal(convertExpression('={{ $input.item.json.a }} {{ $input.first().json.b }}', warn), '{{ $json.a }} {{ $items[0].b }}');
  assert.equal(convertExpression('={{ $json.chatInput }}', warn), '{{ $json.text }}');
  assert.equal(convertExpression('plain text {{ not an expression }}', warn), 'plain text {{ not an expression }}');
  assert.deepEqual(warnings, []);
  convertExpression("={{ $now.toFormat('yyyy-MM-dd') }}", warn);
  assert.match(warnings[0]!, /Luxon/);
});

test('n8n import: one disabled workflow per trigger, nodes mapped, secrets dropped, report complete', () => {
  const { workflows, report } = importN8n(EXPORT, options);
  assert.deepEqual(report.source, ['AI Secretary']);
  assert.deepEqual(workflows.map((workflow) => [workflow.name, workflow.trigger.pool, workflow.enabled]), [
    ['ai-secretary-telegram-trigger-2', 'telegram', false],
    ['ai-secretary-every-morning', 'schedule', false],
  ]);
  const [chat, morning] = workflows as [WorkflowView, WorkflowView];

  // Telegram flow: if → (true) placeholder / (false) agent → reply.
  const byTitle = (workflow: WorkflowView, title: string) => workflow.nodes.find((node) => node.title === title)!;
  const branch = byTitle(chat, 'Is command?');
  assert.equal(branch.type, 'if');
  assert.deepEqual(branch.config.conditions, [{ left: '{{ $json.text }}', operator: 'starts_with', right: '/' }]);
  assert.deepEqual(branch.links, { true: [byTitle(chat, 'Command help').id], false: [byTitle(chat, 'AI Secretary').id] });
  const agent = byTitle(chat, 'AI Secretary');
  assert.deepEqual(agent.config, { agent: 'mimi', instruction: '{{ $trigger.json.text }}' });
  const reply = byTitle(chat, 'Reply');
  assert.deepEqual(reply.config, { tokenSecret: 'TELEGRAM_BOT_TOKEN', chatId: '{{ $trigger.json.chatId }}', text: '{{ $json.text }}', parseMode: 'HTML' });
  assert.equal(byTitle(chat, 'Command help').type, 'code');
  assert.ok(!chat.nodes.some((node) => ['DeepSeek', 'Memory', 'Gmail Tool'].includes(node.title ?? '')));

  // Morning flow: http with query/headers (key gone), retries, set, the loop cut, disabled → passthrough.
  const http = byTitle(morning, 'Get weather');
  assert.deepEqual(http.config, { method: 'GET', url: 'https://api.example.com/weather', query: { city: 'Bangkok' }, headers: { Authorization: REDACTED, Accept: 'application/json' } });
  assert.deepEqual([http.retries, http.retryWaitMs], [2, 2000]);
  assert.deepEqual(byTitle(morning, 'Shape').config, { fields: { summary: '{{ $json.temp }} องศา', n: 3 } });
  assert.equal(byTitle(morning, 'Old step (ปิดไว้ใน n8n)').type, 'set');
  assert.equal(morning.trigger.config.cron, '30 7 * * *');
  assert.match(morning.description, /Morning brief flow/);
  const double = byTitle(morning, 'Double');
  assert.deepEqual(double.links, { main: [] }, 'the link back to the loop is gone');

  assert.ok(!JSON.stringify(workflows).includes(FAKE_KEY), 'no secret survives');
  assert.ok(!JSON.stringify(workflows).includes('credentials'));
  assert.deepEqual(report.redacted.map((entry) => `${entry.node} ${entry.field}`).sort(), ['Get weather headerParameters.parameters[0].Authorization', 'Notion apiKey']);
  assert.deepEqual(report.unsupported.map((entry) => entry.node).sort(), ['Command help', 'Notion']);
  assert.deepEqual(report.models, [{ node: 'AI Secretary', model: 'deepseek-v4-flash' }]);
  assert.deepEqual(report.prompts, [{ node: 'AI Secretary', text: 'คุณคือมิมิ เลขาส่วนตัว' }]);
  assert.ok(report.warnings.some((warning) => /Gmail Tool/.test(warning)));
  assert.ok(report.warnings.some((warning) => /loop links removed/.test(warning)));
  assert.ok(!report.unsupported.some((entry) => entry.node === 'Python bit'), 'unconnected nodes are not imported');

  // Every imported workflow passes the store's own checks.
  const store = new WorkflowStore(path.join(tmp, 'flows'));
  for (const workflow of workflows) store.save(workflow);
  assert.equal(store.list('mimi').length, 2);
  assert.throws(() => importN8n({ hello: 1 }, options), /not an n8n workflow/);
});

test('n8n import: the converted flow runs (code with $input and [{ json }], branches, $trigger)', async () => {
  const { workflows } = importN8n(
    {
      name: 'calc',
      nodes: [
        { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
        { name: 'Code', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return $input.all().map((item) => ({ json: { n: item.json.n * 10 } }));' } },
        {
          name: 'Big?',
          type: 'n8n-nodes-base.if',
          parameters: { conditions: { number: [{ value1: '={{ $json.n }}', operation: 'largerEqual', value2: 50 }] } },
        },
        { name: 'Mark big', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: { assignments: { assignments: [{ name: 'size', value: "={{ 'big ' + $('Webhook').item.json.body.who }}" }] } } },
        { name: 'Mark small', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: { assignments: { assignments: [{ name: 'size', value: 'small' }] } } },
        { name: 'Answer', type: 'n8n-nodes-base.respondToWebhook', parameters: { respondWith: 'json', responseBody: '={"size": "{{ $json.size }}"}', options: { responseCode: 201 } } },
      ],
      connections: {
        Webhook: { main: [[{ node: 'Code' }]] },
        Code: { main: [[{ node: 'Big?' }]] },
        'Big?': { main: [[{ node: 'Mark big' }], [{ node: 'Mark small' }]] },
        'Mark big': { main: [[{ node: 'Answer' }]] },
        'Mark small': { main: [[{ node: 'Answer' }]] },
      },
    },
    { ...options, existingNames: [] },
  );
  const [workflow] = workflows;
  assert.equal(workflow!.trigger.pool, 'webhook');
  const deps: WorkflowRunnerDeps = {
    runAgent: async () => '',
    tool: () => undefined,
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(tmp, 'state.json')),
    allowedDirs: [],
  };
  const run = await runWorkflow({ ...workflow!, webhookKey: 'x' } as WorkflowView, [{ json: { n: 7, who: 'ต้น' } }], deps, undefined, 'webhook');
  assert.equal(run.ok, true, run.result);
  assert.deepEqual(run.nodes.map((node) => node.title), ['Code', 'Big?', 'Mark big', 'Answer']);
  assert.equal(run.nodes[2]!.output[0]!.json.size, 'big ต้น');
  assert.deepEqual(run.response, { status: 201, headers: {}, body: { size: 'big ต้น' } });
});

test('core / server: import saves disabled workflows of the agent', async () => {
  const target = await makeTestCore({});
  const { workflows } = importN8n(EXPORT, { agent: 'mimi', existingNames: target.core.workflows.names('mimi'), hasTool: (name) => Boolean(target.core.tools.get(name)) });
  for (const workflow of workflows) target.core.workflows.save(workflow);
  const saved = target.core.workflows.list('mimi');
  assert.equal(saved.length, 2);
  assert.ok(saved.every((workflow) => !workflow.enabled));
  await target.cleanup();
});

test('canvas positions: stored with the node, carried over from n8n', () => {
  const { workflows } = importN8n(
    {
      name: 'pos',
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
        { name: 'Step', type: 'n8n-nodes-base.noOp', position: [240.6, 300], parameters: {} },
      ],
      connections: { Start: { main: [[{ node: 'Step' }]] } },
    },
    { ...options, existingNames: [] },
  );
  assert.deepEqual(workflows[0]!.nodes[0]!.position, [241, 300]);
  const store = new WorkflowStore(path.join(tmp, 'pos-flows'));
  store.save(workflows[0]!);
  assert.deepEqual(store.get('mimi', workflows[0]!.name)!.nodes[0]!.position, [241, 300]);
  assert.throws(() => store.save({ ...workflows[0]!, nodes: [{ ...workflows[0]!.nodes[0]!, position: [1] as unknown as [number, number] }] }));
});
