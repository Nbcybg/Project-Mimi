import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { WebSocket as WsClient } from 'ws';
import { API_VERSION, CLOSE_CLIENT_TOO_OLD, MIN_CLIENT_API, type ClientMessage, type ServerMessage } from '@mimi/shared';
import { openDb } from '../db/db.ts';
import { AccountStore } from '../gateway/accounts.ts';
import { startGateway } from '../gateway/gateway.ts';
import { NativePushSender, nativePushConfig, type NativePushMessage } from '../notify/native-push.ts';
import { NotificationCenter, type NativePushTransport } from '../notify/notifications.ts';
import { ModelCatalog } from '../providers/catalog.ts';
import { startServer } from '../server/server.ts';
import { testCoreParts } from './core-helpers.ts';
import { fakeModels, replyingModel, scriptedModel, textStep } from './helpers.ts';

// What the native apps (Android, iOS, macOS, Windows) need from a core that the web client
// never did: a version to check, push to FCM / APNs, Range answers, catching up on a chat
// without reloading it, and a core that need not serve the web pages at all.

const TOKEN = 'native-client-token-0123456789';
const CATALOG = new ModelCatalog({
  lab: { name: 'Lab', npm: '@ai-sdk/openai-compatible', api: 'http://127.0.0.1:1/v1', env: [], models: { flash: { name: 'Flash' } } },
});
const FCM_TOKEN = 'fcm-registration-token-abcdefghijklmnopqrstuvwxyz:APA91b';
const APNS_TOKEN = 'a'.repeat(64);

async function boot(t: TestContext, options: { replies?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const mimi = scriptedModel((options.replies ?? ['รับทราบค่ะ']).map((text) => textStep(text)));
  const parts = testCoreParts({ settings: { model: 'lab/flash', provider: { lab: {} } }, env: options.env });
  const server = await startServer(
    { ...parts.config, token: TOKEN, host: '127.0.0.1', port: 0 },
    { settings: parts.settings, catalog: CATALOG, models: fakeModels({ chat: mimi, small: replyingModel([{ text: 'nothing' }]), byModel: { mimi } }) },
  );
  const base = `http://127.0.0.1:${server.port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
    fs.rmSync(parts.root, { recursive: true, force: true });
  });
  const api = (pathname: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(`${base}${pathname}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers } });

  /** A socket with an inbox; `hello` is sent with the given client info. */
  const connect = async (client?: unknown) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(socket);
    const inbox: ServerMessage[] = [];
    let closed: number | null = null;
    let wake: (() => void) | null = null;
    socket.addEventListener('message', (event) => {
      inbox.push(JSON.parse(String(event.data)) as ServerMessage);
      wake?.();
    });
    socket.addEventListener('close', (event) => {
      closed = event.code;
      wake?.();
    });
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
    send({ type: 'hello', role: 'client', token: TOKEN, ...(client ? { client } : {}) } as ClientMessage);
    const ask = async <T extends ServerMessage['type']>(
      message: ClientMessage | null,
      type: T,
      match: (reply: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    ) => {
      const from = message ? inbox.length : 0;
      if (message) send(message);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const found = inbox.slice(from).find((reply): reply is Extract<ServerMessage, { type: T }> => reply.type === type && match(reply as never));
        if (found) return found;
        if (closed !== null) throw new Error(`socket closed (${closed})`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 100);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      throw new Error(`no "${type}"; got ${inbox.slice(from).map((reply) => reply.type).join(', ')}`);
    };
    const waitClosed = async () => {
      const deadline = Date.now() + 5000;
      while (closed === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      return closed;
    };
    return { send, ask, inbox, waitClosed };
  };
  return { server, base, api, connect };
}

test('version: /health, the x-mimi-api header and welcome say which client API the core speaks', async (t) => {
  const app = await boot(t);
  const health = await fetch(`${app.base}/health`);
  assert.deepEqual(
    [health.headers.get('x-mimi-api'), ((await health.json()) as { api: number; minClientApi: number }).api],
    [String(API_VERSION), API_VERSION],
  );
  assert.equal((await app.api('/api/widget')).headers.get('x-mimi-api'), String(API_VERSION), 'API answers carry it too');
  assert.equal((await app.api('/api/widget', {}, null)).headers.get('x-mimi-api'), String(API_VERSION), 'even a 401');

  const client = await app.connect({ platform: 'android', version: '1.0.0', api: API_VERSION });
  const welcome = await client.ask(null, 'welcome');
  assert.deepEqual([welcome.api, welcome.minClientApi, typeof welcome.version], [API_VERSION, MIN_CLIENT_API, 'string']);

  // The web client sends no client info and keeps working.
  await (await app.connect()).ask(null, 'welcome');

  // An app built for an API the core no longer serves is told to update.
  const old = await app.connect({ platform: 'ios', version: '0.1.0', api: MIN_CLIENT_API - 1 });
  assert.equal(await old.waitClosed(), CLOSE_CLIENT_TOO_OLD);
  assert.equal(old.inbox.length, 0);
});

