import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// The core the native apps start on this machine (app/native-host.ts): one ready line, the user's token,
// 127.0.0.1 only, and it stops when the app closes its stdin.

const entry = path.resolve(import.meta.dirname, '../app/native-host.ts');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function host(root: string, port: number): { child: ChildProcess; ready: Promise<Record<string, unknown>> } {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, MIMI_ROOT: root, PORT: String(port), MIMI_TOKEN: '', MIMI_CALENDAR_SYNC: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const line = buffer.split('\n').find((entry) => entry.startsWith('@@mimi-host@@'));
      if (line) resolve(JSON.parse(line.slice('@@mimi-host@@'.length)) as Record<string, unknown>);
    });
    child.once('exit', (code) => reject(new Error(`host ended (${code}) before it was ready: ${buffer}`)));
    setTimeout(() => reject(new Error('no ready line in 45 s')), 45_000).unref();
  });
  return { child, ready };
}

test('the native host starts the core on 127.0.0.1, says where and stops when stdin closes', { timeout: 90_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-native-host-'));
  fs.copyFileSync(path.resolve(import.meta.dirname, '../../../../mimi.json'), path.join(root, 'mimi.json'));
  const port = await freePort();
  const first = host(root, port);
  try {
    const ready = await first.ready;
    assert.equal(ready.port, port);
    assert.equal(typeof ready.token, 'string');
    assert.ok((ready.token as string).length >= 24);
    assert.equal(ready.external, undefined);
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { ok?: boolean };
    assert.equal(health.ok, true);
    // The token lives in the app settings, so the next start (and the app) get the same one.
    const settings = JSON.parse(fs.readFileSync(path.join(root, 'user', 'data', 'app-settings.json'), 'utf8')) as { token?: string };
    assert.equal(settings.token, ready.token);

    // A second start finds the first one running and hands its address over instead of starting again.
    const second = host(root, port);
    const again = await second.ready;
    assert.deepEqual({ port: again.port, token: again.token, external: again.external }, { port, token: ready.token, external: true });
    await new Promise((resolve) => second.child.once('exit', resolve));

    const ended = new Promise<number | null>((resolve) => first.child.once('exit', resolve));
    first.child.stdin!.end();
    assert.equal(await ended, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }));
  } finally {
    first.child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
