import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectorSpec } from '@mimi/shared';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { fakeFetch } from './helpers/fake-fetch.ts';

function spec(overrides: Partial<ConnectorSpec> = {}): ConnectorSpec {
  return {
    key: 'test_api',
    label: 'Test API',
    category: 'test',
    description: 'test-only connector',
    baseUrl: 'https://api.example.test/v1',
    auth: { kind: 'apiKey', fields: [{ key: 'token', label: 'Token', type: 'secret' }] },
    operations: [
      {
        key: 'list',
        label: 'List',
        method: 'GET',
        path: '/items',
        risk: 'read',
        fields: [],
      },
    ],
    ...overrides,
  };
}

function runtime(target: ConnectorSpec, api: ReturnType<typeof fakeFetch>, extra: Partial<ConstructorParameters<typeof ConnectorRuntimeImpl>[0]> = {}) {
  return new ConnectorRuntimeImpl({
    registry: new ConnectorRegistry([target]),
    auth: { resolve: () => ({ token: 'test-token' }) },
    fetchFn: api.fetchFn,
    ...extra,
  });
}

test('pagination: cursor follows nextPath and returns every item', async () => {
  const target = spec({
    operations: [{ ...spec().operations[0]!, paginated: true }],
    pagination: { mode: 'cursor', cursorParam: 'cursor', itemsPath: 'data', nextPath: 'meta.next' },
  });
  const api = fakeFetch((call) => {
    const cursor = new URL(call.url).searchParams.get('cursor');
    return Response.json(cursor ? { data: [{ id: 2 }], meta: { next: '' } } : { data: [{ id: 1 }], meta: { next: 'next-1' } });
  });
  const result = await runtime(target, api).execute({ connector: 'test_api', operation: 'list', input: {} });

  assert.equal(api.calls.length, 2);
  assert.equal(new URL(api.calls[1]!.url).searchParams.get('cursor'), 'next-1');
  assert.deepEqual(result.items.map((item) => item.json.id), [1, 2]);
});

test('pagination: page stops after a short page', async () => {
  const target = spec({
    operations: [
      {
        ...spec().operations[0]!,
        key: 'list',
        fields: [{ key: 'per_page', label: 'Size', type: 'number', required: false }],
        paginated: true,
      },
    ],
    pagination: { mode: 'page', pageParam: 'page', sizeParam: 'per_page', itemsPath: 'data' },
  });
  const api = fakeFetch((call) => {
    const page = Number(new URL(call.url).searchParams.get('page'));
    return Response.json({ data: page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }] });
  });
  const result = await runtime(target, api).execute({ connector: 'test_api', operation: 'list', input: { per_page: 2 } });

  assert.equal(api.calls.length, 2);
  assert.equal(new URL(api.calls[1]!.url).searchParams.get('page'), '2');
  assert.deepEqual(result.items.map((item) => item.json.id), [1, 2, 3]);
});

test('pagination: link mode follows the Link header and respects maxItems', async () => {
  const target = spec({
    operations: [{ ...spec().operations[0]!, paginated: true }],
    pagination: { mode: 'link', maxItems: 2 },
  });
  const api = fakeFetch((call) =>
    new Response(JSON.stringify([{ id: call.url.includes('page=2') ? 2 : 1 }]), {
      headers: {
        'content-type': 'application/json',
        link: call.url.includes('page=2') ? '' : '<https://api.example.test/v1/items?page=2>; rel="next"',
      },
    }),
  );
  const result = await runtime(target, api).execute({ connector: 'test_api', operation: 'list', input: {} });

  assert.equal(api.calls.length, 2);
  assert.equal(result.items.length, 2);
});

test('pagination: nextPageToken mode sends the token back', async () => {
  const target = spec({
    operations: [{ ...spec().operations[0]!, paginated: true }],
    pagination: { mode: 'nextPageToken', cursorParam: 'pageToken', itemsPath: 'items', nextPath: 'nextPageToken' },
  });
  const api = fakeFetch((call) => {
    const token = new URL(call.url).searchParams.get('pageToken');
    return Response.json(token ? { items: [{ id: 2 }] } : { items: [{ id: 1 }], nextPageToken: 'T2' });
  });
  const result = await runtime(target, api).execute({ connector: 'test_api', operation: 'list', input: {} });

  assert.equal(new URL(api.calls[1]!.url).searchParams.get('pageToken'), 'T2');
  assert.deepEqual(result.items.map((item) => item.json.id), [1, 2]);
});

