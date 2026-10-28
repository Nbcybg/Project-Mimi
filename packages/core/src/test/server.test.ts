import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PcAgent } from '@mimi/pc-agent';
import type { AgentEvent, ClientMessage, ServerMessage, WorkflowView } from '@mimi/shared';
import { WebSocket as WsClient } from 'ws';
import { APP_VERSION, type MimiServer, startServer } from '../server/server.ts';
import { hangingModel, type TestCoreOptions, testCoreParts } from './core-helpers.ts';
import { scriptedModel, textStep, toolStep } from './helpers.ts';

const TOKEN = 'test-token';

interface Booted {
  server: MimiServer;
  root: string;
  url: string;
  http: string;
  stop(): Promise<void>;
}

async function boot(options: TestCoreOptions & { localPcTools?: boolean; clientIpHeader?: string } = {}): Promise<Booted> {
  const parts = testCoreParts(options);
  const server = await startServer(
    {
      ...parts.config,
      token: TOKEN,
      host: '127.0.0.1',
      port: 0,
      localPcTools: options.localPcTools ?? false,
      clientIpHeader: options.clientIpHeader,
    },
    parts.coreOptions,
  );
  return {
    server,
    root: parts.root,
    url: `ws://127.0.0.1:${server.port}/ws`,
    http: `http://127.0.0.1:${server.port}`,
    async stop() {
      await server.close();
      fs.rmSync(parts.root, { recursive: true, force: true });
    },
  };
}

/** A UI client as a browser or the Flutter app would be: built-in WebSocket, JSON frames. */
class Client {
  readonly received: ServerMessage[] = [];
  private readonly socket: WebSocket;
  private readonly waiters: Array<() => void> = [];
  closeCode: number | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      this.received.push(JSON.parse(String(event.data)) as ServerMessage);
      this.waiters.splice(0).forEach((wake) => wake());
    });
    socket.addEventListener('close', (event) => {
      this.closeCode = event.code;
      this.waiters.splice(0).forEach((wake) => wake());
    });
  }

  static async open(url: string, token = TOKEN): Promise<Client> {
    const socket = new WebSocket(url);
    const client = new Client(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('connection failed')));
    });
    client.send({ type: 'hello', role: 'client', token, name: 'test' });
    return client;
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Resolves with the first received message that matches, waiting up to `timeoutMs`. */
  async waitFor<T extends ServerMessage>(match: (message: ServerMessage) => message is T, timeoutMs = 4000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const found = this.received.find(match);
      if (found) return found;
      if (this.closeCode !== null) throw new Error(`socket closed (${this.closeCode}) while waiting`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; received: ${this.received.map((message) => message.type).join(', ')}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  waitClosed(timeoutMs = 4000): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.closeCode !== null) return resolve(this.closeCode);
      const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
      this.socket.addEventListener('close', (event) => {
        clearTimeout(timer);
        resolve(event.code);
      });
    });
  }

  events(): AgentEvent[] {
    return this.received.flatMap((message) => (message.type === 'event' ? [message.event] : []));
  }

  close(): void {
    this.socket.close();
  }
}

const isType =
  <T extends ServerMessage['type']>(type: T) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: T }> =>
    message.type === type;
const isEvent =
  <T extends AgentEvent['type']>(type: T, nth = 0) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: 'event' }> =>
    message.type === 'event' && message.event.type === type && nth-- <= 0;
const finished = (client: Client, count = 1) =>
  client.waitFor((message): message is Extract<ServerMessage, { type: 'event' }> =>
    client.events().filter((event) => event.type === 'run-finish').length >= count && message.type === 'event');

test('a connection must present the token before anything else', async () => {
  const booted = await boot();
  const intruder = await Client.open(booted.url, 'wrong-token');
  assert.equal(await intruder.waitClosed(), 4003);
  assert.equal(intruder.received.length, 0);

  const client = await Client.open(booted.url);
  const welcome = await client.waitFor(isType('welcome'));
  assert.deepEqual(welcome.agents.map((agent) => agent.name), ['mimi', 'scout', 'tim']);
  assert.deepEqual(
    { agent: welcome.defaultAgent, pc: welcome.pcOnline, busy: welcome.busy, pending: welcome.pendingPermissions },
    { agent: 'mimi', pc: false, busy: false, pending: [] },
  );
  client.close();
  await booted.stop();
});

