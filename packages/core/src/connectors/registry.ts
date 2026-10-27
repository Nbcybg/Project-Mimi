import { DEFAULT_CONNECTOR_VERSION, RISK_LEVELS, type ConnectorOperation, type ConnectorSpec, type ConnectorView } from '@mimi/shared';
import type { ConnectorRoute } from './types.ts';

const CONNECTOR_KEY = /^[a-z][a-z0-9_]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const METHOD = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Version used when a spec/request does not name one. */
export function connectorVersion(spec: ConnectorSpec): string {
  return spec.version ?? DEFAULT_CONNECTOR_VERSION;
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let at = 0; at < 3; at++) {
    const diff = (left[at] ?? 0) - (right[at] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function invalid(spec: ConnectorSpec, message: string): never {
  throw new Error(`Connector "${spec.key}": ${message}`);
}

function uniqueFieldKeys(spec: ConnectorSpec, operation: ConnectorOperation): void {
  const seen = new Set<string>();
  for (const field of operation.fields) {
    if (!field.key) invalid(spec, `operation "${operation.key}" has a field without a key`);
    if (seen.has(field.key)) invalid(spec, `operation "${operation.key}" repeats field "${field.key}"`);
    seen.add(field.key);
  }
}

/** Body templates are data; every placeholder must name a declared field. */
function checkBodyTemplate(spec: ConnectorSpec, operation: ConnectorOperation): void {
  if (operation.bodyFormat !== undefined && !['json', 'form', 'raw', 'binary'].includes(operation.bodyFormat)) {
    invalid(spec, `operation "${operation.key}" has an unknown body format`);
  }
  const fields = new Set(operation.fields.map((field) => field.key));
  for (const key of operation.query ?? []) {
    if (!fields.has(key)) invalid(spec, `operation "${operation.key}" query refers to unknown field "${key}"`);
  }
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{([^}]+)\}\}/g)) {
        const key = match[1]!.trim();
        if (!fields.has(key)) invalid(spec, `operation "${operation.key}" body refers to unknown field "${key}"`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(operation.body);
  for (const [header, value] of Object.entries(operation.headers ?? {})) {
    if (!header.trim()) invalid(spec, `operation "${operation.key}" has an empty header name`);
    walk(value);
  }
}

/** Checks a spec before it can reach the runtime or the settings screen. */
function validateSpec(spec: ConnectorSpec): void {
  if (!CONNECTOR_KEY.test(spec.key)) invalid(spec, 'key must be lower snake case, starting with a letter');
  if (spec.version !== undefined && !VERSION.test(spec.version)) invalid(spec, 'version must be semver, e.g. 1.2.0');
  if (!spec.label.trim()) invalid(spec, 'label is required');
  if (!spec.category.trim()) invalid(spec, 'category is required');
  if (!spec.description.trim()) invalid(spec, 'description is required');
  if (spec.baseUrl !== undefined && !isHttpUrl(spec.baseUrl)) invalid(spec, 'baseUrl must be an http(s) URL');
  if (spec.operations.length === 0) invalid(spec, 'needs at least one operation');

  const operations = new Set<string>();
  for (const operation of spec.operations) {
    if (!CONNECTOR_KEY.test(operation.key)) {
      invalid(spec, `operation key "${operation.key}" must be lower snake case, starting with a letter`);
    }
    if (operations.has(operation.key)) invalid(spec, `repeats operation "${operation.key}"`);
    operations.add(operation.key);
    if (!METHOD.has(operation.method)) invalid(spec, `operation "${operation.key}" has an unsupported method`);
    if (!operation.path.startsWith('/') && !isHttpUrl(operation.path)) {
      invalid(spec, `operation "${operation.key}" path must start with "/" or be an http(s) URL`);
    }
    if (!(RISK_LEVELS as readonly string[]).includes(operation.risk)) {
      invalid(spec, `operation "${operation.key}" has an unknown risk "${operation.risk}"`);
    }
    uniqueFieldKeys(spec, operation);
    checkBodyTemplate(spec, operation);
  }

  const authKeys = new Set<string>();
  for (const field of spec.auth.fields) {
    if (!field.key) invalid(spec, 'auth has a field without a key');
    if (authKeys.has(field.key)) invalid(spec, `auth repeats field "${field.key}"`);
    authKeys.add(field.key);
  }
  if (spec.auth.kind === 'oauth2') {
    if (!spec.auth.authorizeUrl || !isHttpUrl(spec.auth.authorizeUrl)) invalid(spec, 'oauth2 needs an authorizeUrl');
    if (!spec.auth.tokenUrl || !isHttpUrl(spec.auth.tokenUrl)) invalid(spec, 'oauth2 needs a tokenUrl');
  }

  const triggerKeys = new Set<string>();
  for (const trigger of spec.triggers ?? []) {
    if (!CONNECTOR_KEY.test(trigger.key)) invalid(spec, `trigger key "${trigger.key}" is not lower snake case`);
    if (triggerKeys.has(trigger.key)) invalid(spec, `repeats trigger "${trigger.key}"`);
    triggerKeys.add(trigger.key);
    const triggerFields = new Set<string>();
    for (const field of trigger.fields ?? []) {
      if (!field.key) invalid(spec, `trigger "${trigger.key}" has a field without a key`);
      if (triggerFields.has(field.key)) invalid(spec, `trigger "${trigger.key}" repeats field "${field.key}"`);
      triggerFields.add(field.key);
    }
    if (trigger.kind === 'poll') {
      if (!trigger.operation) invalid(spec, `poll trigger "${trigger.key}" needs an operation`);
      if (!spec.operations.some((operation) => operation.key === trigger.operation)) {
        invalid(spec, `poll trigger "${trigger.key}" refers to unknown operation "${trigger.operation}"`);
      }
    }
    if (trigger.kind === 'webhook' && trigger.signature && !trigger.signature.header.trim()) {
      invalid(spec, `webhook trigger "${trigger.key}" has an empty signature header`);
    }
  }

  const pagination = spec.pagination;
  if (pagination) {
    if (!['page', 'cursor', 'nextPageToken', 'link'].includes(pagination.mode)) invalid(spec, 'has an unknown pagination mode');
    if (pagination.maxPages !== undefined && (!Number.isInteger(pagination.maxPages) || pagination.maxPages < 1)) {
      invalid(spec, 'pagination maxPages must be a positive integer');
    }
    if (pagination.maxItems !== undefined && (!Number.isInteger(pagination.maxItems) || pagination.maxItems < 1)) {
      invalid(spec, 'pagination maxItems must be a positive integer');
    }
  }
}

/** Every tool a spec can produce, in declaration order. */
function routesOf(spec: ConnectorSpec): ConnectorRoute[] {
  return spec.operations.map((operation) => ({ connector: spec, operation }));
}

/**
 * The installed connectors. Registering validates the whole spec and guarantees
 * that the generated tool names (`<connector>_<operation>`) are unique across
 * services, not just inside one service.
 */
export class ConnectorRegistry {
  /** key -> version -> spec */
  private readonly byKey = new Map<string, Map<string, ConnectorSpec>>();
  private routes = new Map<string, ConnectorRoute>();

  constructor(specs: ConnectorSpec[] = []) {
    for (const spec of specs) this.register(spec);
  }

  register(spec: ConnectorSpec): this {
    const version = connectorVersion(spec);
    const normalized: ConnectorSpec = { ...spec, version };
    validateSpec(normalized);
    const versions = this.byKey.get(spec.key);
    if (versions?.has(version)) {
      throw new Error(`Connector "${spec.key}" version "${version}" is already registered`);
    }

    const next = versions ?? new Map<string, ConnectorSpec>();
    next.set(version, normalized);
    this.byKey.set(spec.key, next);
    try {
      this.rebuildRoutes();
    } catch (error) {
      next.delete(version);
      if (next.size === 0) this.byKey.delete(spec.key);
      this.rebuildRoutes();
      throw error;
    }
    return this;
  }

  /** Tool names are unique across services; only the latest version of a key exposes tools. */
  private rebuildRoutes(): void {
    const routes = new Map<string, ConnectorRoute>();
    for (const spec of this.list()) {
      for (const route of routesOf(spec)) {
        const name = `${spec.key}_${route.operation.key}`;
        const owner = routes.get(name);
        if (owner) {
          throw new Error(
            `Connector tool "${name}" from "${spec.key}" is already provided by "${owner.connector.key}_${owner.operation.key}"`,
          );
        }
        routes.set(name, route);
      }
    }
    this.routes = routes;
  }

  /** Without a version, the latest installed version; with one, exactly that version. */
  get(connector: string, version?: string): ConnectorSpec | undefined {
    const versions = this.byKey.get(connector);
    if (!versions) return undefined;
    if (version !== undefined) return versions.get(version);
    return this.latest(connector);
  }

  /** Installed versions, newest first. */
  versions(connector: string): string[] {
    return [...(this.byKey.get(connector)?.keys() ?? [])].sort((a, b) => compareVersions(b, a));
  }

  private latest(connector: string): ConnectorSpec | undefined {
    const newest = this.versions(connector)[0];
    return newest === undefined ? undefined : this.byKey.get(connector)?.get(newest);
  }

  /** Latest version of each connector, one per key. */
  list(): ConnectorSpec[] {
    return [...this.byKey.keys()].flatMap((key) => {
      const spec = this.latest(key);
      return spec ? [spec] : [];
    });
  }

  /** Every installed version of every connector, for diagnostics/tests. */
  listAll(): ConnectorSpec[] {
    return [...this.byKey.values()].flatMap((versions) => [...versions.values()]);
  }

  /** Every operation of every latest connector. */
  operations(): ConnectorRoute[] {
    return [...this.routes.values()];
  }

  toolNames(): string[] {
    return [...this.routes.keys()];
  }

  /** Metadata for the settings and Quick Work screens; it never contains credentials. */
  views(options: { connected?: (connector: string) => boolean } = {}): ConnectorView[] {
    return this.list().map((spec) => {
      const versions = this.versions(spec.key);
      return {
        key: spec.key,
        version: connectorVersion(spec),
        versions,
        label: spec.label,
        category: spec.category,
        description: spec.description,
        ...(spec.baseUrl === undefined ? {} : { baseUrl: spec.baseUrl }),
        auth: {
          kind: spec.auth.kind,
          fields: spec.auth.fields,
          ...(spec.auth.scopes === undefined ? {} : { scopes: spec.auth.scopes }),
          ...(spec.auth.authorizeUrl === undefined ? {} : { authorizeUrl: spec.auth.authorizeUrl }),
          ...(options.connected === undefined ? {} : { connected: options.connected(spec.key) }),
        },
        operations: spec.operations.map((operation) => ({
          key: operation.key,
          label: operation.label,
          ...(operation.description === undefined ? {} : { description: operation.description }),
          method: operation.method,
          path: operation.path,
          fields: operation.fields,
          risk: operation.risk,
          ...(operation.untrustedInput === undefined ? {} : { untrustedInput: operation.untrustedInput }),
          ...(operation.response === undefined ? {} : { response: operation.response }),
        })),
        ...(spec.triggers === undefined ? {} : { triggers: spec.triggers }),
        ...(spec.pagination === undefined ? {} : { pagination: spec.pagination }),
        ...(spec.rateLimit === undefined ? {} : { rateLimit: spec.rateLimit }),
      };
    });
  }
}
