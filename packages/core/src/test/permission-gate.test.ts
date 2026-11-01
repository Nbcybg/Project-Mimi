import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RiskLevel } from '@mimi/shared';
import { type PermissionBroker, PermissionGate } from '../permissions/gate.ts';
import { FakeBroker } from './helpers.ts';

function ask(gate: PermissionGate, risk: RiskLevel) {
  return gate.decide(
    gate.createRequest({
      traceId: 'trace',
      agent: 'mimi',
      tool: 'some_tool',
      risk,
      input: {},
      summary: 'do something',
    }),
  );
}

test('read is automatic and never reaches the broker', async () => {
  const broker = new FakeBroker(false);
  const gate = new PermissionGate(broker);

  assert.deepEqual(await ask(gate, 'read'), { allow: true, via: 'auto' });
  assert.equal(broker.requests.length, 0);
});

test('every side-effect risk level asks the user', async () => {
  for (const risk of ['write', 'shell', 'delete', 'network'] as const) {
    const broker = new FakeBroker(true);
    const gate = new PermissionGate(broker);

    assert.deepEqual(await ask(gate, risk), { allow: true, via: 'user' });
    assert.equal(broker.requests.length, 1, risk);
  }
});

test('a "no" from the user is a denial', async () => {
  const gate = new PermissionGate(new FakeBroker(false));
  assert.deepEqual(await ask(gate, 'shell'), { allow: false, reason: 'denied' });
});

test('no answer within the timeout is a denial, and the prompt is withdrawn', async () => {
  let aborted = false;
  const broker: PermissionBroker = {
    request: (_request, signal) =>
      new Promise(() => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
      }),
  };
  const gate = new PermissionGate(broker, { timeoutMs: 20 });

  assert.deepEqual(await ask(gate, 'write'), { allow: false, reason: 'timeout' });
  assert.equal(aborted, true);
});

test('a failing broker is a denial', async () => {
  const broker: PermissionBroker = { request: () => Promise.reject(new Error('socket closed')) };
  const gate = new PermissionGate(broker);
  assert.deepEqual(await ask(gate, 'write'), { allow: false, reason: 'error' });
});

test('a task grant covers the tool family until it expires', async () => {
  let now = 1_000;
  const broker = new FakeBroker(false);
  const gate = new PermissionGate(broker, { timeoutMs: 20, grantTtlMs: 100, now: () => now });
  const request = gate.createRequest({
    traceId: 'trace-grant',
    agent: 'mimi',
    tool: 'organize_files',
    risk: 'write',
    input: {},
    summary: 'move files',
  });

  assert.equal(gate.granted('trace-grant', 'organize_files'), false);
  assert.equal(gate.grant('trace-grant', 'organize_files'), true);
  assert.equal(gate.granted('trace-grant', 'organize_files'), true);
  assert.equal(gate.modeFor('organize_files', 'write', 'trace-grant'), 'auto');
  assert.equal(gate.modeFor('undo_organize', 'write', 'trace-grant'), 'auto', 'same family');
  assert.equal(gate.modeFor('organize_files', 'write', 'another-trace'), 'ask', 'not another task');
  assert.deepEqual(await gate.decide(request), { allow: true, via: 'auto' });
  assert.equal(broker.requests.length, 0);

  now += 101;
  assert.equal(gate.granted('trace-grant', 'organize_files'), false);
  assert.equal(gate.modeFor('organize_files', 'write', 'trace-grant'), 'ask');
});

test('a grant never overrides an explicit deny', () => {
  const gate = new PermissionGate(new FakeBroker(true), { overrides: { organize_files: 'deny' } });
  assert.equal(gate.grant('trace', 'organize_files'), false);
  assert.equal(gate.modeFor('organize_files', 'write', 'trace'), 'deny');
});

test('an agent policy beats the risk default: run_shell allowed, delete_path asks', () => {
  const gate = new PermissionGate(new FakeBroker(true));
  const policy = { run_shell: 'allow', delete_path: 'ask' } as const;

  assert.equal(gate.modeFor('run_shell', 'shell', 'trace', { overrides: policy }), 'auto');
  assert.equal(gate.modeFor('delete_path', 'delete', 'trace', { overrides: policy }), 'ask');
  assert.equal(gate.modeFor('write_file', 'write', 'trace', { overrides: policy }), 'ask', 'unlisted tools keep the global policy');
});