test('errors name the message they answer; unknown types get E-PROTOCOL', async (t) => {
  const app = await boot(t);
  const client = await app.connect();
  await client.ask(null, 'welcome');
  const unknown = await client.ask({ type: 'from-the-future' } as unknown as ClientMessage, 'error');
  assert.deepEqual([unknown.code, unknown.requestType], ['E-PROTOCOL', 'from-the-future']);
  const failed = await client.ask({ type: 'chat-open', chatId: 9999 }, 'error');
  assert.equal(failed.requestType, 'chat-open');
});

test('the server never serves a page or script; backdrops, icon and /health stay', async (t) => {
  const app = await boot(t);
  const root = await fetch(`${app.base}/`);
  assert.equal(root.status, 404);
  assert.match(await root.text(), /API only/);
  for (const gone of ['/index.html', '/app.js', '/app.css', '/sw.js', '/manifest.webmanifest', '/offline.html', '/vendor/three.module.js', '/sounds/chat_1.mp3']) {
    assert.equal((await fetch(`${app.base}${gone}`)).status, 404, gone);
  }
  for (const kept of ['/health', '/icon.png', '/backgrounds/floral.webp']) {
    assert.equal((await fetch(`${app.base}${kept}`)).status, 200, kept);
  }
  for (const name of ['floral', 'mint', 'blush', 'sky', 'grid', 'starlight', 'dawn', 'ember', 'crimson', 'waves', 'confetti']) {
    const response = await fetch(`${app.base}/backgrounds/${name}.webp?v=1`);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), 'image/webp', name);
    const data = Buffer.from(await response.arrayBuffer());
    assert.equal(data.subarray(0, 4).toString(), 'RIFF', name);
    assert.equal(data.subarray(8, 12).toString(), 'WEBP', name);
  }
  assert.equal((await fetch(`${app.base}/backgrounds/nope.webp`)).status, 404);
  assert.equal((await fetch(`${app.base}/backgrounds/..%2Fpackage.json`)).status, 404);
  await (await app.connect()).ask(null, 'welcome');
});

test('a UI bundled in an app may call the API: CORS for the app origins only', async (t) => {
  const app = await boot(t, { env: { MIMI_ALLOWED_ORIGINS: 'https://ui.example.com/' } });
  for (const origin of ['app://mimi', 'tauri://localhost', 'http://tauri.localhost', 'https://ui.example.com']) {
    const preflight = await fetch(`${app.base}/api/widget`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    assert.equal(preflight.status, 204, origin);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /authorization/);
    const answer = await app.api('/api/widget', { headers: { origin } });
    assert.equal(answer.status, 200, origin);
    assert.equal(answer.headers.get('access-control-allow-origin'), origin);
    assert.match(answer.headers.get('access-control-expose-headers') ?? '', /x-mimi-api/);
    assert.equal((await fetch(`${app.base}/health`, { headers: { origin } })).headers.get('access-control-allow-origin'), origin);
  }
  // Any other page: the preflight is refused and the answer carries no permission to read it.
  const other = 'https://evil.example';
  assert.equal((await fetch(`${app.base}/api/widget`, { method: 'OPTIONS', headers: { origin: other, 'access-control-request-method': 'GET' } })).status, 403);
  assert.equal((await app.api('/api/widget', { headers: { origin: other } })).headers.get('access-control-allow-origin'), null);
  // No Origin (native apps, scripts): untouched.
  assert.equal((await app.api('/api/widget')).headers.get('access-control-allow-origin'), null);
});

test('the WebSocket accepts the app origins and refuses other pages', async (t) => {
  const app = await boot(t);
  const open = (origin: string) =>
    new Promise<boolean>((resolve) => {
      const socket = new WsClient(`ws://127.0.0.1:${new URL(app.base).port}/ws`, { headers: { origin } });
      socket.on('open', () => (socket.close(), resolve(true)));
      socket.on('error', () => resolve(false));
    });
  assert.equal(await open('app://mimi'), true);
  assert.equal(await open('https://evil.example'), false);
});

