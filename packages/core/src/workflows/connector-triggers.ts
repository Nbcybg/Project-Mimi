import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ConnectorRequest,
  ConnectorResult,
  ConnectorSpec,
  ConnectorTrigger,
  FlowItem,
  JsonValue,
} from '@mimi/shared';

export { parseConnectorTriggerPool } from '../connectors/trigger-adapter.ts';

type TriggerRuntime = { execute(request: ConnectorRequest): Promise<ConnectorResult> };

export interface ConnectorPollResult {
  items: FlowItem[];
  raw?: unknown;
  cursor?: string;
}

export interface WebhookVerdict {
  ok: boolean;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function asText(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

export function connectorPollResumeKey(workflowId: string): string {
  return `${workflowId}:connector-poll`;
}

export function connectorTriggerId(trigger: ConnectorTrigger, item: FlowItem): string {
  const field = trigger.idField ?? 'id';
  const value = item.json[field];
  if (value !== undefined && value !== null && value !== '') return String(value);
  return JSON.stringify(item.json);
}

export async function pollConnectorTrigger(
  runtime: TriggerRuntime,
  spec: ConnectorSpec,
  trigger: ConnectorTrigger,
  config: Record<string, JsonValue>,
  cursor?: string,
): Promise<ConnectorPollResult> {
  if (!trigger.operation) throw new Error(`connector trigger "${spec.key}.${trigger.key}" has no operation`);
  const operation = spec.operations.find((entry) => entry.key === trigger.operation);
  if (!operation) throw new Error(`connector trigger "${spec.key}.${trigger.key}" refers to unknown operation "${trigger.operation}"`);
  const input: Record<string, unknown> = isRecord(trigger.input) ? { ...trigger.input } : {};
  for (const field of trigger.fields ?? []) {
    if (field.key === 'everyMinutes' || field.key === 'input') continue;
    if (config[field.key] !== undefined) input[field.key] = config[field.key];
  }
  if (isRecord(config.input)) Object.assign(input, config.input);
  if (cursor && trigger.cursor) input[trigger.cursor.param] = cursor;
  const account = asText(config.account).trim() || undefined;
  const result = await runtime.execute({
    connector: spec.key,
    operation: operation.key,
    input,
    ...(account ? { account } : {}),
    agent: 'trigger',
  });
  const next = trigger.cursor?.responsePath ? getPath(result.raw, trigger.cursor.responsePath) : undefined;
  return {
    items: result.items,
    ...(result.raw === undefined ? {} : { raw: result.raw }),
    ...(next === undefined || next === null || next === '' ? {} : { cursor: String(next) }),
  };
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

export function verifyConnectorWebhook(
  trigger: ConnectorTrigger,
  config: Record<string, JsonValue>,
  headers: Record<string, string | string[] | undefined>,
  payload: string,
  secret: (name: string) => string | undefined,
  now = Date.now(),
): WebhookVerdict {
  const signature = trigger.signature;
  if (!signature) return { ok: true };
  const secretField = signature.secretField ?? 'secretName';
  const secretName = asText(config[secretField]).trim();
  if (!secretName) return { ok: false, error: `missing secret name in "${secretField}"` };
  const value = secret(secretName);
  if (!value) return { ok: false, error: `vault secret "${secretName}" is not set` };

  const actual = headerValue(headers, signature.header);
  if (!actual) return { ok: false, error: `missing ${signature.header} header` };

  const timestampName = signature.timestampHeader;
  const timestamp = timestampName ? headerValue(headers, timestampName) : undefined;
  if (timestampName && !timestamp) return { ok: false, error: `missing ${timestampName} header` };
  if (timestampName && timestamp) {
    const seconds = Number(timestamp);
    const tolerance = signature.toleranceSeconds ?? 300;
    if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > tolerance) {
      return { ok: false, error: 'webhook timestamp is outside the allowed window' };
    }
  }

  const template = signature.signedPayload ?? '{{body}}';
  const signed = template
    .replaceAll('{{body}}', payload)
    .replaceAll('{{timestamp}}', timestamp ?? '');
  const digest = createHmac(signature.algorithm ?? 'sha256', value).update(signed).digest(signature.encoding ?? 'hex');
  const expected = `${signature.prefix ?? ''}${digest}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, error: 'signature does not match' };
  }
  return { ok: true };
}
