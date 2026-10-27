import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { WorkflowView } from '@mimi/shared';
import { z } from 'zod';
import { ConnectorRegistry } from '../../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../../connectors/runtime.ts';
import { slackConnector } from '../../connectors/services/slack.ts';
import { defineTool } from '../../tools/registry.ts';
import { importN8n } from '../../workflows/n8n-import.ts';
import { runWorkflow, triggerItems, type WorkflowRunnerDeps, WorkflowState } from '../../workflows/runner.ts';
import { TriggerPool } from '../../workflows/trigger-pool.ts';
import { WorkflowStore } from '../../workflows/workflow-store.ts';
import { makeTestCore } from '../core-helpers.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-e2e-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const TOOL = defineTool({
  name: 'audit',
  description: 'Mark that a message was audited.',
  risk: 'read',
  target: 'core',
  inputSchema: z.object({ message: z.string() }),
  summarize: (input) => `audit ${input.message}`,
  execute: async (input) => `audited: ${input.message}`,
});

function baseDeps(connector?: ConnectorRuntimeImpl): WorkflowRunnerDeps {
  return {
    runAgent: async () => 'agent answer',
    tool: (name) => (name === 'audit' ? TOOL : undefined),
    ...(connector ? { connector } : {}),
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(root, `state-${Math.random().toString(36).slice(2)}.json`)),
    allowedDirs: [root],
    timezone: 'Asia/Bangkok',
  };
}

function slackRuntime(sent: string[]): ConnectorRuntimeImpl {
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
    sent.push(body.text ?? '');
    return Response.json({ ok: true, message: { type: 'message', text: `sent: ${body.text ?? ''}`, ts: '1712345678.000001' } });
  }) as typeof fetch;
  return new ConnectorRuntimeImpl({
    registry: new ConnectorRegistry([slackConnector]),
    auth: { resolve: () => ({ botToken: 'xoxb-e2e' }) },
    fetchFn,
  });
}

test('e2e: webhook trigger -> connector -> if -> tool -> respond', async () => {
  const store = new WorkflowStore(path.join(root, 'workflows'));
  const view = store.save({
    name: 'e2e-hook',
    agent: 'mimi',
    title: 'E2E hook',
    description: '',
    enabled: true,
    trigger: { pool: 'webhook', config: {} },
    webhook: null,
    nodes: [
      {
        id: 'n1',
        type: 'connector',
        title: 'Slack',
        config: {
          connector: 'slack',
          operation: 'send_message',
          allow: true,
          input: { channel: 'C0123456', text: '{{ $json.text }}' },
        },
        links: { main: ['n2'] },
      },
      {
        id: 'n2',
        type: 'if',
        title: 'Is hello',
        config: { left: '{{ $json.text }}', operator: 'contains', right: 'hello' },
        links: { true: ['n3'], false: [] },
      },
      {
        id: 'n3',
        type: 'tool',
        title: 'Audit',
        config: { tool: 'audit', input: { message: '{{ $json.text }}' } },
        links: { main: ['n4'] },
      },
      {
        id: 'n4',
        type: 'respond',
        title: 'Answer',
        config: { status: 200, body: { ok: true, message: '{{ $json.text }}' } },
        links: { main: [] },
      },
    ],
  });
  const stored = store.byWebhookKey(view.webhookKey!)!;
  const sent: string[] = [];
  const deps = baseDeps(slackRuntime(sent));
  const pool = new TriggerPool(path.join(root, 'triggers'));

  const started = await triggerItems(stored, pool, deps, { body: { text: 'hello from e2e' } });
  const run = await runWorkflow(stored, started, deps, undefined, 'webhook');

  assert.equal(run.ok, true, run.result);
  assert.deepEqual(sent, ['hello from e2e']);
  assert.deepEqual(run.nodes.map((node) => node.id), ['n1', 'n2', 'n3', 'n4']);
  assert.deepEqual(run.response, {
    status: 200,
    headers: {},
    body: { ok: true, message: 'audited: sent: hello from e2e' },
  });
});

test('e2e: a failed workflow runs its error workflow with the failure', async () => {
  const target = await makeTestCore({});
  try {
    const base = {
      agent: 'mimi',
      description: '',
      enabled: true,
      trigger: { pool: 'manual' as const, config: {} },
      webhook: null,
    };
    target.core.workflows.save({
      ...base,
      name: 'broken',
      title: 'Broken',
      errorWorkflow: 'alerter',
      nodes: [{ id: 'n1', type: 'tool', title: 'Missing', config: { tool: 'nope', input: {} }, links: { main: [] } }],
    });
    target.core.workflows.save({
      ...base,
      name: 'alerter',
      title: 'Alerter',
      nodes: [{ id: 'n1', type: 'chat', title: 'Alert', config: { text: 'failed: {{ $json.error }}' }, links: { main: [] } }],
    });

    const run = await target.core.runWorkflow('mimi', 'broken', {});
    assert.equal(run.ok, false);
    const chat = target.core.chats.directChat('mimi');
    const [session] = target.core.chats.sessions(chat.id, 1);
    const messages = target.core.deps.messages.page(session!.thread, undefined, 10);
    assert.match(messages.at(-1)!.text, /^failed: tool node: unknown tool "nope"$/);
  } finally {
    await target.cleanup();
  }
});

test('e2e: an imported n8n workflow runs and responds', async () => {
  const { workflows, report } = importN8n(
    {
      name: 'Imported e2e',
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        {
          name: 'Shape',
          type: 'n8n-nodes-base.set',
          parameters: { assignments: { assignments: [{ name: 'message', value: 'imported ok', type: 'string' }] } },
        },
        { name: 'Reply', type: 'n8n-nodes-base.respondToWebhook', parameters: { respondWith: 'firstIncomingItem' } },
      ],
      connections: {
        Start: { main: [[{ node: 'Shape', type: 'main', index: 0 }]] },
        Shape: { main: [[{ node: 'Reply', type: 'main', index: 0 }]] },
      },
    },
    { agent: 'mimi', existingNames: [], hasTool: () => false },
  );

  const workflow = workflows.find((entry) => entry.name && entry.nodes.some((node) => node.type === 'respond'));
  assert.ok(workflow, 'import produced a runnable workflow');
  assert.equal(report.source[0], 'Imported e2e');
  const run = await runWorkflow({ ...workflow, webhookKey: 'imported-e2e' } as WorkflowView & { webhookKey: string }, [{ json: {} }], baseDeps());
  assert.equal(run.ok, true, run.result);
  assert.deepEqual(run.response?.body, { message: 'imported ok' });
});