test('rate limit: a token bucket waits before the third request', async () => {
  const target = spec({ rateLimit: { requests: 2, perMs: 1000, burst: 2 } });
  const api = fakeFetch(() => Response.json([]));
  let clock = 0;
  const sleeps: number[] = [];
  const client = runtime(target, api, {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });

  await client.execute({ connector: 'test_api', operation: 'list', input: {} });
  await client.execute({ connector: 'test_api', operation: 'list', input: {} });
  await client.execute({ connector: 'test_api', operation: 'list', input: {} });

  assert.equal(api.calls.length, 3);
  assert.deepEqual(sleeps, [500]);
});

test('retry: 429 honours Retry-After and succeeds on the next attempt', async () => {
  let calls = 0;
  const api = fakeFetch(() => {
    calls += 1;
    return calls === 1
      ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
      : Response.json([{ id: 1 }]);
  });
  const sleeps: number[] = [];
  const client = runtime(spec(), api, {
    retries: 2,
    retryDelayMs: 10,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const result = await client.execute({ connector: 'test_api', operation: 'list', input: {} });
  assert.equal(api.calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(result.items.length, 1);
});

test('retry: writes need idempotent before a network retry', async () => {
  const write = spec({
    operations: [{ ...spec().operations[0]!, key: 'create', label: 'Create', method: 'POST', path: '/items', risk: 'write' }],
  });
  let calls = 0;
  const api = fakeFetch(() => {
    calls += 1;
    if (calls === 1) throw new Error('network down');
    return Response.json({ id: 1 });
  });
  const client = runtime(write, api, { retries: 1, retryDelayMs: 1, sleep: async () => {} });

  await assert.rejects(client.execute({ connector: 'test_api', operation: 'create', input: {} }), /network down/);
  assert.equal(api.calls.length, 1);

  calls = 0;
  const idempotentApi = fakeFetch(() => {
    calls += 1;
    if (calls === 1) throw new Error('network down');
    return Response.json({ id: 1 });
  });
  const idempotent = spec({
    operations: [{ ...write.operations[0]!, idempotent: true }],
  });
  const retrying = runtime(idempotent, idempotentApi, { retries: 1, retryDelayMs: 1, sleep: async () => {} });
  await retrying.execute({ connector: 'test_api', operation: 'create', input: {} });
  assert.equal(idempotentApi.calls.length, 2);
});

test('auth: query credentials are added without leaking into headers', async () => {
  const target = spec({
    auth: {
      kind: 'apiKey',
      fields: [{ key: 'token', label: 'API token', type: 'secret' }],
      extra: { location: 'query', queryNames: { token: 'api_token' } },
    },
  });
  const api = fakeFetch(() => Response.json([]));
  await runtime(target, api).execute({ connector: 'test_api', operation: 'list', input: {} });

  const call = api.calls[0]!;
  assert.equal(new URL(call.url).searchParams.get('api_token'), 'test-token');
  assert.equal(call.headers.get('authorization'), null);
});

test('requests: operation headers render templates and binary bodies decode base64', async () => {
  const target = spec({
    operations: [
      {
        key: 'upload',
        label: 'Upload',
        method: 'POST',
        path: '/upload',
        risk: 'write',
        bodyFormat: 'binary',
        body: '{{content}}',
        headers: { 'x-file-name': '{{name}}', 'content-type': 'application/octet-stream' },
        fields: [
          { key: 'name', label: 'Name', type: 'string', required: true },
          { key: 'content', label: 'Content', type: 'string', required: true },
        ],
      },
    ],
  });
  const api = fakeFetch((call) => {
    assert.equal(call.headers.get('x-file-name'), 'hello.txt');
    assert.equal(Buffer.from(call.bodyBytes!).toString('utf8'), 'hello');
    return Response.json({ ok: true });
  });
  await runtime(target, api).execute({
    connector: 'test_api',
    operation: 'upload',
    input: { name: 'hello.txt', content: Buffer.from('hello').toString('base64') },
  });
});

test('request: operation.query keeps selected fields in the URL for writes', async () => {
  const target = spec({
    operations: [
      {
        key: 'create',
        label: 'Create',
        method: 'POST',
        path: '/items',
        risk: 'write',
        query: ['workspace'],
        fields: [
          { key: 'workspace', label: 'Workspace', type: 'string', required: true },
          { key: 'name', label: 'Name', type: 'string', required: true },
        ],
      },
    ],
  });
  const api = fakeFetch(() => Response.json({ id: 1 }));
  await runtime(target, api).execute({
    connector: 'test_api',
    operation: 'create',
    input: { workspace: 'w1', name: 'Example' },
  });

  assert.equal(new URL(api.calls[0]!.url).searchParams.get('workspace'), 'w1');
  assert.deepEqual(JSON.parse(api.calls[0]!.body ?? '{}'), { name: 'Example' });
});
