import fs from 'node:fs';
import path from 'node:path';

export interface IdempotencyStoreOptions {
  /** How long a key is remembered; default 24 hours. */
  ttlMs?: number;
  /** Oldest keys are dropped beyond this; default 5000. */
  maxEntries?: number;
  /** JSON file that keeps the keys across restarts. */
  file?: string;
  now?: () => number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_ENTRIES = 5000;
const PRUNE_INTERVAL_MS = 60_000;

/** A bounded, expiring set of keys; `claim` is atomic for a single event. */
export class IdempotencyStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly file?: string;
  private readonly now: () => number;
  private readonly entries = new Map<string, number>();
  private nextPrune = 0;

  constructor(options: IdempotencyStoreOptions = {}) {
    const ttl = Math.floor(Number(options.ttlMs));
    const max = Math.floor(Number(options.maxEntries));
    this.ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MS;
    this.maxEntries = Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_ENTRIES;
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.load();
  }

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  /** True when the key is new; the key is remembered until the TTL runs out. */
  claim(key: string): boolean {
    const now = this.now();
    this.prune(now);
    if (this.entries.has(key)) return false;
    this.entries.set(key, now);
    this.trim();
    this.persist();
    return true;
  }

  has(key: string): boolean {
    this.prune();
    return this.entries.has(key);
  }

  /** Drops a claim so a failed event can be retried. */
  release(key: string): boolean {
    const removed = this.entries.delete(key);
    if (removed) this.persist();
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.nextPrune = 0;
    this.persist();
  }

  private prune(now = this.now()): void {
    if (now < this.nextPrune) return;
    this.nextPrune = now + Math.min(this.ttlMs, PRUNE_INTERVAL_MS);
    for (const [key, at] of this.entries) {
      if (now - at >= this.ttlMs) this.entries.delete(key);
    }
    if (this.entries.size > this.maxEntries) {
      this.trim();
      this.persist();
    }
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const now = this.now();
      for (const [key, value] of Object.entries(raw)) {
        const at = Number(value);
        if (Number.isFinite(at) && now - at < this.ttlMs) this.entries.set(key, at);
      }
      this.trim();
    } catch {
      // first start or an unreadable file
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      const data = Object.fromEntries(this.entries);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(data)}\n`, 'utf8');
      fs.renameSync(temp, this.file);
    } catch {
      // the in-memory keys still guard this process
    }
  }
}

const ID_HEADERS = [
  'idempotency-key',
  'x-mimi-delivery',
  'x-webhook-id',
  'x-event-id',
  'x-github-delivery',
  'x-gitlab-event-uuid',
  'x-shopify-webhook-id',
  'x-request-id',
];

const ID_BODY_KEYS = ['event_id', 'eventId', 'delivery_id', 'deliveryId', 'idempotency_key', 'idempotencyKey'];

/** A provider's event id from headers, else from a known body field; never from the whole body. */
export function webhookEventId(
  headers: Record<string, string | string[] | undefined>,
  payload = '',
): string | undefined {
  const byName = new Map<string, string>();
  for (const [name, raw] of Object.entries(headers)) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value && value.trim()) byName.set(name.toLowerCase(), value);
  }
  for (const name of ID_HEADERS) {
    const value = byName.get(name)?.trim();
    if (value) return value.slice(0, 200);
  }
  try {
    const body = JSON.parse(payload) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    for (const key of ID_BODY_KEYS) {
      const value = (body as Record<string, unknown>)[key];
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const text = String(value).trim();
      if (text) return text.slice(0, 200);
    }
  } catch {
    // not JSON
  }
  return undefined;
}

export function webhookIdempotencyKey(scope: string, eventId: string): string {
  return `webhook:${scope}:${eventId}`;
}
