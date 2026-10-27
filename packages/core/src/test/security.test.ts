import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { WorkflowView } from '@mimi/shared';
import { z } from 'zod';
import { UserProfileStore } from '../profile/user-profile.ts';
import { AuthLimiter } from '../server/auth-limiter.ts';
import { startServer } from '../server/server.ts';
import { defineTool } from '../tools/registry.ts';
import { runCodeIsolated } from '../workflows/code-sandbox.ts';
import { assertPublicUrl, isPrivateAddress } from '../workflows/net-guard.ts';
import { runWorkflowNode, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { testCoreParts } from './core-helpers.ts';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-sec-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const workflow = (): WorkflowView => ({ name: 'f', agent: 'mimi', title: 'F', description: '', enabled: true, trigger: { pool: 'manual', config: {} }, webhook: null, nodes: [] });

function deps(extra: Partial<WorkflowRunnerDeps> = {}): WorkflowRunnerDeps {
  return {
    runAgent: async () => '',
    tool: () => undefined,
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(tmp, `state-${Math.random().toString(36).slice(2)}.json`)),
    allowedDirs: [],
    ...extra,
  };
}

test('code sandbox: runs code on items, but no files, no programs, no keys', async () => {
  const done = await runCodeIsolated('return items.map((item) => ({ json: { n: item.n * 2 } }));', [{ n: 2 }, { n: 5 }]);
  assert.deepEqual(done.result, [{ json: { n: 4 } }, { json: { n: 10 } }]);
  assert.equal((await runCodeIsolated('console.log("x"); return undefined;', [])).result, undefined);

  const secretFile = path.join(tmp, 'secret.txt');
  fs.writeFileSync(secretFile, 'top secret');
  await assert.rejects(runCodeIsolated(`return require('fs').readFileSync(${JSON.stringify(secretFile)}, 'utf8');`, []), /ERR_ACCESS_DENIED|denied|restricted|not defined/i);
  await assert.rejects(runCodeIsolated(`return require('child_process').execSync('whoami').toString();`, []), /ERR_ACCESS_DENIED|denied|restricted|not defined/i);
  // The parent's keys do not reach the sandbox.
  process.env.MIMI_TEST_SECRET = 'should-not-leak';
  const env = await runCodeIsolated('return Object.keys(process.env).filter((key) => /SECRET|KEY|TOKEN/i.test(key));', []);
  assert.deepEqual(env.result, []);
  // Escaping through a constructor reaches only the sandbox's own process.
  const escape = await runCodeIsolated("return this.constructor.constructor('return typeof process.env.MIMI_TEST_SECRET')();", []);
  assert.equal(escape.result, 'undefined');
  await assert.rejects(runCodeIsolated('throw new Error("boom")', []), /boom/);
  await assert.rejects(runCodeIsolated('while (true) {}', [], { timeoutMs: 1500 }), /stopped after 1.5 s/);
});

test('code node: goes through the sandbox and keeps the n8n-style helpers', async () => {
  const result = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'code', config: { code: 'return $input.all().map((item) => ({ json: { ...item.json, up: String(item.json.s).toUpperCase() } }));' }, links: { main: [] } },
    [{ json: { s: 'a' } }],
    deps(),
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.outputs.main![0]!.json, { s: 'a', up: 'A' });
});

test('net guard: private, loopback, link-local and metadata addresses are refused', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.100.1.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.0.5']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1']) assert.equal(isPrivateAddress(address), false, address);
  const lookup = async (host: string) => (host === 'router.lan' ? ['192.168.1.1'] : ['93.184.216.34']);
  await assertPublicUrl('https://api.example.com/x', lookup);
  await assert.rejects(assertPublicUrl('http://router.lan/admin', lookup), /local network/);
  await assert.rejects(assertPublicUrl('http://localhost:8787/api', lookup), /local network/);
  await assert.rejects(assertPublicUrl('http://127.0.0.1:8787/', lookup), /local network/);
  await assert.rejects(assertPublicUrl('file:///etc/passwd', lookup), /only http/);

  // The HTTP node asks the guard unless the node allows the local network.
  const fetchFn = (async () => new Response('{"ok":true}')) as typeof fetch;
  const guarded = deps({ fetchFn, lookup });
  const refused = await runWorkflowNode(workflow(), { id: 'n1', type: 'http', config: { url: 'http://router.lan/admin' }, links: { main: [] } }, [], guarded);
  assert.match(refused.error!, /local network/);
  const allowed = await runWorkflowNode(workflow(), { id: 'n1', type: 'http', config: { url: 'http://router.lan/admin', allowLocal: true }, links: { main: [] } }, [], guarded);
  assert.equal(allowed.ok, true, allowed.error);

  // A public URL that redirects to the LAN is still refused on the next hop.
  const redirecting = (async () => new Response(null, { status: 302, headers: { location: 'http://router.lan/admin' } })) as typeof fetch;
  const hop = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'http', config: { url: 'https://api.example.com/start' }, links: { main: [] } },
    [],
    deps({ fetchFn: redirecting, lookup }),
  );
  assert.match(hop.error!, /local network/);
});

