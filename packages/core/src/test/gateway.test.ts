import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import Database from 'better-sqlite3';
import type { ServerMessage } from '@mimi/shared';
import { WebSocket } from 'ws';
import { AccountStore } from '../gateway/accounts.ts';
import { type Gateway, startGateway } from '../gateway/gateway.ts';
import { type MimiServer, startServer } from '../server/server.ts';
import { type TestCoreOptions, testCoreParts } from './core-helpers.ts';
import { scriptedModel, textStep, toolStep } from './helpers.ts';

// Each person has their own core (on Railway: a service with its own volume). Here two
// cores run in this process as stand-ins; everything a device does goes through the gateway.

const SECRET = 'gateway-secret-for-tests-0123456789abcdef';
const PASSWORD = { alice: 'alice-password-1', bob: 'bob-password-22' } as const;
type Who = keyof typeof PASSWORD;

interface Person {
  core: MimiServer;
  root: string;
  coreToken: string;
  webhookBase: string;
}

interface Booted {
  gateway: Gateway;
  accounts: AccountStore;
  dbFile: string;
  http: string;
  ws: string;
  people: Record<Who, Person>;
  stop(): Promise<void>;
}

/** Starts two people's cores and the gateway; they are stopped after the test, pass or fail. */
async function boot(t: TestContext, options: { alice?: TestCoreOptions; now?: () => number; realCost?: boolean } = {}): Promise<Booted> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-gateway-'));
  const dbFile = path.join(dir, 'accounts.db');
  // A cheap scrypt keeps the suite fast; the first test checks the real cost.
  const accounts = new AccountStore(dbFile, SECRET, { now: options.now, passwordCost: options.realCost ? undefined : 1024 });
  const people = {} as Record<Who, Person>;
  for (const who of ['alice', 'bob'] as const) {
    // The account comes first: it makes the token the core must be started with.
    const made = await accounts.create(who, PASSWORD[who], 'http://127.0.0.1:1');
    const parts = testCoreParts(who === 'alice' ? options.alice : {});
    const core = await startServer(
      { ...parts.config, token: made.coreToken, host: '127.0.0.1', port: 0, localPcTools: true },
      parts.coreOptions,
    );
    accounts.setCoreUrl(who, `http://127.0.0.1:${core.port}`);
    people[who] = { core, root: parts.root, coreToken: made.coreToken, webhookBase: made.webhookBase };
  }
  const gateway = await startGateway({ accounts, host: '127.0.0.1', port: 0, clientIpHeader: 'x-real-ip', sweepMs: 100, log: () => {} });
  const booted: Booted = {
    gateway,
    accounts,
    dbFile,
    http: `http://127.0.0.1:${gateway.port}`,
    ws: `ws://127.0.0.1:${gateway.port}/ws`,
    people,
    async stop() {
      await gateway.close();
      for (const person of Object.values(people)) {
        await person.core.close();
        fs.rmSync(person.root, { recursive: true, force: true });
      }
      accounts.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  t.after(() => booted.stop());
  return booted;
}

let nextIp = 1;
/** Every test signs in from its own address so the per-address limit of one test cannot touch another. */
const freshIp = () => `198.51.100.${nextIp++}`;

async function login(booted: Booted, who: Who, password: string = PASSWORD[who], ip = freshIp()): Promise<Response> {
  return fetch(`${booted.http}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({ username: who, password }),
  });
}

async function session(booted: Booted, who: Who): Promise<string> {
  const response = await login(booted, who);
  assert.equal(response.status, 200);
  return ((await response.json()) as { token: string }).token;
}

const authed = (token: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${token}`, 'x-real-ip': freshIp(), ...(init.headers as Record<string, string> | undefined) },
});

/** A device on the gateway's socket, as the web client is. */
class Device {
  readonly received: ServerMessage[] = [];
  closeCode: number | null = null;
  private readonly socket: WebSocket;
  private readonly waiters: Array<() => void> = [];

