import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_TRIGGERS, type ConnectorSpec, type NodeTypeField, type TriggerPoolView } from '@mimi/shared';
import { z } from 'zod';
import {
  CONNECTOR_TRIGGER_PREFIX,
  connectorTriggerViews,
  findConnectorTrigger,
} from '../connectors/trigger-adapter.ts';

export const TRIGGER_NAME = /^[a-z][a-z0-9_-]*$/;

const fieldSchema = z.strictObject({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  label: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'text', 'json', 'expression', 'account']),
  service: z.enum(['google', 'microsoft', 'mail']).optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
}) satisfies z.ZodType<NodeTypeField>;

const poolSchema = z.strictObject({
  name: z.string().regex(TRIGGER_NAME, 'lowercase letters, digits, "-" or "_"'),
  label: z.string().min(1),
  description: z.string().default(''),
  // Only kinds whose execution is known can be added by hand; the rest are built in.
  kind: z.enum(['poll', 'webhook']),
  fields: z.array(fieldSchema).default([]),
  sample: z.record(z.string(), z.unknown()).default({}),
});

/**
 * The trigger pool: built-in trigger types plus the user's own, stored in
 * `triggers/pool/<name>.json`. A workflow picks one from here and fills its fields,
 * so a new trigger type never means a code change.
 */
export class TriggerPool {
  private readonly dir: string;
  private readonly connectorSpecs: () => readonly ConnectorSpec[];

  constructor(dir: string, connectorSpecs: () => readonly ConnectorSpec[] = () => []) {
    this.dir = dir;
    this.connectorSpecs = connectorSpecs;
  }

  list(): TriggerPoolView[] {
    const custom = this.customNames()
      .map((name) => this.get(name))
      .filter((entry): entry is TriggerPoolView => entry !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
    const names = new Set(custom.map((entry) => entry.name));
    return [
      ...BUILTIN_TRIGGERS.filter((entry) => !names.has(entry.name)),
      ...custom,
      ...connectorTriggerViews(this.connectorSpecs()).filter((entry) => !names.has(entry.name)),
    ];
  }

  get(name: string): TriggerPoolView | undefined {
    if (name.startsWith(CONNECTOR_TRIGGER_PREFIX)) {
      const found = findConnectorTrigger(this.connectorSpecs(), name);
      if (!found) return undefined;
      return connectorTriggerViews([found.spec]).find((entry) => entry.name === name);
    }
    const builtin = BUILTIN_TRIGGERS.find((entry) => entry.name === name);
    if (builtin) return builtin;
    if (!TRIGGER_NAME.test(name)) return undefined;
    const file = path.join(this.dir, `${name}.json`);
    if (!fs.existsSync(file)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`${file}: not valid JSON: ${(error as Error).message}`);
    }
    const parsed = poolSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${file}: invalid trigger:\n${z.prettifyError(parsed.error)}`);
    return { ...(parsed.data as Omit<TriggerPoolView, 'builtin'>), builtin: false };
  }

  save(entry: TriggerPoolView): TriggerPoolView {
    if (entry.name.startsWith(CONNECTOR_TRIGGER_PREFIX)) {
      throw new Error(`"${CONNECTOR_TRIGGER_PREFIX}" names are reserved for connector triggers.`);
    }
    if (BUILTIN_TRIGGERS.some((builtin) => builtin.name === entry.name)) {
      throw new Error(`"${entry.name}" is a built-in trigger; pick another name.`);
    }
    // `builtin` is derived for clients; the file does not keep it.
    const { builtin: _derived, ...rest } = entry;
    const parsed = poolSchema.safeParse(rest);
    if (!parsed.success) throw new Error(`trigger "${entry.name}":\n${z.prettifyError(parsed.error)}`);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${parsed.data.name}.json`), `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
    return { ...(parsed.data as Omit<TriggerPoolView, 'builtin'>), builtin: false };
  }

  remove(name: string): boolean {
    if (name.startsWith(CONNECTOR_TRIGGER_PREFIX)) return false;
    const file = path.join(this.dir, `${name}.json`);
    if (!TRIGGER_NAME.test(name) || !fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  private customNames(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -5))
      .filter((name) => TRIGGER_NAME.test(name));
  }
}
