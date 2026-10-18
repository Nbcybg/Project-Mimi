import fs from 'node:fs';
import path from 'node:path';
import type { CustomToolKind, CustomToolSpec, ToolParamField, ToolPreset, ToolSettingField } from '@mimi/shared';
import { z } from 'zod';

/** Names of tools and presets share the agent rules so they can appear in agent files. */
export const TOOL_NAME = /^[a-z][a-z0-9_-]*$/;
const SETTING_KEY = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const settingField = z.strictObject({
  key: z.string().regex(SETTING_KEY, 'letters, digits and "_"'),
  label: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'secret', 'text']),
  description: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
}) satisfies z.ZodType<ToolSettingField>;

const paramField = z.strictObject({
  key: z.string().regex(SETTING_KEY, 'letters, digits and "_"'),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().optional(),
  required: z.boolean().optional(),
}) satisfies z.ZodType<ToolParamField>;

const customToolSchema = z.strictObject({
  name: z.string().regex(TOOL_NAME, 'lowercase letters, digits, "-" or "_"'),
  description: z.string().min(1),
  kind: z.enum(['http', 'code', 'shell']),
  params: z.array(paramField).default([]),
  settings: z.array(settingField).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
});

const presetSchema = z.strictObject({
  name: z.string().regex(TOOL_NAME, 'lowercase letters, digits, "-" or "_"'),
  tool: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

function describe(error: z.ZodError, origin: string): Error {
  return new Error(`${origin}: invalid tool definition:\n${z.prettifyError(error)}`);
}

/** Kind-specific checks; a tool that would fail at call time is rejected before it is saved. */
function checkConfig(kind: CustomToolKind, config: Record<string, unknown>, origin: string): void {
  const need = (key: string): string => {
    const value = config[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${origin}: "config.${key}" is required`);
    return value;
  };
  if (kind === 'http') {
    const method = config.method ?? 'GET';
    if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method.toUpperCase())) {
      throw new Error(`${origin}: "config.method" must be GET, POST, PUT, PATCH, DELETE or HEAD`);
    }
    const url = need('url');
    if (!/^https?:\/\//i.test(url) && !/^\{\{/.test(url)) {
      throw new Error(`${origin}: "config.url" must start with http:// or https:// (or a {{…}} template)`);
    }
  } else if (kind === 'code') {
    need('code');
  } else {
    need('command');
  }
}

function parseFile<T>(file: string, parse: (raw: unknown, origin: string) => T): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: not valid JSON: ${(error as Error).message}`);
  }
  return parse(raw, file);
}

/**
 * The tool pool on disk, next to `agents/` and `skills/` so it travels with them:
 * `tools/<name>.json` holds one tool each, `tools/presets/<name>.json` holds configured
 * instances of those tools (and of the built-in ones). Files are read on every call, so
 * hand edits apply to the next run.
 */
export class ToolStore {
  private readonly customDir: string;
  private readonly presetsDir: string;

  constructor(dir: string) {
    this.customDir = dir;
    this.presetsDir = path.join(dir, 'presets');
  }

  listCustom(): CustomToolSpec[] {
    return this.listFiles(this.customDir)
      .map((name) => this.custom(name))
      .filter((spec): spec is CustomToolSpec => spec !== undefined);
  }

  custom(name: string): CustomToolSpec | undefined {
    if (!TOOL_NAME.test(name)) return undefined;
    return parseFile(path.join(this.customDir, `${name}.json`), (raw, origin) => {
      const parsed = customToolSchema.safeParse(raw);
      if (!parsed.success) throw describe(parsed.error, origin);
      checkConfig(parsed.data.kind, parsed.data.config, origin);
      return parsed.data;
    });
  }

  saveCustom(spec: CustomToolSpec, renameFrom?: string): CustomToolSpec {
    const parsed = customToolSchema.safeParse(spec);
    if (!parsed.success) throw describe(parsed.error, `tool "${(spec as { name?: string }).name ?? '?'}"`);
    checkConfig(parsed.data.kind, parsed.data.config, `tool "${parsed.data.name}"`);
    if (renameFrom && renameFrom !== parsed.data.name) this.deleteCustom(renameFrom);
    fs.mkdirSync(this.customDir, { recursive: true });
    fs.writeFileSync(path.join(this.customDir, `${parsed.data.name}.json`), `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
    return parsed.data;
  }

  deleteCustom(name: string): boolean {
    return this.removeFile(this.customDir, name);
  }

  listPresets(): ToolPreset[] {
    return this.listFiles(this.presetsDir)
      .map((name) => this.preset(name))
      .filter((preset): preset is ToolPreset => preset !== undefined);
  }

  preset(name: string): ToolPreset | undefined {
    if (!TOOL_NAME.test(name)) return undefined;
    return parseFile(path.join(this.presetsDir, `${name}.json`), (raw, origin) => {
      const parsed = presetSchema.safeParse(raw);
      if (!parsed.success) throw describe(parsed.error, origin);
      return parsed.data as ToolPreset;
    });
  }

  savePreset(preset: ToolPreset, renameFrom?: string): ToolPreset {
    const parsed = presetSchema.safeParse(preset);
    if (!parsed.success) throw describe(parsed.error, `tool preset "${(preset as { name?: string }).name ?? '?'}"`);
    if (renameFrom && renameFrom !== parsed.data.name) this.deletePreset(renameFrom);
    fs.mkdirSync(this.presetsDir, { recursive: true });
    fs.writeFileSync(path.join(this.presetsDir, `${parsed.data.name}.json`), `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
    return parsed.data as ToolPreset;
  }

  deletePreset(name: string): boolean {
    return this.removeFile(this.presetsDir, name);
  }

  private listFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -5))
      .filter((name) => TOOL_NAME.test(name))
      .sort();
  }

  private removeFile(dir: string, name: string): boolean {
    const file = path.join(dir, `${name}.json`);
    if (!TOOL_NAME.test(name) || !fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }
}
