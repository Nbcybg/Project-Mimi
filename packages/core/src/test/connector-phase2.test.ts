import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { connectorSpecs } from '../connectors/services/index.ts';
import { startServer } from '../server/server.ts';
import type { WorkflowNode, WorkflowView } from '@mimi/shared';
import { makeTestCore, testCoreParts } from './core-helpers.ts';

const AUTH_KINDS = new Set(['oauth2', 'oauth1', 'apiKey', 'basic', 'bearer', 'none']);
const FIELD_TYPES = new Set(['string', 'number', 'boolean', 'json', 'secret', 'select']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const RISKS = new Set(['read', 'write', 'delete', 'shell', 'network']);
const PAGINATION_MODES = new Set(['page', 'cursor', 'nextPageToken', 'link']);

function respond(body: WorkflowNode['config']): WorkflowNode {
  return { id: 'answer', type: 'respond', title: 'Answer', config: { body }, links: { main: [] } };
}

test('contract: every connector has complete, valid, provider-free metadata', () => {
  const seenConnectors = new Set<string>();
  const seenTools = new Set<string>();

  for (const spec of connectorSpecs) {
    assert.match(spec.key, /^[a-z][a-z0-9_]*$/, `${spec.key}: connector key`);
    assert.ok(!seenConnectors.has(spec.key), `${spec.key}: duplicate connector`);
    seenConnectors.add(spec.key);
    assert.ok(spec.label.trim(), `${spec.key}: label`);
    assert.match(spec.category, /^[a-z][a-z0-9-]*$/, `${spec.key}: category`);
    assert.ok(spec.description.trim(), `${spec.key}: description`);
    if (spec.baseUrl) assert.match(spec.baseUrl, /^https:\/\//, `${spec.key}: HTTPS base URL`);

    assert.ok(AUTH_KINDS.has(spec.auth.kind), `${spec.key}: auth kind`);
    const authKeys = new Set<string>();
    for (const field of spec.auth.fields) {
      assert.match(field.key, /^[A-Za-z][A-Za-z0-9_]*$/, `${spec.key}.auth.${field.key}: key`);
      assert.ok(!authKeys.has(field.key), `${spec.key}.auth.${field.key}: duplicate`);
      authKeys.add(field.key);
      assert.ok(FIELD_TYPES.has(field.type), `${spec.key}.auth.${field.key}: field type`);
      if (field.type === 'secret') assert.equal(field.default, undefined, `${spec.key}.auth.${field.key}: secret default`);
      if (field.type === 'select') assert.ok(field.options?.length || field.optionsFrom, `${spec.key}.auth.${field.key}: choices`);
    }
    if (spec.auth.kind === 'oauth2') {
      assert.match(spec.auth.authorizeUrl ?? '', /^https:\/\//, `${spec.key}: authorize URL`);
      assert.match(spec.auth.tokenUrl ?? '', /^https:\/\//, `${spec.key}: token URL`);
      assert.ok((spec.auth.scopes?.length ?? 0) > 0, `${spec.key}: scopes`);
    }

    const operationKeys = new Set<string>();
    for (const operation of spec.operations) {
      assert.match(operation.key, /^[a-z][a-z0-9_]*$/, `${spec.key}.${operation.key}: key`);
      assert.ok(!operationKeys.has(operation.key), `${spec.key}.${operation.key}: duplicate operation`);
      operationKeys.add(operation.key);
      const tool = `${spec.key}_${operation.key}`;
      assert.match(tool, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/, `${tool}: tool name`);
      assert.ok(!seenTools.has(tool), `${tool}: duplicate tool`);
      seenTools.add(tool);
      assert.ok(operation.label.trim(), `${tool}: label`);
      assert.ok(METHODS.has(operation.method), `${tool}: method`);
      assert.ok(operation.path.startsWith('/') || /^https:\/\//.test(operation.path), `${tool}: path`);
      assert.ok(RISKS.has(operation.risk), `${tool}: risk`);
      if (operation.bodyFormat === 'binary') assert.ok(operation.body, `${tool}: binary body template`);

      const fieldKeys = new Set<string>();
      for (const field of operation.fields) {
        assert.match(field.key, /^[A-Za-z][A-Za-z0-9_]*$/, `${tool}.${field.key}: key`);
        assert.ok(!fieldKeys.has(field.key), `${tool}.${field.key}: duplicate field`);
        fieldKeys.add(field.key);
        assert.ok(field.label.trim(), `${tool}.${field.key}: label`);
        assert.ok(FIELD_TYPES.has(field.type), `${tool}.${field.key}: field type`);
        if (field.type === 'select') {
          assert.ok(field.options?.length || field.optionsFrom, `${tool}.${field.key}: choices`);
          for (const option of field.options ?? []) assert.ok(option.value && option.label, `${tool}.${field.key}: option`);
        }
        if (field.optionsFrom) {
          const source = connectorSpecs.find((candidate) => candidate.key === field.optionsFrom!.connector);
          assert.ok(source, `${tool}.${field.key}: optionsFrom connector`);
          assert.ok(
            source.operations.some((candidate) => candidate.key === field.optionsFrom!.operation),
            `${tool}.${field.key}: optionsFrom operation`,
          );
          assert.ok(field.optionsFrom.labelField && field.optionsFrom.valueField, `${tool}.${field.key}: optionsFrom mapping`);
          for (const dependency of field.dependsOn ?? []) {
            assert.ok(fieldKeys.has(dependency), `${tool}.${field.key}: unknown dependency "${dependency}"`);
          }
        }
      }
    }

    if (spec.pagination) {
      assert.ok(PAGINATION_MODES.has(spec.pagination.mode), `${spec.key}: pagination mode`);
      if (spec.pagination.mode === 'page') assert.ok(spec.pagination.pageParam || spec.pagination.cursorParam, `${spec.key}: page parameter`);
      if (spec.pagination.mode === 'cursor') assert.ok(spec.pagination.cursorParam, `${spec.key}: cursor parameter`);
      if (spec.pagination.mode === 'nextPageToken') {
        assert.ok(spec.pagination.cursorParam, `${spec.key}: token parameter`);
        assert.ok(spec.pagination.nextPath, `${spec.key}: next token path`);
      }
      if (spec.pagination.maxPages !== undefined) assert.ok(spec.pagination.maxPages > 0, `${spec.key}: maxPages`);
      if (spec.pagination.maxItems !== undefined) assert.ok(spec.pagination.maxItems > 0, `${spec.key}: maxItems`);
    }

    if (spec.rateLimit) {
      assert.ok(spec.rateLimit.requests > 0, `${spec.key}: rate limit requests`);
      assert.ok(spec.rateLimit.perMs > 0, `${spec.key}: rate limit window`);
      assert.ok((spec.rateLimit.burst ?? 1) > 0, `${spec.key}: rate limit burst`);
    }

    const triggerKeys = new Set<string>();
    for (const trigger of spec.triggers ?? []) {
      assert.match(trigger.key, /^[a-z][a-z0-9_]*$/, `${spec.key}.${trigger.key}: trigger key`);
      assert.ok(!triggerKeys.has(trigger.key), `${spec.key}.${trigger.key}: duplicate trigger`);
      triggerKeys.add(trigger.key);
      assert.ok(trigger.label.trim(), `${spec.key}.${trigger.key}: label`);
      assert.ok(trigger.kind === 'webhook' || trigger.kind === 'poll', `${spec.key}.${trigger.key}: kind`);
      assert.ok(trigger.sample !== undefined, `${spec.key}.${trigger.key}: sample`);
      for (const field of trigger.fields ?? []) {
        assert.ok(FIELD_TYPES.has(field.type), `${spec.key}.${trigger.key}.${field.key}: field type`);
        if (field.type === 'select') assert.ok(field.options?.length || field.optionsFrom, `${spec.key}.${trigger.key}.${field.key}: choices`);
      }
      if (trigger.kind === 'webhook') {
        assert.ok(trigger.signature, `${spec.key}.${trigger.key}: signature`);
        assert.ok(trigger.signature.header, `${spec.key}.${trigger.key}: signature header`);
        const secretField = trigger.signature.secretField ?? 'secretName';
        assert.ok(trigger.fields?.some((field) => field.key === secretField), `${spec.key}.${trigger.key}: secret field`);
      } else {
        const operation = spec.operations.find((candidate) => candidate.key === trigger.operation);
        assert.ok(operation, `${spec.key}.${trigger.key}: poll operation`);
        assert.equal(operation.risk, 'read', `${spec.key}.${trigger.key}: poll operation is a read`);
        const operationFields = new Set(operation.fields.map((field) => field.key));
        for (const key of Object.keys(trigger.input ?? {})) assert.ok(operationFields.has(key), `${spec.key}.${trigger.key}: input.${key}`);
        for (const field of trigger.fields ?? []) assert.ok(operationFields.has(field.key), `${spec.key}.${trigger.key}: field ${field.key}`);
        if (trigger.cursor) {
          assert.ok(trigger.cursor.responsePath && trigger.cursor.param, `${spec.key}.${trigger.key}: cursor mapping`);
          assert.ok(operationFields.has(trigger.cursor.param), `${spec.key}.${trigger.key}: cursor parameter`);
        }
      }
    }
  }

  assert.deepEqual(
    connectorSpecs.filter((spec) => spec.triggers?.length).map((spec) => spec.key).sort(),
    ['github', 'linear', 'slack', 'todoist'],
  );
});

test('integration: core poll trigger dedupes seen tasks and reruns only new ones', async () => {
  const booted = await makeTestCore();
  const realFetch = globalThis.fetch;
  const requests: string[] = [];
  try {
    let tasks = [
      { id: 'task-1', content: 'first' },
      { id: 'task-2', content: 'second' },
    ];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return Response.json(tasks);
    }) as typeof fetch;

    const connection = booted.core.connections.save({
      connector: 'todoist',
      name: 'Phase 2 poll',
      fields: { token: 'todoist-phase2-test-token' },
    });
    const workflow: WorkflowView = {
      name: 'poll-tasks',
      agent: 'mimi',
      title: 'Poll tasks',
      description: '',
      enabled: true,
      trigger: { pool: 'connector:todoist:new_tasks', config: { account: connection.id, everyMinutes: 5 } },
      webhook: null,
      nodes: [respond({ id: '{{ $json.id }}' })],
    };
    const saved = booted.core.workflows.save(workflow);
    booted.core.syncWorkflowSchedule(saved);
    const scheduled = booted.core.triggers.byWorkflow('mimi/poll-tasks');
    assert.ok(scheduled, 'poll workflows get a scheduler row');

    assert.match(await booted.core.fire(scheduled.id), /^2 connector items:/);
    assert.equal(booted.core.workflowRuns.list('mimi/poll-tasks').length, 2);
    assert.equal(await booted.core.fire(scheduled.id), 'no new connector items');
    assert.equal(booted.core.workflowRuns.list('mimi/poll-tasks').length, 2);

    tasks = [...tasks, { id: 'task-3', content: 'third' }];
    assert.match(await booted.core.fire(scheduled.id), /^1 connector items:/);
    assert.equal(booted.core.workflowRuns.list('mimi/poll-tasks').length, 3);
    assert.equal(requests.length, 3);
    assert.ok(requests.every((url) => url === 'https://api.todoist.com/rest/v2/tasks'));
    assert.ok(!JSON.stringify(booted.core.workflowRuns.list('mimi/poll-tasks')).includes('todoist-phase2-test-token'));
  } finally {
    globalThis.fetch = realFetch;
    await booted.cleanup();
  }
});

test('integration: the server enforces a Slack signature before running a workflow', async () => {
  const parts = testCoreParts();
  const server = await startServer(
    { ...parts.config, token: 'phase2-token', host: '127.0.0.1', port: 0, localPcTools: false },
    parts.coreOptions,
  );
  try {
    const secretName = 'phase2_slack_signing';
    const signingSecret = 'phase2-slack-signing-secret';
    server.core.secrets.save({ [secretName]: signingSecret });
    const workflow: WorkflowView = {
      name: 'slack-events',
      agent: 'mimi',
      title: 'Slack events',
      description: '',
      enabled: true,
      trigger: { pool: 'connector:slack:events', config: { signingSecretName: secretName } },
      webhook: null,
      nodes: [respond({ event: '{{ $json.event.type }}', team: '{{ $json.team_id }}' })],
    };
    const saved = server.core.workflows.save(workflow);
    assert.ok(saved.webhook);

    const payload = JSON.stringify({ type: 'event_callback', team_id: 'T123', event: { type: 'app_mention' } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp };
    const url = `http://127.0.0.1:${server.port}${saved.webhook}`;

    const refused = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'x-slack-signature': `v0=${'0'.repeat(64)}` },
      body: payload,
    });
    assert.equal(refused.status, 401);
    const refusal = await refused.text();
    assert.doesNotMatch(refusal, new RegExp(signingSecret));

    const signature = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${payload}`).digest('hex')}`;
    const accepted = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'x-slack-signature': signature },
      body: payload,
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { event: 'app_mention', team: 'T123' });
    assert.equal(server.core.workflowRuns.list('mimi/slack-events').length, 1);
  } finally {
    await server.close();
    fs.rmSync(parts.root, { recursive: true, force: true });
  }
});
