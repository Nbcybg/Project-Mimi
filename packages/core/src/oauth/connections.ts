import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ConnectorConnectionInput,
  ConnectorConnectionView,
  ConnectorField,
} from '@mimi/shared';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { ConnectorAuthValues } from '../connectors/types.ts';
import { safeFetch, type Lookup } from '../workflows/net-guard.ts';
import { startGenericOAuth } from './generic-flow.ts';
import type { SecretStore } from '../app/secrets.ts';

interface StoredConnection {
  id: string;
  connector: string;
  name: string;
  default?: boolean;
  createdAt: string;
}

interface StoredFile {
  connections: StoredConnection[];
}

export interface ConnectorConnectionsOptions {
  dir: string;
  registry: ConnectorRegistry;
  secrets: SecretStore;
  fetchFn?: typeof fetch;
  lookup?: Lookup;
  allowLocal?: boolean;
  now?: () => number;
}

const ID = /^[a-z0-9][a-z0-9-]{2,60}$/;
const secretOf = (id: string, field: string) => `connector.${id}.${field}`;

function isStored(value: unknown): value is StoredConnection {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<StoredConnection>;
  return (
    typeof entry.id === 'string' &&
    ID.test(entry.id) &&
    typeof entry.connector === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.createdAt === 'string'
  );
}

/**
 * Credentials of native connectors. Metadata lives in `connections.json`; every
 * field value lives in the machine-local vault, never in the synced folder. OAuth2
 * connections refresh their own access token and write it back to the vault.
 */
export class ConnectorConnections {
  private readonly dir: string;
  private readonly registry: ConnectorRegistry;
  private readonly secrets: SecretStore;
  private readonly fetchFn: typeof fetch;
  private readonly customFetch: boolean;
  private readonly lookup?: Lookup;
  private readonly allowLocal: boolean;
  private readonly now: () => number;
  private connections: StoredConnection[];
  /** One refresh per connection at a time: providers rotate refresh tokens and reject replays. */
  private readonly refreshing = new Map<string, Promise<ConnectorAuthValues>>();

  constructor(options: ConnectorConnectionsOptions) {
    this.dir = options.dir;
    this.registry = options.registry;
    this.secrets = options.secrets;
    this.customFetch = options.fetchFn !== undefined;
    this.fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.lookup = options.lookup;
    this.allowLocal = options.allowLocal === true;
    this.now = options.now ?? Date.now;
    this.connections = this.load();
  }

  /** Token endpoints come from connector specs, but a bad/imported spec must not reach the LAN. */
  private request(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    return safeFetch(url, init ?? {}, {
      ...(this.customFetch ? { fetchFn: this.fetchFn } : {}),
      ...(this.lookup ? { lookup: this.lookup } : {}),
      ...(this.allowLocal ? { allowLocal: true } : {}),
    });
  }

  private file(): string {
    return path.join(this.dir, 'connections.json');
  }