test('session grants cover one thread; forever grants are persisted', () => {
  let saved: Record<string, string[]> = {};
  const gate = new PermissionGate(new FakeBroker(true), {
    alwaysLoad: () => saved,
    alwaysSave: (grants) => {
      saved = grants;
    },
  });

  assert.equal(gate.grant('trace', 'run_shell', { scope: 'session', thread: 'thread-1' }), true);
  assert.equal(gate.modeFor('run_shell', 'shell', 'other', { thread: 'thread-1' }), 'auto');
  assert.equal(gate.modeFor('run_shell', 'shell', 'other', { thread: 'thread-2' }), 'ask');
  assert.equal(gate.modeFor('run_shell', 'shell', 'other'), 'ask');

  assert.equal(gate.grant('trace', 'delete_path', { scope: 'always', agent: 'mimi' }), true);
  assert.equal(gate.modeFor('delete_path', 'delete', 'other', { agent: 'mimi' }), 'auto');
  assert.deepEqual(saved, { mimi: ['delete_path'] });
  assert.equal(gate.revokeAlways('delete_path', 'mimi'), true);
  assert.deepEqual(saved, {});
});

test('a forever grant only covers the agent it was approved for', () => {
  const gate = new PermissionGate(new FakeBroker(true));
  assert.equal(gate.grant('trace', 'delete_path', { scope: 'always', agent: 'mimi' }), true);
  assert.equal(gate.modeFor('delete_path', 'delete', 'other', { agent: 'mimi' }), 'auto');
  assert.equal(gate.modeFor('delete_path', 'delete', 'other', { agent: 'tim' }), 'ask');
  assert.deepEqual(gate.alwaysGrantsByAgent(), { mimi: ['delete_path'] });
  assert.equal(gate.revokeAlways('delete_path'), true, 'without an agent it is removed everywhere');
  assert.deepEqual(gate.alwaysGrantsByAgent(), {});
});

test('old global forever grants still cover every agent', () => {
  const gate = new PermissionGate(new FakeBroker(true), { alwaysLoad: () => ({ '*': ['run_shell'] }) });
  assert.equal(gate.modeFor('run_shell', 'shell', 'other', { agent: 'mimi' }), 'auto');
  assert.equal(gate.modeFor('run_shell', 'shell', 'other', { agent: 'tim' }), 'auto');
  assert.deepEqual(gate.alwaysAllowed(), ['run_shell']);
});

test('browser_fill_secret asks every time: grants and allow overrides do not cover it', () => {
  const gate = new PermissionGate(new FakeBroker(true));
  assert.equal(gate.grant('trace', 'browser_fill_secret', { scope: 'always', agent: 'mimi' }), false);
  assert.equal(gate.grant('trace', 'browser_fill_secret', { scope: 'session', thread: 'thread-1' }), false);
  assert.equal(gate.grant('trace', 'browser_fill_secret', { scope: 'task' }), false);
  assert.equal(gate.modeFor('browser_fill_secret', 'write', 'trace', { agent: 'mimi' }), 'ask');
  assert.equal(gate.modeFor('browser_fill_secret', 'write', 'trace', { thread: 'thread-1', agent: 'mimi' }), 'ask');
  assert.equal(gate.modeFor('browser_fill_secret', 'write', 'trace', { overrides: { browser_fill_secret: 'allow' } }), 'ask');
  assert.equal(gate.modeFor('browser_fill_secret', 'write', 'trace', { overrides: { browser_fill_secret: 'deny' } }), 'deny');
  assert.equal(gate.alwaysGrantsByAgent().mimi, undefined);

  assert.equal(gate.grant('trace', 'stripe_refund_payment', { scope: 'always', agent: 'mimi' }), false);
  assert.equal(gate.modeFor('stripe_refund_payment', 'write', 'trace', { overrides: { stripe_refund_payment: 'allow' } }), 'ask');
});

test('stopping the caller withdraws the permission prompt', async () => {
  let aborted = false;
  const broker: PermissionBroker = {
    request: (_request, signal) =>
      new Promise(() => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
      }),
  };
  const gate = new PermissionGate(broker, { timeoutMs: 60_000 });
  const controller = new AbortController();
  const decision = gate.decide(
    gate.createRequest({ traceId: 't', agent: 'mimi', tool: 'some_tool', risk: 'write', input: {}, summary: 'do it' }),
    controller.signal,
  );
  controller.abort();
  assert.deepEqual(await decision, { allow: false, reason: 'denied' });
  assert.equal(aborted, true);
});
