import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import type { CustomToolSpec } from '@mimi/shared';
import { buildCustomTool } from '../tools/custom-tools.ts';
import { contextFor, resolveString, resolveValue } from '../workflows/expressions.ts';
import { sandbox, sandboxLaunch } from '../workflows/sandbox.ts';

// Workflow expressions and custom code tools are written by people (or arrive in an imported
// workflow). They run in a separate, locked-down process: nothing in it reaches the core's
// process, its environment (API keys), its files or its network.

after(() => sandbox().close());

// Something only the core's own process holds, standing in for keys and tokens.
const CANARY = 'core-secret-canary-6d1f';
process.env.MIMI_SANDBOX_CANARY = CANARY;
(globalThis as Record<string, unknown>).__mimiCanary = CANARY;

const context = () => contextFor({ json: { name: 'mimi', amount: 120 } }, 0, [{ json: { name: 'mimi', amount: 120 } }, { json: { amount: 80 } }]);

/** Known ways out of a `vm` context in the same process, written as workflow expressions. */
const ESCAPES = [
  '{{ this.constructor.constructor("return process")().env.MIMI_SANDBOX_CANARY }}',
  '{{ $if.constructor("return process")().env.MIMI_SANDBOX_CANARY }}',
  '{{ $json.constructor.constructor("return process")().env }}',
  '{{ ({}).constructor.constructor("return globalThis")().__mimiCanary }}',
  '{{ $item.constructor("return require")()("node:fs").readFileSync("/etc/hosts", "utf8") }}',
  '{{ eval("process") }}',
  '{{ new Function("return process")() }}',
];

test('expressions: the usual escapes fail; process, require and the core are out of reach', async () => {
  for (const expression of ESCAPES) {
    await assert.rejects(resolveString(expression, context()), /Code generation from strings disallowed|not defined/, expression);
  }
  assert.equal(await resolveString('{{ typeof process }}/{{ typeof require }}/{{ typeof fetch }}', context()), 'undefined/undefined/undefined');
  assert.equal(await resolveString('{{ globalThis.__mimiCanary }}', context()), null, 'the core\'s globals are another process');
  // A dynamic import has nothing to load from.
  assert.deepEqual(await resolveString('{{ import("node:fs") }}', context()), {});
  // Still a working expression language.
  assert.equal(await resolveString('{{ $json.name.toUpperCase() }} {{ $if($json.amount > 100, "big", "small") }} {{ $item(1).amount }}', context()), 'MIMI big 80');
  assert.deepEqual(await resolveValue({ a: '{{ $json.amount * 2 }}', b: ['{{ $items.length }}', 'plain'] }, context()), { a: 240, b: [2, 'plain'] });
});

test('expressions: an endless loop is stopped and the sandbox carries on', async () => {
  await assert.rejects(resolveString('{{ (() => { while (true) {} })() }}', context()), /timed out/);
  assert.equal(await resolveString('{{ 1 + 1 }}', context()), 2);
});

const codeTool = (code: string): ReturnType<typeof buildCustomTool> =>
  buildCustomTool({ name: 'probe', description: 'test', kind: 'code', params: [], settings: [], config: { code, timeoutMs: 2000 } } satisfies CustomToolSpec);
const run = (code: string) => codeTool(code).execute({}, { traceId: 't', thread: 't', agent: 'mimi', allowedDirs: [] }, {});

test('code tools: run in the sandbox; the same escapes fail there too', async () => {
  assert.equal(await run('console.log("hi"); return { n: 21 * 2, host: new URL("https://a.example/x").host };'), '{\n  "n": 42,\n  "host": "a.example"\n}\nlogs:\nhi');
  for (const code of [
    'return this.constructor.constructor("return process")().env.MIMI_SANDBOX_CANARY',
    'return URL.constructor("return process")().env',
    'return TextEncoder.constructor("return globalThis")().__mimiCanary',
    'return eval("process")',
  ]) {
    await assert.rejects(run(code), /Code generation from strings disallowed/, code);
  }
  assert.equal(await run('return [typeof process, typeof require, typeof fetch].join(" ")'), 'undefined undefined undefined');
  await assert.rejects(run('return (await import("node:fs")).readFileSync("/etc/hosts", "utf8")'), /dynamic import/);
  await assert.rejects(run('while (true) {}'), /timed out/);
  await assert.rejects(run('await new Promise(() => {})'), /stopped after/);
  assert.equal(await run('return "still working"'), 'still working');
});

