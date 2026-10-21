import type {
  ConnectorField,
  ConnectorOperation,
  ConnectorRequest,
  ConnectorResult,
  ConnectorRuntime,
  ConnectorSpec,
  ConnectorView,
  FlowItem,
  JsonValue,
} from '@mimi/shared';
import type { ConnectorRegistry } from './registry.ts';
import {
  ConnectorError,
  type ConnectorAuthResolver,
  type ConnectorAuthValues,
  type ConnectorFetch,
} from './types.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_TEXT = 12_000;
const TOKEN_KEYS = ['accessToken', 'access_token', 'token', 'botToken', 'apiKey', 'api_key'];

export interface ConnectorRuntimeOptions {
  registry: ConnectorRegistry;
  /** Missing means every connector is disconnected; tests pass a fake. */
  auth?: ConnectorAuthResolver;
  fetchFn?: ConnectorFetch;
  /** Per request; defaults to 30 seconds. */
  timeoutMs?: number;
  /** Extra attempts for network errors and 429/5xx responses; defaults to 0. */
  retries?: number;
  /** Delay between retries; defaults to 250 ms. */
  retryDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(asJsonValue);
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = asJsonValue(entry);
    }
    return out;
  }
  return String(value);
}

function itemOf(value: unknown): FlowItem {
  if (isRecord(value)) {
    const json: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) json[key] = asJsonValue(entry);
    }
    return { json };
  }
  return { json: { value: asJsonValue(value) } };
}

function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function parseJson(text: string, contentType: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!contentType.includes('json') && !trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

/** Replaces the stored credentials anywhere a response or error may have echoed them. */
function redactString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactValue(entry, secrets);
    return out;
  }
  return value;
}

function errorDetail(body: unknown): string {
  if (typeof body === 'string') return truncate(body.trim(), 500);
  if (!isRecord(body)) return '';
  if (typeof body.error === 'string') {
    const needed = typeof body.needed === 'string' ? ` (needed: ${body.needed})` : '';
    const provided = typeof body.provided === 'string' ? ` (provided: ${body.provided})` : '';
    return `${body.error}${needed}${provided}`;
  }
  if (isRecord(body.error) && typeof body.error.message === 'string') return truncate(body.error.message, 500);
  if (typeof body.message === 'string') return truncate(body.message, 500);
  const first = Array.isArray(body.errors) ? body.errors[0] : undefined;
  if (isRecord(first) && typeof first.message === 'string') return truncate(first.message, 500);
  if (typeof first === 'string') return truncate(first, 500);
  return '';
}

function appendQuery(url: URL, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const entry of value) appendQuery(url, key, entry);
    return;
  }
  if (isRecord(value)) {
    url.searchParams.append(key, JSON.stringify(value));
    return;
  }
  url.searchParams.append(key, String(value));
}

/** Replaces `{{field}}` in a body template; a whole-value placeholder keeps its type. */
function renderTemplate(template: unknown, input: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(template);
    if (whole) return input[whole[1]!];
    return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, key: string) => {
      const value = input[key];
      return value === undefined || value === null ? '' : String(value);
    });
  }
  if (Array.isArray(template)) return template.map((entry) => renderTemplate(entry, input));
  if (isRecord(template)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(template)) {
      const rendered = renderTemplate(entry, input);
      if (rendered !== undefined) out[key] = rendered;
    }
    return out;
  }
  return template;
}

function formValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return '';
  return String(value);
}

function appendForm(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => appendForm(params, `${key}[${index}]`, entry));
    return;
  }
  if (isRecord(value)) {
    for (const [child, entry] of Object.entries(value)) appendForm(params, `${key}[${child}]`, entry);
    return;
  }
  params.append(key, formValue(value));
}

