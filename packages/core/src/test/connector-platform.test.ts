import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { connectorSpecs } from '../connectors/services/index.ts';
import { connectorTools } from '../connectors/tool-adapter.ts';
import { fakeFetch } from './helpers/fake-fetch.ts';

const registry = new ConnectorRegistry(connectorSpecs);

test('platform: fifty services and two hundred fourteen operations are installed', () => {
  assert.equal(connectorSpecs.length, 50);
  assert.equal(connectorSpecs.reduce((total, spec) => total + spec.operations.length, 0), 214);
  assert.equal(registry.toolNames().length, 214);
  assert.deepEqual(
    connectorSpecs.map((spec) => spec.key),
    [
      'slack',
      'discord',
      'notion',
      'airtable',
      'google_docs',
      'google_tasks',
      'google_forms',
      'hubspot',
      'stripe',
      'github',
      'jira',
      'trello',
      'asana',
      'clickup',
      'monday',
      'linear',
      'todoist',
      'dropbox',
      'openai',
      'google_drive',
      'salesforce',
      'pipedrive',
      'shopify',
      'woocommerce',
      'wordpress',
      'mailchimp',
      'sendgrid',
      'twilio',
      'whatsapp',
      'supabase',
      'microsoft_teams',
      'excel',
      'zoom',
      'calendly',
      'typeform',
      'box',
      'google_analytics',
      'google_ads',
      'line',
      'zoho_crm',
      'facebook',
      'instagram',
      'linkedin',
      'x',
      'youtube',
      'reddit',
      'google_search_console',
      'google_chat',
      'google_slides',
      'google_classroom',
    ],
  );
});

test('platform: every operation has a complete, credential-free view', () => {
  for (const spec of connectorSpecs) {
    assert.ok(spec.label && spec.category && spec.description, `${spec.key} has metadata`);
    const view = registry.views().find((entry) => entry.key === spec.key)!;
    assert.equal(view.operations.length, spec.operations.length, `${spec.key} view operations`);
    for (const operation of spec.operations) {
      assert.ok(operation.label, `${spec.key}.${operation.key} label`);
      assert.ok(operation.fields.every((field) => field.key && field.label), `${spec.key}.${operation.key} fields`);
      assert.ok(['read', 'write', 'delete', 'shell', 'network'].includes(operation.risk), `${spec.key}.${operation.key} risk`);
      for (const field of operation.fields) {
        if (field.type === 'select' && !field.optionsFrom) assert.ok(field.options?.length, `${spec.key}.${operation.key}.${field.key} options`);
      }
    }
    for (const field of spec.auth.fields) {
      assert.equal(field.default, undefined, `${spec.key}.${field.key} has no default secret`);
    }
  }
  assert.doesNotMatch(JSON.stringify(registry.views()), /xoxb-[A-Za-z0-9-]{8,}|sk_(live|test)_[A-Za-z0-9]{8,}/);
});