test('http: serves the web client and a health check; other origins cannot open the socket', async () => {
  const booted = await boot();
  const page = await fetch(`${booted.http}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type')!, /text\/html/);
  assert.match(await page.text(), /<title>Mimi<\/title>/);
  // Public: says it is up and nothing about who uses it or whether the PC is online.
  assert.deepEqual(await (await fetch(`${booted.http}/health`)).json(), { ok: true, version: APP_VERSION });
  assert.equal((await fetch(`${booted.http}/etc/passwd`)).status, 404);

  // A page on another site trying to drive the agent through the user's browser.
  const outcome = await new Promise<string>((resolve) => {
    const socket = new WsClient(booted.url, { origin: 'https://evil.example' });
    socket.on('open', () => resolve('open'));
    socket.on('error', () => resolve('refused'));
  });
  assert.equal(outcome, 'refused');
  await booted.stop();
});

test('a turn from one client streams to every client, and history can be fetched', async () => {
  const booted = await boot({ models: { mimi: scriptedModel([textStep('สวัสดีค่ะนายท่าน')]) } });
  const [phone, desktop] = await Promise.all([Client.open(booted.url), Client.open(booted.url)]);
  await Promise.all([phone.waitFor(isType('welcome')), desktop.waitFor(isType('welcome'))]);

  phone.send({ type: 'send', text: 'สวัสดี' });
  for (const client of [phone, desktop]) {
    const echoed = await client.waitFor(isType('user-message'));
    assert.deepEqual({ text: echoed.text, agent: echoed.agent }, { text: 'สวัสดี', agent: 'mimi' });
    await finished(client);
    const text = client.events().flatMap((event) => (event.type === 'text-delta' ? [event.text] : [])).join('');
    assert.equal(text, 'สวัสดีค่ะนายท่าน');
  }

  desktop.send({ type: 'history', limit: 10 });
  const history = await desktop.waitFor(isType('history'));
  assert.deepEqual(history.messages.map((message) => [message.role, message.text]), [['user', 'สวัสดี'], ['assistant', 'สวัสดีค่ะนายท่าน']]);
  phone.close();
  desktop.close();
  await booted.stop();
});

test('permission requests go to all clients; the first answer decides, late joiners still see it', async () => {
  const mimi = scriptedModel([toolStep('write_file', { path: 'note.txt', content: 'hello' }), textStep('saved')]);
  const booted = await boot({ models: { mimi }, localPcTools: true });
  const [phone, desktop] = await Promise.all([Client.open(booted.url), Client.open(booted.url)]);
  await Promise.all([phone.waitFor(isType('welcome')), desktop.waitFor(isType('welcome'))]);

  desktop.send({ type: 'send', text: 'write the note' });
  const asked = await Promise.all([phone, desktop].map((client) => client.waitFor(isEvent('permission-request'))));
  const request = (asked[0]!.event as Extract<AgentEvent, { type: 'permission-request' }>).request;
  assert.deepEqual({ tool: request.tool, risk: request.risk, agent: request.agent }, { tool: 'write_file', risk: 'write', agent: 'mimi' });
  assert.equal(fs.existsSync(path.join(booted.root, 'user', 'workspace', 'note.txt')), false, 'nothing runs before approval');

  const late = await Client.open(booted.url);
  const welcome = await late.waitFor(isType('welcome'));
  assert.deepEqual({ busy: welcome.busy, pending: welcome.pendingPermissions.map((pending) => pending.id) }, { busy: true, pending: [request.id] });

  phone.send({ type: 'permission-response', requestId: request.id, allow: true }); // approved from the phone
  for (const client of [phone, desktop, late]) {
    const resolved = await client.waitFor(isType('permission-resolved'));
    assert.deepEqual(resolved, { type: 'permission-resolved', requestId: request.id, decision: { allow: true, via: 'user' } });
  }
  await finished(desktop);
  assert.equal(fs.readFileSync(path.join(booted.root, 'user', 'workspace', 'note.txt'), 'utf8'), 'hello');
  desktop.send({ type: 'permission-response', requestId: request.id, allow: false }); // too late: ignored
  for (const client of [phone, desktop, late]) client.close();
  await booted.stop();
});

test('a permission request nobody answers times out as a denial', async () => {
  const mimi = scriptedModel([toolStep('write_file', { path: 'note.txt', content: 'x' }), textStep('not saved')]);
  const booted = await boot({ models: { mimi }, localPcTools: true, env: { PERMISSION_TIMEOUT_MS: '120' } });
  const client = await Client.open(booted.url);
  await client.waitFor(isType('welcome'));

  client.send({ type: 'send', text: 'write it' });
  const resolved = await client.waitFor(isType('permission-resolved'));
  assert.deepEqual(resolved.decision, { allow: false, reason: 'timeout' });
  await finished(client);
  assert.equal(fs.existsSync(path.join(booted.root, 'user', 'workspace', 'note.txt')), false);
  client.close();
  await booted.stop();
});

test('PC agent: tools run on the PC through its outbound connection, and "PC offline" when it is gone', async () => {
  const mimi = scriptedModel([
    toolStep('read_file', { path: 'notes.txt' }),
    textStep('offline answer'),
    toolStep('read_file', { path: 'notes.txt' }, 'call-2'),
    textStep('online answer'),
    toolStep('read_file', { path: '../outside.txt' }, 'call-3'),
    textStep('refused answer'),
  ]);
  const booted = await boot({ models: { mimi } }); // cloud-style core: no local file access
  const client = await Client.open(booted.url);
  await client.waitFor(isType('welcome'));
  const toolResults = () => client.events().flatMap((event) => (event.type === 'tool-result' ? [event.result] : []));

  client.send({ type: 'send', text: 'read my notes' });
  await finished(client, 1);
  assert.equal(toolResults()[0]!.ok, false);
  assert.match(toolResults()[0]!.output, /PC offline/);

  // The PC agent dials out to the core; its own folder list is what counts.
  const pcDir = path.join(booted.root, 'pc-files');
  fs.mkdirSync(pcDir);
  fs.writeFileSync(path.join(pcDir, 'notes.txt'), 'ซื้อนมสองกล่อง');
  fs.writeFileSync(path.join(booted.root, 'outside.txt'), 'private');
  const agent = new PcAgent({ url: booted.url, token: TOKEN, allowedDirs: [pcDir], name: 'test-pc', reconnect: false });
  agent.start();
  const online = await client.waitFor((message): message is Extract<ServerMessage, { type: 'pc-status' }> => message.type === 'pc-status' && message.online);
  assert.equal(online.name, 'test-pc');
  assert.deepEqual(booted.server.pc.allowedDirs, [pcDir]);

  client.send({ type: 'send', text: 'read my notes again' });
  await finished(client, 2);
  assert.deepEqual({ ok: toolResults()[1]!.ok, output: toolResults()[1]!.output }, { ok: true, output: 'ซื้อนมสองกล่อง' });
  assert.match(JSON.stringify(mimi.doStreamCalls[2]!.prompt), new RegExp(`Working folder[^"]*pc-files`), 'the model is told the PC folder');

  client.send({ type: 'send', text: 'read outside' });
  await finished(client, 3);
  assert.equal(toolResults()[2]!.ok, false);
  assert.match(toolResults()[2]!.output, /outside the allowed folders/);

  agent.stop();
  await client.waitFor((message): message is Extract<ServerMessage, { type: 'pc-status' }> => message.type === 'pc-status' && !message.online);
  assert.equal(booted.server.pc.online, false);
  client.close();
  await booted.stop();
});

/** Says hello over a socket that arrives "from" `ip` as a reverse proxy would report it. */
function helloVia(url: string, ip: string, token: string): Promise<number | 'welcome'> {
  const socket = new WsClient(url, { headers: { 'x-real-ip': ip } });
  return new Promise((resolve) => {
    socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', role: 'client', token, name: 'test' })));
    socket.on('message', (data) => {
      if ((JSON.parse(String(data)) as ServerMessage).type === 'welcome') {
        resolve('welcome');
        socket.close();
      }
    });
    socket.on('close', (code) => resolve(code));
  });
}

test('behind a proxy, wrong tokens block only the caller the proxy names', async () => {
  const booted = await boot({ clientIpHeader: 'x-real-ip' });
  for (let i = 0; i < 10; i++) assert.equal(await helloVia(booted.url, '203.0.113.7', 'wrong'), 4003);
  assert.equal(await helloVia(booted.url, '203.0.113.7', TOKEN), 4029);
  // Everyone else reaches the core through the same proxy and is not locked out.
  assert.equal(await helloVia(booted.url, '198.51.100.2', TOKEN), 'welcome');
  await booted.stop();
});

test('without a configured proxy header, a caller cannot pick its own address', async () => {
  const booted = await boot();
  for (let i = 0; i < 10; i++) assert.equal(await helloVia(booted.url, `203.0.113.${i}`, 'wrong'), 4003);
  assert.equal(await helloVia(booted.url, '198.51.100.2', TOKEN), 4029);
  await booted.stop();
});

test('a PC agent with the wrong token is turned away', async () => {
  const booted = await boot();
  const lines: string[] = [];
  const agent = new PcAgent({ url: booted.url, token: 'nope', allowedDirs: [booted.root], log: (line) => lines.push(line) });
  agent.start();
  const deadline = Date.now() + 3000;
  while (!lines.some((line) => /rejected the token/.test(line)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(lines.some((line) => /rejected the token/.test(line)), lines.join(' | '));
  assert.equal(booted.server.pc.online, false);
  agent.stop();
  await booted.stop();
});

test('abort stops the running turn', async () => {
  const booted = await boot({ models: { mimi: hangingModel() } });
  const client = await Client.open(booted.url);
  await client.waitFor(isType('welcome'));

  client.send({ type: 'send', text: 'think forever' });
  await client.waitFor(isEvent('run-start'));
  client.send({ type: 'abort' });
  await finished(client);
  const finish = client.events().find((event) => event.type === 'run-finish') as Extract<AgentEvent, { type: 'run-finish' }>;
  assert.equal(finish.reason, 'aborted');
  client.close();
  await booted.stop();
});

test('reminders are pushed to connected clients; triggers can be synced to a device', async () => {
  const booted = await boot();
  const client = await Client.open(booted.url);
  await client.waitFor(isType('welcome'));
  const { core } = booted.server;
  const once = core.triggers.create({ kind: 'reminder', title: 'กินยา', text: 'หลังอาหาร', fireAt: new Date(Date.now() + 3_600_000).toISOString() });
  core.triggers.create({ kind: 'reminder', title: 'Standup', text: 'daily', cron: '0 9 * * 1-5' });

  client.send({ type: 'triggers-sync' });
  const synced = await client.waitFor(isType('triggers'));
  assert.deepEqual(synced.triggers.map((trigger) => [trigger.title, trigger.status, trigger.cron]), [['กินยา', 'active', null], ['Standup', 'active', '0 9 * * 1-5']]);
  assert.ok(core.triggers.list().every((trigger) => trigger.deviceSynced));

  core.db.prepare(`UPDATE triggers SET next_fire_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(once.id);
  await core.scheduler.tick();
  const pushed = await client.waitFor(isType('notification'));
  const chat = core.chats.directChat('mimi');
  const { id: inboxId, ...pushedRest } = pushed.notification;
  assert.equal(typeof inboxId, 'number');
  assert.deepEqual(pushedRest, { kind: 'reminder', title: 'กินยา', body: 'หลังอาหาร', triggerId: once.id, chatId: chat.id });
  assert.equal(core.triggers.get(once.id)!.deviceSynced, false, 'a fired trigger must be re-synced');
  client.close();
  await booted.stop();
});

/** Polls the running core until a condition holds; the socket only carries broadcasts. */
async function poll<T>(fn: () => T | undefined, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('poll timed out');
}

test('webhook triggers: the URL fires without a token; create, edit, run and delete over the socket', async () => {
  const booted = await boot({ models: { mimi: scriptedModel([textStep('จัดการออเดอร์เรียบร้อยค่ะ')]) } });
  const client = await Client.open(booted.url);
  await client.waitFor(isType('welcome'));
  const { core } = booted.server;

  client.send({
    type: 'trigger-create',
    trigger: { kind: 'agent_task', title: 'Order', text: 'Handle the new order', agent: 'mimi', webhook: true },
  });
  const hook = await poll(() => core.triggers.list().find((trigger) => trigger.title === 'Order'));
  assert.match(hook.webhook!, /^\/api\/webhook\/[\w-]{20,}$/);
  assert.equal(hook.nextFireAt, null);
  assert.ok(fs.existsSync(path.join(booted.root, 'user', 'triggers', `${hook.id}.json`)), 'mirrored to a file');

  const bad = await fetch(`${booted.http}/api/webhook/nope`, { method: 'POST', body: '{}' });
  assert.equal(bad.status, 404);

  const response = await fetch(`${booted.http}${hook.webhook}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: 42 }),
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { ok: boolean }).ok, true);
  const fired = core.triggers.get(hook.id)!;
  assert.equal(fired.lastResult, 'จัดการออเดอร์เรียบร้อยค่ะ');
  assert.ok(fired.lastFiredAt, 'a webhook run records its time');
  const task = core.db.prepare(`SELECT text FROM messages WHERE thread = ? LIMIT 1`).get(`task:${hook.id}`) as { text: string };
  assert.match(task.text, /orderId/, 'the agent saw the webhook payload');

  // Edit and run from the screen.
  client.send({ type: 'trigger-update', id: hook.id, patch: { title: 'Order v2', text: 'Handle it again' } });
  const edited = await poll(() => core.triggers.get(hook.id)!.title === 'Order v2' ? core.triggers.get(hook.id) : undefined);
  assert.equal(edited.text, 'Handle it again');
  assert.equal(edited.webhookKey, hook.webhookKey, 'the URL survived the edit');

  const reports = () =>
    (core.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE text LIKE '[Scheduled task "Order v2"%'`).get() as { n: number }).n;
  const before = reports();
  client.send({ type: 'trigger-run', id: hook.id });
  await poll(() => (reports() > before ? true : undefined));

  client.send({ type: 'trigger-delete', id: hook.id });
  await poll(() => (core.triggers.get(hook.id) === undefined ? true : undefined));
  assert.equal(fs.existsSync(path.join(booted.root, 'user', 'triggers', `${hook.id}.json`)), false, 'the file went away too');

  client.close();
  await booted.stop();
});

test('workflows: saved under an agent, fired by their webhook URL without a token', async () => {
  const booted = await boot({ models: { mimi: scriptedModel([textStep('สรุปเมลแล้วค่ะ')]) } });
  const client = await Client.open(booted.url);
  await client.waitFor(isType('welcome'));
  const { core } = booted.server;

  const workflow: WorkflowView = {
    name: 'triage',
    agent: 'mimi',
    title: 'คัดกรอง',
    description: '',
    enabled: true,
    trigger: { pool: 'webhook', config: {} },
    webhook: null,
    nodes: [
      { id: 'n1', type: 'agent', title: 'อ่านเมล', config: { agent: 'mimi', instruction: 'อ่าน' }, links: { main: ['n2'] } },
      { id: 'n2', type: 'chat', title: 'แจ้ง', config: { text: '📬 {{ $json.Subject }} → {{ $json.text }}' }, links: { main: [] } },
    ],
  };
  client.send({ type: 'workflow-save', workflow });
  const saved = await poll(() => core.workflows.get('mimi', 'triage'));
  assert.ok(saved.webhookKey);
  assert.ok(fs.existsSync(path.join(booted.root, 'user', 'workflows', 'mimi', 'triage.json')));

  // A workflow may only name agents that exist.
  client.send({
    type: 'workflow-save',
    workflow: { ...workflow, name: 'bad', nodes: [{ ...workflow.nodes[0]!, config: { agent: 'ghost' } }, workflow.nodes[1]!] },
  });
  const refused = await client.waitFor((message): message is Extract<ServerMessage, { type: 'error' }> => message.type === 'error' && message.message.includes('ghost'));
  assert.match(refused.message, /agent "ghost" does not exist/);

  // A tool node may choose whose tools it calls, and that agent must exist too.
  client.send({
    type: 'workflow-save',
    workflow: {
      ...workflow,
      name: 'bad-tool',
      nodes: [{ id: 'n1', type: 'tool', config: { tool: 'notify_user', agent: 'ghost' }, links: { main: [] } }],
    },
  });
  const refusedTool = await client.waitFor((message): message is Extract<ServerMessage, { type: 'error' }> => message.type === 'error' && message.message.includes('ghost'));
  assert.match(refusedTool.message, /agent "ghost" does not exist/);

  const bad = await fetch(`${booted.http}/api/workflow/nope`, { method: 'POST', body: '{}' });
  assert.equal(bad.status, 404);
  const response = await fetch(`${booted.http}${saved.webhook}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"Subject":"hi"}',
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { ok: boolean }).ok, true);

  const chat = core.chats.directChat('mimi');
  const [session] = core.chats.sessions(chat.id, 1);
  const messages = core.deps.messages.page(session!.thread, undefined, 10);
  assert.equal(messages.at(-1)!.text, '📬 hi → สรุปเมลแล้วค่ะ');

  // A respond node shapes the answer: status, headers and body of the webhook reply.
  client.send({
    type: 'workflow-save',
    workflow: {
      ...workflow,
      name: 'answer',
      title: 'ตอบกลับ',
      nodes: [
        {
          id: 'n1',
          type: 'respond',
          title: 'ตอบ',
          config: { status: 202, headers: { 'x-source': 'mimi' }, body: { got: '{{ $json.Subject }}' } },
          links: { main: [] },
        },
      ],
    },
  });
  const answer = await poll(() => core.workflows.get('mimi', 'answer'));
  const reply = await fetch(`${booted.http}${answer.webhook}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"Subject":"hello"}',
  });
  assert.equal(reply.status, 202);
  assert.equal(reply.headers.get('x-source'), 'mimi');
  assert.deepEqual(await reply.json(), { got: 'hello' });
  client.send({ type: 'workflow-delete', agent: 'mimi', name: 'answer' });
  await poll(() => (core.workflows.get('mimi', 'answer') === undefined ? true : undefined));

  // An HTML form works too: GET query values and urlencoded POST values become items.
  client.send({
    type: 'workflow-save',
    workflow: {
      ...workflow,
      name: 'form',
      title: 'ฟอร์ม',
      trigger: { pool: 'form', config: {} },
      nodes: [{ id: 'n1', type: 'respond', config: { body: '{{ $json.name }}' }, links: { main: [] } }],
    },
  });
  const form = await poll(() => core.workflows.get('mimi', 'form'));
  const byGet = await fetch(`${booted.http}${form.webhook}?name=Ann`);
  assert.equal(byGet.status, 200);
  assert.equal(await byGet.text(), 'Ann');
  const byForm = await fetch(`${booted.http}${form.webhook}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Bob&email=bob%40example.com',
  });
  assert.equal(byForm.status, 200);
  assert.equal(await byForm.text(), 'Bob');
  client.send({ type: 'workflow-delete', agent: 'mimi', name: 'form' });
  await poll(() => (core.workflows.get('mimi', 'form') === undefined ? true : undefined));

  client.send({ type: 'workflow-delete', agent: 'mimi', name: 'triage' });
  await poll(() => (core.workflows.get('mimi', 'triage') === undefined ? true : undefined));
  assert.equal(fs.existsSync(path.join(booted.root, 'user', 'workflows', 'mimi', 'triage.json')), false);

  client.close();
  await booted.stop();
});
