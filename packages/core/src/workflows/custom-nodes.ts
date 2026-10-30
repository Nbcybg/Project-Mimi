import fs from 'node:fs';
import path from 'node:path';
import type { NodeTypeField } from '@mimi/shared';
import { z } from 'zod';

/** Names of custom nodes: they appear in workflow editor field options. */
export const CUSTOM_NODE_NAME = /^[a-z][a-z0-9_-]{1,60}$/;

const fieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  label: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'text', 'json', 'expression']),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  description: z.string().optional(),
});

/**
 * A custom node is a small piece of JavaScript in its own file under `user/nodes`.
 * It runs in the workflow sandbox (no files, processes, network or keys) and receives
 * `items` and `$config`; whatever it returns becomes the node's output items.
 */
export interface CustomNodeSpec {
  name: string;
  label: string;
  description: string;
  /** The code body; `items` and `$config` are in scope, `return` new items. */
  code: string;
  /** Optional form fields the editor can show (stored with the definition). */
  fields?: NodeTypeField[];
  timeoutMs?: number;
}

const specSchema = z.strictObject({
  name: z.string().regex(CUSTOM_NODE_NAME, 'lowercase letters, digits, "-" or "_"'),
  label: z.string().min(1),
  description: z.string().min(1),
  code: z.string().min(1),
  fields: z.array(fieldSchema).max(30).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
}) satisfies z.ZodType<CustomNodeSpec>;

function describe(error: z.ZodError, origin: string): Error {
  return new Error(`${origin}: invalid custom node:\n${z.prettifyError(error)}`);
}

/** `user/nodes/<name>.json`: definitions travel with the user's folder, like tools and skills. */
export class CustomNodeStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  list(): CustomNodeSpec[] {
    return this.names().map((name) => this.get(name)).filter((entry): entry is CustomNodeSpec => entry !== undefined);
  }

  names(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -5))
      .filter((name) => CUSTOM_NODE_NAME.test(name))
      .sort();
  }

  get(name: string): CustomNodeSpec | undefined {
    if (!CUSTOM_NODE_NAME.test(name)) return undefined;
    const file = path.join(this.dir, `${name}.json`);
    if (!fs.existsSync(file)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`${file}: not valid JSON: ${(error as Error).message}`);
    }
    const parsed = specSchema.safeParse(raw);
    if (!parsed.success) throw describe(parsed.error, file);
    return parsed.data as CustomNodeSpec;
  }

  save(spec: CustomNodeSpec, renameFrom?: string): CustomNodeSpec {
    const parsed = specSchema.safeParse(spec);
    if (!parsed.success) throw describe(parsed.error, `custom node "${spec.name}"`);
    if (renameFrom && renameFrom !== parsed.data.name) this.remove(renameFrom);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${parsed.data.name}.json`), `${JSON.stringify(parsed.data, null, 2)}\n`, { mode: 0o600 });
    return parsed.data as CustomNodeSpec;
  }

  remove(name: string): boolean {
    if (!CUSTOM_NODE_NAME.test(name)) return false;
    const file = path.join(this.dir, `${name}.json`);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }
}
