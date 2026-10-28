import { spawn } from 'node:child_process';

/**
 * Runs a code node in its own Node process under the permission model: no file
 * access, no child processes, no workers, and an empty environment (so no API keys).
 * `node:vm` alone is not a security boundary; a separate locked-down process is.
 * The permission model blocks network access too from Node 25 on (the Docker image runs
 * Node 26); on Node 24 the code can still open connections.
 */

const RUNNER = `
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', async () => {
  const logs = [];
  const log = (...parts) => logs.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
  const send = (value) => process.stdout.write('\\u0000MIMI\\u0000' + JSON.stringify(value));
  try {
    const { code, items } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const $input = {
      all: () => items.map((json) => ({ json })),
      first: () => ({ json: items[0] ?? {} }),
      last: () => ({ json: items.at(-1) ?? {} }),
      item: { json: items[0] ?? {} },
    };
    const console = { log, info: log, warn: log, error: log };
    const run = new Function('items', '$json', '$items', '$input', 'console', 'return (async () => {\\n' + code + '\\n})()');
    const result = await run(items, items[0] ?? {}, items, $input, console);
    send({ ok: true, result: result === undefined ? null : result, undefined: result === undefined, logs });
  } catch (error) {
    send({ ok: false, error: String(error && error.message ? error.message : error), logs });
  }
});
`;

const MAX_OUTPUT = 10 * 1024 * 1024;

export interface CodeResult {
  /** What the code returned; `undefined` when it returned nothing. */
  result: unknown;
  logs: string[];
}

export function runCodeIsolated(
  code: string,
  items: unknown[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CodeResult> {
  return new Promise((resolve, reject) => {
    // Windows needs SystemRoot for the runtime itself; nothing else is passed on.
    const env: NodeJS.ProcessEnv = process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
    const child = spawn(process.execPath, ['--permission', '--max-old-space-size=256', '-e', RUNNER], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const finish = (error: Error | null, value?: CodeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (!child.killed && child.exitCode === null) child.kill();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(`code node: stopped after ${(options.timeoutMs ?? 15_000) / 1000} s`)), options.timeoutMs ?? 15_000);
    const onAbort = () => finish(new Error('aborted'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) return finish(new Error('code node: the result is too large (over 10 MB)'));
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(new Error(`code node: could not start the sandbox: ${error.message}`)));
    child.on('close', () => {
      const text = Buffer.concat(out).toString('utf8');
      const at = text.lastIndexOf('\u0000MIMI\u0000');
      if (at < 0) return finish(new Error(`code node: the sandbox ended without a result${stderr ? `: ${stderr.trim().split('\n')[0]}` : ''}`));
      let reply: { ok: boolean; result?: unknown; undefined?: boolean; error?: string; logs?: string[] };
      try {
        reply = JSON.parse(text.slice(at + 6));
      } catch {
        return finish(new Error('code node: the result is not JSON (return plain data: objects, arrays, text, numbers)'));
      }
      if (!reply.ok) return finish(new Error(reply.error || 'code node failed'));
      finish(null, { result: reply.undefined ? undefined : reply.result, logs: reply.logs ?? [] });
    });
    child.stdin.end(JSON.stringify({ code, items }));
  });
}
