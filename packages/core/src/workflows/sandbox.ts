import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { JsonValue } from '@mimi/shared';

/**
 * Where code people write runs: workflow expressions (`{{ $json.x }}`), workflow code nodes
 * and custom tools of the "code" kind. `node:vm` alone is not a security boundary (an expression could reach the
 * core's `process`, its keys and files), so this code runs in a separate, locked-down Node
 * process that lives as long as the core:
 *
 * - the permission model: no file access, no child processes, no workers, no native addons,
 *   and (Node 25 and later) no network;
 * - an empty environment, so no API keys;
 * - no code generation from strings in that process (eval, new Function);
 * - every request in a fresh context of its own, whose data arrives as JSON text, so no
 *   object of that process is reachable from the code;
 * - a time limit per request; a stuck process is killed and started again.
 *
 * Data in and out is JSON.
 */

const CHILD = String.raw`
'use strict';
const vm = require('node:vm');
const write = process.stdout.write.bind(process.stdout);
const send = (message) => write(JSON.stringify(message) + '\n');
const DONT_CONTEXTIFY = vm.constants && vm.constants.DONT_CONTEXTIFY;
const Url = URL, UrlSearchParams = URLSearchParams, Encoder = TextEncoder, Decoder = TextDecoder;

// Run inside the fresh context: its data arrives as text, parsed by that context's own JSON.
const PRELUDE = '(() => {' +
  'const data = JSON.parse(globalThis.__data); delete globalThis.__data;' +
  'for (const key of Object.keys(data)) globalThis[key] = data[key];' +
  'const toNumber = (v) => (typeof v === "number" ? v : Number(v));' +
  'const numbers = (values) => values.map(toNumber).filter((v) => !Number.isNaN(v));' +
  'globalThis.$item = (at) => (globalThis.$items || [])[at] ?? {};' +
  'globalThis.$if = (c, a, b) => (c ? a : b);' +
  'globalThis.$ifEmpty = (v, f) => (v === undefined || v === null || v === "" ? f : v);' +
  'globalThis.$max = (...v) => Math.max(...numbers(v));' +
  'globalThis.$min = (...v) => Math.min(...numbers(v));' +
  'globalThis.$average = (...v) => { const n = numbers(v); return n.length === 0 ? 0 : n.reduce((s, x) => s + x, 0) / n.length; };' +
  'globalThis.$number = toNumber;' +
  'globalThis.$string = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));' +
  // Results leave as text: [kind, text]. "u" undefined, "n" number, "j" JSON, "s" other.
  'globalThis.__out = (v) => { if (v === undefined) return ["u", ""]; if (typeof v === "number") return ["n", String(v)];' +
  ' if (typeof v === "function" || typeof v === "symbol") return ["u", ""];' +
  ' try { const s = JSON.stringify(v); return s === undefined ? ["u", ""] : ["j", s]; } catch { return ["s", String(v)]; } };' +
  '})()';

function fresh(data, extra) {
  const context = DONT_CONTEXTIFY ? vm.createContext(DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: false } }) : vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext('globalThis.__data = ' + JSON.stringify(JSON.stringify(data)) + ';', context);
  vm.runInContext(PRELUDE, context);
  if (extra) extra(context);
  return context;
}

function out(pair) {
  if (!Array.isArray(pair)) return { kind: 'u' };
  return { kind: String(pair[0]), text: String(pair[1]).slice(0, 16 * 1024 * 1024) };
}

function evaluate(request) {
  const context = fresh(request.data || {});
  return request.expressions.map((expression) => {
    try {
      const script = new vm.Script('__out((' + expression + '\n))', { filename: 'expression' });
      return { ok: true, value: out(script.runInContext(context, { timeout: request.timeoutMs || 1000 })) };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });
}

// The n8n-style names a workflow code node sees, over its items' JSON.
const NODE_PRELUDE = '(() => {' +
  'const items = globalThis.items;' +
  'globalThis.$json = items[0] ?? {}; globalThis.$items = items;' +
  'globalThis.$input = { all: () => items.map((json) => ({ json })), first: () => ({ json: items[0] ?? {} }),' +
  ' last: () => ({ json: items.at(-1) ?? {} }), item: { json: items[0] ?? {} } };' +
  '})()';

async function code(request) {
  const node = request.op === 'node';
  const logs = [];
  const log = (...parts) => logs.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ').slice(0, 2000));
  // Not ECMAScript built-ins, so they come from this process: harmless here, nothing beyond it.
  const variables = node ? { items: Array.isArray(request.items) ? request.items : [] } : { input: request.input ?? null, settings: request.settings ?? {} };
  const context = fresh(variables, (target) => {
    target.__log = log;
    target.URL = Url; target.URLSearchParams = UrlSearchParams; target.TextEncoder = Encoder; target.TextDecoder = Decoder;
  });
  vm.runInContext('globalThis.console = { log: __log, info: __log, warn: __log, error: __log }; delete globalThis.__log;', context);
  if (node) vm.runInContext(NODE_PRELUDE, context);
  const script = new vm.Script('(async () => {\n' + request.code + '\n})().then(__out)', { filename: node ? 'code node' : 'tool:' + request.name });
  const timeout = request.timeoutMs || 10000;
  const pending = script.runInContext(context, { timeout });
  let timer;
  const value = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stopped after ' + timeout / 1000 + ' s')), timeout); })]);
  clearTimeout(timer);
  if (node && Array.isArray(value) && String(value[1]).length > 10 * 1024 * 1024) throw new Error('the result is too large (over 10 MB)');
  return { value: out(value), logs };
}

// Code that leaves a promise failing (or throws later) must not take the process down for everyone.
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request.op === 'eval') {
      let results;
      try { results = evaluate(request); } catch (error) { send({ id: request.id, ok: false, error: String(error && error.message || error) }); continue; }
      send({ id: request.id, ok: true, results });
    } else if (request.op === 'code' || request.op === 'node') {
      code(request).then(
        (result) => send({ id: request.id, ok: true, ...result }),
        (error) => send({ id: request.id, ok: false, error: String(error && error.message ? error.message : error) }),
      );
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

/**
 * How the sandbox process is started, for `script`: the fence is the command line itself
 * (exported so a test can run a probe under exactly the same rules).
 */
export function sandboxLaunch(script: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  // Windows needs SystemRoot for the runtime itself; nothing else is passed on.
  const env: NodeJS.ProcessEnv = process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
  return {
    command: process.execPath,
    args: ['--permission', '--disallow-code-generation-from-strings', '--max-old-space-size=256', '-e', script],
    env,
  };
}

/** What a request returns: a value from the code, as JSON-compatible data. */
export type SandboxValue = JsonValue | undefined;

export interface EvalResult {
  ok: boolean;
  value?: SandboxValue;
  error?: string;
}

interface Pending {
  resolve(reply: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function decode(raw: unknown): SandboxValue {
  const { kind, text } = (raw ?? {}) as { kind?: string; text?: string };
  if (kind === 'n') return Number(text);
  if (kind === 'j') return JSON.parse(text ?? 'null') as JsonValue;
  if (kind === 's') return text ?? '';
  return undefined;
}

const MAX_REPLY = 32 * 1024 * 1024;

export class Sandbox {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';

  private start(): ChildProcessWithoutNullStreams {
    const launch = sandboxLaunch(CHILD);
    const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > MAX_REPLY) return this.restart(new Error('the sandbox answered with too much data'));
      let at: number;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        let reply: Record<string, unknown>;
        try {
          reply = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const waiting = this.pending.get(Number(reply.id));
        if (!waiting) continue;
        this.pending.delete(Number(reply.id));
        clearTimeout(waiting.timer);
        waiting.resolve(reply);
      }
      this.idle();
    });
    child.stderr.on('data', () => {});
    child.on('error', (error) => this.restart(new Error(`the sandbox could not start: ${error.message}`)));
    child.on('exit', () => {
      if (this.child === child) this.restart(new Error('the sandbox stopped'));
    });
    return child;
  }

  /** Fails what is in flight and forgets the process; the next request starts a new one. */
  private restart(error: Error): void {
    const child = this.child;
    this.child = null;
    this.buffer = '';
    if (child && child.exitCode === null) child.kill('SIGKILL');
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      this.pending.delete(id);
      waiting.reject(error);
    }
  }

  /** A sandbox with nothing to do does not keep the core (or a test) running. */
  private idle(): void {
    const child = this.child;
    if (!child) return;
    const hold = this.pending.size > 0;
    for (const handle of [child, child.stdin, child.stdout, child.stderr] as Array<{ ref(): void; unref(): void }>) {
      if (hold) handle.ref();
      else handle.unref();
    }
  }

  private request(body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    this.child ??= this.start();
    const id = this.nextId++;
    const child = this.child;
    return new Promise((resolve, reject) => {
      // Past its time, or when the run is stopped, the code may still be running (perhaps in a
      // loop): the process is replaced.
      const stop = (error: Error, reason: string) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
        if (this.child === child) this.restart(new Error(reason));
      };
      const timer = setTimeout(() => stop(new Error(`stopped after ${Math.round(timeoutMs / 1000)} s`), 'the sandbox was restarted after a request ran too long'), timeoutMs);
      const onAbort = () => stop(new Error('aborted'), 'the sandbox was restarted after a run was stopped');
      signal?.addEventListener('abort', onAbort, { once: true });
      const settled = <T>(settle: (value: T) => void) => (value: T) => {
        signal?.removeEventListener('abort', onAbort);
        settle(value);
      };
      this.pending.set(id, { resolve: settled(resolve), reject: settled(reject), timer });
      this.idle();
      child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    });
  }

  /** Evaluates expressions against one set of variables; one result per expression, in order. */
  async evaluate(expressions: string[], data: Record<string, unknown>, timeoutMs = 1000): Promise<EvalResult[]> {
    if (expressions.length === 0) return [];
    const reply = await this.request({ op: 'eval', expressions, data, timeoutMs }, timeoutMs * expressions.length + 5000);
    if (reply.ok !== true) throw new Error(String(reply.error ?? 'expression failed'));
    return (reply.results as Array<{ ok: boolean; value?: unknown; error?: string }>).map((result) =>
      result.ok ? { ok: true, value: decode(result.value) } : { ok: false, error: result.error },
    );
  }

  /** Runs the body of a custom code tool: `input` and `settings` are its variables; it may `return` a value. */
  async runCode(
    name: string,
    code: string,
    variables: { input: unknown; settings: unknown },
    timeoutMs = 10_000,
  ): Promise<{ value: SandboxValue; logs: string[] }> {
    const reply = await this.request({ op: 'code', name, code, ...variables, timeoutMs }, timeoutMs + 3000);
    if (reply.ok !== true) throw new Error(String(reply.error ?? 'the code failed'));
    return { value: decode(reply.value), logs: (reply.logs as string[] | undefined) ?? [] };
  }

  /**
   * Runs a workflow code node over its items' JSON. It sees `items`, `$json`, `$items` and
   * `$input` as in n8n and may `return` items; the value is `undefined` when it returns nothing.
   */
  async runNode(
    code: string,
    items: JsonValue[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ value: SandboxValue; logs: string[] }> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const reply = await this.request({ op: 'node', code, items, timeoutMs }, timeoutMs + 3000, options.signal);
    if (reply.ok !== true) throw new Error(String(reply.error ?? 'the code failed'));
    return { value: decode(reply.value), logs: (reply.logs as string[] | undefined) ?? [] };
  }

  close(): void {
    const child = this.child;
    this.restart(new Error('the sandbox was closed'));
    child?.stdin.end();
  }
}

let shared: Sandbox | undefined;

/** The one sandbox process of this core, started on first use. */
export function sandbox(): Sandbox {
  shared ??= new Sandbox();
  return shared;
}
