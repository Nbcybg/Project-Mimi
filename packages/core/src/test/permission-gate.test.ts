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
