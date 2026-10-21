import { RISK_LEVELS, type ConnectorOperation, type ConnectorSpec, type ConnectorView } from '@mimi/shared';
import type { ConnectorRoute } from './types.ts';

const CONNECTOR_KEY = /^[a-z][a-z0-9_]*$/;
const METHOD = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

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
  if (operation.body === undefined) return;
  if (operation.bodyFormat !== undefined && operation.bodyFormat !== 'json' && operation.bodyFormat !== 'form') {
    invalid(spec, `operation "${operation.key}" has an unknown body format`);
  }
  const fields = new Set(operation.fields.map((field) => field.key));
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
}

/** Checks a spec before it can reach the runtime or the settings screen. */
function validateSpec(spec: ConnectorSpec): void {
  if (!CONNECTOR_KEY.test(spec.key)) invalid(spec, 'key must be lower snake case, starting with a letter');
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

  for (const trigger of spec.triggers ?? []) {
    if (!CONNECTOR_KEY.test(trigger.key)) invalid(spec, `trigger key "${trigger.key}" is not lower snake case`);
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
  private readonly specs = new Map<string, ConnectorSpec>();
  private readonly routes = new Map<string, ConnectorRoute>();

  constructor(specs: ConnectorSpec[] = []) {
    for (const spec of specs) this.register(spec);
  }

  register(spec: ConnectorSpec): this {
    validateSpec(spec);
    if (this.specs.has(spec.key)) throw new Error(`Connector "${spec.key}" is already registered`);

    const routes = routesOf(spec);
    for (const route of routes) {
      const name = `${spec.key}_${route.operation.key}`;
      const owner = this.routes.get(name);
      if (owner) {
        throw new Error(
          `Connector tool "${name}" from "${spec.key}" is already provided by "${owner.connector.key}_${owner.operation.key}"`,
        );
      }
    }

    this.specs.set(spec.key, spec);
    for (const route of routes) this.routes.set(`${spec.key}_${route.operation.key}`, route);
    return this;
  }

  get(connector: string): ConnectorSpec | undefined {
    return this.specs.get(connector);
  }

  list(): ConnectorSpec[] {
    return [...this.specs.values()];
  }

  /** Every operation of every installed connector. */
  operations(): ConnectorRoute[] {
    return [...this.routes.values()];
  }

  toolNames(): string[] {
    return [...this.routes.keys()];
  }

  /** Metadata for the settings and Quick Work screens; it never contains credentials. */
  views(options: { connected?: (connector: string) => boolean } = {}): ConnectorView[] {
    return this.list().map((spec) => ({
      key: spec.key,
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
    }));
  }
}
