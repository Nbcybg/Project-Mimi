import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectorSpec } from '@mimi/shared';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { connectorSpecs } from '../connectors/services/index.ts';
import type { ConnectorAuthResolver } from '../connectors/types.ts';
import { fakeFetch, fixtureBody } from './helpers/fake-fetch.ts';

const registry = new ConnectorRegistry(connectorSpecs);
const tokenAuth: ConnectorAuthResolver = {
  resolve(connector) {
    const spec = registry.get(connector);
    const field = spec?.auth.fields[0];
    return spec?.auth.kind === 'oauth2'
      ? { accessToken: 'access-token-test', clientId: 'client-test', clientSecret: 'secret-test', refreshToken: 'refresh-test', expiresAt: '9999999999' }
      : field
        ? { [field.key]: 'token-test' }
        : {};
  },
};

type Input = Record<string, unknown>;

const samples: Record<string, Record<string, Input>> = {
  microsoft_teams: {
    list_teams: {},
    list_channels: { teamId: 'team1' },
    send_message: { teamId: 'team1', channelId: 'ch1', message: 'hello' },
    list_messages: { teamId: 'team1', channelId: 'ch1' },
  },
  excel: {
    list_worksheets: { itemId: 'item1' },
    read_range: { itemId: 'item1', worksheet: 'Sheet1', range: 'A1:B2' },
    write_range: { itemId: 'item1', worksheet: 'Sheet1', range: 'A1:B2', values: [['x', 'y']] },
    add_row: { itemId: 'item1', worksheet: 'Sheet1', table: 'Table1', values: ['x'] },
  },
  zoom: {
    list_meetings: { userId: 'me' },
    create_meeting: { userId: 'me', topic: 'Standup' },
    get_meeting: { meetingId: '123456' },
    delete_meeting: { meetingId: '123456' },
  },
  calendly: {
    list_event_types: { user: 'https://api.calendly.com/users/AAAA' },
    list_scheduled_events: { user: 'https://api.calendly.com/users/AAAA' },
    create_invitee: { eventUuid: 'evt1', email: 'ada@example.com', name: 'Ada' },
  },
  typeform: {
    list_forms: {},
    get_form: { formId: 'form1' },
    list_responses: { formId: 'form1' },
  },
  box: {
    list_folder: {},
    search: { query: 'report' },
    upload_file: { name: 'notes.txt', contentBase64: 'aGk=' },
    download_file: { fileId: 'file1' },
  },
  google_analytics: {
    list_properties: {},
    run_report: { propertyId: 'properties/123' },
  },
  google_ads: {
    list_campaigns: { customerId: '123', developerToken: 'dev-token' },
    get_campaign: { customerId: '123', campaignId: '456', developerToken: 'dev-token' },
    update_campaign_status: { customerId: '123', campaignId: '456', status: 'PAUSED', developerToken: 'dev-token' },
  },
  line: {
    send_text: { to: 'U1', text: 'hello' },
    send_flex: { to: 'U1', altText: 'hello', contents: { type: 'bubble' } },
    list_followers: {},
  },
  zoho_crm: {
    list_contacts: {},
    create_contact: { lastName: 'Ada' },
    list_deals: {},
    create_deal: { dealName: 'New deal' },
  },
};

function expectedPath(spec: ConnectorSpec, operation: ConnectorSpec['operations'][number], input: Input): string {
  const rendered = operation.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const fallback = operation.fields.find((field) => field.key === key)?.default;
    return encodeURIComponent(String(input[key] ?? fallback));
  });
  if (/^https?:\/\//i.test(rendered)) return new URL(rendered).pathname;
  return new URL(`${spec.baseUrl!.replace(/\/+$/, '')}/${rendered.replace(/^\/+/, '')}`).pathname;
}

for (const [service, cases] of Object.entries(samples)) {
  test(`batch E: ${service} operations reach the right endpoint`, async () => {
    const spec = registry.get(service)!;
    const api = fakeFetch(() => Response.json(fixtureBody()));
    const runtime = new ConnectorRuntimeImpl({ registry, auth: tokenAuth, fetchFn: api.fetchFn });
    for (const [operationKey, input] of Object.entries(cases)) {
      const operation = spec.operations.find((entry) => entry.key === operationKey);
      assert.ok(operation, `${service}.${operationKey} exists`);
      await runtime.execute({ connector: service, operation: operationKey, input });
      const call = api.calls.at(-1)!;
      assert.equal(call.method, operation.method, `${service}.${operationKey} method`);
      assert.equal(new URL(call.url).pathname, expectedPath(spec, operation, input), `${service}.${operationKey} path`);
      const expectedToken = spec.auth.kind === 'oauth2' ? 'access-token-test' : 'token-test';
      const prefix = typeof spec.auth.extra?.prefix === 'string' ? spec.auth.extra.prefix : 'Bearer ';
      assert.equal(call.headers.get('authorization'), `${prefix}${expectedToken}`, `${service}.${operationKey} auth`);
    }
    assert.equal(api.calls.length, Object.keys(cases).length);
  });
}

test('batch E: nested JSON bodies, developer-token headers and form uploads', async () => {
  const api = fakeFetch(() => Response.json(fixtureBody()));
  const runtime = new ConnectorRuntimeImpl({ registry, auth: tokenAuth, fetchFn: api.fetchFn });

  await runtime.execute({
    connector: 'microsoft_teams',
    operation: 'send_message',
    input: { teamId: 'team1', channelId: 'ch1', message: 'hello' },
  });
  assert.deepEqual(JSON.parse(api.calls[0]!.body!), { body: { content: 'hello' } });

  await runtime.execute({
    connector: 'excel',
    operation: 'write_range',
    input: { itemId: 'item1', worksheet: 'Sheet1', range: 'A1:B2', values: [['x', 'y']] },
  });
  assert.deepEqual(JSON.parse(api.calls[1]!.body!), { values: [['x', 'y']] });

  await runtime.execute({
    connector: 'google_ads',
    operation: 'get_campaign',
    input: { customerId: '123', campaignId: '456', developerToken: 'dev-token' },
  });
  assert.equal(api.calls[2]!.headers.get('developer-token'), 'dev-token');
  assert.match(JSON.parse(api.calls[2]!.body!).query, /campaign\.id = 456/);

  await runtime.execute({
    connector: 'box',
    operation: 'upload_file',
    input: { name: 'notes.txt', folderId: '0', contentBase64: 'aGk=' },
  });
  assert.equal(api.calls[3]!.headers.get('content-type'), 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(api.calls[3]!.body!);
  assert.equal(form.get('attributes[name]'), 'notes.txt');
  assert.equal(form.get('file'), 'aGk=');
});
