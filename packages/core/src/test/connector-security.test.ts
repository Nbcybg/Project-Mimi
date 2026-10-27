import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ConnectorSpec } from '@mimi/shared';
import { SecretStore } from '../app/secrets.ts';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { ConnectorConnections } from '../oauth/connections.ts';
import { buildCustomTool } from '../tools/custom-tools.ts';
import { safeFetch } from '../workflows/net-guard.ts';

const lookup = async (host: string): Promise<string[]> => {
  if (host === 'public.test' || host === 'other.test') return ['93.184.216.34'];
  if (host === 'metadata.test') return ['169.254.169.254'];
  return ['10.0.0.5'];
};

function spec(baseUrl = 'https://public.test'): ConnectorSpec {
  return {
    key: 'guarded',
    version: '1.0.0',
    label: 'Guarded',
    category: 'test',
    description: 'Security test connector',
    baseUrl,
    auth: { kind: 'none', fields: [] },
    operations: [{ key: 'read', label: 'Read', method: 'GET', path: '/read', fields: [], risk: 'read' }],
  };
}

function oauthSpec(tokenUrl: string): ConnectorSpec {
  return {
    key: 'oauth_race',
    label: 'OAuth Race',
    category: 'test',
    description: 'test-only',
    baseUrl: 'https://api.example',
    auth: {
      kind: 'oauth2',
      tokenUrl,
      authorizeUrl: 'https://auth.example/authorize',
      scopes: [],
      fields: [
        { key: 'clientId', label: 'Client ID', type: 'string', required: true },
        { key: 'clientSecret', label: 'Client secret', type: 'secret' },
        { key: 'refreshToken', label: 'Refresh token', type: 'secret' },
        { key: 'accessToken', label: 'Access token', type: 'secret' },
        { key: 'expiresAt', label: 'Expires at', type: 'string' },
      ],
    },
    operations: [{ key: 'read', label: 'Read', method: 'GET', path: '/read', fields: [], risk: 'read' }],
  };
}

test('safeFetch: private URLs and redirects to metadata are blocked', async () => {
  let calls = 0;
  const fetchFn = (async (input: string | URL | Request) => {
    calls += 1;
    assert.equal(String(input), 'https://public.test/start');
    return new Response(null, { status: 302, headers: { location: 'http://metadata.test/latest' } });
  }) as typeof fetch;

  await assert.rejects(safeFetch('https://public.test/start', {}, { fetchFn, lookup }), /local network/);
  assert.equal(calls, 1);
  await assert.rejects(safeFetch('http://127.0.0.1:8080/admin', {}, { fetchFn, lookup }), /local network/);
  assert.equal(calls, 1);
});

test('safeFetch: public redirects are followed', async () => {
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    seen.push(String(input));
    if (seen.length === 1) return new Response(null, { status: 302, headers: { location: '/next' } });
    return Response.json({ ok: true });
  }) as typeof fetch;

  const response = await safeFetch('https://public.test/start', {}, { fetchFn, lookup });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ['https://public.test/start', 'https://public.test/next']);
});

test('safeFetch: credentials do not follow cross-origin redirects', async () => {
  const headers: Array<Headers | undefined> = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    headers.push(init?.headers ? new Headers(init.headers) : undefined);
    if (headers.length === 1) return new Response(null, { status: 307, headers: { location: 'https://other.test/next' } });
    return Response.json({ ok: true });
  }) as typeof fetch;

  await safeFetch(
    'https://public.test/start',
    { headers: { authorization: 'Bearer secret', 'x-api-key': 'secret', 'x-trace': 'keep' } },
    { fetchFn, lookup },
  );
  assert.equal(headers[0]!.get('authorization'), 'Bearer secret');
  assert.equal(headers[1]!.get('authorization'), null);
  assert.equal(headers[1]!.get('x-api-key'), null);
  assert.equal(headers[1]!.get('x-trace'), 'keep');
});

test('connector runtime: base URLs and redirects cannot reach the local network', async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: 'http://metadata.test/latest' } });
  }) as typeof fetch;
  const client = new ConnectorRuntimeImpl({
    registry: new ConnectorRegistry([spec()]),
    fetchFn,
    lookup,
  });

  await assert.rejects(client.execute({ connector: 'guarded', operation: 'read', input: {} }), /local network/);
  assert.equal(calls, 1);

  const local = new ConnectorRuntimeImpl({
    registry: new ConnectorRegistry([spec('http://router.lan')]),
    fetchFn,
    lookup,
  });
  await assert.rejects(local.execute({ connector: 'guarded', operation: 'read', input: {} }), /local network/);
  assert.equal(calls, 1);

  const allowed = new ConnectorRuntimeImpl({
    registry: new ConnectorRegistry([spec('http://router.lan')]),
    fetchFn: (async () => Response.json({ items: [{ id: '1' }] })) as typeof fetch,
    allowLocal: true,
  });
  const result = await allowed.execute({ connector: 'guarded', operation: 'read', input: {} });
  assert.equal(result.items.length, 1);
});

test('custom HTTP tools: private destinations need allowLocal', async () => {
  const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [] };
  const blocked = buildCustomTool({
    name: 'lan_admin',
    description: 'LAN admin',
    kind: 'http',
    params: [],
    settings: [],
    config: { method: 'GET', url: 'http://127.0.0.1:8080/admin' },
  });
  await assert.rejects(blocked.execute({}, context, {}), /local network/);

  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
  try {
    const allowed = buildCustomTool({
      name: 'lan_admin',
      description: 'LAN admin',
      kind: 'http',
      params: [],
      settings: [],
      config: { method: 'GET', url: 'http://127.0.0.1:8080/admin', allowLocal: true },
    });
    assert.equal(await allowed.execute({}, context, {}), 'ok');
  } finally {
    globalThis.fetch = original;
  }
});

test('connections: OAuth token endpoints cannot reach private addresses', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mimi-security-oauth-'));
  try {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return Response.json({ access_token: 'fresh' });
    }) as typeof fetch;
    const connections = new ConnectorConnections({
      dir,
      registry: new ConnectorRegistry([oauthSpec('http://169.254.169.254/token')]),
      secrets: new SecretStore(path.join(dir, 'secrets.json')),
      fetchFn,
      lookup,
      now: () => 1_000_000,
    });
    const saved = connections.save({
      connector: 'oauth_race',
      name: 'private-token',
      fields: {
        clientId: 'client',
        refreshToken: 'old-refresh',
        accessToken: 'expired',
        expiresAt: '1',
      },
    });

    await assert.rejects(connections.resolve('oauth_race', saved.id), /local network/);
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('connections: concurrent token refreshes share one request', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mimi-security-connections-'));
  try {
    const oauth = oauthSpec('https://auth.example/token');
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 });
    }) as typeof fetch;
    const connections = new ConnectorConnections({
      dir,
      registry: new ConnectorRegistry([oauth]),
      secrets: new SecretStore(path.join(dir, 'secrets.json')),
      fetchFn,
      now: () => 1_000_000,
    });
    const saved = connections.save({
      connector: 'oauth_race',
      name: 'race',
      fields: {
        clientId: 'client',
        refreshToken: 'old-refresh',
        accessToken: 'expired',
        expiresAt: '1',
      },
    });

    const [first, second, third] = await Promise.all([
      connections.resolve('oauth_race', saved.id),
      connections.resolve('oauth_race', saved.id),
      connections.resolve('oauth_race', saved.id),
    ]);
    assert.equal(calls, 1);
    for (const values of [first, second, third]) {
      assert.equal(values?.accessToken, 'fresh');
      assert.equal(values?.refreshToken, 'rotated');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
