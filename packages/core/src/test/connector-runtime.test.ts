import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectorSpec, ToolDefinition } from '@mimi/shared';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { connectorSpecs } from '../connectors/services/index.ts';
import { slackConnector } from '../connectors/services/slack.ts';
import { connectorTools } from '../connectors/tool-adapter.ts';
import type { ConnectorAuthResolver } from '../connectors/types.ts';

const TOKEN = 'xoxb-test-only-token';
const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [] };

interface Call {
  url: string;
  method: string;
  body: string | undefined;
  headers: Headers;
}

type Handler = (call: Call) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function authWith(values: Record<string, string> | undefined = { botToken: TOKEN }) {
  const calls: Array<{ connector: string; account: string | undefined }> = [];
  const resolver: ConnectorAuthResolver = {
    resolve(connector, account) {
      calls.push({ connector, account });
      return values;
    },
  };
  return { calls, resolver };
}

const registry = new ConnectorRegistry(connectorSpecs);

const bodySpec: ConnectorSpec = {
  key: 'body_api',
  label: 'Body API',
  category: 'productivity',
  description: 'test-only spec for body templates',
  baseUrl: 'https://body.example/v1',
  auth: {
    kind: 'apiKey',
    fields: [{ key: 'token', label: 'Token', type: 'secret', required: true }],
    extra: { headers: { 'x-api-version': '2026-01-01' } },
  },
  operations: [
    {
      key: 'create_page',
      label: 'Create page',
      method: 'POST',
      path: '/pages',
      risk: 'write',
      body: {
        parent: { page_id: '{{parentId}}' },
        properties: { title: { title: [{ text: { content: '{{title}}' } }] } },
        archived: '{{archived}}',
      },
      fields: [
        { key: 'parentId', label: 'Parent', type: 'string', required: true },
        { key: 'title', label: 'Title', type: 'string', required: true },
        { key: 'archived', label: 'Archived', type: 'boolean' },
      ],
    },
    {
      key: 'create_checkout',
      label: 'Create checkout',
      method: 'POST',
      path: '/checkout',
      risk: 'write',
      bodyFormat: 'form',
      body: {
        customer: '{{customer}}',
        line_items: [{ price: '{{price}}', quantity: '{{quantity}}' }],
        metadata: '{{metadata}}',
      },
      fields: [
        { key: 'customer', label: 'Customer', type: 'string', required: true },
        { key: 'price', label: 'Price', type: 'string', required: true },
        { key: 'quantity', label: 'Quantity', type: 'number', default: 1 },
        { key: 'metadata', label: 'Metadata', type: 'json' },
      ],
    },
  ],
};
const bodyRegistry = new ConnectorRegistry([bodySpec]);

