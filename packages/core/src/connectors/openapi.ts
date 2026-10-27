import net from 'node:net';
import { parse as parseYaml } from 'yaml';
import type {
  ConnectorAuth,
  ConnectorField,
  ConnectorHttpMethod,
  ConnectorOperation,
  ConnectorSpec,
} from '@mimi/shared';
import { ConnectorRegistry } from './registry.ts';
import { isPrivateAddress } from '../workflows/net-guard.ts';

type JsonObject = Record<string, unknown>;

export interface OpenApiImportOptions {
  key?: string;
  label?: string;
  category?: string;
  allowHttp?: boolean;
  allowLocal?: boolean;
  validate?: boolean;
}

export interface OpenApiOperationReport {
  key: string;
  label: string;
  method: ConnectorHttpMethod;
  path: string;
}

export interface OpenApiIssue {
  where: string;
  reason: string;
}

export interface OpenApiImportReport {
  title: string;
  version: string;
  server?: string;
  operations: OpenApiOperationReport[];
  unsupported: OpenApiIssue[];
  warnings: string[];
  security: string[];
}

export interface OpenApiImportResult {
  spec: ConnectorSpec;
  report: OpenApiImportReport;
}

const METHODS: Array<[string, ConnectorHttpMethod]> = [
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['patch', 'PATCH'],
  ['delete', 'DELETE'],
];

const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'cookie']);
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function humanize(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_./-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const label = words.join(' ');
  return label ? label[0]!.toUpperCase() + label.slice(1) : value;
}

function slug(value: string, fallback = 'value'): string {
  const key = value
    .normalize('NFKD')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return key.replace(/^[^a-z]+/, '') || fallback;
}

function parseSource(source: string | unknown): JsonObject {
  let parsed: unknown;
  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (!trimmed) throw new Error('OpenAPI import: the document is empty');
    try {
      parsed = trimmed.startsWith('{') || trimmed.startsWith('[') ? JSON.parse(trimmed) : parseYaml(trimmed);
    } catch (error) {
      throw new Error(`OpenAPI import: could not parse the document (${error instanceof Error ? error.message : String(error)})`);
    }
  } else {
    parsed = source;
  }
  if (!isObject(parsed)) throw new Error('OpenAPI import: the document must be an object');
  return parsed;
}

