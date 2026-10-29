import type { ToolSettingOption, ToolSettingOptionsFrom } from './tools.ts';
import type { RiskLevel } from './tools.ts';
import type { FlowItem, JsonValue } from './workflows.ts';

/** Semver assigned when a spec does not name one; existing connectors stay on 1.0.0. */
export const DEFAULT_CONNECTOR_VERSION = '1.0.0';

/**
 * Version of the connector contract. Bump it when an existing field changes meaning
 * or becomes required; additive optional fields do not need a bump.
 */
export const CONNECTOR_CONTRACT_VERSION = 1;

/** How a connector authenticates. `apiKey` and `bearer` are token-style credentials. */
export type ConnectorAuthKind = 'oauth2' | 'oauth1' | 'apiKey' | 'basic' | 'bearer' | 'none';

export type ConnectorFieldType = 'string' | 'number' | 'boolean' | 'json' | 'secret' | 'select';

/**
 * One input of an operation or one credential of an auth scheme. A connector spec
 * describes fields; it never stores values. Secrets live in the vault.
 */
export interface ConnectorField {
  key: string;
  label: string;
  type: ConnectorFieldType;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  description?: string;
  /** Fixed choices for a `select` field. */
  options?: ToolSettingOption[];
  /** Choices read from another operation, e.g. Slack channels. */
  optionsFrom?: ToolSettingOptionsFrom;
  /** Other input keys that must be filled before this one can be resolved. */
  dependsOn?: string[];
}

export type ConnectorHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** How the runtime turns an HTTP response into items. */
export interface ConnectorResponse {
  /** Dot path to the item array, e.g. `messages` or `data.items`. Missing = the whole body. */
  itemsPath?: string;
  /** The response is a download rather than JSON. */
  binary?: boolean;
}

/** One callable action. Tool name is `<connector>_<operation>`. */
export interface ConnectorOperation {
  key: string;
  label: string;
  description?: string;
  method: ConnectorHttpMethod;
  /** Relative to `ConnectorSpec.baseUrl`, or absolute when it starts with http(s). */
  path: string;
  /**
   * Optional body template for APIs that need a nested body. Strings of the form
   * `{{field}}` are replaced with the resolved input; a whole-value placeholder keeps
   * the original type (object, array, number). Without a template the runtime sends
   * every non-path input field as a flat body.
   */
  body?: unknown;
  /** How the request body is encoded. Defaults to JSON; `binary` decodes a base64 field. */
  bodyFormat?: 'json' | 'form' | 'raw' | 'binary';
  /** Extra request headers; string values may contain `{{field}}` placeholders. */
  headers?: Record<string, string>;
  /** Input fields sent as query parameters even for POST/PATCH/PUT. */
  query?: string[];
  fields: ConnectorField[];
  risk: RiskLevel;
  /** The response carries text written by third parties (messages, documents). */
  untrustedInput?: boolean;
  response?: ConnectorResponse;
  /** Follow `ConnectorSpec.pagination` and return every page as items. */
  paginated?: boolean;
  /** Safe to repeat after a network error or 5xx, even for a write. */
  idempotent?: boolean;
}

export interface ConnectorAuth {
  kind: ConnectorAuthKind;
  fields: ConnectorField[];
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  /** Provider-specific OAuth settings (PKCE, extra params); never secrets. */
  extra?: Record<string, unknown>;
}

/** How a provider signs a webhook body. The secret itself lives in the vault. */
export interface ConnectorWebhookSignature {
  /** Request header carrying the signature. */
  header: string;
  algorithm?: 'sha256' | 'sha1';
  encoding?: 'hex' | 'base64';
  /** Prefix expected before the digest, e.g. `sha256=` or `v0=`. */
  prefix?: string;
  /** Template for the signed bytes, e.g. `v0:{{timestamp}}:{{body}}`. */
  signedPayload?: string;
  /** Header carrying the Unix timestamp used in `signedPayload`. */
  timestampHeader?: string;
  /** Config key naming the vault secret; defaults to `secretName`. */
  secretField?: string;
  /** Reject timestamps older than this; defaults to 300 seconds. */
  toleranceSeconds?: number;
}