  constructor(url: string, token: string, role: 'client' | 'pc' = 'client') {
    this.socket = new WebSocket(url, { headers: { 'x-real-ip': freshIp() } });
    this.socket.on('open', () => this.socket.send(JSON.stringify({ type: 'hello', role, token, name: 'test', allowedDirs: [], tools: [] })));
    this.socket.on('message', (data) => {
      this.received.push(JSON.parse(String(data)) as ServerMessage);
      this.waiters.splice(0).forEach((wake) => wake());
    });
    this.socket.on('close', (code) => {
      this.closeCode = code;
      this.waiters.splice(0).forEach((wake) => wake());
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor<T extends ServerMessage['type']>(type: T, timeoutMs = 4000): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const found = this.received.find((message) => message.type === type);
      if (found) return found as Extract<ServerMessage, { type: T }>;
      if (this.closeCode !== null) throw new Error(`socket closed (${this.closeCode}) while waiting for ${type}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}; got ${this.received.map((m) => m.type).join(', ')}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async closed(timeoutMs = 4000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error('socket did not close');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.closeCode;
  }

  close(): void {
    this.socket.close();
  }
}

async function poll<T>(fn: () => T | undefined, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('poll timed out');
}

test('accounts: salted scrypt passwords, hashed session tokens, encrypted core tokens', async (t) => {
  const booted = await boot(t, { realCost: true });
  const token = await session(booted, 'alice');
  const raw = new Database(booted.dbFile, { readonly: true });
  const users = raw.prepare('SELECT username, password_hash, core_token FROM users').all() as Array<Record<string, string>>;
  const sessions = raw.prepare('SELECT token_hash FROM sessions').all() as Array<{ token_hash: string }>;
  raw.close();
  for (const user of users) {
    assert.match(user.password_hash!, /^scrypt\$32768\$8\$1\$[\w+/=]+\$[\w+/=]+$/);
    assert.ok(!user.password_hash!.includes(PASSWORD[user.username as Who]));
    assert.ok(!user.core_token!.includes(booted.people[user.username as Who].coreToken), 'the core token is not stored in clear');
  }
  const [a, b] = users.map((user) => user.password_hash!.split('$')[4]);
  assert.notEqual(a, b, 'a salt per account');
  assert.equal(sessions.length, 1);
  assert.ok(!sessions[0]!.token_hash.includes(token) && sessions[0]!.token_hash.length === 64, 'only a hash of the session token');
  assert.equal(fs.statSync(booted.dbFile).mode & 0o077, 0, 'the database is readable by its owner only');

  // Without the gateway secret the stored core tokens are useless.
  const other = new AccountStore(booted.dbFile, 'a-different-secret-of-enough-length-000');
  assert.throws(() => other.session(token), /cannot be decrypted/);
  other.close();
});

test('sign-in: wrong, unknown and disabled look the same; repeated failures are blocked', async (t) => {
  const booted = await boot(t);
  const wrong = await login(booted, 'alice', 'not-the-password');
  const unknown = await fetch(`${booted.http}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': freshIp() },
    body: JSON.stringify({ username: 'nobody', password: 'whatever-password' }),
  });
  booted.accounts.setDisabled('bob', true);
  const disabled = await login(booted, 'bob');
  for (const response of [wrong, unknown, disabled]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Wrong username or password.' });
  }
  booted.accounts.setDisabled('bob', false);

  const ip = freshIp();
  for (let i = 0; i < 10; i++) assert.equal((await login(booted, 'alice', `guess-number-${i}`, ip)).status, 401);
  assert.equal((await login(booted, 'alice', PASSWORD.alice, ip)).status, 429, 'blocked even with the right password');
  assert.equal((await login(booted, 'alice')).status, 200, 'another address is not blocked');
  // Spread over many addresses, guesses at one account are still capped.
  for (let i = 0; i < 20; i++) await login(booted, 'bob', `guess-number-${i}`);
  assert.equal((await login(booted, 'bob')).status, 429);
  assert.equal((await login(booted, 'alice')).status, 200, 'other accounts are not affected');
});

test('HTTP: a session reaches only its own core; the core token never leaves the gateway', async (t) => {
  const booted = await boot(t);
  const [alice, bob] = [await session(booted, 'alice'), await session(booted, 'bob')];

  const upload = await fetch(`${booted.http}/api/upload?name=secret.txt`, authed(alice, { method: 'POST', body: 'only for alice', headers: { 'content-type': 'text/plain' } }));
  assert.equal(upload.status, 200);
  const { id } = (await upload.json()) as { id: string };
  const own = await fetch(`${booted.http}/api/files/${id}`, authed(alice));
  assert.equal(own.status, 200);
  assert.equal(await own.text(), 'only for alice');
  assert.equal((await fetch(`${booted.http}/api/files/${id}`, authed(bob))).status, 404, "bob's core has no such file");
  assert.equal((await fetch(`${booted.http}/api/files/${id}`)).status, 401);
  assert.equal((await fetch(`${booted.http}/api/files/${id}`, authed('made-up-token-xxxxxxxxxxxxxxxxxx'))).status, 401);
  // A device cannot present a core token instead of a session either.
  assert.equal((await fetch(`${booted.http}/api/files/${id}`, authed(booted.people.alice.coreToken))).status, 401);

  const me = await fetch(`${booted.http}/auth/session`, authed(alice));
  const body = await me.text();
  assert.deepEqual(Object.keys(JSON.parse(body) as object).sort(), ['expiresAt', 'username', 'webhookBase']);
  for (const person of Object.values(booted.people)) assert.ok(!body.includes(person.coreToken));

  assert.deepEqual(await (await fetch(`${booted.http}/health`)).json(), { ok: true, version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version, accounts: true });
  assert.equal((await fetch(`${booted.http}/`)).status, 200);
  assert.equal((await fetch(`${booted.http}/app/show`, { method: 'POST' })).status, 404);
});

test('WebSocket: each session talks to its own core; triggers and workflows stay apart', async (t) => {
  const booted = await boot(t);
  const alice = new Device(booted.ws, await session(booted, 'alice'));
  const bob = new Device(booted.ws, await session(booted, 'bob'));
  await Promise.all([alice.waitFor('welcome'), bob.waitFor('welcome')]);

  alice.send({ type: 'trigger-create', trigger: { kind: 'reminder', title: 'Alice only', text: 'private', fireAt: new Date(Date.now() + 3_600_000).toISOString() } });
  await poll(() => booted.people.alice.core.core.triggers.list().find((trigger) => trigger.title === 'Alice only'));
  alice.send({
    type: 'workflow-save',
    workflow: {
      name: 'mine',
      agent: 'mimi',
      title: 'Alice flow',
      description: '',
      enabled: true,
      trigger: { pool: 'webhook', config: {} },
      webhook: null,
      nodes: [{ id: 'n1', type: 'chat', title: 'say', config: { text: 'hi' }, links: { main: [] } }],
    },
  });
  await poll(() => booted.people.alice.core.core.workflows.get('mimi', 'mine'));

  bob.send({ type: 'triggers-sync' });
  assert.deepEqual((await bob.waitFor('triggers')).triggers, [], 'bob sees none of alice\'s triggers');
  assert.equal(booted.people.bob.core.core.workflows.list().length, 0);
  assert.equal(booted.people.bob.core.core.triggers.list().length, 0);
  assert.ok(!fs.existsSync(path.join(booted.people.bob.root, 'user', 'workflows', 'mimi', 'mine.json')));

  // A session token is not a core token: going straight to a core with it fails.
  const direct = new Device(`ws://127.0.0.1:${booted.people.bob.core.port}/ws`, await session(booted, 'bob'));
  assert.equal(await direct.closed(), 4003);
  alice.close();
  bob.close();
});

test('webhooks: /h/<id> reaches only that account\'s core', async (t) => {
  const booted = await boot(t);
  const alice = new Device(booted.ws, await session(booted, 'alice'));
  await alice.waitFor('welcome');
  alice.send({ type: 'trigger-create', trigger: { kind: 'agent_task', title: 'Hook', text: 'from outside', agent: 'mimi', webhook: true } });
  const hook = await poll(() => booted.people.alice.core.core.triggers.list().find((trigger) => trigger.title === 'Hook'));
  const post = (url: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"n":1}' });

  assert.equal((await post(`${booted.http}${booted.people.alice.webhookBase}${hook.webhook}`)).status, 200);
  await poll(() => booted.people.alice.core.core.triggers.get(hook.id)!.lastFiredAt ?? undefined);
  assert.equal((await post(`${booted.http}${booted.people.bob.webhookBase}${hook.webhook}`)).status, 404, "bob's prefix does not reach alice's core");
  assert.equal((await post(`${booted.http}${hook.webhook}`)).status, 404, 'no webhook without the account prefix');
  assert.equal((await post(`${booted.http}/h/unknown-route${hook.webhook}`)).status, 404);
  booted.accounts.setDisabled('alice', true);
  assert.equal((await post(`${booted.http}${booted.people.alice.webhookBase}${hook.webhook}`)).status, 404, 'a disabled account takes no webhooks');
  alice.close();
});

test('tools: a tool call, its approval and its result stay with that person', async (t) => {
  const mimi = scriptedModel([toolStep('write_file', { path: 'note.txt', content: 'alice wrote this' }), textStep('saved')]);
  const booted = await boot(t, { alice: { models: { mimi } } });
  const alice = new Device(booted.ws, await session(booted, 'alice'));
  const bob = new Device(booted.ws, await session(booted, 'bob'));
  await Promise.all([alice.waitFor('welcome'), bob.waitFor('welcome')]);

  alice.send({ type: 'send', text: 'write the note' });
  const asked = await poll(() =>
    alice.received.find((message) => message.type === 'event' && message.event.type === 'permission-request'),
  );
  assert.ok(asked);
  const request = (asked as Extract<ServerMessage, { type: 'event' }>).event as { request: { id: string } };
  alice.send({ type: 'permission-response', requestId: request.request.id, allow: true });
  await poll(() => (fs.existsSync(path.join(booted.people.alice.root, 'user', 'workspace', 'note.txt')) ? true : undefined));
  assert.ok(!fs.existsSync(path.join(booted.people.bob.root, 'user', 'workspace', 'note.txt')));
  assert.ok(
    !bob.received.some((message) => message.type === 'event' || message.type === 'permission-resolved'),
    'bob saw nothing of alice\'s run',
  );
  alice.close();
  bob.close();
});

test('logout revokes the session on the server: HTTP and new sockets fail, open sockets close', async (t) => {
  const booted = await boot(t);
  const token = await session(booted, 'alice');
  const other = await session(booted, 'alice');
  const device = new Device(booted.ws, token);
  const pc = new Device(booted.ws, token, 'pc');
  await device.waitFor('welcome');
  await poll(() => (booted.people.alice.core.pc.online ? true : undefined));

  assert.equal((await fetch(`${booted.http}/auth/logout`, authed(token, { method: 'POST' }))).status, 204);
  assert.equal(await device.closed(), 4003);
  assert.equal(await pc.closed(), 4003, 'a PC agent on that session is cut off too');
  assert.equal((await fetch(`${booted.http}/auth/session`, authed(token))).status, 401);
  assert.equal((await fetch(`${booted.http}/api/files/x`, authed(token))).status, 401);
  assert.equal(await new Device(booted.ws, token).closed(), 4003);
  assert.equal((await fetch(`${booted.http}/auth/session`, authed(other))).status, 200, 'other devices stay signed in');
});

test('admin changes made by another process (the CLI) end open sockets and block sign-in', async (t) => {
  const booted = await boot(t);
  const device = new Device(booted.ws, await session(booted, 'bob'));
  await device.waitFor('welcome');
  const admin = new AccountStore(booted.dbFile, SECRET, { passwordCost: 1024 });
  admin.setDisabled('bob', true);
  admin.close();
  assert.equal(await device.closed(), 4003);
  assert.equal((await login(booted, 'bob')).status, 401);

  const admin2 = new AccountStore(booted.dbFile, SECRET, { passwordCost: 1024 });
  admin2.setDisabled('bob', false);
  await admin2.setPassword('bob', 'a-brand-new-password');
  admin2.close();
  assert.equal((await login(booted, 'bob')).status, 401, 'the old password is gone');
  assert.equal((await login(booted, 'bob', 'a-brand-new-password')).status, 200);
});

test('sessions lapse after the idle period and are renewed by use', async (t) => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const booted = await boot(t, { now: () => now });
  const used = await session(booted, 'alice');
  const idle = await session(booted, 'alice');
  for (let day = 0; day < 40; day += 5) {
    now += 5 * 86_400_000;
    assert.equal((await fetch(`${booted.http}/auth/session`, authed(used))).status, 200, `day ${day + 5}`);
  }
  assert.equal((await fetch(`${booted.http}/auth/session`, authed(idle))).status, 401, 'unused for 40 days');
});

