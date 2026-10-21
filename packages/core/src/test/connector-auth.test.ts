import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ConnectorSpec } from '@mimi/shared';
import { SecretStore } from '../app/secrets.ts';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorConnections } from '../oauth/connections.ts';
import { slackConnector } from '../connectors/services/slack.ts';

const oauthConnector: ConnectorSpec = {
  key: 'oauth_demo',
  label: 'OAuth Demo',
  category: 'test',
  description: 'test-only oauth connector',
  baseUrl: 'https://api.example',
  auth: {
    kind: 'oauth2',
    tokenUrl: 'https://auth.example/token',
    authorizeUrl: 'https://auth.example/authorize',
    scopes: ['read'],
    extra: { pkce: true },
    fields: [
      { key: 'clientId', label: 'Client ID', type: 'string', required: true },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
      { key: 'refreshToken', label: 'Refresh token', type: 'secret', required: true },
      { key: 'accessToken', label: 'Access token', type: 'secret' },
      { key: 'expiresAt', label: 'Expires at', type: 'string' },
    ],
  },
  operations: [
    {
      key: 'read',
      label: 'Read',
      method: 'GET',
      path: '/read',
      risk: 'read',
      fields: [],
    },
  ],
};

function setup(fetchFn?: typeof fetch) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mimi-connections-'));
  const secrets = new SecretStore(path.join(dir, 'secrets.json'));
  const registry = new ConnectorRegistry([slackConnector, oauthConnector]);
  const connections = new ConnectorConnections({
    dir,
    registry,
    secrets,
    ...(fetchFn ? { fetchFn } : {}),
    now: () => 1_000_000,
  });
  return { dir, secrets, connections, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('connections: save, default, resolve, remove and no secret in views', async () => {
  const { dir, secrets, connections, cleanup } = setup();
  try {
    const first = connections.save({ connector: 'slack', name: 'งาน', fields: { botToken: 'xoxb-secret-one' } });
    const second = connections.save({ connector: 'slack', name: 'ส่วนตัว', fields: { botToken: 'xoxb-secret-two' } });
    assert.equal(first.default, true);
    assert.equal(second.default, false);
    const view = connections.views()[0]!;
    assert.equal(view.connected, true);
    assert.equal(view.hasSecret, true);
    assert.doesNotMatch(JSON.stringify(connections.views()), /xoxb-secret/);

    assert.deepEqual(await connections.resolve('slack'), { botToken: 'xoxb-secret-one' });
    assert.deepEqual(await connections.resolve('slack', second.id), { botToken: 'xoxb-secret-two' });
    connections.setDefault(second.id);
    assert.equal(connections.views('slack').find((entry) => entry.id === second.id)?.default, true);

    connections.remove(second.id);
    assert.equal(connections.views('slack').length, 1);
    assert.equal(secrets.get(`connector.${second.id}.botToken`), undefined);
    assert.equal(connections.find(second.id), undefined);
    await assert.rejects(connections.resolve('slack', second.id), /No connector connection/);
  } finally {
    cleanup();
    assert.ok(dir);
  }
});

test('connections: unknown connector and credential field are refused', () => {
  const { connections, cleanup } = setup();
  try {
    assert.throws(() => connections.save({ connector: 'nope', name: 'x' }), /Unknown connector/);
    assert.throws(
      () => connections.save({ connector: 'slack', name: 'x', fields: { nope: 'value' } }),
      /no credential field "nope"/,
    );
  } finally {
    cleanup();
  }
});

test('connections: OAuth2 refresh stores a fresh token and keeps secrets out of errors', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') });
    return Response.json({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 });
  }) as typeof fetch;
  const { secrets, connections, cleanup } = setup(fetchFn);
  try {
    const saved = connections.save({
      connector: 'oauth_demo',
      name: 'demo',
      fields: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'old-refresh',
        accessToken: 'old-access',
        expiresAt: '1',
      },
    });
    const values = await connections.resolve('oauth_demo', saved.id);
    assert.equal(values?.accessToken, 'fresh-access');
    assert.equal(values?.refreshToken, 'fresh-refresh');
    assert.equal(secrets.get(`connector.${saved.id}.accessToken`), 'fresh-access');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://auth.example/token');
    const body = new URLSearchParams(calls[0]!.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'old-refresh');

    const fresh = await connections.resolve('oauth_demo', saved.id);
    assert.equal(fresh?.accessToken, 'fresh-access');
    assert.equal(calls.length, 1);
  } finally {
    cleanup();
  }
});

test('connections: generic OAuth2 sign-in exchanges the code and stores tokens', async () => {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? '')) });
    return Response.json({ access_token: 'signed-access', refresh_token: 'signed-refresh', expires_in: 60 });
  }) as typeof fetch;
  const { secrets, connections, cleanup } = setup(fetchFn);
  try {
    const saved = connections.save({
      connector: 'oauth_demo',
      name: 'demo',
      fields: { clientId: 'client-id', clientSecret: 'client-secret' },
    });
    const flow = await connections.startConnect(saved.id);
    const authorize = new URL(flow.url);
    assert.equal(authorize.origin + authorize.pathname, 'https://auth.example/authorize');
    assert.equal(authorize.searchParams.get('client_id'), 'client-id');
    assert.equal(authorize.searchParams.get('response_type'), 'code');
    assert.equal(authorize.searchParams.get('scope'), 'read');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorize.searchParams.get('code_challenge'));
    const state = authorize.searchParams.get('state')!;
    const redirect = authorize.searchParams.get('redirect_uri')!;

    const callback = await fetch(`${redirect}?code=the-code&state=${state}`);
    assert.equal(callback.status, 200);
    await flow.done;

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://auth.example/token');
    assert.equal(calls[0]!.body.get('grant_type'), 'authorization_code');
    assert.equal(calls[0]!.body.get('code'), 'the-code');
    assert.equal(calls[0]!.body.get('redirect_uri'), redirect);
    assert.equal(calls[0]!.body.get('client_id'), 'client-id');
    assert.equal(calls[0]!.body.get('client_secret'), 'client-secret');
    assert.ok(calls[0]!.body.get('code_verifier'));

    assert.equal(secrets.get(`connector.${saved.id}.accessToken`), 'signed-access');
    assert.equal(secrets.get(`connector.${saved.id}.refreshToken`), 'signed-refresh');
    assert.equal(secrets.get(`connector.${saved.id}.expiresAt`), '1060000');
    assert.equal((await connections.resolve('oauth_demo', saved.id))?.accessToken, 'signed-access');
  } finally {
    cleanup();
  }
});

test('connections: failed OAuth2 refresh is readable and redacted', async () => {
  const fetchFn = (async () =>
    Response.json({ error: 'invalid_grant', error_description: 'refresh token expired' }, { status: 400 })) as typeof fetch;
  const { connections, cleanup } = setup(fetchFn);
  try {
    const saved = connections.save({
      connector: 'oauth_demo',
      name: 'demo',
      fields: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'old-refresh',
      },
    });
    await assert.rejects(connections.resolve('oauth_demo', saved.id), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /refresh token expired/);
      assert.doesNotMatch(error.message, /old-refresh|client-secret/);
      return true;
    });
  } finally {
    cleanup();
  }
});

test('connections: legacy vault keys still resolve without an account', async () => {
  const { secrets, connections, cleanup } = setup();
  try {
    secrets.set('connector.slack.botToken', 'xoxb-legacy');
    assert.deepEqual(await connections.resolve('slack'), { botToken: 'xoxb-legacy' });
  } finally {
    cleanup();
  }
});