export interface ConnectorTrigger {
  key: string;
  label: string;
  description?: string;
  kind: 'webhook' | 'poll';
  events?: string[];
  fields?: ConnectorField[];
  /** Poll: the operation called on every tick. */
  operation?: string;
  /** Poll: fixed operation input. */
  input?: Record<string, JsonValue>;
  /** Poll: item field used to drop duplicates; defaults to `id`. */
  idField?: string;
  /** Poll: where the next cursor comes from and which input parameter takes it back. */
  cursor?: { responsePath: string; param: string };
  /** Webhook: provider signature verification. */
  signature?: ConnectorWebhookSignature;
  /** What this trigger produces; shown in the editor and used for manual runs. */
  sample?: Record<string, JsonValue>;
}

export type ConnectorPaginationMode = 'page' | 'cursor' | 'nextPageToken' | 'link';

export interface ConnectorPagination {
  mode: ConnectorPaginationMode;
  pageParam?: string;
  sizeParam?: string;
  cursorParam?: string;
  itemsPath?: string;
  nextPath?: string;
  /** Safety bounds; defaults to 20 pages and 1000 items. */
  maxPages?: number;
  maxItems?: number;
}

export interface ConnectorRateLimit {
  requests: number;
  perMs: number;
  burst?: number;
}

/**
 * The single source of truth for one service. Specs are data only: no fetch,
 * no secrets, no side effects. Add a service by adding one file under
 * `packages/core/src/connectors/services/`.
 */
export interface ConnectorSpec {
  /** Lower snake case; the prefix of every tool name. */
  key: string;
  /**
   * Semver of this connector definition, e.g. `1.2.0`. Several versions of one key
   * may be registered; workflows pin one, new workflows get the latest. Missing
   * means `DEFAULT_CONNECTOR_VERSION`.
   */
  version?: string;
  label: string;
  category: string;
  description: string;
  /** Base URL for relative operation paths. Security must be decided by the runtime. */
  baseUrl?: string;
  auth: ConnectorAuth;
  operations: ConnectorOperation[];
  triggers?: ConnectorTrigger[];
  pagination?: ConnectorPagination;
  rateLimit?: ConnectorRateLimit;
}

/** Auth metadata safe to send to a client; secret values never travel. */
export interface ConnectorAuthView {
  kind: ConnectorAuthKind;
  fields: ConnectorField[];
  scopes?: string[];
  authorizeUrl?: string;
  tokenUrl?: string;
  /** True when this machine has at least one usable credential for the connector. */
  connected?: boolean;
}

/** Operation metadata safe to send to a client. */
export interface ConnectorOperationView {
  key: string;
  label: string;
  description?: string;
  method: ConnectorHttpMethod;
  path: string;
  fields: ConnectorField[];
  risk: RiskLevel;
  untrustedInput?: boolean;
  response?: ConnectorResponse;
}

/** What the settings and Quick Work screens receive for one service. */
export interface ConnectorView {
  key: string;
  /** Latest installed version (always set by the registry). */
  version?: string;
  /** All installed versions, newest first. */
  versions?: string[];
  label: string;
  category: string;
  description: string;
  baseUrl?: string;
  auth: ConnectorAuthView;
  operations: ConnectorOperationView[];
  triggers?: ConnectorTrigger[];
  pagination?: ConnectorPagination;
  rateLimit?: ConnectorRateLimit;
}

export interface ConnectorRequest {
  connector: string;
  operation: string;
  input: Record<string, unknown>;
  /** Account id; missing means the connector's default account. */
  account?: string;
  signal?: AbortSignal;
  /** The agent that asked; used for policy and logs. */
  agent?: string;
  /** Sent as `Idempotency-Key` so a retried write can be deduplicated by providers that support it. */
  idempotencyKey?: string;
  /** Pin a connector spec version; missing means the latest installed version. */
  version?: string;
}

export interface ConnectorResult {
  items: FlowItem[];
  /** Short text handed back to the model. Must not contain credentials. */
  text?: string;
  /** Raw response for debugging; the runtime strips secrets before filling this. */
  raw?: unknown;
  /** Spec version that actually ran. */
  version?: string;
  /** True when the run used an older version than the installed latest. */
  deprecated?: boolean;
  /** Latest installed version, set together with `deprecated`. */
  latestVersion?: string;
}

/** What a connector call asks for; `version` pins a spec, missing means latest. */
/** The runtime surface the tool and workflow adapters use. */
export interface ConnectorRuntime {
  list(): ConnectorView[];
  get(connector: string, version?: string): ConnectorSpec | undefined;
  execute(request: ConnectorRequest): Promise<ConnectorResult>;
  test(connector: string, operation: string, input: Record<string, unknown>, account?: string): Promise<ConnectorResult>;
}