function runtimeWith(
  fetchFn: typeof fetch,
  auth: ConnectorAuthResolver,
  timeoutMs?: number,
  target: ConnectorRegistry = registry,
): ConnectorRuntimeImpl {
  return new ConnectorRuntimeImpl({ registry: target, auth, fetchFn, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

test('registry: Slack operations become unique tools and safe views', () => {
  assert.deepEqual(
    registry.toolNames().filter((name) => name.startsWith('slack_')).sort(),
    [
      'slack_add_reaction',
      'slack_list_channels',
      'slack_list_messages',
      'slack_list_users',
      'slack_send_message',
      'slack_update_message',
    ],
  );

  const view = registry.views({ connected: (key) => key === 'slack' }).find((entry) => entry.key === 'slack')!;
  assert.equal(view.key, 'slack');
  assert.equal(view.auth.kind, 'apiKey');
  assert.equal(view.auth.connected, true);
  assert.equal(view.operations.length, 6);
  assert.equal(view.operations.find((operation) => operation.key === 'list_messages')?.untrustedInput, true);
  assert.deepEqual(view.pagination?.mode, 'cursor');
  assert.doesNotMatch(JSON.stringify(view), new RegExp(TOKEN));
});

test('registry: duplicate connectors, operations and tool names are refused', () => {
  assert.throws(() => new ConnectorRegistry([slackConnector, slackConnector]), /already registered/);

  const duplicateOperation: ConnectorSpec = {
    ...slackConnector,
    operations: [slackConnector.operations[0]!, slackConnector.operations[0]!],
  };
  assert.throws(() => new ConnectorRegistry([duplicateOperation]), /repeats operation/);

  const collision: ConnectorSpec = {
    ...slackConnector,
    key: 'slack_send',
    operations: [{ ...slackConnector.operations[0]!, key: 'message' }],
  };
  assert.throws(() => new ConnectorRegistry([collision, slackConnector]), /already provided/);
});

test('tool adapter: names, risk, untrusted flag and zod validation', () => {
  const api = fakeFetch(() => Response.json({ ok: true }));
  const tools = connectorTools(registry, runtimeWith(api.fetchFn, authWith().resolver));
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<string, ToolDefinition>;

  const send = byName.slack_send_message!;
  const channels = byName.slack_list_channels!;
  const messages = byName.slack_list_messages!;

  assert.equal(send.risk, 'write');
  assert.equal(channels.risk, 'read');
  assert.equal(channels.untrustedInput, undefined);
  assert.equal(messages.untrustedInput, true);
  assert.deepEqual(send.settings, [
    {
      key: 'account',
      label: 'Connection',
      type: 'connection',
      connector: 'slack',
      required: false,
      description: 'เว้นว่าง = connection เริ่มต้นของ service นี้',
    },
  ]);

  assert.equal(send.inputSchema.safeParse({ channel: 'C0123456' }).success, false);
  assert.equal(send.inputSchema.safeParse({ channel: 'C0123456', text: 'hello' }).success, true);
  assert.equal(send.inputSchema.safeParse({ channel: 'C0123456', text: 'hello', thread_ts: '1.2' }).success, true);
  assert.equal(channels.inputSchema.safeParse({ limit: 10 }).success, true);
});

test('runtime: POST sends auth, path, body and maps the message', async () => {
  const api = fakeFetch(() =>
    Response.json({ ok: true, message: { type: 'message', text: 'hello', ts: '1712345678.000001' } }),
  );
  const auth = authWith();
  const runtime = runtimeWith(api.fetchFn, auth.resolver);

  const result = await runtime.execute({
    connector: 'slack',
    operation: 'send_message',
    input: { channel: 'C0123456', text: 'hello', unfurl_links: false },
    agent: 'mimi',
  });

  const call = api.calls[0]!;
  assert.equal(call.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(call.headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(call.body!), { channel: 'C0123456', text: 'hello', unfurl_links: false });
  assert.deepEqual(auth.calls, [{ connector: 'slack', account: undefined }]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.json.text, 'hello');
  assert.match(result.text!, /hello/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});

test('runtime: GET sends query defaults and uses itemsPath', async () => {
  const api = fakeFetch(() =>
    Response.json({
      ok: true,
      channels: [
        { id: 'C1', name: 'general' },
        { id: 'C2', name: 'random' },
      ],
      response_metadata: { next_cursor: '' },
    }),
  );
  const runtime = runtimeWith(api.fetchFn, authWith().resolver);

  const first = await runtime.execute({ connector: 'slack', operation: 'list_channels', input: { limit: 2 } });
  const firstUrl = new URL(api.calls[0]!.url);
  assert.equal(firstUrl.pathname, '/api/conversations.list');
  assert.equal(firstUrl.searchParams.get('limit'), '2');
  assert.equal(firstUrl.searchParams.get('exclude_archived'), 'true');
  assert.equal(first.items.length, 2);
  assert.equal(first.items[0]!.json.name, 'general');

  const second = await runtime.execute({ connector: 'slack', operation: 'list_channels', input: {} });
  const secondUrl = new URL(api.calls[1]!.url);
  assert.equal(secondUrl.searchParams.get('limit'), '100');
  assert.equal(second.items.length, 2);
});

test('runtime: Slack ok=false and HTTP errors are readable and redacted', async () => {
  const slackError = fakeFetch(() => Response.json({ ok: false, error: 'channel_not_found' }));
  const slackRuntime = runtimeWith(slackError.fetchFn, authWith().resolver);
  await assert.rejects(
    slackRuntime.execute({ connector: 'slack', operation: 'send_message', input: { channel: 'C0', text: 'hi' } }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /channel_not_found/);
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      return true;
    },
  );

  const httpError = fakeFetch(() =>
    Response.json({ error: { message: 'boom' } }, { status: 500, statusText: 'Internal Server Error' }),
  );
  const httpRuntime = runtimeWith(httpError.fetchFn, authWith().resolver);
  await assert.rejects(
    httpRuntime.execute({ connector: 'slack', operation: 'list_channels', input: {} }),
    /HTTP 500.*boom/,
  );
});

test('runtime: disconnected connector and missing auth field are refused', async () => {
  const api = fakeFetch(() => Response.json({ ok: true }));
  const disconnected = runtimeWith(api.fetchFn, { resolve: () => undefined });
  await assert.rejects(
    disconnected.execute({ connector: 'slack', operation: 'list_channels', input: {} }),
    /not connected/,
  );
  assert.equal(api.calls.length, 0);

  const incomplete = runtimeWith(api.fetchFn, { resolve: () => ({ botToken: '' }) });
  await assert.rejects(
    incomplete.execute({ connector: 'slack', operation: 'list_channels', input: {} }),
    /Bot token.*missing/,
  );
  assert.equal(api.calls.length, 0);
});

test('runtime: input validation catches missing, unknown and mistyped fields', async () => {
  const api = fakeFetch(() => Response.json({ ok: true }));
  const runtime = runtimeWith(api.fetchFn, authWith().resolver);

  await assert.rejects(
    runtime.execute({ connector: 'slack', operation: 'send_message', input: { channel: 'C1' } }),
    /needs "text"/,
  );
  await assert.rejects(
    runtime.execute({ connector: 'slack', operation: 'send_message', input: { channel: 'C1', text: 'hi', nope: 1 } }),
    /does not know: nope/,
  );
  await assert.rejects(
    runtime.execute({ connector: 'slack', operation: 'list_channels', input: { limit: 'many' } }),
    /expected a number for "limit"/,
  );
  assert.equal(api.calls.length, 0);
});

test('runtime: timeout becomes a readable error without a secret', async () => {
  const fetchFn = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as typeof fetch;
  const runtime = runtimeWith(fetchFn, authWith().resolver, 10);

  await assert.rejects(
    runtime.execute({ connector: 'slack', operation: 'list_channels', input: {} }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /timed out after 10ms/);
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      return true;
    },
  );
});

test('tool adapter: execute uses the runtime and never prints the token', async () => {
  const api = fakeFetch(() => Response.json({ ok: true, message: { text: 'hello from tool' } }));
  const tools = connectorTools(registry, runtimeWith(api.fetchFn, authWith().resolver));
  const send = tools.find((tool) => tool.name === 'slack_send_message')!;

  const output = await send.execute({ channel: 'C0123456', text: 'hello' }, context);
  assert.match(output, /hello from tool/);
  assert.doesNotMatch(output, new RegExp(TOKEN));
  assert.equal(api.calls[0]!.headers.get('authorization'), `Bearer ${TOKEN}`);
});


test('runtime: nested JSON body templates keep types and add provider headers', async () => {
  const api = fakeFetch(() => Response.json({ object: 'page', id: 'page_1', url: 'https://example/page' }));
  const runtime = runtimeWith(api.fetchFn, authWith({ token: TOKEN }).resolver, undefined, bodyRegistry);

  await runtime.execute({
    connector: 'body_api',
    operation: 'create_page',
    input: { parentId: 'root', title: 'Hello', archived: false },
  });

  const call = api.calls[0]!;
  assert.equal(call.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(call.headers.get('x-api-version'), '2026-01-01');
  assert.equal(call.headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(call.body!), {
    parent: { page_id: 'root' },
    properties: { title: { title: [{ text: { content: 'Hello' } }] } },
    archived: false,
  });
});

test('runtime: form bodies encode nested arrays, objects and numbers', async () => {
  const api = fakeFetch(() => Response.json({ id: 'cs_1', url: 'https://checkout' }));
  const runtime = runtimeWith(api.fetchFn, authWith({ token: TOKEN }).resolver, undefined, bodyRegistry);

  await runtime.execute({
    connector: 'body_api',
    operation: 'create_checkout',
    input: { customer: 'cus_1', price: 'price_1', quantity: '2', metadata: { tier: 'pro' } },
  });

  const call = api.calls[0]!;
  assert.equal(call.headers.get('content-type'), 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(call.body!);
  assert.equal(form.get('customer'), 'cus_1');
  assert.equal(form.get('line_items[0][price]'), 'price_1');
  assert.equal(form.get('line_items[0][quantity]'), '2');
  assert.equal(form.get('metadata[tier]'), 'pro');
});

test('registry: body templates must reference declared fields', () => {
  const broken: ConnectorSpec = {
    ...bodySpec,
    operations: [
      {
        ...bodySpec.operations[0]!,
        body: { title: '{{missingField}}' },
      },
    ],
  };
  assert.throws(() => new ConnectorRegistry([broken]), /unknown field "missingField"/);
});