test('chat files answer Range requests and keep their safety headers', async (t) => {
  const app = await boot(t);
  const bytes = Buffer.from('0123456789abcdef');
  const upload = (await (await app.api('/api/upload?name=clip.mp4', { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: bytes })).json()) as { id: string };
  const whole = await app.api(`/api/files/${upload.id}`);
  assert.deepEqual([whole.status, whole.headers.get('accept-ranges'), whole.headers.get('content-type')], [200, 'bytes', 'video/mp4']);
  assert.match(whole.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);
  const part = await app.api(`/api/files/${upload.id}`, { headers: { range: 'bytes=4-7' } });
  assert.deepEqual([part.status, part.headers.get('content-range'), await part.text()], [206, 'bytes 4-7/16', '4567']);
  assert.equal((await app.api(`/api/files/${upload.id}`, { headers: { range: 'bytes=99-' } })).status, 416);
  // A type that must never render in place is still a download.
  const text = (await (await app.api('/api/upload?name=a.html', { method: 'POST', headers: { 'content-type': 'text/html' }, body: '<b>x</b>' })).json()) as { id: string };
  const download = await app.api(`/api/files/${text.id}`);
  assert.deepEqual([download.headers.get('content-type'), (download.headers.get('content-disposition') ?? '').split(';')[0]], ['application/octet-stream', 'attachment']);
});

test('a finished turn sends its stored replies with ids; chat-open afterId catches up', async (t) => {
  const app = await boot(t, { replies: ['ตอบครั้งแรก', 'ตอบครั้งที่สอง'] });
  const client = await app.connect({ platform: 'android', api: API_VERSION });
  await client.ask(null, 'welcome');
  const opened = await client.ask({ type: 'chat-create', kind: 'direct', agents: ['mimi'] }, 'chat-history');
  const chatId = opened.chat.id;

  client.send({ type: 'chat-send', chatId, text: 'สวัสดี', clientId: 'c-1' });
  const echo = await client.ask(null, 'chat-message', (reply) => reply.message.clientId === 'c-1');
  const saved = await client.ask(null, 'chat-turn-messages');
  assert.equal(saved.chatId, chatId);
  assert.equal(saved.afterId, echo.message.id);
  assert.deepEqual(saved.messages.map((message) => [message.role, message.text]), [['assistant', 'ตอบครั้งแรก']]);
  assert.ok(saved.messages[0]!.id > echo.message.id);
  // It comes before the turn is over, so a client can swap the bubble before `busy done`.
  const order = client.inbox.map((message) => message.type);
  assert.ok(order.indexOf('chat-turn-messages') < order.lastIndexOf('busy'));
  await client.ask(null, 'busy', (reply) => reply.chatId === chatId && reply.done === true);

  // Another device missed the second turn: it asks only for what came after the last id it has.
  const last = saved.messages[0]!.id;
  client.send({ type: 'chat-send', chatId, text: 'อีกครั้ง' });
  await client.ask(null, 'chat-turn-messages', (reply) => reply.afterId > last);
  const caughtUp = await client.ask({ type: 'chat-open', chatId, afterId: last }, 'chat-history', (reply) => reply.afterId === last);
  assert.deepEqual(caughtUp.messages.map((message) => message.text), ['อีกครั้ง', 'ตอบครั้งที่สอง']);
  assert.equal(caughtUp.hasMore, false);
  const full = await client.ask({ type: 'chat-open', chatId }, 'chat-history', (reply) => reply.afterId === undefined && reply.messages.length === 4);
  assert.equal(full.messages.length, 4);
  assert.match((await client.ask({ type: 'chat-open', chatId, afterId: -1 }, 'error')).message, /afterId/);
});

