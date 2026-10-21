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
      ? { accessToken: 'access-token-test' }
      : field
        ? { [field.key]: 'token-test' }
        : {};
  },
};

type Input = Record<string, unknown>;

const samples: Record<string, Record<string, Input>> = {
  slack: {
    send_message: { channel: 'C1', text: 'hello' },
    list_channels: {},
    list_messages: { channel: 'C1' },
    update_message: { channel: 'C1', ts: '1.2', text: 'edited' },
    add_reaction: { channel: 'C1', timestamp: '1.2', name: 'thumbsup' },
    list_users: {},
  },
  discord: {
    send_message: { channelId: '1', content: 'hello' },
    list_guilds: {},
    list_channels: { guildId: '1' },
    list_messages: { channelId: '1' },
    delete_message: { channelId: '1', messageId: '2' },
  },
  notion: {
    search: {},
    get_page: { pageId: 'page_1' },
    create_page: { databaseId: 'db_1', properties: { Name: { title: [] } } },
    append_blocks: { blockId: 'block_1', children: [] },
    query_database: { databaseId: 'db_1' },
  },
  airtable: {
    list_records: { baseId: 'app1', table: 'Leads' },
    get_record: { baseId: 'app1', table: 'Leads', recordId: 'rec1' },
    create_record: { baseId: 'app1', table: 'Leads', fields: { Name: 'A' } },
    update_record: { baseId: 'app1', table: 'Leads', recordId: 'rec1', fields: { Name: 'B' } },
    delete_record: { baseId: 'app1', table: 'Leads', recordId: 'rec1' },
  },
  google_docs: {
    create_document: { title: 'Doc' },
    get_document: { documentId: 'doc1' },
    append_text: { documentId: 'doc1', text: 'hello' },
    replace_text: { documentId: 'doc1', find: 'a', replace: 'b' },
  },
};

function expectedPath(spec: ConnectorSpec, operation: ConnectorSpec['operations'][number], input: Input): string {
  const path = operation.path.replace(/\{([^}]+)\}/g, (_match, key: string) => encodeURIComponent(String(input[key])));
  return new URL(`${spec.baseUrl!.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`).pathname;
}

for (const [service, cases] of Object.entries(samples)) {
  test(`batch A: ${service} operations reach the right endpoint`, async () => {
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

test('batch A: provider-specific headers, JSON templates and form bodies', async () => {
  const api = fakeFetch(() => Response.json(fixtureBody()));
  const runtime = new ConnectorRuntimeImpl({ registry, auth: tokenAuth, fetchFn: api.fetchFn });

  await runtime.execute({ connector: 'notion', operation: 'search', input: { query: 'roadmap' } });
  assert.equal(api.calls[0]!.headers.get('notion-version'), '2022-06-28');
  assert.deepEqual(JSON.parse(api.calls[0]!.body!), { query: 'roadmap', page_size: 100 });

  await runtime.execute({
    connector: 'airtable',
    operation: 'update_record',
    input: { baseId: 'app1', table: 'Leads', recordId: 'rec1', fields: { Name: 'B' } },
  });
  assert.deepEqual(JSON.parse(api.calls[1]!.body!), { fields: { Name: 'B' }, typecast: false });

  await runtime.execute({ connector: 'google_docs', operation: 'replace_text', input: { documentId: 'doc1', find: 'a', replace: 'b' } });
  assert.deepEqual(JSON.parse(api.calls[2]!.body!), {
    requests: [{ replaceAllText: { containsText: { text: 'a', matchCase: false }, replaceText: 'b' } }],
  });

  await runtime.execute({ connector: 'discord', operation: 'send_message', input: { channelId: '1', content: 'hi' } });
  assert.equal(api.calls[3]!.headers.get('authorization'), 'Bot token-test');
});