/** Stripe-style application/x-www-form-urlencoded, including nested objects and arrays. */
function encodeForm(body: unknown): string {
  const params = new URLSearchParams();
  if (isRecord(body)) {
    for (const [key, value] of Object.entries(body)) appendForm(params, key, value);
  } else if (body !== undefined) {
    params.append('value', formValue(body));
  }
  return params.toString();
}

function renderItems(spec: ConnectorSpec, operation: ConnectorOperation, items: FlowItem[]): string {
  const label = `${spec.label} ${operation.label}`;
  if (items.length === 0) return `${label}: no items`;
  return truncate(JSON.stringify(items.map((item) => item.json), null, 2), MAX_TEXT);
}

/**
 * Executes connector specs against their HTTP APIs. Phase 0 covers auth headers,
 * timeout, error normalization and item extraction; pagination and rate limiting
 * arrive in Phase 2 behind the same interface.
 */
export class ConnectorRuntimeImpl implements ConnectorRuntime {
  private readonly registry: ConnectorRegistry;
  private readonly auth?: ConnectorAuthResolver;
  private readonly fetchFn: ConnectorFetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(options: ConnectorRuntimeOptions) {
    this.registry = options.registry;
    this.auth = options.auth;
    this.fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = Math.max(0, options.retries ?? 0);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
  }

  list(): ConnectorView[] {
    return this.registry.views();
  }

  get(connector: string): ConnectorSpec | undefined {
    return this.registry.get(connector);
  }

  test(connector: string, operation: string, input: Record<string, unknown>, account?: string): Promise<ConnectorResult> {
    return this.execute({ connector, operation, input, account, agent: 'test' });
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResult> {
    const spec = this.registry.get(request.connector);
    if (!spec) {
      throw new ConnectorError(
        `Unknown connector "${request.connector}". Available: ${this.registry.list().map((entry) => entry.key).join(', ') || 'none'}`,
        request.connector,
        request.operation,
      );
    }
    const operation = spec.operations.find((entry) => entry.key === request.operation);
    if (!operation) {
      throw new ConnectorError(
        `Connector "${spec.key}" has no operation "${request.operation}". Available: ${spec.operations.map((entry) => entry.key).join(', ')}`,
        spec.key,
        request.operation,
      );
    }

    const input = this.resolveInput(spec, operation, request.input);
    const { headers, values } = await this.authFor(spec, operation, request.account);
    const secrets = Object.values(values ?? {}).filter((value) => value.length >= 4);

    const pathParams = new Set<string>();
    const path = operation.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
      const value = input[key];
      if (isMissing(value)) {
        throw new ConnectorError(
          `Connector "${spec.key}" operation "${operation.key}" needs "${key}" in its path`,
          spec.key,
          operation.key,
        );
      }
      pathParams.add(key);
      return encodeURIComponent(String(value));
    });

