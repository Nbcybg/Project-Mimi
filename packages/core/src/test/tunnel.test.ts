import assert from 'node:assert/strict';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { TunnelView } from '@mimi/shared';
import { QuickTunnel } from '../app/tunnel.ts';

/** A stand-in for the cloudflared process: tests write its output and decide when it exits. */
function fakeProcess() {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  let child: (EventEmitter & { stdout: PassThrough; stderr: PassThrough; exitCode: number | null; kill(): boolean }) | undefined;
  const spawnFn = ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env });
    const made = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      kill() {
        made.exitCode = 0;
        made.emit('exit', null);
        return true;
      },
    });
    child = made;
    return made;
  }) as unknown as typeof spawn;
  return { spawnFn, calls, child: () => child! };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('tunnel: the address comes from cloudflared output; stop ends the process', async () => {
  const fake = fakeProcess();
  const seen: TunnelView[] = [];
  const tunnel = new QuickTunnel({
    port: () => 8787,
    find: () => '/usr/bin/cloudflared',
    spawnFn: fake.spawnFn,
    env: { PATH: '/usr/bin', MIMI_TOKEN: 'secret-token', OPENAI_API_KEY: 'sk-test' },
    onChange: (view) => seen.push(view),
  });
  assert.equal(tunnel.start().state, 'starting');
  assert.deepEqual(fake.calls[0]!.args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8787']);
  assert.equal(fake.calls[0]!.env.MIMI_TOKEN, undefined, 'no secrets in the child environment');
  assert.equal(fake.calls[0]!.env.OPENAI_API_KEY, undefined);

  fake.child().stderr.write('2026-11-01T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...\n');
  fake.child().stderr.write('2026-11-01T10:00:01Z INF |  https://calm-river-words-test.trycloudflare.com  |\n');
  await tick();
  assert.equal(tunnel.status().state, 'on');
  assert.equal(tunnel.url(), 'https://calm-river-words-test.trycloudflare.com');
  assert.equal(tunnel.start().state, 'on', 'a second start keeps the running tunnel');
  assert.equal(fake.calls.length, 1);

  tunnel.stop();
  assert.equal(tunnel.url(), null);
  assert.equal(fake.child().exitCode, 0);
  assert.deepEqual(seen.map((view) => view.state), ['starting', 'on', 'off']);
});

test('tunnel: missing binary, a crash and a silent start are reported', async () => {
  const missing = new QuickTunnel({ port: () => 1, find: () => null });
  const view = missing.start();
  assert.equal(view.state, 'missing');
  assert.ok(view.hint);

  const fake = fakeProcess();
  const crashing = new QuickTunnel({ port: () => 1, find: () => 'cloudflared', spawnFn: fake.spawnFn, env: {} });
  crashing.start();
  fake.child().stderr.write('ERR failed to request quick Tunnel: 429 Too Many Requests\n');
  await tick();
  fake.child().emit('exit', 1);
  assert.equal(crashing.status().state, 'error');
  assert.match(crashing.status().error ?? '', /429/);

  const silent = fakeProcess();
  const slow = new QuickTunnel({ port: () => 1, find: () => 'cloudflared', spawnFn: silent.spawnFn, env: {}, startTimeoutMs: 20 });
  slow.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(slow.status().state, 'error');
  assert.match(slow.status().error ?? '', /no address/);
  assert.equal(silent.child().exitCode, 0, 'the silent process was stopped');
});
