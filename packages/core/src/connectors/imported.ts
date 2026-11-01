import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { ConnectorHttpMethod, ConnectorImportReportView, ConnectorSpec, RiskLevel } from '@mimi/shared';
import { isPrivateAddress } from '../workflows/net-guard.ts';
import { importOpenApi, type OpenApiImportReport } from './openapi.ts';
import type { ConnectorRegistry } from './registry.ts';

/** Every imported connector lands in this category; the catalog's "OpenAPI import" chip reads it. */
export const IMPORTED_CATEGORY = 'imported';
/** Largest OpenAPI document accepted from a client (JSON text). */
export const MAX_IMPORT_SOURCE_BYTES = 2 * 1024 * 1024;
/** Largest stored connector file; bigger files are skipped at start-up. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORTED_CONNECTORS = 50;
export const MAX_IMPORTED_OPERATIONS = 200;
const FORMAT = 1;
const KEY = /^[a-z][a-z0-9_]*$/;
/** The `auth.extra` settings an OpenAPI import can produce; anything else (e.g. `provider`) is dropped. */
const AUTH_EXTRA = new Set(['header', 'prefix', 'location', 'queryNames']);

interface StoredConnector {
  format: number;
  importedAt: string;
  title: string;
  apiVersion: string;
  spec: ConnectorSpec;
}

export interface ConnectorImportOptions {
  key?: string;
  label?: string;
  replace?: boolean;
}

export interface ConnectorImportPlan {
  spec?: ConnectorSpec;
  report?: ConnectorImportReportView;
  errors: string[];
}

export interface ImportedConnectorHooks {
  /** A tool name already taken by something that is not this imported connector. */
  toolTaken(name: string): boolean;
  addTools(spec: ConnectorSpec): void;
  removeTools(spec: ConnectorSpec): void;
}

function riskOf(method: ConnectorHttpMethod): RiskLevel {
  return method === 'GET' ? 'read' : method === 'DELETE' ? 'delete' : 'write';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Why a base URL may not be used by an imported connector, if it may not. */
function baseUrlProblem(value: string | undefined): string | undefined {
  if (!value) return 'the document has no absolute https server URL (servers[0].url)';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `server URL "${value}" is not a URL`;
  }
  if (url.protocol !== 'https:') return `server "${url.origin}" must use https`;
  if (url.username || url.password) return 'credentials in the server URL are not allowed';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) > 0 && isPrivateAddress(host))) {
    return `local server "${url.origin}" is not allowed`;
  }
  return undefined;
}

/**
 * Fixes the trust settings an imported connector may never relax, whatever its file says:
 * the imported category, the default version (so it can never shadow a native connector),
 * method-based risk, untrusted output, relative paths on its own server, no triggers, and
 * none of the OAuth settings that would reuse a built-in account (Google tokens).
 */
export function hardenImported(spec: ConnectorSpec): ConnectorSpec {
  const extra = Object.fromEntries(Object.entries(spec.auth.extra ?? {}).filter(([key]) => AUTH_EXTRA.has(key)));
  const { version: _version, triggers: _triggers, ...rest } = spec;
  return {
    ...rest,
    category: IMPORTED_CATEGORY,
    auth: {
      kind: spec.auth.kind,
      // Auth fields are declarations; a value written into the file is never used as a credential.
      fields: spec.auth.fields.map(({ default: _default, ...field }) => field),
      ...(spec.auth.authorizeUrl === undefined ? {} : { authorizeUrl: spec.auth.authorizeUrl }),
      ...(spec.auth.tokenUrl === undefined ? {} : { tokenUrl: spec.auth.tokenUrl }),
      ...(spec.auth.scopes === undefined ? {} : { scopes: spec.auth.scopes }),
      ...(Object.keys(extra).length === 0 ? {} : { extra }),
    },
    operations: spec.operations.map(({ confirmPhrase: _confirm, ...operation }) => ({
      ...operation,
      risk: riskOf(operation.method),
      untrustedInput: true,
    })),
  };
}