test('tool node: tools that change things need the node to allow them; settings can allow or deny', async () => {
  const calls: string[] = [];
  const make = (name: string, risk: 'read' | 'write') =>
    defineTool({ name, description: name, risk, target: 'core', inputSchema: z.object({}), summarize: () => name, execute: async () => (calls.push(name), 'done') });
  const tools: Record<string, ReturnType<typeof make>> = { look: make('look', 'read'), send: make('send', 'write') };
  const base = { tool: (name: string) => tools[name] };
  const node = (tool: string, allow?: boolean) => ({ id: 'n1', type: 'tool' as const, config: { tool, input: {}, ...(allow !== undefined ? { allow } : {}) }, links: { main: [] } });

  assert.equal((await runWorkflowNode(workflow(), node('look'), [], deps(base))).ok, true);
  const blocked = await runWorkflowNode(workflow(), node('send'), [], deps(base));
  assert.match(blocked.error!, /can change things \(write\).*อนุญาต/);
  assert.equal((await runWorkflowNode(workflow(), node('send', true), [], deps(base))).ok, true);
  assert.equal((await runWorkflowNode(workflow(), node('send'), [], deps({ ...base, permissions: { send: 'allow' } }))).ok, true);
  const denied = await runWorkflowNode(workflow(), node('send', true), [], deps({ ...base, permissions: { send: 'deny' } }));
  assert.match(denied.error!, /denied in the settings/);
  assert.deepEqual(calls, ['look', 'send', 'send']);
});

test('auth limiter: too many wrong tokens block the address for a while', () => {
  let now = 0;
  const limiter = new AuthLimiter({ maxFailures: 3, windowMs: 1000, blockMs: 5000, now: () => now });
  limiter.fail('a');
  limiter.fail('a');
  assert.equal(limiter.blocked('a'), false);
  limiter.fail('a');
  assert.equal(limiter.blocked('a'), true);
  assert.equal(limiter.blocked('b'), false);
  now = 6000;
  assert.equal(limiter.blocked('a'), false);
  now = 9000;
  limiter.fail('c');
  limiter.succeed('c');
  limiter.fail('c');
  limiter.fail('c');
  assert.equal(limiter.blocked('c'), false, 'a success resets the count');
});

test('server: webhook secrets, and wrong tokens get the address blocked', async () => {
  const parts = testCoreParts();
  const server = await startServer({ ...parts.config, token: 'right-token', host: '127.0.0.1', port: 0, localPcTools: false }, parts.coreOptions);
  try {
    const saved = server.core.workflows.save({
      name: 'hook',
      agent: 'mimi',
      title: 'Hook',
      description: '',
      enabled: true,
      trigger: { pool: 'webhook', config: { secret: 's3cret-value' } },
      webhook: null,
      nodes: [{ id: 'n1', type: 'set', config: { fields: { got: true } }, links: { main: [] } }],
    });
    const url = `http://127.0.0.1:${server.port}/api/workflow/${saved.webhookKey}`;
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', body: '{}', headers: { 'x-mimi-secret': 'nope' } })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', body: '{}', headers: { 'x-mimi-secret': 's3cret-value' } })).status, 200);

    const api = `http://127.0.0.1:${server.port}/api/files/none`;
    for (let n = 0; n < 10; n++) assert.equal((await fetch(api, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    // Blocked now, even with the right token.
    assert.equal((await fetch(api, { headers: { authorization: 'Bearer right-token' } })).status, 401);
  } finally {
    await server.close();
    fs.rmSync(parts.root, { recursive: true, force: true });
  }
});

test('profile: "this machine only" values stay out of user/profile.json', () => {
  const shared = path.join(tmp, 'user', 'profile.json');
  const local = path.join(tmp, 'user', 'data', 'profile-local.json');
  const store = new UserProfileStore(shared, local);
  store.save(
    {
      fields: [
        { key: 'nickname', label: 'ชื่อเล่น', value: 'ต้น', visibleTo: '*' },
        { key: 'bank_account', label: 'บัญชี', value: '123-4-56789-0', visibleTo: ['mimi'], localOnly: true },
      ],
    },
    ['mimi'],
  );
  assert.ok(!fs.readFileSync(shared, 'utf8').includes('123-4-56789-0'));
  assert.equal(JSON.parse(fs.readFileSync(local, 'utf8')).bank_account, '123-4-56789-0');
  assert.equal(store.get().fields.find((field) => field.key === 'bank_account')!.value, '123-4-56789-0');
  assert.match(store.render('mimi'), /123-4-56789-0/);
  // Renaming an agent rewrites the shared file without leaking or losing the value.
  store.renameAgent('mimi', 'mimi2');
  assert.ok(!fs.readFileSync(shared, 'utf8').includes('123-4-56789-0'));
  assert.equal(store.get().fields.find((field) => field.key === 'bank_account')!.value, '123-4-56789-0');
});