  private load(): StoredConnection[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Partial<StoredFile>;
      return Array.isArray(raw.connections) ? raw.connections.filter(isStored) : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const data: StoredFile = { connections: this.connections };
    fs.writeFileSync(this.file(), JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  find(id: string | undefined): StoredConnection | undefined {
    return id ? this.connections.find((entry) => entry.id === id) : undefined;
  }

  private require(id: string): StoredConnection {
    const found = this.find(id);
    if (!found) throw new Error(`No connector connection "${id}".`);
    return found;
  }

  defaultFor(connector: string): StoredConnection | undefined {
    const entries = this.connections.filter((entry) => entry.connector === connector);
    return entries.find((entry) => entry.default) ?? entries[0];
  }

  private fieldsOf(specKey: string): ConnectorField[] {
    return this.registry.get(specKey)?.auth.fields ?? [];
  }

  private valuesOf(id: string): ConnectorAuthValues {
    const values: ConnectorAuthValues = {};
    for (const field of this.fieldsOf(this.require(id).connector)) {
      const value = this.secrets.get(secretOf(id, field.key));
      if (value) values[field.key] = value;
    }
    return values;
  }

  private connected(connection: StoredConnection): boolean {
    const spec = this.registry.get(connection.connector);
    if (!spec) return false;
    if (spec.auth.kind === 'none') return true;
    const values = this.valuesOf(connection.id);
    return spec.auth.fields.filter((field) => field.required !== false).every((field) => Boolean(values[field.key]));
  }

  views(connector?: string): ConnectorConnectionView[] {
    return this.connections
      .filter((entry) => connector === undefined || entry.connector === connector)
      .sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)) || a.name.localeCompare(b.name))
      .map((entry) => {
        const spec = this.registry.get(entry.connector);
        const values = this.valuesOf(entry.id);
        return {
          id: entry.id,
          connector: entry.connector,
          name: entry.name,
          authKind: spec?.auth.kind ?? 'none',
          connected: this.connected(entry),
          hasSecret: Object.keys(values).length > 0,
          default: Boolean(entry.default),
          createdAt: entry.createdAt,
        };
      });
  }

  /** Adds a connection, or updates one when `id` is given. Passwords are written to the vault. */
  save(input: ConnectorConnectionInput, id?: string): ConnectorConnectionView {
    const spec = this.registry.get(String(input.connector ?? ''));
    if (!spec) throw new Error(`Unknown connector "${input.connector}".`);
    const existing = id ? this.require(id) : undefined;
    if (existing && existing.connector !== spec.key) throw new Error('ย้าย connection ข้าม connector ไม่ได้: ลบแล้วเพิ่มใหม่');
    const name = String(input.name ?? '').trim() || spec.label;
    if (!name) throw new Error('ใส่ชื่อ connection ก่อน');

    const connection: StoredConnection = existing ?? {
      id: this.newId(spec.key),
      connector: spec.key,
      name,
      createdAt: new Date().toISOString(),
    };
    connection.name = name;
    if (input.default) connection.default = true;

    const fields = input.fields ?? {};
    for (const [key, value] of Object.entries(fields)) {
      if (!spec.auth.fields.some((field) => field.key === key)) {
        throw new Error(`Connector "${spec.key}" has no credential field "${key}".`);
      }
      this.secrets.set(secretOf(connection.id, key), String(value ?? ''));
    }

    if (!existing) {
      if (!this.defaultFor(spec.key)) connection.default = true;
      this.connections.push(connection);
    }
    if (connection.default) {
      for (const entry of this.connections) {
        if (entry.connector === spec.key && entry.id !== connection.id) delete entry.default;
      }
    }
    this.persist();
    return this.views(spec.key).find((view) => view.id === connection.id)!;
  }

  remove(id: string): void {
    const connection = this.require(id);
    this.connections = this.connections.filter((entry) => entry.id !== id);
    const values: Record<string, string> = {};
    for (const name of this.secrets.names()) {
      if (name.startsWith(`connector.${id}.`)) values[name] = '';
    }
    if (Object.keys(values).length > 0) this.secrets.save(values);
    if (connection.default) {
      const next = this.connections.find((entry) => entry.connector === connection.connector);
      if (next) next.default = true;
    }
    this.persist();
  }

  setDefault(id: string): void {
    const connection = this.require(id);
    for (const entry of this.connections) {
      if (entry.connector === connection.connector) entry.default = entry.id === id;
    }
    this.persist();
  }

  /**
   * Starts the generic OAuth2 authorization-code flow for one connection. The caller
   * opens `url`; `done` stores the returned tokens in the vault. Google connectors use
   * the OAuth accounts screen instead.
   */
  async startConnect(id: string): Promise<{ url: string; done: Promise<void> }> {
    const connection = this.require(id);
    const spec = this.registry.get(connection.connector);
    if (!spec) throw new Error(`Unknown connector "${connection.connector}".`);
    if (spec.auth.kind !== 'oauth2') throw new Error(`"${connection.connector}" is not an OAuth2 connector.`);
    if (spec.auth.extra?.provider === 'google') throw new Error('Google ใช้บัญชี Google ที่ Hub → บัญชี ไม่ใช่ connection');
    if (!spec.auth.authorizeUrl || !spec.auth.tokenUrl) throw new Error(`"${connection.connector}" ยังไม่มี OAuth2 endpoints`);
    const fields = new Set(spec.auth.fields.map((field) => field.key));
    if (!fields.has('clientId') || !fields.has('accessToken')) {
      throw new Error(`"${connection.connector}" ต้องประกาศ field clientId และ accessToken สำหรับ OAuth2`);
    }
    const values = this.valuesOf(id);
    if (!values.clientId) throw new Error(`ยังไม่มี Client ID ของ "${connection.name}"`);
    const flow = await startGenericOAuth({
      authorizeUrl: spec.auth.authorizeUrl,
      tokenUrl: spec.auth.tokenUrl,
      clientId: values.clientId,
      clientSecret: values.clientSecret,
      scopes: spec.auth.scopes ?? [],
      extra: spec.auth.extra,
      fetchFn: (input, init) => this.request(input, init),
      now: this.now,
    });
    const done = flow.done.then((tokens) => {
      const fresh = {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresAt ? { expiresAt: String(tokens.expiresAt) } : {}),
      };
      for (const [key, value] of Object.entries(fresh)) {
        if (fields.has(key)) this.secrets.set(secretOf(id, key), value);
      }
    });
    done.catch(() => {});
    return { url: flow.url, done };
  }

  /** Values for the runtime: the named connection, else the connector default, else legacy vault/env. */
  async resolve(connector: string, account?: string): Promise<ConnectorAuthValues | undefined> {
    const spec = this.registry.get(connector);
    if (!spec) return undefined;
    if (spec.auth.kind === 'none') return {};
    const connection = account ? this.find(account) : this.defaultFor(connector);
    if (account && !connection) throw new Error(`No connector connection "${account}".`);
    if (connection && connection.connector !== connector) {
      throw new Error(`Connection "${connection.name}" belongs to "${connection.connector}", not "${connector}".`);
    }
    if (!connection) {
      const legacy: ConnectorAuthValues = {};
      for (const field of spec.auth.fields) {
        const env = `${connector.toUpperCase()}_${field.key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
        const value = this.secrets.get(`connector.${connector}.${field.key}`) ?? process.env[env];
        if (value) legacy[field.key] = value;
      }
      return Object.keys(legacy).length > 0 ? legacy : undefined;
    }
    const values = this.valuesOf(connection.id);
    if (spec.auth.kind !== 'oauth2') return values;
    return this.refreshIfNeeded(spec.auth.tokenUrl, spec.auth.fields, connection.id, values);
  }

  private async refreshIfNeeded(
    tokenUrl: string | undefined,
    fields: ConnectorField[],
    id: string,
    values: ConnectorAuthValues,
  ): Promise<ConnectorAuthValues> {
    const expiresAt = Number(values.expiresAt ?? 0);
    if (values.accessToken && (!expiresAt || expiresAt > this.now() + 60_000)) return values;
    const refreshToken = values.refreshToken;
    if (!refreshToken) return values;
    const clientId = values.clientId;
    const clientSecret = values.clientSecret;
    if (!tokenUrl || !clientId) return values;

    const pending = this.refreshing.get(id);
    if (pending) return pending;

    const refresh = (async () => {
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      });
      if (clientSecret) form.set('client_secret', clientSecret);
      const response = await this.request(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const body = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (!response.ok || !body.access_token) {
        throw new Error(
          `Connector "${id}" token refresh failed: ${body.error_description ?? body.error ?? response.status}`,
        );
      }
      const fresh: ConnectorAuthValues = { ...values, accessToken: body.access_token };
      if (body.refresh_token) fresh.refreshToken = body.refresh_token;
      if (body.expires_in) fresh.expiresAt = String(this.now() + body.expires_in * 1000);
      for (const [key, value] of Object.entries(fresh)) {
        if (fields.some((field) => field.key === key)) this.secrets.set(secretOf(id, key), value);
      }
      return fresh;
    })();
    this.refreshing.set(id, refresh);
    try {
      return await refresh;
    } finally {
      this.refreshing.delete(id);
    }
  }

  private newId(connector: string): string {
    for (;;) {
      const id = `${connector}-${randomBytes(4).toString('hex')}`.slice(0, 60).replace(/-+$/, '');
      if (!this.connections.some((entry) => entry.id === id)) return id;
    }
  }
}
