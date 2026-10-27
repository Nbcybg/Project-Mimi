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
import { connectorVersion } from './registry.ts';
import { safeFetch, type Lookup } from '../workflows/net-guard.ts';
import {
  ConnectorError,
  type ConnectorAuthResolver,
  type ConnectorAuthValues,
  type ConnectorFetch,
} from './types.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_ITEMS = 1000;
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_TEXT = 12_000;
const TOKEN_KEYS = ['accessToken', 'access_token', 'token', 'botToken', 'apiKey', 'api_key'];

export interface ConnectorRuntimeOptions {
  registry: ConnectorRegistry;
  /** Missing means every connector is disconnected; tests pass a fake. */
  auth?: ConnectorAuthResolver;
  fetchFn?: ConnectorFetch;
  /** Tests can supply a resolver so URL guards stay deterministic. */
  lookup?: Lookup;
  /** Opt in to local/private connector hosts; off by default. */
  allowLocal?: boolean;
  /** Per request; defaults to 30 seconds. */
  timeoutMs?: number;
  /** Extra attempts for network errors and 429/5xx responses; defaults to 0. */
  retries?: number;
  /** Base delay between retries; defaults to 250 ms. */
  retryDelayMs?: number;
  /** Injectable clock and sleeper, for deterministic rate-limit tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface PreparedRequest {
  spec: ConnectorSpec;
  operation: ConnectorOperation;
  input: Record<string, unknown>;
  url: URL;
  headers: Headers;
  payload?: string | Uint8Array;
  secrets: string[];
}

interface PageResult {
  items: FlowItem[];
  raw: unknown;
  url: URL;
  link?: string;
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
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
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
  private readonly customFetch: boolean;
  private readonly lookup?: Lookup;
  private readonly allowLocal: boolean;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(options: ConnectorRuntimeOptions) {
    this.registry = options.registry;
    this.auth = options.auth;
    this.customFetch = options.fetchFn !== undefined;
    this.fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.lookup = options.lookup;
    this.allowLocal = options.allowLocal === true;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = Math.max(0, options.retries ?? 0);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
    this.now = options.now ?? Date.now;
    this.sleepFn = options.sleep ?? sleep;
  }

  list(): ConnectorView[] {
    return this.registry.views();
  }

  get(connector: string, version?: string): ConnectorSpec | undefined {
    return this.registry.get(connector, version);
  }

  test(connector: string, operation: string, input: Record<string, unknown>, account?: string): Promise<ConnectorResult> {
    return this.execute({ connector, operation, input, account, agent: 'test' });
  }

  /** Version metadata for a result: the version that ran, plus a deprecation hint. */
  private resultMeta(spec: ConnectorSpec): Pick<ConnectorResult, 'version' | 'deprecated' | 'latestVersion'> {
    const version = connectorVersion(spec);
    const latest = this.registry.versions(spec.key)[0];
    if (!latest || latest === version) return { version };
    return { version, deprecated: true, latestVersion: latest };
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResult> {
    const spec = this.registry.get(request.connector, request.version);
    if (!spec) {
      const installed = this.registry.versions(request.connector);
      const message = installed.length > 0
        ? `Connector "${request.connector}" version "${request.version}" is not installed. Installed versions: ${installed.join(', ')}`
        : `Unknown connector "${request.connector}". Available: ${this.registry.list().map((entry) => entry.key).join(', ') || 'none'}`;
      throw new ConnectorError(message, request.connector, request.operation);
    }
    const operation = spec.operations.find((entry) => entry.key === request.operation);
    if (!operation) {
      throw new ConnectorError(
        `Connector "${spec.key}" v${connectorVersion(spec)} has no operation "${request.operation}". Available: ${spec.operations.map((entry) => entry.key).join(', ')}`,
        spec.key,
        request.operation,
      );
    }

    const prepared = await this.prepare(spec, operation, request);
    if (operation.paginated && spec.pagination) return this.executePages(prepared, request.signal);
    const response = await this.fetchWithRetry(prepared, request.signal);
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
        ...this.resultMeta(spec),
      };
    }
    const { items, raw } = await this.readPage(prepared, response);
    return {
      items,
      text: renderItems(spec, operation, items),
      raw,
      ...this.resultMeta(spec),
    };
  }

  private async prepare(spec: ConnectorSpec, operation: ConnectorOperation, request: ConnectorRequest): Promise<PreparedRequest> {
    const input = this.resolveInput(spec, operation, request.input);
    const auth = await this.authFor(spec, operation, request.account);
    const headers = auth.headers;
    const secrets = Object.values(auth.values ?? {}).filter((value) => value.length >= 4);

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
    const queryFields = new Set(operation.query ?? []);
    for (const [key, value] of Object.entries(input)) {
      if (pathParams.has(key)) continue;
      if (queryFields.has(key) || operation.method === 'GET' || operation.method === 'DELETE') query.push([key, value]);
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
    for (const [key, value] of Object.entries(auth.query ?? {})) appendQuery(url, key, value);

    let payload: string | Uint8Array | undefined;
    if (operation.method !== 'GET' && operation.method !== 'DELETE') {
      const bodyValue = operation.body === undefined ? (Object.keys(body).length > 0 ? body : undefined) : renderTemplate(operation.body, input);
      if (bodyValue !== undefined) {
        if (operation.bodyFormat === 'form') {
          payload = encodeForm(bodyValue);
          headers.set('content-type', 'application/x-www-form-urlencoded');
        } else if (operation.bodyFormat === 'raw') {
          payload = String(bodyValue);
        } else if (operation.bodyFormat === 'binary') {
          payload = Buffer.from(String(bodyValue), 'base64');
          headers.set('content-type', 'application/octet-stream');
        } else {
          payload = JSON.stringify(bodyValue);
          headers.set('content-type', 'application/json');
        }
      }
    }
    for (const [key, value] of Object.entries(operation.headers ?? {})) {
      headers.set(key, String(renderTemplate(value, input)));
    }
    if (request.idempotencyKey && !headers.has('idempotency-key')) headers.set('idempotency-key', request.idempotencyKey);

    return { spec, operation, input, url, headers, ...(payload === undefined ? {} : { payload }), secrets };
  }

  private async executePages(prepared: PreparedRequest, signal?: AbortSignal): Promise<ConnectorResult> {
    const { spec, operation } = prepared;
    const pagination = spec.pagination!;
    const maxPages = Math.max(1, pagination.maxPages ?? DEFAULT_MAX_PAGES);
    const maxItems = Math.max(1, pagination.maxItems ?? DEFAULT_MAX_ITEMS);
    const items: FlowItem[] = [];
    const pages: unknown[] = [];
    const visited = new Set<string>();
    let url = prepared.url;
    let page = Number(prepared.input[pagination.pageParam ?? 'page'] ?? 1);
    if (!Number.isFinite(page) || page < 1) page = 1;
    if (pagination.mode === 'page') url.searchParams.set(pagination.pageParam ?? 'page', String(page));

    for (let index = 0; index < maxPages; index++) {
      if (visited.has(url.toString())) break;
      visited.add(url.toString());
      const response = await this.fetchWithRetry({ ...prepared, url }, signal);
      const pageResult = await this.readPage({ ...prepared, url }, response);
      pages.push(pageResult.raw);
      items.push(...pageResult.items);
      if (items.length >= maxItems) {
        items.length = maxItems;
        break;
      }
      if (pageResult.items.length === 0) break;

      if (pagination.mode === 'link') {
        if (!pageResult.link) break;
        try {
          url = new URL(pageResult.link, url);
        } catch {
          break;
        }
        continue;
      }

      if (pagination.mode === 'cursor' || pagination.mode === 'nextPageToken') {
        const next = pagination.nextPath ? getPath(pageResult.raw, pagination.nextPath) : undefined;
        if (next === undefined || next === null || next === '') break;
        url = new URL(url);
        url.searchParams.set(pagination.cursorParam ?? 'cursor', String(next));
        continue;
      }

      if (pagination.nextPath) {
        const next = getPath(pageResult.raw, pagination.nextPath);
        if (next === undefined || next === null || next === '' || next === false) break;
      } else {
        const size = pagination.sizeParam ? Number(prepared.input[pagination.sizeParam]) : NaN;
        if (Number.isFinite(size) && size > 0 && pageResult.items.length < size) break;
      }
      page += 1;
      url = new URL(url);
      url.searchParams.set(pagination.pageParam ?? 'page', String(page));
    }

    return {
      items,
      text: renderItems(spec, operation, items),
      raw: pages.length === 1 ? pages[0] : pages,
      ...this.resultMeta(spec),
    };
  }

  private async fetchWithRetry(prepared: PreparedRequest, signal?: AbortSignal): Promise<Response> {
    const { spec, operation, url, headers, payload, secrets } = prepared;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.acquire(spec);
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await safeFetch(
          url.toString(),
          {
            method: operation.method,
            headers,
            ...(payload === undefined ? {} : { body: payload }),
            signal: combined,
          },
          {
            ...(this.customFetch ? { fetchFn: this.fetchFn } : {}),
            ...(this.lookup ? { lookup: this.lookup } : {}),
            ...(this.allowLocal ? { allowLocal: true } : {}),
          },
        );
        if (response.ok || !RETRY_STATUS.has(response.status) || attempt >= this.retries) return response;
        const safe = response.status === 429 || operation.idempotent === true || operation.method === 'GET' || operation.method === 'DELETE';
        if (!safe) return response;
        await response.body?.cancel();
        await this.sleepFn(this.retryDelay(response, attempt));
      } catch (error) {
        lastError = error;
        if (timeout.aborted) {
          throw new ConnectorError(
            `Connector "${spec.key}" operation "${operation.key}" timed out after ${this.timeoutMs}ms`,
            spec.key,
            operation.key,
          );
        }
        if (signal?.aborted) {
          throw new ConnectorError(
            `Connector "${spec.key}" operation "${operation.key}" was aborted`,
            spec.key,
            operation.key,
          );
        }
        const safe = operation.idempotent === true || operation.method === 'GET' || operation.method === 'DELETE';
        if (attempt >= this.retries || !safe) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ConnectorError(
            `Connector "${spec.key}" operation "${operation.key}" failed: ${redactString(message, secrets)}`,
            spec.key,
            operation.key,
          );
        }
        await this.sleepFn(this.retryDelay(undefined, attempt));
      }
    }
    const message = lastError instanceof Error ? lastError.message : 'request failed';
    throw new ConnectorError(`Connector "${spec.key}" operation "${operation.key}" failed: ${message}`, spec.key, operation.key);
  }

  private retryDelay(response: Response | undefined, attempt: number): number {
    const header = response?.headers.get('retry-after');
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
      const at = Date.parse(header);
      if (Number.isFinite(at)) return Math.max(0, Math.min(at - this.now(), 60_000));
    }
    const base = this.retryDelayMs * 2 ** attempt;
    return Math.round(base + Math.random() * base * 0.25);
  }

  private async acquire(spec: ConnectorSpec): Promise<void> {
    const limit = spec.rateLimit;
    if (!limit || limit.requests <= 0 || limit.perMs <= 0) return;
    const capacity = Math.max(1, limit.burst ?? limit.requests);
    const rate = limit.requests / limit.perMs;
    const now = this.now();
    const bucket = this.buckets.get(spec.key) ?? { tokens: capacity, at: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.at) * rate);
    bucket.at = now;
    if (bucket.tokens < 1) {
      const wait = Math.ceil((1 - bucket.tokens) / rate);
      await this.sleepFn(wait);
      const after = this.now();
      bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, after - bucket.at) * rate);
      bucket.at = after;
    }
    bucket.tokens = Math.max(0, bucket.tokens - 1);
    this.buckets.set(spec.key, bucket);
  }

  private async readPage(prepared: PreparedRequest, response: Response): Promise<PageResult> {
    const { spec, operation, url, secrets } = prepared;
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
    const itemsPath = operation.response?.itemsPath ?? spec.pagination?.itemsPath;
    const selected = itemsPath ? getPath(safe, itemsPath) : safe;
    const items =
      selected === undefined || selected === null
        ? []
        : Array.isArray(selected)
          ? selected.map((entry) => itemOf(entry))
          : [itemOf(selected)];
    const link = response.headers.get('link') ?? undefined;
    return { items, raw: safe, url, ...(link === undefined ? {} : { link }) };
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
  ): Promise<{ headers: Headers; values?: ConnectorAuthValues; query?: Record<string, string> }> {
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

    if (extra.location === 'query') {
      const names = isRecord(extra.queryNames) ? extra.queryNames : {};
      const query: Record<string, string> = {};
      for (const field of spec.auth.fields) {
        const value = values[field.key];
        if (typeof value !== 'string' || !value) continue;
        const name = typeof names[field.key] === 'string' ? String(names[field.key]) : field.key;
        query[name] = value;
      }
      return { headers, values, query };
    }

    const configuredHeader = typeof extra.header === 'string' && extra.header.trim() ? extra.header.trim() : undefined;
    const header = configuredHeader ?? 'Authorization';
    const prefix = typeof extra.prefix === 'string' ? extra.prefix : configuredHeader ? '' : 'Bearer ';
    headers.set(header, `${prefix}${token}`);
    return { headers, values };
  }
}
