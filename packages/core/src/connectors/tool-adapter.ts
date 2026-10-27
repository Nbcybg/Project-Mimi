import type {
  ConnectorField,
  ConnectorOperation,
  ConnectorResult,
  ConnectorRuntime,
  ConnectorSpec,
  ToolSettingField,
  ToolSettingValues,
} from '@mimi/shared';
import { z } from 'zod';
import { defineTool, type ToolContext, type ToolDefinition } from '../tools/registry.ts';
import type { ConnectorRegistry } from './registry.ts';

const MAX_OUTPUT = 12_000;

function fieldSchema(field: ConnectorField): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (field.type) {
    case 'number':
      schema = z.number();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'json':
      schema = z.unknown();
      break;
    case 'select':
    case 'secret':
    case 'string':
    default:
      schema = z.string();
      break;
  }
  if (field.description) schema = schema.describe(field.description);
  if (field.default !== undefined) schema = schema.default(field.default);
  else if (field.required === false) schema = schema.optional();
  return schema;
}

function inputSchemaOf(operation: ConnectorOperation): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of operation.fields) shape[field.key] = fieldSchema(field);
  return z.object(shape);
}

/** Every connector gets a picker; Google uses the OAuth hub, the rest use connections. */
function settingsOf(spec: ConnectorSpec): ToolSettingField[] {
  const google = spec.auth.kind === 'oauth2' && spec.auth.extra?.provider === 'google';
  return [
    google
      ? {
          key: 'account',
          label: 'บัญชี Google',
          type: 'account',
          service: 'google',
          required: false,
          description: 'เว้นว่าง = บัญชี Google เริ่มต้น',
        }
      : {
          key: 'account',
          label: 'Connection',
          type: 'connection',
          connector: spec.key,
          required: false,
          description: 'เว้นว่าง = connection เริ่มต้นของ service นี้',
        },
  ];
}

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const shown = text ?? String(value);
  return shown.length > 60 ? `${shown.slice(0, 60)}…` : shown;
}

function accountOf(settings: ToolSettingValues | undefined): string | undefined {
  const value = settings?.account;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} more characters)` : text;
}

function render(result: ConnectorResult): string {
  if (result.text) return truncate(result.text);
  const text = JSON.stringify(
    result.items.map((item) => item.json),
    null,
    2,
  );
  return truncate(text);
}

/** A tool definition with the metadata Quick Work groups by (kept out of ToolSpec for now). */
export interface ConnectorToolDefinition extends ToolDefinition<Record<string, unknown>> {
  connector: string;
  operation: string;
  familyLabel: string;
  connectorCategory: string;
}

function toolFor(spec: ConnectorSpec, operation: ConnectorOperation, runtime: ConnectorRuntime): ConnectorToolDefinition {
  const settings = settingsOf(spec);
  const tool = defineTool<Record<string, unknown>>({
    name: `${spec.key}_${operation.key}`,
    description: operation.description ?? operation.label,
    risk: operation.risk,
    target: 'core',
    ...(operation.untrustedInput === undefined ? {} : { untrustedInput: operation.untrustedInput }),
    settings,
    inputSchema: inputSchemaOf(operation),
    summarize(input) {
      const shown = operation.fields
        .filter((field) => field.type !== 'secret' && input[field.key] !== undefined && input[field.key] !== '')
        .slice(0, 3)
        .map((field) => `${field.key}=${preview(input[field.key])}`);
      return `${spec.label} · ${operation.label}${shown.length > 0 ? ` (${shown.join(', ')})` : ''}`;
    },
    async execute(input, context: ToolContext, preset?: ToolSettingValues) {
      const result = await runtime.execute({
        connector: spec.key,
        operation: operation.key,
        input,
        account: accountOf(preset),
        signal: context.signal,
        agent: context.agent,
      });
      return render(result);
    },
  });
  return Object.assign(tool, {
    connector: spec.key,
    operation: operation.key,
    familyLabel: spec.label,
    connectorCategory: spec.category,
  });
}

/** Every operation of every registered connector, as an agent tool. */
export function connectorTools(registry: ConnectorRegistry, runtime: ConnectorRuntime): ConnectorToolDefinition[] {
  return registry.operations().map(({ connector, operation }) => toolFor(connector, operation, runtime));
}
