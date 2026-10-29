import assert from 'node:assert/strict';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { PermissionRequest } from '@mimi/shared';
import { LineReader } from '../cli/line-reader.ts';
import { CliBroker } from '../permissions/cli-broker.ts';
import { PermissionGate } from '../permissions/gate.ts';

function setup() {
  const input = new PassThrough();
  const rl = readline.createInterface({ input, output: new PassThrough() });
  return { input, rl, lines: new LineReader(rl) };
}

/** Lets readline turn written data into 'line' events. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const request: PermissionRequest = {
  id: 'r1',
  traceId: 't',
  agent: 'mimi',
  tool: 'run_shell',
  risk: 'shell',
  input: { command: 'dir' },
  summary: 'Run: dir',
  timeoutMs: 1_000,
  createdAt: '2026-01-01T00:00:00.000Z',
};

test('lines typed ahead are queued and handed out in order', async () => {
  const { input, rl, lines } = setup();
  input.write('first\nsecond\n');
  await flush();

  assert.equal(await lines.next('> '), 'first');
  assert.equal(await lines.next('> '), 'second');
  rl.close();
});

test('next() resolves null when input ends or the wait is aborted', async () => {
  const { rl, lines } = setup();
  const controller = new AbortController();
  const pending = lines.next('> ', controller.signal);
  controller.abort();
  assert.equal(await pending, null);

  const atClose = lines.next('> ');
  rl.close();
  assert.equal(await atClose, null);
  assert.equal(await lines.next('> '), null);
});

test('CLI broker: only y/yes approves', async () => {
  for (const [answer, expected] of [
    ['y', true],
    ['YES', true],
    ['', false],
    ['n', false],
    ['sure', false],
  ] as const) {
    const { input, rl, lines } = setup();
    const pending = new CliBroker(lines).request(request, new AbortController().signal);
    input.write(`${answer}\n`);
    assert.equal(await pending, expected, `answer "${answer}"`);
    rl.close();
  }
});

test('CLI broker behind the gate: an unanswered prompt times out, and the next line is not swallowed', async () => {
  const { input, rl, lines } = setup();
  const gate = new PermissionGate(new CliBroker(lines), { timeoutMs: 20 });

  const decision = await gate.decide({ ...request, timeoutMs: 20 });
  assert.deepEqual(decision, { allow: false, reason: 'timeout' });

  const next = lines.next('you> ');
  input.write('hello\n');
  assert.equal(await next, 'hello');
  rl.close();
});