test('native push tokens: register over HTTP or the socket, list, remove; bad tokens refused', async (t) => {
  const app = await boot(t);
  const client = await app.connect();
  await client.ask(null, 'welcome');

  const refused = await app.api('/api/push/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'apns', token: 'not-hex' }) });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /APNs device token/);
  assert.equal((await app.api('/api/push/register', { method: 'POST', body: '{}' }, null)).status, 401);

  const made = await app.api('/api/push/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'fcm', token: FCM_TOKEN, label: 'Pixel 8', appVersion: '1.0.0' }),
  });
  const registered = (await made.json()) as { ok: boolean; delivering: boolean; device: { endpoint: string; platform: string; service: string; label: string } };
  // No FCM credentials on this core: stored, but nothing will be delivered.
  assert.deepEqual([registered.ok, registered.delivering, registered.device.platform, registered.device.service, registered.device.label], [true, false, 'fcm', 'fcm.googleapis.com', 'Pixel 8']);
  assert.match(registered.device.endpoint, /^native:fcm:[0-9a-f]{16}$/);
  assert.ok(!registered.device.endpoint.includes(FCM_TOKEN), 'the token itself is never listed');
  await client.ask(null, 'push-devices', (reply) => reply.devices.length === 1);

  client.send({ type: 'native-push-register', platform: 'apns', token: APNS_TOKEN, label: 'iPhone', sandbox: true });
  const both = await client.ask(null, 'push-devices', (reply) => reply.devices.length === 2);
  const iphone = both.devices.find((device) => device.platform === 'apns')!;
  assert.equal(iphone.service, 'api.push.apple.com');

  // The settings screen removes a device by its endpoint, web or native alike.
  client.send({ type: 'push-unsubscribe', endpoint: iphone.endpoint });
  await client.ask(null, 'push-devices', (reply) => reply.devices.length === 1);
  const removed = (await (await app.api('/api/push/unregister', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: FCM_TOKEN }) })).json()) as { removed: boolean };
  assert.equal(removed.removed, true);
  await client.ask(null, 'push-devices', (reply) => reply.devices.length === 0);
});

test('notifications: afterId lists read and unread; answers from a notification button work over HTTP', async (t) => {
  const app = await boot(t);
  app.server.core.notify({ kind: 'reminder', title: 'ยา', body: 'กินยา' });
  app.server.core.notify({ kind: 'info', title: 'note', body: 'ข้อมูล' });
  const all = (await (await app.api('/api/notifications?afterId=0')).json()) as Array<{ id: number; read: boolean; title: string }>;
  assert.deepEqual(all.map((item) => [item.title, item.read]), [['ยา', false], ['note', false]]);
  app.server.core.notifications.markRead([all[0]!.id]);
  const after = (await (await app.api(`/api/notifications?afterId=${all[0]!.id - 1}`)).json()) as Array<{ read: boolean }>;
  assert.deepEqual(after.map((item) => item.read), [true, false], 'read on another device shows as read');
  const legacy = (await (await app.api('/api/notifications')).json()) as unknown[];
  assert.equal(legacy.length, 1, 'without afterId: unread only, as the old Android app expects');
  assert.equal((await app.api('/api/notifications?afterId=x')).status, 400);

  const json = { method: 'POST', headers: { 'content-type': 'application/json' } };
  assert.equal((await app.api('/api/permissions/no-such-request', { ...json, body: JSON.stringify({ allow: true }) })).status, 404);
  assert.equal((await app.api('/api/approvals/12345', { ...json, body: JSON.stringify({ approved: true }) })).status, 404);
  assert.equal((await app.api('/api/approvals/abc', { ...json, body: '{}' })).status, 400);
});

test('api 2: Mimiamp is gone (no songs, playlists or YouTube audio)', async (t) => {
  const app = await boot(t);
  for (const gone of ['/mimiamp/tracks.json', '/mimiamp/song.mp3', '/mimiamp/youtube/dQw4w9WgXcQ.audio', '/feature-mimiamp.js']) {
    assert.equal((await fetch(`${app.base}${gone}`)).status, 404, gone);
  }
  for (const gone of ['/api/mimiamp/state', '/api/mimiamp/playlists', '/api/mimiamp/youtube/search?q=x']) {
    assert.equal((await app.api(gone)).status, 404, gone);
  }
  assert.equal((await app.api('/api/mimiamp/files?name=x.mp3', { method: 'POST', body: 'x' })).status, 404);
});

