import { exec } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import type { CustomToolSpec, ToolSettingField, ToolSettingValues } from '@mimi/shared';
import { z } from 'zod';
import type { PcRunner } from './executor.ts';
import { defineTool, type ToolContext, type ToolDefinition } from './registry.ts';

export const MAX_TOOL_OUTPUT = 20_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Everything a template may use: {{input.x}}, {{settings.x}}, {{secret.NAME}}, {{env.NAME}} and bare {{x}}. */
export interface TemplateScope {
  input: Record<string, unknown>;
  settings: ToolSettingValues;
  secret(name: string): string | undefined;
}

export function renderTemplate(text: string, scope: TemplateScope): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    if (key.startsWith('secret.')) return scope.secret(key.slice(7)) ?? '';
    if (key.startsWith('env.')) return scope.secret(key.slice(4)) ?? '';
    if (key.startsWith('input.')) {
      const value = scope.input[key.slice(6)];
      return value === undefined || value === null ? '' : String(value);
    }
    if (key.startsWith('settings.')) {
      const value = scope.settings[key.slice(9)];
      return value === undefined || value === null ? '' : String(value);
    }
    const value = scope.input[key] ?? scope.settings[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function truncateOutput(text: string, limit = MAX_TOOL_OUTPUT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

/** Merges declared defaults into the values, and refuses a call while a required setting is empty. */
export function resolveSettings(fields: ToolSettingField[], values: ToolSettingValues, toolName: string): ToolSettingValues {
  const merged: ToolSettingValues = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (raw !== undefined && raw !== null && raw !== '') merged[field.key] = raw;
    else if (field.default !== undefined && field.default !== '') merged[field.key] = field.default;
  }
  const missing = fields.filter((field) => field.required !== false && merged[field.key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Tool "${toolName}" needs its settings first: ${missing.map((field) => `"${field.label}"`).join(', ')}. Make a preset of it on the Tools screen (Hub → Tools) and give the agent that preset.`,
    );
  }
  return merged;
}

function paramsSchema(params: CustomToolSpec['params']): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of params) {
    let field: z.ZodTypeAny =
      param.type === 'number' ? z.number() : param.type === 'boolean' ? z.boolean() : z.string();
    if (param.description) field = field.describe(param.description);
    shape[param.key] = param.required === false ? field.optional() : field;
  }
  return z.object(shape);
}

interface HttpConfig {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string;
  bodyType?: 'json' | 'text' | 'form';
  timeoutMs?: number;
}

function scopeFor(
  input: unknown,
  settings: ToolSettingValues,
  secret: (name: string) => string | undefined = (name) => process.env[name],
): TemplateScope {
  return {
    input: (input ?? {}) as Record<string, unknown>,
    settings,
    secret,
  };
}

function riskOf(spec: CustomToolSpec): 'read' | 'network' | 'shell' {
  if (spec.kind === 'http') {
    const method = String(spec.config.method ?? 'GET').toUpperCase();
    return method === 'GET' || method === 'HEAD' ? 'read' : 'network';
  }
  return 'shell';
}

async function runHttp(
  config: HttpConfig,
  input: unknown,
  settings: ToolSettingValues,
  signal: AbortSignal | undefined,
  secret: (name: string) => string | undefined,
): Promise<string> {
  const scope = scopeFor(input, settings, secret);
  const method = String(config.method ?? 'GET').toUpperCase();
  let url = renderTemplate(config.url, scope);
  const query = Object.entries(config.query ?? {});
  if (query.length > 0) {
    const parsed = new URL(url);
    for (const [key, value] of query) parsed.searchParams.append(renderTemplate(key, scope), renderTemplate(value, scope));
    url = parsed.toString();
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    const rendered = renderTemplate(value, scope);
    if (rendered) headers[key] = rendered;
  }

  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD' && config.body) {
    body = renderTemplate(config.body, scope);
    headers['content-type'] ??=
      config.bodyType === 'form' ? 'application/x-www-form-urlencoded' : config.bodyType === 'text' ? 'text/plain; charset=utf-8' : 'application/json';
  }

  const timeout = AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${truncateOutput(text, 500)}`);
  return truncateOutput(text);
}

async function runCode(spec: CustomToolSpec, input: unknown, settings: ToolSettingValues): Promise<string> {
  const code = String(spec.config.code ?? '');
  const timeoutMs = Number(spec.config.timeoutMs) || 10_000;
  const logs: string[] = [];
  const log = (...parts: unknown[]) => logs.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
  const sandbox = {
    input,
    settings,
    console: { log, info: log, warn: log, error: log },
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Set,
    Map,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Intl,
    isNaN,
    parseInt,
    parseFloat,
  };
  const wrapped = `(async () => {\n${code}\n})()`;
  const result: unknown = await vm.runInNewContext(wrapped, sandbox, { timeout: timeoutMs, filename: `tool:${spec.name}` });
  const output =
    result === undefined ? '' : typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  const joined = [output, logs.length > 0 ? `logs:\n${logs.join('\n')}` : ''].filter(Boolean).join('\n');
  return truncateOutput(joined || '(the code returned nothing)');
}

async function runShell(
  spec: CustomToolSpec,
  input: unknown,
  settings: ToolSettingValues,
  context: ToolContext,
  secret: (name: string) => string | undefined,
  pc?: PcRunner,
): Promise<string> {
  const scope = scopeFor(input, settings, secret);
  const command = renderTemplate(String(spec.config.command ?? ''), scope);
  const requested = typeof spec.config.cwd === 'string' && spec.config.cwd.trim() ? renderTemplate(spec.config.cwd, scope) : undefined;
  if (spec.config.runsOn === 'pc' && pc) {
    const mode = pc.mode();
    // On the user's PC: the PC agent's own shell tool runs it (its folder check and time limit apply there).
    if (mode === 'remote' || mode === 'offline') {
      const timeout = Number(spec.config.timeoutMs) || DEFAULT_TIMEOUT_MS;
      return truncateOutput(await pc.execute('run_shell', { command, ...(requested ? { cwd: requested } : {}), timeout_ms: Math.min(timeout, 600_000) }, context));
    }
  }
  const cwd = path.resolve(requested ?? context.allowedDirs[0] ?? process.cwd());
  const allowed = context.allowedDirs.map((dir) => path.resolve(dir));
  if (allowed.length > 0 && !allowed.some((dir) => cwd === dir || cwd.startsWith(dir + path.sep))) {
    throw new Error(`The working folder "${cwd}" is outside the allowed folders.`);
  }
  const timeoutMs = Number(spec.config.timeoutMs) || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const output = truncateOutput([stdout, stderr].filter(Boolean).join('\n').trim());
        if (error) {
          reject(new Error(`Command failed (${error.message.split('\n')[0]}):\n${output || '(no output)'}`));
          return;
        }
        resolve(output || '(no output)');
      },
    );
  });
}