function pointer(root: JsonObject, ref: string): unknown {
  const parts = ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  for (const part of parts) {
    if (!isObject(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function deref(root: JsonObject, value: unknown, where: string, depth = 0): unknown {
  if (!isObject(value) || value.$ref === undefined) return value;
  if (depth > 20) throw new Error(`OpenAPI import: circular $ref at ${where}`);
  const ref = text(value.$ref);
  if (!ref || !ref.startsWith('#/')) {
    throw new Error(`OpenAPI import: ${where} uses an external or invalid $ref`);
  }
  const target = pointer(root, ref);
  if (target === undefined) throw new Error(`OpenAPI import: ${where} points at missing ${ref}`);
  const resolved = deref(root, target, where, depth + 1);
  const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref'));
  if (Object.keys(siblings).length === 0) return resolved;
  return isObject(resolved) ? { ...resolved, ...siblings } : resolved;
}

function schemaField(
  root: JsonObject,
  raw: unknown,
  key: string,
  required: boolean,
  where: string,
  report: OpenApiImportReport,
): ConnectorField | undefined {
  const resolved = deref(root, raw, where);
  if (!isObject(resolved)) {
    report.unsupported.push({ where, reason: 'schema is missing or not an object' });
    return undefined;
  }
  if (resolved.oneOf !== undefined || resolved.anyOf !== undefined || resolved.allOf !== undefined) {
    report.unsupported.push({ where, reason: 'combined schemas (oneOf/anyOf/allOf) are not supported' });
    return undefined;
  }
  let type = resolved.type;
  if (Array.isArray(type)) type = type.find((entry) => entry !== 'null');
  if (type === undefined && isObject(resolved.properties)) type = 'object';
  if (type === undefined && resolved.items !== undefined) type = 'array';
  const name = text(resolved['x-mimi-type']) ?? (typeof type === 'string' ? type : undefined);

  const field: ConnectorField = {
    key,
    label: humanize(text(resolved.title) ?? key),
    type: 'string',
    required,
  };
  const description = text(resolved.description);
  if (description) field.description = description;

  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) {
    const values = resolved.enum.filter((value) => ['string', 'number', 'boolean'].includes(typeof value));
    if (values.length !== resolved.enum.length) {
      report.unsupported.push({ where, reason: 'enum values must be strings, numbers or booleans' });
      return undefined;
    }
    field.type = 'select';
    field.options = values.map((value) => ({ value: String(value), label: String(value) }));
  } else if (name === 'string') {
    field.type = 'string';
  } else if (name === 'integer' || name === 'number') {
    field.type = 'number';
  } else if (name === 'boolean') {
    field.type = 'boolean';
  } else if (name === 'object' || name === 'array') {
    field.type = 'json';
  } else {
    report.unsupported.push({ where, reason: `schema type "${String(name)}" is not supported` });
    return undefined;
  }

  if (resolved.default !== undefined && ['string', 'number', 'boolean'].includes(typeof resolved.default)) {
    field.default = resolved.default;
  } else if (resolved.example !== undefined && ['string', 'number', 'boolean'].includes(typeof resolved.example)) {
    field.default = resolved.example;
  }
  return field;
}

function operationKey(operationId: unknown, method: string, path: string): string {
  const id = text(operationId);
  return slug(id ?? `${method}_${path.replace(/[{}]/g, '')}`, `${method}_operation`);
}

function uniqueOperationKey(used: Set<string>, base: string): string {
  let key = base;
  let index = 2;
  while (used.has(key)) {
    key = `${base}_${index}`;
    index += 1;
  }
  used.add(key);
  return key;
}

function responseOf(
  root: JsonObject,
  operation: JsonObject,
  where: string,
  report: OpenApiImportReport,
): ConnectorOperation['response'] {
  const responses = isObject(operation.responses) ? operation.responses : undefined;
  if (!responses) {
    report.warnings.push(`${where} has no responses; the whole body is returned`);
    return undefined;
  }
  const keys = Object.keys(responses);
  const success = keys
    .filter((key) => /^2\d\d$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
    .find((key) => key !== '204') ?? keys.find((key) => key === '204');
  const selected = success ?? (keys.includes('default') ? 'default' : undefined);
  if (!selected) {
    report.warnings.push(`${where} has no 2xx response`);
    return undefined;
  }
  const response = deref(root, responses[selected], `${where} response ${selected}`);
  if (!isObject(response)) return undefined;
  const content = isObject(response.content) ? response.content : {};
  const media = Object.keys(content);
  const json = media.find((type) => type === 'application/json' || type.endsWith('+json'));
  if (json) {
    const entry = content[json];
    if (!isObject(entry)) return undefined;
    const schema = deref(root, entry.schema, `${where} response schema`);
    if (!isObject(schema)) return undefined;
    const itemsPath = text(schema['x-mimi-items-path']);
    if (itemsPath) return { itemsPath };
    const type = Array.isArray(schema.type) ? schema.type.find((entry) => entry !== 'null') : schema.type;
    if (type === 'array') return {};
    return undefined;
  }
  const binary = media.some(
    (type) =>
      type === 'application/octet-stream' ||
      type === 'application/pdf' ||
      type.startsWith('image/') ||
      type.startsWith('audio/') ||
      type.startsWith('video/'),
  );
  return binary ? { binary: true } : undefined;
}

function mapSecurityScheme(
  root: JsonObject,
  name: string,
  requirement: JsonObject,
  report: OpenApiImportReport,
): ConnectorAuth {
  const components = isObject(root.components) ? root.components : {};
  const schemes = isObject(components.securitySchemes) ? components.securitySchemes : {};
  const raw = deref(root, schemes[name], `security scheme "${name}"`);
  if (!isObject(raw)) {
    report.unsupported.push({ where: `security scheme "${name}"`, reason: 'scheme is missing' });
    return { kind: 'none', fields: [] };
  }
  const type = text(raw.type);
  const scopeValues = Array.isArray(requirement[name])
    ? (requirement[name] as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];

  if (type === 'apiKey') {
    const keyName = text(raw.name);
    const location = text(raw.in);
    if (!keyName) {
      report.unsupported.push({ where: `security scheme "${name}"`, reason: 'apiKey needs a name' });
      return { kind: 'none', fields: [] };
    }
    if (location === 'header') {
      report.security.push(`apiKey "${keyName}" in header`);
      return {
        kind: 'apiKey',
        fields: [{ key: 'apiKey', label: humanize(keyName), type: 'secret', required: true }],
        extra: { header: keyName, prefix: '' },
      };
    }
    if (location === 'query') {
      report.security.push(`apiKey "${keyName}" in query`);
      return {
        kind: 'apiKey',
        fields: [{ key: 'apiKey', label: humanize(keyName), type: 'secret', required: true }],
        extra: { location: 'query', queryNames: { apiKey: keyName } },
      };
    }
    report.unsupported.push({ where: `security scheme "${name}"`, reason: `apiKey in "${String(location)}" is not supported` });
    return { kind: 'none', fields: [] };
  }

  if (type === 'http') {
    const scheme = text(raw.scheme)?.toLowerCase();
    if (scheme === 'basic') {
      report.security.push('HTTP basic');
      return {
        kind: 'basic',
        fields: [
          { key: 'username', label: 'Username', type: 'string', required: true },
          { key: 'password', label: 'Password', type: 'secret', required: true },
        ],
      };
    }
    if (scheme === 'bearer') {
      report.security.push('HTTP bearer');
      return {
        kind: 'bearer',
        fields: [{ key: 'token', label: 'Bearer token', type: 'secret', required: true }],
      };
    }
    report.unsupported.push({ where: `security scheme "${name}"`, reason: `HTTP scheme "${String(scheme)}" is not supported` });
    return { kind: 'none', fields: [] };
  }

  if (type === 'oauth2') {
    const flows = isObject(raw.flows) ? raw.flows : {};
    const candidates = ['authorizationCode', 'clientCredentials', 'implicit', 'password'];
    let flow: JsonObject | undefined;
    let flowName: string | undefined;
    for (const candidate of candidates) {
      if (isObject(flows[candidate])) {
        flow = flows[candidate] as JsonObject;
        flowName = candidate;
        break;
      }
    }
    const authorizeUrl = flow ? text(flow.authorizationUrl) : undefined;
    const tokenUrl = flow ? text(flow.tokenUrl) : undefined;
    const declaredScopes = flow && isObject(flow.scopes) ? Object.keys(flow.scopes) : [];
    const scopes = scopeValues.length > 0 ? scopeValues : declaredScopes;
    if (authorizeUrl && tokenUrl) {
      report.security.push(`OAuth2 ${flowName ?? ''} (${scopes.length} scopes)`);
      return {
        kind: 'oauth2',
        fields: [],
        authorizeUrl,
        tokenUrl,
        ...(scopes.length > 0 ? { scopes } : {}),
      };
    }
    report.warnings.push(
      `OAuth2 scheme "${name}" has no complete authorization code flow; imported as a bearer token field`,
    );
    return {
      kind: 'bearer',
      fields: [{ key: 'token', label: 'OAuth2 access token', type: 'secret', required: true }],
      ...(scopes.length > 0 ? { scopes } : {}),
    };
  }

  report.unsupported.push({ where: `security scheme "${name}"`, reason: `security type "${String(type)}" is not supported` });
  return { kind: 'none', fields: [] };
}

function mapAuth(root: JsonObject, report: OpenApiImportReport): ConnectorAuth {
  const security = Array.isArray(root.security) ? root.security : [];
  const requirement = security.find((entry): entry is JsonObject => isObject(entry));
  if (!requirement) {
    report.security.push('none');
    return { kind: 'none', fields: [] };
  }
  const names = Object.keys(requirement);
  if (names.length === 0) {
    report.security.push('none');
    return { kind: 'none', fields: [] };
  }
  if (names.length > 1) {
    report.unsupported.push({
      where: 'security',
      reason: `a requirement combining ${names.join(', ')} cannot be represented; only "${names[0]}" is used`,
    });
  }
  return mapSecurityScheme(root, names[0]!, requirement, report);
}

function serverOf(
  root: JsonObject,
  options: OpenApiImportOptions,
  report: OpenApiImportReport,
): string | undefined {
  const servers = Array.isArray(root.servers) ? root.servers : [];
  const server = servers.find((entry): entry is JsonObject => isObject(entry));
  const template = text(server?.url);
  if (!template) {
    report.warnings.push('no servers[0].url; operations keep relative paths');
    return undefined;
  }
  const variables = isObject(server?.variables) ? server.variables : {};
  let unresolved = false;
  const url = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const variable = variables[name];
    const value = isObject(variable) ? text(variable.default) : undefined;
    if (!value) {
      unresolved = true;
      return '';
    }
    return value;
  });
  if (unresolved) {
    report.unsupported.push({ where: 'servers[0]', reason: 'server variables need defaults' });
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    report.warnings.push(`server URL "${url}" is relative; operations keep relative paths`);
    return undefined;
  }
  if (parsed.username || parsed.password) {
    report.unsupported.push({ where: 'servers[0]', reason: 'credentials in the server URL are not allowed' });
    return undefined;
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && options.allowHttp === true)) {
    throw new Error(`OpenAPI import: server "${parsed.origin}" must use https (set allowHttp to override)`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) > 0 && isPrivateAddress(host));
  if (local && options.allowLocal !== true) {
    throw new Error(`OpenAPI import: local server "${parsed.origin}" is disabled (set allowLocal to override)`);
  }
  const href = parsed.href.replace(/\/+$/, '');
  report.server = href;
  return href;
}

function operationPath(template: string, pathParams: Set<string>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    pathParams.add(name);
    return `{${name}}`;
  });
}