test('a core that refuses the gateway does not sign the device out', async (t) => {
  const booted = await boot(t);
  booted.accounts.rotateCoreToken('alice'); // the core still runs with the old token
  const device = new Device(booted.ws, await session(booted, 'alice'));
  assert.equal(await device.closed(), 4502);
  booted.accounts.setCoreUrl('alice', 'http://127.0.0.1:1'); // nothing listens there
  const offline = new Device(booted.ws, await session(booted, 'alice'));
  assert.equal(await offline.closed(), 1013);
  assert.equal((await fetch(`${booted.http}/api/files/x`, authed(await session(booted, 'alice')))).status, 502);
});

test('admin CLI: accounts are made with a password from stdin; the core token is shown once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-accounts-cli-'));
  const env = { ...process.env, MIMI_GATEWAY_SECRET: SECRET, MIMI_ACCOUNTS_DB: path.join(dir, 'accounts.db') };
  const cli = (args: string[], input = '') =>
    spawnSync(process.execPath, ['packages/core/src/cli/accounts.ts', ...args], { env, input, encoding: 'utf8' });

  const added = cli(['add', 'Carol', '--core', 'http://mimi-carol.railway.internal:8080'], 'carol-password-1\ncarol-password-1\n');
  assert.equal(added.status, 0, added.stderr);
  const coreToken = /MIMI_TOKEN=(\S+)/.exec(added.stdout)?.[1];
  assert.ok(coreToken && coreToken.length >= 32);
  assert.ok(!added.stdout.includes('carol-password-1'), 'the password is never printed');
  assert.match(added.stdout, /MIMI_HOST=::/);

  const listed = cli(['list']);
  assert.match(listed.stdout, /^carol\thttp:\/\/mimi-carol\.railway\.internal:8080\t0 session\(s\)\twebhooks: \/h\/[\w-]+$/m);
  assert.ok(!listed.stdout.includes(coreToken), 'list does not show core tokens');

  assert.equal(cli(['passwd', 'carol'], 'one-new-password\nanother-password\n').status, 1, 'the two entries must match');
  assert.match(cli(['add', 'dave', '--core', 'http://x:1'], 'short\nshort\n').stderr, /at least 10 characters/);
  assert.match(cli(['add', 'erin', '--core', 'http://x:1/path'], 'erin-password-1\nerin-password-1\n').stderr, /only scheme, host and port/);

  const copy = path.join(dir, 'copy', 'accounts.db');
  assert.equal(cli(['backup', copy]).status, 0);
  assert.equal(fs.statSync(copy).mode & 0o077, 0, 'the copy is readable by its owner only');
  assert.equal(cli(['backup', copy]).status, 1, 'an existing file is not overwritten');
  const restored = new AccountStore(copy, SECRET);
  assert.deepEqual(restored.list().map((account) => account.username), ['carol']);
  restored.close();

  const store = new AccountStore(env.MIMI_ACCOUNTS_DB, SECRET);
  const opened = await store.login('carol', 'carol-password-1');
  assert.equal(opened?.target.coreToken, coreToken);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sign-in takes JSON only; password checks are capped so a flood gets 503, not the CPU', async (t) => {
  const booted = await boot(t, { realCost: true });
  const form = await fetch(`${booted.http}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-real-ip': freshIp() },
    body: JSON.stringify({ username: 'alice', password: PASSWORD.alice }),
  });
  assert.equal(form.status, 415, 'a cross-site form cannot post JSON with the right type');

  const statuses = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      fetch(`${booted.http}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': freshIp() },
        body: JSON.stringify({ username: `nobody${i}`, password: 'some-guess-here' }),
      }).then((response) => response.status),
    ),
  );
  const busy = statuses.filter((status) => status === 503).length;
  assert.ok(busy > 0 && busy <= 4, `4 checking + 32 waiting, the rest busy: ${busy}`);
  assert.equal(statuses.filter((status) => status === 401).length, 40 - busy);
  assert.equal((await login(booted, 'alice')).status, 200, 'normal sign-in works afterwards');
});

test('the gateway\'s pages may not be framed and run only their own scripts', async (t) => {
  const booted = await boot(t);
  const page = await fetch(`${booted.http}/`);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.match(page.headers.get('content-security-policy')!, /script-src 'self' 'sha256-[\w+/=]+'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
});