/**
 * Turns a user-defined tool into a normal tool definition. Templates read the caller's
 * input, the preset's settings, and secrets from the machine's vault (or the
 * environment) — never from files, so an API key stays out of the synced pool.
 */
export function buildCustomTool(
  spec: CustomToolSpec,
  secret: (name: string) => string | undefined = (name) => process.env[name],
  pc?: PcRunner,
): ToolDefinition<Record<string, unknown>> {
  const risk = riskOf(spec);
  const tool = defineTool({
    name: spec.name,
    description: spec.description,
    risk,
    target: 'core',
    // HTTP tools read a stranger's data; code and shell tools are the dangerous side of the fence.
    untrustedInput: spec.kind === 'http',
    settings: spec.settings,
    inputSchema: paramsSchema(spec.params),
    summarize: (input) => {
      const scope = scopeFor(input, {}, secret);
      if (spec.kind === 'http') {
        const config = spec.config as unknown as HttpConfig;
        return `HTTP ${String(config.method ?? 'GET').toUpperCase()} ${truncateOutput(renderTemplate(config.url, scope), 120)}`;
      }
      if (spec.kind === 'shell') return `Run: ${truncateOutput(renderTemplate(String(spec.config.command ?? ''), scope), 120)}`;
      return `Run JavaScript tool "${spec.name}"`;
    },
    async execute(input, context, settings) {
      const values = resolveSettings(spec.settings, settings ?? {}, spec.name);
      if (spec.kind === 'http') {
        return runHttp(spec.config as unknown as HttpConfig, input, values, context.signal, secret);
      }
      if (spec.kind === 'code') return runCode(spec, input, values);
      return runShell(spec, input, values, context, secret, pc);
    },
  });
  return tool;
}