/** Problems that keep a (hardened) spec from being stored or loaded. */
function specProblems(spec: ConnectorSpec, nativeKey: (key: string) => boolean): string[] {
  const problems: string[] = [];
  if (!KEY.test(spec.key)) problems.push(`key "${spec.key}" must be lower snake case, starting with a letter`);
  if (nativeKey(spec.key)) problems.push(`"${spec.key}" is a built-in connector; pick another key`);
  const base = baseUrlProblem(spec.baseUrl);
  if (base) problems.push(base);
  if (spec.operations.length > MAX_IMPORTED_OPERATIONS) {
    problems.push(`${spec.operations.length} operations is more than the ${MAX_IMPORTED_OPERATIONS} an imported connector may have`);
  }
  for (const operation of spec.operations) {
    if (!operation.path.startsWith('/')) problems.push(`operation "${operation.key}" must use a path on the connector's server`);
  }
  return problems;
}

function reportView(spec: ConnectorSpec, report: OpenApiImportReport, replaces: boolean): ConnectorImportReportView {
  return {
    key: spec.key,
    label: spec.label,
    title: report.title,
    version: report.version,
    ...(spec.baseUrl === undefined ? {} : { server: spec.baseUrl }),
    security: report.security,
    operations: spec.operations.map((operation) => ({
      key: operation.key,
      label: operation.label,
      method: operation.method,
      path: operation.path,
      risk: operation.risk,
    })),
    tools: spec.operations.map((operation) => `${spec.key}_${operation.key}`),
    unsupported: report.unsupported,
    warnings: report.warnings,
    replaces,
  };
}

/**
 * Connectors imported from OpenAPI documents, one file per connector in
 * `user/connectors/imported/<key>.json`. Files are written atomically; a file that
 * cannot be read or fails the checks is skipped and reported, never fatal.
 */
export class ImportedConnectors {
  private readonly dir: string;
  private readonly registry: ConnectorRegistry;
  private readonly nativeKey: (key: string) => boolean;
  private hooks: ImportedConnectorHooks | undefined;
  /** Imported connectors currently registered, by key. */
  private readonly installed = new Map<string, ConnectorSpec>();

  constructor(options: { dir: string; registry: ConnectorRegistry; nativeKeys: Iterable<string> }) {
    this.dir = options.dir;
    this.registry = options.registry;
    const native = new Set(options.nativeKeys);
    this.nativeKey = (key) => native.has(key);
  }

  keys(): string[] {
    return [...this.installed.keys()];
  }

  has(key: string): boolean {
    return this.installed.has(key);
  }