export function importOpenApi(
  source: string | JsonObject,
  options: OpenApiImportOptions = {},
): OpenApiImportResult {
  const root = parseSource(source);
  const version = text(root.openapi);
  if (!version || !/^3\./.test(version)) {
    throw new Error('OpenAPI import: only OpenAPI 3.x documents are supported (Swagger 2.0 is not)');
  }
  const info = isObject(root.info) ? root.info : undefined;
  const title = text(info?.title);
  if (!title) throw new Error('OpenAPI import: info.title is required');
  const apiVersion = text(info?.version) ?? '0';
  const paths = isObject(root.paths) ? root.paths : undefined;
  if (!paths) throw new Error('OpenAPI import: paths is required');

  const report: OpenApiImportReport = {
    title,
    version: apiVersion,
    operations: [],
    unsupported: [],
    warnings: [],
    security: [],
  };
  const baseUrl = serverOf(root, options, report);
  const auth = mapAuth(root, report);
  const usedKeys = new Set<string>();
  const operations: ConnectorOperation[] = [];

  for (const [template, rawPathItem] of Object.entries(paths)) {
    if (template.startsWith('x-')) continue;
    const pathItem = deref(root, rawPathItem, `path ${template}`);
    if (!isObject(pathItem)) continue;
    const sharedParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const [lower, method] of METHODS) {
      const rawOperation = pathItem[lower];
      if (rawOperation === undefined) continue;
      const operation = deref(root, rawOperation, `${method} ${template}`);
      if (!isObject(operation)) continue;
      const where = `${method} ${template}`;
      const key = uniqueOperationKey(usedKeys, operationKey(operation.operationId, lower, template));
      const fields = new Map<string, ConnectorField>();
      const query: string[] = [];
      const headers: Record<string, string> = {};
      const pathParams = new Set<string>();
      let bodyFormat: ConnectorOperation['bodyFormat'];

      const addField = (field: ConnectorField, source: string): boolean => {
        if (fields.has(field.key)) {
          report.unsupported.push({ where: `${where} ${source} "${field.key}"`, reason: 'field key is already used' });
          return false;
        }
        fields.set(field.key, field);
        return true;
      };

      const parameters = [
        ...sharedParameters,
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ];
      const seenParameters = new Set<string>();
      for (const rawParameter of parameters) {
        const parameter = deref(root, rawParameter, `${where} parameter`);
        if (!isObject(parameter)) continue;
        const name = text(parameter.name);
        const location = text(parameter.in);
        if (!name || !location) {
          report.unsupported.push({ where: `${where} parameter`, reason: 'name or in is missing' });
          continue;
        }
        const identity = `${location}:${name}`;
        if (seenParameters.has(identity)) continue;
        seenParameters.add(identity);
        if (location === 'cookie') {
          report.unsupported.push({ where: `${where} parameter "${name}"`, reason: 'cookie parameters are not supported' });
          continue;
        }
        if (location !== 'path' && location !== 'query' && location !== 'header') {
          report.unsupported.push({ where: `${where} parameter "${name}"`, reason: `parameter in "${location}" is not supported` });
          continue;
        }
        if (parameter.content !== undefined) {
          report.unsupported.push({ where: `${where} parameter "${name}"`, reason: 'content-based parameters are not supported' });
          continue;
        }
        const fieldKey = location === 'header' ? `header_${slug(name, 'header')}` : name;
        if (location === 'header' && RESERVED_HEADERS.has(name.toLowerCase())) {
          report.unsupported.push({ where: `${where} parameter "${name}"`, reason: 'this header is managed by the runtime' });
          continue;
        }
        const required = location === 'path' || parameter.required === true;
        if (location === 'header' && !required) {
          report.unsupported.push({
            where: `${where} parameter "${name}"`,
            reason: 'optional header parameters cannot be sent conditionally',
          });
          continue;
        }
        const field = schemaField(
          root,
          parameter.schema ?? {},
          fieldKey,
          required,
          `${where} parameter "${name}"`,
          report,
        );
        if (!field) continue;
        if (!addField(field, 'parameter')) continue;
        if (location === 'query') query.push(fieldKey);
        if (location === 'header') headers[name] = `{{${fieldKey}}}`;
      }

      const requestBody = deref(root, operation.requestBody, `${where} requestBody`);
      if (isObject(requestBody)) {
        const content = isObject(requestBody.content) ? requestBody.content : {};
        const jsonType = Object.keys(content).find((type) => type === 'application/json' || type.endsWith('+json'));
        const formType = 'application/x-www-form-urlencoded' in content ? 'application/x-www-form-urlencoded' : undefined;
        const mediaType = jsonType ?? formType;
        if (!mediaType) {
          report.unsupported.push({ where: `${where} requestBody`, reason: 'only JSON and form-urlencoded bodies are supported' });
        } else {
          bodyFormat = jsonType ? 'json' : 'form';
          const entry = content[mediaType];
          const schema = isObject(entry) ? deref(root, entry.schema, `${where} requestBody schema`) : undefined;
          if (!isObject(schema)) {
            report.unsupported.push({ where: `${where} requestBody`, reason: 'body schema is missing' });
          } else {
            const type = Array.isArray(schema.type) ? schema.type.find((entry) => entry !== 'null') : schema.type;
            if (type === 'array') {
              report.unsupported.push({ where: `${where} requestBody`, reason: 'top-level array bodies are not supported' });
            } else if (!isObject(schema.properties)) {
              report.unsupported.push({ where: `${where} requestBody`, reason: 'body schema has no object properties' });
            } else {
              const required = new Set(Array.isArray(schema.required) ? schema.required.filter((entry) => typeof entry === 'string') : []);
              for (const [name, property] of Object.entries(schema.properties)) {
                const field = schemaField(
                  root,
                  property,
                  name,
                  required.has(name),
                  `${where} body "${name}"`,
                  report,
                );
                if (field) addField(field, 'body property');
              }
            }
          }
        }
      }

      for (const name of template.matchAll(/\{([^}]+)\}/g)) {
        const param = name[1]!;
        if (!fields.has(param)) {
          fields.set(param, { key: param, label: humanize(param), type: 'string', required: true });
          report.warnings.push(`${where} path parameter "${param}" was not declared; added as a required string`);
        }
      }
      const path = operationPath(template, pathParams);

      if (operation.security !== undefined) {
        const own = Array.isArray(operation.security) ? operation.security.length : 0;
        if (own > 0) report.warnings.push(`${where} declares its own security; the connector-level auth is used`);
      }

      const summary = text(operation.summary) ?? text(operation.description);
      const operationResponse = responseOf(root, operation, where, report);
      operations.push({
        key,
        label: summary ? humanize(summary).slice(0, 80) : humanize(key),
        method,
        path,
        ...(bodyFormat === undefined ? {} : { bodyFormat }),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
        ...(query.length === 0 ? {} : { query }),
        fields: [...fields.values()],
        risk: method === 'GET' ? 'read' : method === 'DELETE' ? 'delete' : 'write',
        ...(operationResponse === undefined ? {} : { response: operationResponse }),
      });
      report.operations.push({ key, label: summary ? humanize(summary).slice(0, 80) : humanize(key), method, path });
    }
  }

  if (operations.length === 0) throw new Error('OpenAPI import: the document has no supported operations');

  const spec: ConnectorSpec = {
    key: options.key?.trim() || slug(title, 'imported_api'),
    label: options.label?.trim() || title,
    category: options.category?.trim() || 'imported',
    description: `${title} ${apiVersion}, imported from an OpenAPI document`,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    auth,
    operations,
  };
  if (options.validate !== false) new ConnectorRegistry([spec]);
  return { spec, report };
}