test('the sandbox process itself: no files, no child processes, no keys, no code from strings', () => {
  // A probe under exactly the command line the sandbox uses, as if code had got out of its context.
  const probe = String.raw`
    const out = {};
    const attempt = (name, fn) => { try { out[name] = 'open: ' + String(fn()).slice(0, 40); } catch (error) { out[name] = 'blocked: ' + (error.code || error.message).slice(0, 60); } };
    attempt('read', () => require('node:fs').readFileSync('/etc/hosts', 'utf8'));
    attempt('write', () => require('node:fs').writeFileSync(require('node:os').tmpdir() + '/mimi-sandbox-probe', 'x'));
    attempt('spawn', () => require('node:child_process').execSync('echo hi'));
    attempt('worker', () => new (require('node:worker_threads').Worker)('1', { eval: true }));
    attempt('eval', () => eval('1 + 1'));
    attempt('function', () => new Function('return 1')());
    // Set by the OS itself, not passed on: Windows needs SystemRoot; macOS adds its text encoding.
    out.env = Object.keys(process.env).filter((key) => key !== 'SystemRoot' && key !== '__CF_USER_TEXT_ENCODING');
    out.canary = process.env.MIMI_SANDBOX_CANARY ?? null;
    out.netFenced = process.permission ? !process.permission.has('net') : false;
    process.stdout.write(JSON.stringify(out));
  `;
  const launch = sandboxLaunch(probe);
  const result = spawnSync(launch.command, launch.args, { env: launch.env, encoding: 'utf8' });
  const seen = JSON.parse(result.stdout) as Record<string, unknown>;
  for (const name of ['read', 'write', 'spawn', 'worker']) assert.match(String(seen[name]), /^blocked: ERR_ACCESS_DENIED/, `${name}: ${seen[name]}`);
  for (const name of ['eval', 'function']) assert.match(String(seen[name]), /^blocked: Code generation from strings disallowed/, `${name}: ${seen[name]}`);
  assert.deepEqual(seen.env, [], 'an empty environment: no API keys');
  assert.equal(seen.canary, null);
  // Node 25 and later also fence the network under the permission model; Node 24 does not.
  if (process.allowedNodeEnvironmentFlags.has('--allow-net')) assert.equal(seen.netFenced, true);
});

test('code node: runs in the same sandbox; the escapes fail and expressions carry on', async () => {
  const run = (code: string, signal?: AbortSignal) => sandbox().runNode(code, [{ n: 1 }, { n: 2 }], { timeoutMs: 2000, signal });
  const done = await run('console.log($input.all().length); return items.map((item) => ({ json: { n: item.n + $json.n, last: $input.last().json.n } }));');
  assert.deepEqual(done.value, [{ json: { n: 2, last: 2 } }, { json: { n: 3, last: 2 } }]);
  assert.deepEqual(done.logs, ['2']);
  for (const code of [
    'return this.constructor.constructor("return process")().env.MIMI_SANDBOX_CANARY',
    'return $input.all.constructor("return process")().env',
    'return eval("process")',
    'return new Function("return globalThis")().__mimiCanary',
  ]) {
    await assert.rejects(run(code), /Code generation from strings disallowed/, code);
  }
  assert.equal((await run('return [typeof process, typeof require, typeof fetch, typeof globalThis.__mimiCanary].join(" ")')).value, 'undefined undefined undefined undefined');
  await assert.rejects(run('return (await import("node:fs")).readFileSync("/etc/hosts", "utf8")'), /dynamic import/);
  await assert.rejects(run('return "x".repeat(11 * 1024 * 1024)'), /too large \(over 10 MB\)/);

  // A loop after an await is past the vm's own time limit: the process is replaced.
  await assert.rejects(run('await null; while (true) {}'), /stopped after/);
  assert.equal(await resolveString('{{ $json.amount + 1 }}', context()), 121);

  // Stopping the run stops the code, even in a loop, and the sandbox comes back.
  const controller = new AbortController();
  const stuck = run('await null; while (true) {}', controller.signal);
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(stuck, /aborted/);
  await assert.rejects(run('return 1', AbortSignal.abort()), /aborted/);
  assert.equal((await run('return "still working"')).value, 'still working');
});