  private fileOf(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  /**
   * Reads every stored connector into the connector registry. Tools are added once
   * `attach` gives the tool hooks. Returns one message per file that was skipped.
   */
  load(): string[] {
    const errors: string[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${this.dir}: ${(error as Error).message}`);
      return errors;
    }
    for (const name of names) {
      if (this.installed.size >= MAX_IMPORTED_CONNECTORS) {
        errors.push(`${name}: more than ${MAX_IMPORTED_CONNECTORS} imported connectors; the rest are skipped`);
        break;
      }
      try {
        const file = path.join(this.dir, name);
        if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('file is too large');
        const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredConnector;
        if (!isObject(stored) || stored.format !== FORMAT || !isObject(stored.spec)) throw new Error('not an imported connector file');
        const spec = hardenImported(stored.spec);
        if (`${spec.key}.json` !== name) throw new Error(`file name does not match key "${spec.key}"`);
        const problems = specProblems(spec, this.nativeKey);
        if (problems.length > 0) throw new Error(problems.join('; '));
        this.registry.register(spec);
        this.installed.set(spec.key, spec);
      } catch (error) {
        errors.push(`${name}: ${(error as Error).message}`);
      }
    }
    return errors;
  }

  /** Adds the tools of the loaded connectors; a connector whose tool names are taken is dropped. */
  attach(hooks: ImportedConnectorHooks): string[] {
    this.hooks = hooks;
    const errors: string[] = [];
    for (const spec of [...this.installed.values()]) {
      const taken = spec.operations.map((operation) => `${spec.key}_${operation.key}`).filter((name) => hooks.toolTaken(name));
      try {
        if (taken.length > 0) throw new Error(`tool names already in use: ${taken.join(', ')}`);
        hooks.addTools(spec);
      } catch (error) {
        this.registry.unregister(spec.key);
        this.installed.delete(spec.key);
        errors.push(`${spec.key}.json: ${(error as Error).message}`);
      }
    }
    return errors;
  }

  /** Parses and checks a document without storing anything. */
  plan(source: string, options: ConnectorImportOptions = {}): ConnectorImportPlan {
    if (typeof source !== 'string' || !source.trim()) return { errors: ['the OpenAPI document is empty'] };
    if (Buffer.byteLength(source, 'utf8') > MAX_IMPORT_SOURCE_BYTES) {
      return { errors: [`the document is larger than ${MAX_IMPORT_SOURCE_BYTES / 1024 / 1024} MB`] };
    }
    let document: unknown;
    try {
      document = JSON.parse(source);
    } catch (error) {
      return { errors: [`only OpenAPI JSON is accepted (convert YAML to JSON first): ${(error as Error).message}`] };
    }
    if (!isObject(document)) return { errors: ['the OpenAPI document must be a JSON object'] };

    let parsed: ReturnType<typeof importOpenApi>;
    try {
      // Server-side imports never allow http or local servers; those options are for tests.
      parsed = importOpenApi(document, {
        ...(options.key?.trim() ? { key: options.key.trim() } : {}),
        ...(options.label?.trim() ? { label: options.label.trim() } : {}),
        category: IMPORTED_CATEGORY,
      });
    } catch (error) {
      return { errors: [(error as Error).message.replace(/^Connector "[^"]*": /, '')] };
    }
    const spec = hardenImported(parsed.spec);
    const replaces = this.installed.has(spec.key);
    const report = reportView(spec, parsed.report, replaces);
    const errors = specProblems(spec, this.nativeKey);
    if (replaces && options.replace !== true) {
      errors.push(`"${spec.key}" was imported before; confirm replacing it or pick another key`);
    }
    if (!replaces && this.installed.size >= MAX_IMPORTED_CONNECTORS) {
      errors.push(`at most ${MAX_IMPORTED_CONNECTORS} connectors can be imported; remove one first`);
    }
    const taken = report.tools.filter((name) => this.hooks?.toolTaken(name) && !(replaces && name.startsWith(`${spec.key}_`)));
    if (taken.length > 0) errors.push(`tool names already in use: ${taken.join(', ')}`);
    return { spec, report, errors };
  }

  /** Checks, stores and registers a document; nothing changes when `errors` is not empty. */
  save(source: string, options: ConnectorImportOptions = {}): ConnectorImportPlan {
    const plan = this.plan(source, options);
    const { spec, report } = plan;
    if (!spec || !report || plan.errors.length > 0) return plan;
    if (!this.hooks) return { ...plan, errors: ['the connector store is not ready yet'] };

    const previous = this.installed.get(spec.key);
    if (previous) this.uninstall(previous);
    try {
      this.registry.register(spec);
      try {
        this.hooks.addTools(spec);
      } catch (error) {
        this.registry.unregister(spec.key);
        throw error;
      }
    } catch (error) {
      if (previous) this.install(previous);
      return { ...plan, errors: [(error as Error).message] };
    }
    try {
      this.write(spec, report);
    } catch (error) {
      this.uninstall(spec);
      if (previous) this.install(previous);
      return { ...plan, errors: [`could not store the connector: ${(error as Error).message}`] };
    }
    this.installed.set(spec.key, spec);
    return plan;
  }

  /** Removes an imported connector, its tools and its file. Native connectors are refused. */
  remove(key: string): void {
    if (this.nativeKey(key)) throw new Error(`"${key}" is a built-in connector and cannot be removed`);
    const spec = this.installed.get(key);
    if (!spec) throw new Error(`no imported connector "${key}"`);
    fs.rmSync(this.fileOf(key), { force: true });
    this.uninstall(spec);
  }

  private install(spec: ConnectorSpec): void {
    this.registry.register(spec);
    this.hooks?.addTools(spec);
    this.installed.set(spec.key, spec);
  }

  private uninstall(spec: ConnectorSpec): void {
    this.hooks?.removeTools(spec);
    this.registry.unregister(spec.key);
    this.installed.delete(spec.key);
  }

  private write(spec: ConnectorSpec, report: ConnectorImportReportView): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const stored: StoredConnector = {
      format: FORMAT,
      importedAt: new Date().toISOString(),
      title: report.title,
      apiVersion: report.version,
      spec,
    };
    const file = this.fileOf(spec.key);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  }
}