test('gateway: /health says the api; /mimiamp/* is gone with or without a session', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-gw-native-'));
  const accounts = new AccountStore(path.join(dir, 'accounts.db'), 'gateway-secret-for-tests-0123456789abcdef', { passwordCost: 1024 });
  const made = await accounts.create('alice', 'alice-password-1', 'http://127.0.0.1:1');
  const parts = testCoreParts();
  const core = await startServer({ ...parts.config, token: made.coreToken, host: '127.0.0.1', port: 0 }, parts.coreOptions);
  accounts.setCoreUrl('alice', `http://127.0.0.1:${core.port}`);
  const gateway = await startGateway({ accounts, host: '127.0.0.1', port: 0, log: () => {} });
  t.after(async () => {
    await gateway.close();
    await core.close();
    accounts.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(parts.root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${gateway.port}`;
  const health = (await (await fetch(`${base}/health`)).json()) as { api: number; minClientApi: number; accounts: boolean };
  assert.deepEqual([health.api, health.minClientApi, health.accounts], [API_VERSION, MIN_CLIENT_API, true]);

  const login = (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'alice-password-1' }) })).json()) as { token: string };
  assert.equal((await fetch(`${base}/mimiamp/tracks.json`, { headers: { authorization: `Bearer ${login.token}` } })).status, 404);
  assert.equal((await fetch(`${base}/mimiamp/tracks.json`)).status, 404);
});

// ---------- the FCM / APNs senders against stand-in services ----------

const message: NativePushMessage = { id: 7, kind: 'message', title: 'มิมิ', body: 'ข้อความลับ', chatId: 3, unread: 2 };

function decodeJwt(jwt: string) {
  const [header, claims, signature] = jwt.split('.') as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, unknown>,
    signed: Buffer.from(`${header}.${claims}`),
    signature: Buffer.from(signature, 'base64url'),
  };
}

async function listen(server: http.Server | http2.Http2Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('FCM: a signed service-account JWT buys an access token; pushes carry no text by default; dead tokens are gone', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const seen: Array<{ url: string; auth?: string; body: string }> = [];
  let exchanges = 0;
  const service = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      seen.push({ url: request.url ?? '', auth: request.headers.authorization, body });
      if (request.url === '/token') {
        exchanges++;
        const assertion = new URLSearchParams(body).get('assertion')!;
        const jwt = decodeJwt(assertion);
        const ok = verify('RSA-SHA256', jwt.signed, publicKey, jwt.signature) && jwt.claims.scope === 'https://www.googleapis.com/auth/firebase.messaging';
        response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { access_token: 'ya29.test', expires_in: 3600 } : {}));
        return;
      }
      const gone = JSON.parse(body).message.token === 'dead-token-0123456789';
      response.writeHead(gone ? 404 : 200, { 'content-type': 'application/json' }).end(gone ? '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' : '{"name":"x"}');
    });
  });
  const url = await listen(service);
  t.after(() => service.close());

  const account = JSON.stringify({ project_id: 'mimi-test', client_email: 'push@mimi-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${url}/token` });
  const config = { ...nativePushConfig({ MIMI_FCM_SERVICE_ACCOUNT: account }), fcmBaseUrl: url };
  assert.equal(config.content, 'minimal');
  const sender = new NativePushSender(config);
  assert.deepEqual([sender.available('fcm'), sender.available('apns')], [true, false]);

  assert.deepEqual(await sender.send({ platform: 'fcm', token: 'live-token-0123456789' }, message, 'high'), { ok: true });
  const sent = seen.find((entry) => entry.url.startsWith('/v1/'))!;
  assert.equal(sent.url, '/v1/projects/mimi-test/messages:send');
  assert.equal(sent.auth, 'Bearer ya29.test');
  const fcm = JSON.parse(sent.body).message as { token: string; data: Record<string, string>; android: { priority: string } };
  assert.deepEqual([fcm.token, fcm.android.priority, fcm.data.id, fcm.data.chatId, fcm.data.unread, fcm.data.kind], ['live-token-0123456789', 'HIGH', '7', '3', '2', 'message']);
  assert.ok(!sent.body.includes('ข้อความลับ'), 'the message text does not travel through Google');
  assert.ok(Object.values(fcm.data).every((value) => typeof value === 'string'), 'FCM data values are strings');

  const dead = await sender.send({ platform: 'fcm', token: 'dead-token-0123456789' }, message, 'normal');
  assert.deepEqual([dead.ok, !dead.ok && dead.gone], [false, true]);
  assert.equal(exchanges, 1, 'the access token is reused');

  const full = new NativePushSender({ ...config, content: 'full' });
  await full.send({ platform: 'fcm', token: 'live-token-0123456789' }, message, 'normal');
  assert.ok(seen.at(-1)!.body.includes('ข้อความลับ'), 'MIMI_NATIVE_PUSH_CONTENT=full sends the text');
});