test('platform: OAuth2 specs name their endpoints and scopes', () => {
  const oauth = connectorSpecs.filter((spec) => spec.auth.kind === 'oauth2');
  assert.deepEqual(
    oauth.map((spec) => spec.key),
    [
      'google_docs',
      'google_tasks',
      'google_forms',
      'google_drive',
      'microsoft_teams',
      'excel',
      'zoom',
      'calendly',
      'typeform',
      'box',
      'google_analytics',
      'google_ads',
      'zoho_crm',
      'facebook',
      'instagram',
      'linkedin',
      'x',
      'youtube',
      'reddit',
      'google_search_console',
      'google_chat',
      'google_slides',
      'google_classroom',
    ],
  );
  const google = oauth.filter((spec) => spec.auth.extra?.provider === 'google');
  assert.deepEqual(
    google.map((spec) => spec.key),
    [
      'google_docs',
      'google_tasks',
      'google_forms',
      'google_drive',
      'google_analytics',
      'google_ads',
      'youtube',
      'google_search_console',
      'google_chat',
      'google_slides',
      'google_classroom',
    ],
  );
  for (const spec of oauth) {
    assert.match(spec.auth.authorizeUrl ?? '', /^https:\/\//);
    assert.match(spec.auth.tokenUrl ?? '', /^https:\/\//);
    assert.ok((spec.auth.scopes?.length ?? 0) > 0, `${spec.key} scopes`);
    if (spec.auth.extra?.provider !== 'google') {
      for (const key of ['clientId', 'clientSecret', 'refreshToken']) {
        assert.ok(spec.auth.fields.some((field) => field.key === key), `${spec.key} has ${key}`);
      }
    }
  }
});

test('platform: every operation becomes one tool without name collisions', () => {
  const tools = connectorTools(registry, new ConnectorRuntimeImpl({ registry, auth: { resolve: () => undefined } }));
  assert.equal(tools.length, 214);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 214);
  for (const tool of tools) {
    assert.ok(tool.connector && tool.operation && tool.familyLabel, `${tool.name} metadata`);
    assert.ok(tool.connectorCategory, `${tool.name} category`);
    assert.equal(tool.name, `${tool.connector}_${tool.operation}`);
  }
});

test('platform: connector tools form fifty Quick Work families', () => {
  const tools = connectorTools(registry, new ConnectorRuntimeImpl({ registry, auth: { resolve: () => undefined } }));
  const families = new Set(tools.map((tool) => tool.familyLabel));
  assert.equal(families.size, 50);
  assert.deepEqual([...families].sort(), connectorSpecs.map((spec) => spec.label).sort());
});

test('platform: Quick Work offers the right connection picker per service', () => {
  const tools = connectorTools(registry, new ConnectorRuntimeImpl({ registry, auth: { resolve: () => undefined } }));
  const google = new Set(
    connectorSpecs.filter((spec) => spec.auth.kind === 'oauth2' && spec.auth.extra?.provider === 'google').map((spec) => spec.key),
  );
  for (const tool of tools) {
    const field = tool.settings?.[0];
    assert.ok(field, `${tool.name} settings`);
    assert.equal(field.key, 'account');
    if (google.has(tool.connector)) {
      assert.equal(field.type, 'account');
      assert.equal(field.service, 'google');
    } else {
      assert.equal(field.type, 'connection');
      assert.equal(field.connector, tool.connector);
    }
  }
});

test('runtime: GET retries a transient 503 and succeeds', async () => {
  let attempts = 0;
  const api = fakeFetch(() => {
    attempts++;
    return attempts === 1
      ? Response.json({ error: 'busy' }, { status: 503 })
      : Response.json({ ok: true, channels: [{ id: 'C1' }] });
  });
  const runtime = new ConnectorRuntimeImpl({
    registry,
    auth: { resolve: () => ({ botToken: 'xoxb-test-only-token' }) },
    fetchFn: api.fetchFn,
    retries: 1,
    retryDelayMs: 1,
  });
  const result = await runtime.execute({ connector: 'slack', operation: 'list_channels', input: {} });
  assert.equal(attempts, 2);
  assert.equal(result.items[0]!.json.id, 'C1');
});

test('runtime: POST is not retried after a 503', async () => {
  let attempts = 0;
  const api = fakeFetch(() => {
    attempts++;
    return Response.json({ error: 'busy' }, { status: 503 });
  });
  const runtime = new ConnectorRuntimeImpl({
    registry,
    auth: { resolve: () => ({ botToken: 'xoxb-test-only-token' }) },
    fetchFn: api.fetchFn,
    retries: 2,
    retryDelayMs: 1,
  });
  await assert.rejects(
    runtime.execute({ connector: 'slack', operation: 'send_message', input: { channel: 'C1', text: 'hi' } }),
    /HTTP 503/,
  );
  assert.equal(attempts, 1);
});
