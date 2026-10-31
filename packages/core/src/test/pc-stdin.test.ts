import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { copyPcAgentPackages, packPcAgent } from '../../../../scripts/pack-pc-agent.mjs';
import { startServer } from '../server/server.ts';
import { testCoreParts } from './core-helpers.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ROOT = path.resolve(import.meta.dirname, '../../../..');

async function boot() {
  const parts = testCoreParts({});
  const token = 'stdin-token';
  const server = await startServer(
    { ...parts.config, token, host: '127.0.0.1', port: 0, localPcTools: false },
    parts.coreOptions,
  );
  const pcDir = fs.realpathSync.native(fs.mkdtempSync(path.join(parts.root, 'pc-')));
  return { parts, token, server, pcDir };
}

function startAgent(entry: string, server: { port: number }, pcDir: string, token: string): { child: ChildProcess; lines: string[] } {
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      MIMI_TOKEN_STDIN: '1',
      MIMI_CONSENT_STDIO: '1',
      MIMI_CORE_URL: `ws://127.0.0.1:${server.port}/ws`,
      ALLOWED_DIRS: pcDir,
      MIMI_PC_NAME: 'stdin-pc',
      MIMI_LOCAL_CONSENT: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines: string[] = [];
  child.stdout!.on('data', (data) => lines.push(String(data)));
  child.stderr!.on('data', (data) => lines.push(String(data)));
  child.stdin!.write(`${token}\n`);
  return { child, lines };
}

async function stopAgent(child: ChildProcess): Promise<void> {
  child.stdin!.end();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2_000)]);
  if (child.exitCode === null) child.kill();
}

/**
 * The desktop app starts the PC agent with the token on stdin, not in the environment.
 * This is the handshake a packaged app depends on; it broke once and is easy to regress.
 */
test('PC agent reads its token from stdin and connects', async () => {
  const { parts, token, server, pcDir } = await boot();
  const { child, lines } = startAgent(path.join(ROOT, 'packages/pc-agent/src/main.ts'), server, pcDir, token);
  try {
    const deadline = Date.now() + 8_000;
    while (!server.pc.online && Date.now() < deadline) await sleep(50);
    assert.equal(server.pc.online, true, lines.join(''));
    assert.equal(server.pc.name, 'stdin-pc');
  } finally {
    await stopAgent(child);
    await server.close();
    fs.rmSync(parts.root, { recursive: true, force: true });
  }
});

/**
 * Node 24 refuses to strip TypeScript types from files under node_modules. The
 * packaged app used to start the agent from node_modules/@mimi/pc-agent and could
 * never connect; the build now copies it beside the app.
 */
test('the packaged layout starts the PC agent outside node_modules', async () => {
  const { parts, token, server, pcDir } = await boot();
  const app = fs.realpathSync.native(fs.mkdtempSync(path.join(parts.root, 'app-')));
  packPcAgent(ROOT, app);
  copyPcAgentPackages(ROOT, app);
  assert.equal(fs.existsSync(path.join(app, 'node_modules', '@mimi', 'pc-agent')), false);
  assert.ok(fs.existsSync(path.join(app, 'node_modules', 'pdf-lib')), 'pdf-lib travels with the PC agent');
  assert.match(fs.readFileSync(path.join(app, 'pc-agent/src/tools/organize.ts'), 'utf8'), /shared\/src\/index\.ts/);
  const entry = path.join(app, 'pc-agent/src/main.ts');
  const { child, lines } = startAgent(entry, server, pcDir, token);
  try {
    const deadline = Date.now() + 8_000;
    while (!server.pc.online && Date.now() < deadline) await sleep(50);
    assert.equal(server.pc.online, true, lines.join(''));
    assert.equal(server.pc.name, 'stdin-pc');
  } finally {
    await stopAgent(child);
    await server.close();
    fs.rmSync(parts.root, { recursive: true, force: true });
  }
});