    const query: Array<[string, unknown]> = [];
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (pathParams.has(key)) continue;
      if (operation.method === 'GET' || operation.method === 'DELETE') query.push([key, value]);
      else body[key] = value;
    }

    let url: URL;
    try {
      if (/^https?:\/\//i.test(path)) url = new URL(path);
      else if (spec.baseUrl) url = new URL(`${spec.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
      else throw new Error('missing baseUrl');
    } catch {
      throw new ConnectorError(
        `Connector "${spec.key}" operation "${operation.key}" has no usable URL`,
        spec.key,
        operation.key,
      );
    }
    for (const [key, value] of query) appendQuery(url, key, value);

    let payload: string | undefined;
    if (operation.method !== 'GET' && operation.method !== 'DELETE') {
      const bodyValue = operation.body === undefined ? (Object.keys(body).length > 0 ? body : undefined) : renderTemplate(operation.body, input);
      if (bodyValue !== undefined) {
        if (operation.bodyFormat === 'form') {
          payload = encodeForm(bodyValue);
          headers.set('content-type', 'application/x-www-form-urlencoded');
        } else {
          payload = JSON.stringify(bodyValue);
          headers.set('content-type', 'application/json');
        }
      }
    }

    let response: Response | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      try {
        response = await this.fetchFn(url, {
          method: operation.method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
          signal,
        });
      } catch (error) {
        if (timeout.aborted) {
          throw new ConnectorError(
            `Connector "${spec.key}" operation "${operation.key}" timed out after ${this.timeoutMs}ms`,
            spec.key,
            operation.key,
          );
        }
        if (request.signal?.aborted) {
          throw new ConnectorError(
            `Connector "${spec.key}" operation "${operation.key}" was aborted`,
            spec.key,
            operation.key,
          );
        }
        if (attempt < this.retries && (operation.method === 'GET' || operation.method === 'DELETE')) {
          await sleep(this.retryDelayMs * (attempt + 1));
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new ConnectorError(
          `Connector "${spec.key}" operation "${operation.key}" failed: ${redactString(message, secrets)}`,
          spec.key,
          operation.key,
        );
      }
      if (!response.ok && RETRY_STATUS.has(response.status) && attempt < this.retries) {
        const safe = response.status === 429 || operation.method === 'GET' || operation.method === 'DELETE';
        if (safe) {
          await response.body?.cancel();
          await sleep(this.retryDelayMs * (attempt + 1));
          continue;
        }
      }
      break;
    }
    if (!response) throw new ConnectorError(`Connector "${spec.key}" operation "${operation.key}" failed`, spec.key, operation.key);

    if (!response.ok) {
      const text = await response.text();
      const parsed = parseJson(text, response.headers.get('content-type') ?? '');
      const detail = redactString(errorDetail(parsed ?? text), secrets);
      throw new ConnectorError(
        `Connector "${spec.label}" ${operation.label} failed (HTTP ${response.status} ${response.statusText})${detail ? `: ${detail}` : ''}`,
        spec.key,
        operation.key,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (operation.response?.binary) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const item: FlowItem = {
        json: {
          mime: contentType || 'application/octet-stream',
          bytes: buffer.byteLength,
          base64: buffer.toString('base64'),
        },
      };
      return {
        items: [item],
        text: `${spec.label} ${operation.label}: ${buffer.byteLength} bytes`,
      };
    }

    const text = await response.text();
    const parsed = parseJson(text, contentType);
    if (isRecord(parsed) && parsed.ok === false) {
      const detail = redactString(errorDetail(parsed), secrets);
      throw new ConnectorError(
        `Connector "${spec.label}" ${operation.label} failed: ${detail || 'request failed'}`,
        spec.key,
        operation.key,
      );
    }

    const safe = redactValue(parsed ?? text, secrets);
    const selected = operation.response?.itemsPath ? getPath(safe, operation.response.itemsPath) : safe;
    const items =
      selected === undefined || selected === null
        ? []
        : Array.isArray(selected)
          ? selected.map((entry) => itemOf(entry))
          : [itemOf(selected)];

    return {
      items,
      text: renderItems(spec, operation, items),
      raw: safe,
    };
  }

  /** Only declared fields reach the request; typos and required gaps become readable errors. */
  private resolveInput(spec: ConnectorSpec, operation: ConnectorOperation, raw: Record<string, unknown>): Record<string, unknown> {
    if (!isRecord(raw)) {
      throw new ConnectorError(`Connector "${spec.key}" operation "${operation.key}" needs an input object`, spec.key, operation.key);
    }
    const fields = new Map(operation.fields.map((field) => [field.key, field]));
    const unknown = Object.keys(raw).filter((key) => !fields.has(key));
    if (unknown.length > 0) {
      throw new ConnectorError(
        `Connector "${spec.key}" operation "${operation.key}" does not know: ${unknown.join(', ')}`,
        spec.key,
        operation.key,
      );
    }

    const input: Record<string, unknown> = {};
    for (const field of operation.fields) {
      let value = raw[field.key];
      if (value === undefined && field.default !== undefined) value = field.default;
      if (isMissing(value)) {
        if (field.required !== false) {
          throw new ConnectorError(
            `Connector "${spec.key}" operation "${operation.key}" needs "${field.key}" (${field.label})`,
            spec.key,
            operation.key,
          );
        }
        continue;
      }
      input[field.key] = this.coerceField(spec, operation, field, value);
    }
    return input;
  }

  private coerceField(spec: ConnectorSpec, operation: ConnectorOperation, field: ConnectorField, value: unknown): unknown {
    if (field.type === 'number') {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) {
        throw new ConnectorError(
          `Connector "${spec.key}" operation "${operation.key}" expected a number for "${field.key}"`,
          spec.key,
          operation.key,
        );
      }
      return number;
    }
    if (field.type === 'boolean') {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1 || value === '1') return true;
      if (value === 'false' || value === 0 || value === '0') return false;
      throw new ConnectorError(
        `Connector "${spec.key}" operation "${operation.key}" expected true/false for "${field.key}"`,
        spec.key,
        operation.key,
      );
    }
    if (field.type === 'json') return value;

    const text = typeof value === 'string' ? value : String(value);
    if (field.type === 'select' && field.options && !field.options.some((option) => option.value === text)) {
      throw new ConnectorError(
        `Connector "${spec.key}" operation "${operation.key}" got an unknown choice for "${field.key}"`,
        spec.key,
        operation.key,
      );
    }
    return text;
  }

  private async authFor(
    spec: ConnectorSpec,
    operation: ConnectorOperation,
    account?: string,
  ): Promise<{ headers: Headers; values?: ConnectorAuthValues }> {
    const headers = new Headers();
    headers.set('accept', 'application/json');
    const extra = spec.auth.extra ?? {};
    if (isRecord(extra.headers)) {
      for (const [key, value] of Object.entries(extra.headers)) {
        if (typeof value === 'string' && value.trim()) headers.set(key, value.trim());
      }
    }
    if (spec.auth.kind === 'none') return { headers };

    const values = this.auth ? await this.auth.resolve(spec.key, account) : undefined;
    if (!values) {
      throw new ConnectorError(
        `Connector "${spec.key}" is not connected. Set up its credential first.`,
        spec.key,
        operation.key,
      );
    }

    const missing = spec.auth.fields.filter((field) => field.required !== false && isMissing(values[field.key]));
    if (missing.length > 0) {
      throw new ConnectorError(
        `Connector "${spec.key}" is not connected: ${missing.map((field) => `"${field.label}"`).join(', ')} is missing`,
        spec.key,
        operation.key,
      );
    }

    if (spec.auth.kind === 'basic') {
      const username = values.username ?? values.user;
      const password = values.password ?? values.pass;
      if (!username || !password) {
        throw new ConnectorError(
          `Connector "${spec.key}" is not connected: username and password are required`,
          spec.key,
          operation.key,
        );
      }
      headers.set('authorization', `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
      return { headers, values };
    }

    if (spec.auth.kind === 'oauth1') {
      throw new ConnectorError(`Connector "${spec.key}" uses OAuth1, which is not supported yet`, spec.key, operation.key);
    }

    const token = TOKEN_KEYS.map((key) => values[key]).find((value) => typeof value === 'string' && value) ??
      spec.auth.fields.map((field) => values[field.key]).find((value) => typeof value === 'string' && value);
    if (!token) {
      throw new ConnectorError(`Connector "${spec.key}" is not connected: no token was found`, spec.key, operation.key);
    }

    const configuredHeader = typeof extra.header === 'string' && extra.header.trim() ? extra.header.trim() : undefined;
    const header = configuredHeader ?? 'Authorization';
    const prefix = typeof extra.prefix === 'string' ? extra.prefix : configuredHeader ? '' : 'Bearer ';
    headers.set(header, `${prefix}${token}`);
    return { headers, values };
  }
}