test('APNs: an ES256 provider token, the topic and priority headers; 410 means the token is gone', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const requests: Array<{ headers: http2.IncomingHttpHeaders; body: string }> = [];
  const service = http2.createServer();
  service.on('stream', (stream, headers) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => (body += chunk));
    stream.on('end', () => {
      requests.push({ headers, body });
      const gone = String(headers[':path']).endsWith('b'.repeat(64));
      stream.respond({ ':status': gone ? 410 : 200, 'content-type': 'application/json' });
      stream.end(gone ? '{"reason":"Unregistered"}' : '');
    });
  });
  const url = await listen(service);
  t.after(() => service.close());

  const config = {
    ...nativePushConfig({ MIMI_APNS_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n'), MIMI_APNS_KEY_ID: 'KEY123', MIMI_APNS_TEAM_ID: 'TEAM456', MIMI_APNS_TOPIC: 'app.mimi.ios' }),
    apnsHost: url,
    apnsSandboxHost: url,
  };
  const sender = new NativePushSender(config);
  assert.equal(sender.available('apns'), true);
  assert.deepEqual(await sender.send({ platform: 'apns', token: APNS_TOKEN, sandbox: true }, message, 'high'), { ok: true });
  const sent = requests[0]!;
  assert.deepEqual(
    [sent.headers[':path'], sent.headers['apns-topic'], sent.headers['apns-priority'], sent.headers['apns-push-type']],
    [`/3/device/${APNS_TOKEN}`, 'app.mimi.ios', '10', 'alert'],
  );
  const jwt = decodeJwt(String(sent.headers.authorization).replace(/^bearer /, ''));
  assert.deepEqual([jwt.header.alg, jwt.header.kid, jwt.claims.iss], ['ES256', 'KEY123', 'TEAM456']);
  assert.ok(verify('sha256', jwt.signed, { key: publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature), 'signed with the .p8 key');
  const payload = JSON.parse(sent.body) as { aps: { alert: { title: string; body: string }; badge: number; 'mutable-content': number; 'thread-id': string }; id: number };
  assert.deepEqual([payload.aps.badge, payload.aps['mutable-content'], payload.aps['thread-id'], payload.id], [2, 1, 'chat-3', 7]);
  assert.ok(!sent.body.includes('ข้อความลับ'), 'no text through Apple by default');

  const gone = await sender.send({ platform: 'apns', token: 'b'.repeat(64), bundleId: 'app.mimi.mac' }, message, 'normal');
  assert.deepEqual([gone.ok, !gone.ok && gone.gone, requests[1]!.headers['apns-topic'], requests[1]!.headers['apns-priority']], [false, true, 'app.mimi.mac', '5']);
});

test('the notification center pushes to apps too and forgets the ones that are gone', async () => {
  const db = openDb(':memory:');
  const sent: Array<{ platform: string; token: string; text: string; unread: number }> = [];
  const native: NativePushTransport = {
    available: (platform) => platform === 'fcm',
    send: async (target, pushed) => {
      sent.push({ platform: target.platform, token: target.token, text: pushed.body, unread: pushed.unread });
      return target.token.startsWith('gone') ? { ok: false, gone: true, status: 404, reason: 'UNREGISTERED' } : { ok: true };
    },
  };
  const center = new NotificationCenter(db, { vapid: () => ({ publicKey: 'x', privateKey: 'y' }) as never, subject: 'mailto:x@y', send: async () => ({ status: 201, gone: false }), native });
  center.registerNative({ platform: 'fcm', token: `live-${FCM_TOKEN}` });
  center.registerNative({ platform: 'fcm', token: `gone-${FCM_TOKEN}` });
  center.registerNative({ platform: 'apns', token: APNS_TOKEN }); // no APNs key on this core: skipped
  center.subscribe({ endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' }, 'browser');

  const delivered = await center.push({ id: 1, kind: 'reminder', title: 't', body: 'กินยา', chatId: undefined });
  assert.equal(delivered, 2, 'the browser and the live app');
  assert.deepEqual(sent.map((entry) => entry.platform).sort(), ['fcm', 'fcm']);
  assert.deepEqual(center.devices().map((device) => device.platform ?? 'web').sort(), ['apns', 'fcm', 'web'], 'the gone token was forgotten');
  assert.ok(center.devices().find((device) => device.platform === 'fcm')?.lastOkAt);

  // Registering the same token again updates it instead of adding a second device.
  center.registerNative({ platform: 'fcm', token: `live-${FCM_TOKEN}`, label: 'renamed' });
  assert.equal(center.devices().filter((device) => device.platform === 'fcm').length, 1);
  assert.equal(center.devices().find((device) => device.platform === 'fcm')?.label, 'renamed');
  db.close();
});
