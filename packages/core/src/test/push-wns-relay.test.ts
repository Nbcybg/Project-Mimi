import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AccountStore } from '../gateway/accounts.ts';
import { startGateway } from '../gateway/gateway.ts';
import { NativePushSender, nativePushConfig, type NativePushMessage, type NativePushTarget, wnsChannelOk } from '../notify/native-push.ts';
import { corePushTransport } from '../notify/push-relay.ts';
import { startServer } from '../server/server.ts';
import { testCoreParts } from './core-helpers.ts';

// Windows push (WNS) and the push relay of the accounts gateway (Q3: the FCM / APNs / WNS keys
// live only on the gateway; every core sends its pushes there with its own token).

const message: NativePushMessage = { id: 9, kind: 'approval', title: 'มิมิ', body: 'ข้อความลับ', chatId: 4, unread: 1 };
const CHANNEL = 'https://wns2-sg2p.notify.windows.com/w/?token=AwYAAABq%2bWNS';

test('WNS: only Microsoft channel URIs; an Entra ID token buys raw pushes without the text; 410 means gone', async () => {
  assert.equal(wnsChannelOk(CHANNEL), true);
  for (const bad of ['http://wns2-sg2p.notify.windows.com/w/', 'https://notify.windows.com.evil.example/w', 'https://evil.example/?h=notify.windows.com', 'https://a.notify.windows.com:8443/w', 'not a url']) {
    assert.equal(wnsChannelOk(bad), false, bad);
  }

  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let tokens = 0;
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
    calls.push({ url, headers, body: String(init?.body ?? '') });
    if (url.startsWith('https://login.microsoftonline.com/')) {
      tokens++;
      return new Response(JSON.stringify({ access_token: 'wns-access', expires_in: 3600 }), { status: 200 });
    }
    return new Response('', { status: url.includes('expired') ? 410 : 200 });
  };
  const config = nativePushConfig({ MIMI_WNS_TENANT_ID: 'tenant-1', MIMI_WNS_CLIENT_ID: 'app-guid', MIMI_WNS_CLIENT_SECRET: 'secret' });
  const sender = new NativePushSender(config, { fetch: fake });
  assert.deepEqual([sender.available('wns'), sender.available('fcm'), sender.wnsRemoteId], [true, false, 'app-guid']);

  assert.deepEqual(await sender.send({ platform: 'wns', token: CHANNEL }, message, 'high'), { ok: true });
  const login = calls[0]!;
  assert.equal(login.url, 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
  const form = new URLSearchParams(login.body);
  assert.deepEqual([form.get('grant_type'), form.get('client_id'), form.get('scope')], ['client_credentials', 'app-guid', 'https://wns.windows.com/.default']);
  const push = calls[1]!;
  assert.equal(push.url, CHANNEL);
  assert.deepEqual([push.headers.authorization, push.headers['x-wns-type']], ['Bearer wns-access', 'wns/raw']);
  const raw = JSON.parse(push.body) as Record<string, unknown>;
  assert.deepEqual([raw.id, raw.kind, raw.chatId, raw.unread, raw.content], [9, 'approval', 4, 1, 'minimal']);
  assert.ok(!push.body.includes('ข้อความลับ'), 'the text does not travel through Microsoft');

  const gone = await sender.send({ platform: 'wns', token: 'https://wns2-sg2p.notify.windows.com/w/?token=expired' }, message, 'normal');
  assert.deepEqual([gone.ok, !gone.ok && gone.gone], [false, true]);
  // A made-up address never gets the token.
  const before = calls.length;
  const refused = await sender.send({ platform: 'wns', token: 'https://evil.example/w' }, message, 'normal');
  assert.deepEqual([refused.ok, !refused.ok && refused.gone, calls.length], [false, true, before]);
  assert.equal(tokens, 1, 'the access token is reused');
});

test('relay: a core without keys pushes through the gateway with its own token; the app learns the WNS remote id', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-relay-'));
  const accounts = new AccountStore(path.join(dir, 'accounts.db'), 'gateway-secret-for-tests-0123456789abcdef', { passwordCost: 1024 });
  const made = await accounts.create('alice', 'alice-password-1', 'http://127.0.0.1:1');
  const pushed: Array<{ target: NativePushTarget; urgency: string }> = [];
  const gateway = await startGateway({
    accounts,
    host: '127.0.0.1',
    port: 0,
    log: () => {},
    push: {
      available: (platform) => platform === 'wns',
      wnsRemoteId: 'gateway-app-guid',
      send: async (target, _message, urgency) => {
        pushed.push({ target, urgency });
        return target.token.includes('expired') ? { ok: false, gone: true, status: 410, reason: 'expired' } : { ok: true };
      },
    },
  });
  const relayUrl = `http://127.0.0.1:${gateway.port}`;
  const parts = testCoreParts({ env: { MIMI_PUSH_RELAY_URL: relayUrl } });
  const core = await startServer({ ...parts.config, token: made.coreToken, host: '127.0.0.1', port: 0 }, parts.coreOptions);
  t.after(async () => {
    await core.close();
    await gateway.close();
    accounts.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(parts.root, { recursive: true, force: true });
  });
  const api = (pathname: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${core.port}${pathname}`, { ...init, headers: { authorization: `Bearer ${made.coreToken}`, 'content-type': 'application/json', ...init.headers } });

  // What the Windows app asks before it makes its channel.
  assert.deepEqual(await (await api('/api/push/info')).json(), { platforms: ['wns'], wnsRemoteId: 'gateway-app-guid' });
  const registered = (await (await api('/api/push/register', { method: 'POST', body: JSON.stringify({ platform: 'wns', token: CHANNEL, label: 'PC' }) })).json()) as { delivering: boolean; device: { service: string } };
  assert.deepEqual([registered.delivering, registered.device.service], [true, 'notify.windows.com']);
  const bad = await api('/api/push/register', { method: 'POST', body: JSON.stringify({ platform: 'wns', token: 'https://evil.example/w' }) });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /WNS channel URI/);

  // The core's transport, as the notification center uses it.
  const transport = corePushTransport(nativePushConfig({ MIMI_PUSH_RELAY_URL: relayUrl }), made.coreToken)!;
  assert.deepEqual(await transport.send({ platform: 'wns', token: CHANNEL }, message, 'high'), { ok: true });
  const gone = await transport.send({ platform: 'wns', token: `${CHANNEL}expired` }, message, 'normal');
  assert.deepEqual([gone.ok, !gone.ok && gone.gone], [false, true], 'the push service answer comes back to the core');
  assert.deepEqual(pushed.map((entry) => entry.urgency), ['high', 'normal']);
  const noKeys = await transport.send({ platform: 'fcm', token: 'fcm-token-0123456789abcdef' }, message, 'normal');
  assert.match(!noKeys.ok ? noKeys.reason : '', /no fcm credentials on the gateway/);

  // Only a core's own token opens the relay; a person's session token does not.
  const stranger = corePushTransport(nativePushConfig({ MIMI_PUSH_RELAY_URL: relayUrl }), 'not-a-core-token-0123456789')!;
  const refused = await stranger.send({ platform: 'wns', token: CHANNEL }, message, 'normal');
  assert.deepEqual([refused.ok, !refused.ok && refused.status], [false, 401]);
  const login = (await (await fetch(`${relayUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'alice-password-1' }) })).json()) as { token: string };
  assert.equal((await fetch(`${relayUrl}/push/relay`, { headers: { authorization: `Bearer ${login.token}` } })).status, 401);
  assert.equal(pushed.length, 2);
});
