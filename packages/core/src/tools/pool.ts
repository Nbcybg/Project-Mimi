import type { CustomToolSpec, ToolPreset, ToolView } from '@mimi/shared';
import { presetSecretKey, type SecretStore } from '../app/secrets.ts';
import type { McpHub } from '../mcp/hub.ts';
import { buildCustomTool } from './custom-tools.ts';
import type { PcRunner } from './executor.ts';
import { type ToolDefinition, ToolRegistry, shellConflict, type ToolSource } from './registry.ts';
import { ToolStore } from './tool-store.ts';

/** Connector tools carry grouping metadata that ToolSpec does not declare yet. */
function connectorMeta(tool: ToolDefinition): Pick<ToolView, 'connector' | 'operation' | 'familyLabel' | 'connectorCategory'> {
  const meta = tool as ToolDefinition & { connector?: unknown; operation?: unknown; familyLabel?: unknown; connectorCategory?: unknown };
  return {
    ...(typeof meta.connector === 'string' ? { connector: meta.connector } : {}),
    ...(typeof meta.operation === 'string' ? { operation: meta.operation } : {}),
    ...(typeof meta.familyLabel === 'string' ? { familyLabel: meta.familyLabel } : {}),
    ...(typeof meta.connectorCategory === 'string' ? { connectorCategory: meta.connectorCategory } : {}),
  };
}

function describeSettings(base: ToolDefinition, preset: ToolPreset): string {
  const fields = base.settings ?? [];
  const shown = fields
    .filter((field) => field.type !== 'secret' && preset.settings?.[field.key] !== undefined && preset.settings[field.key] !== '')
    .slice(0, 6)
    .map((field) => `${field.key}=${String(preset.settings[field.key]).slice(0, 80)}`);
  return shown.join(', ');
}

/**
 * The tool pool an agent picks from: the built-in tools plus the user's custom tools,
 * and the presets that turn any of them into a configured instance. A preset is a
 * *reference*: the tool plus the values filled in (spreadsheet ids, folders, API keys
 * from the vault). Agents list the preset name like any tool.
 */
export class ToolPool implements ToolSource {
  private readonly registry: ToolRegistry;
  private readonly store: ToolStore;
  private readonly secrets: SecretStore;
  /** Tools of the user's MCP servers (`mcp_<server>_<tool>`). */
  readonly mcp?: McpHub;
  /** Where tools that are set to run on the user's PC go. */
  private readonly pc?: PcRunner;

  constructor(registry: ToolRegistry, store: ToolStore, secrets: SecretStore, mcp?: McpHub, pc?: PcRunner) {
    this.pc = pc;
    this.registry = registry;
    this.store = store;
    this.secrets = secrets;
    this.mcp = mcp;
  }

  /** Every name an agent file may list. */
  names(): string[] {
    return [
      ...this.registry.names(),
      ...this.store.listCustom().map((spec) => spec.name),
      ...this.store.listPresets().map((preset) => preset.name),
      ...(this.mcp?.names() ?? []),
    ].sort();
  }

  get(name: string): ToolDefinition | undefined {
    const builtin = this.registry.get(name);
    if (builtin) return builtin;
    if (name.startsWith('mcp_')) {
      const tool = this.mcp?.get(name);
      if (tool) return tool;
    }
    const custom = this.store.custom(name);
    if (custom) return this.customTool(custom);
    const preset = this.store.preset(name);
    if (!preset) return undefined;
    const base = this.registry.get(preset.tool) ?? this.materializeCustom(preset);
    if (!base) return undefined;
    return this.materialize(preset, base);
  }

  select(names: string[]): ToolDefinition[] {
    // `mcp_<server>` stands for every tool of that server.
    const expanded = [...new Set(names.flatMap((name) => this.mcp?.expand(name) ?? [name]))];
    const selected = expanded.map((name) => {
      const tool = this.get(name);
      if (!tool) throw new Error(`Unknown tool "${name}". Available: ${this.names().join(', ')}`);
      return tool;
    });
    const conflict = shellConflict(selected);
    if (conflict) {
      throw new Error(
        `An agent cannot have both "${conflict.untrusted.name}" (reads third-party content) and "${conflict.shell.name}" (shell). Give them to different agents.`,
      );
    }
    return selected;
  }

  /** The pool as the tools screen shows it: built-ins and custom tools, with their settings schema. */
  views(): ToolView[] {
    const presetsByTool = new Map<string, string[]>();
    for (const preset of this.store.listPresets()) {
      presetsByTool.set(preset.tool, [...(presetsByTool.get(preset.tool) ?? []), preset.name]);
    }
    const builtins = this.registry.names().map((name) => {
      const tool = this.registry.get(name)!;
      return {
        name,
        description: tool.description,
        risk: tool.risk,
        target: tool.target,
        builtin: true,
        settings: tool.settings ?? [],
        presets: presetsByTool.get(name) ?? [],
        ...connectorMeta(tool),
      };
    });
    const customs = this.store.listCustom().map((spec) => {
      const tool = this.customTool(spec);
      return {
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        target: tool.target,
        builtin: false,
        settings: tool.settings ?? [],
        presets: presetsByTool.get(tool.name) ?? [],
      };
    });
    const mcp = (this.mcp?.toolViews() ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      target: 'core' as const,
      builtin: false,
      settings: [],
      presets: [],
      mcp: tool.server.name,
    }));
    return [...builtins, ...customs, ...mcp];
  }

  presetViews(): ToolPreset[] {
    return this.store.listPresets();
  }

  customSpecs(): CustomToolSpec[] {
    return this.store.listCustom();
  }

  /** Which `secret`-type settings each preset has stored in the vault (names only). */
  secretKeys(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const preset of this.store.listPresets()) {
      const fields = (this.registry.get(preset.tool)?.settings ?? this.store.custom(preset.tool)?.settings ?? []).filter(
        (field) => field.type === 'secret',
      );
      const set = fields.filter((field) => this.secrets.has(presetSecretKey(preset.name, field.key))).map((field) => field.key);
      if (set.length > 0) out[preset.name] = set;
    }
    return out;
  }

  saveCustom(spec: CustomToolSpec, renameFrom?: string): CustomToolSpec {
    if (this.registry.get(spec.name)) throw new Error(`"${spec.name}" is the name of a built-in tool; pick another.`);
    const saved = this.store.saveCustom(spec, renameFrom);
    if (renameFrom && renameFrom !== saved.name) {
      for (const preset of this.store.listPresets()) {
        if (preset.tool === renameFrom) this.store.savePreset({ ...preset, tool: saved.name });
      }
    }
    return saved;
  }

  /** Deletes a custom tool and every preset built on it; returns the preset names that went with it. */
  deleteCustom(name: string): string[] {
    const orphans = this.store.listPresets().filter((preset) => preset.tool === name).map((preset) => preset.name);
    for (const orphan of orphans) {
      this.store.deletePreset(orphan);
      this.secrets.removePreset(orphan);
    }
    this.store.deleteCustom(name);
    return orphans;
  }

  savePreset(preset: ToolPreset, renameFrom?: string): ToolPreset {
    const base = this.registry.get(preset.tool) ?? (this.store.custom(preset.tool) ? this.materializeCustom(preset) : undefined);
    if (!base) throw new Error(`Unknown tool "${preset.tool}".`);
    if (base.target === 'pc') throw new Error(`"${preset.tool}" runs on the PC agent and cannot be made into a preset yet.`);
    if (this.registry.get(preset.name) || this.store.custom(preset.name)) {
      throw new Error(`"${preset.name}" is the name of an existing tool; pick another.`);
    }
    // The same check a call would do, so a preset that cannot run never reaches disk.
    const missing = (base.settings ?? []).filter(
      (field) =>
        field.required !== false &&
        !field.default &&
        !preset.settings?.[field.key] &&
        !this.secrets.has(presetSecretKey(preset.name, field.key)),
    );
    if (missing.length > 0) {
      throw new Error(`Fill in: ${missing.map((field) => `"${field.label}"`).join(', ')}.`);
    }
    return this.store.savePreset(preset, renameFrom);
  }

  deletePreset(name: string): boolean {
    this.secrets.removePreset(name);
    return this.store.deletePreset(name);
  }

  private customTool(spec: CustomToolSpec): ToolDefinition {
    return buildCustomTool(spec, (name) => this.secrets.get(name) ?? process.env[name], this.pc);
  }

  private materializeCustom(preset: ToolPreset): ToolDefinition | undefined {
    const spec = this.store.custom(preset.tool);
    return spec ? this.customTool(spec) : undefined;
  }

  private secretSettings(preset: ToolPreset, base: ToolDefinition): Record<string, string> {
    const out: Record<string, string> = {};
    for (const field of base.settings ?? []) {
      if (field.type !== 'secret') continue;
      const value = this.secrets.get(presetSecretKey(preset.name, field.key));
      if (value) out[field.key] = value;
    }
    return out;
  }

  private materialize(preset: ToolPreset, base: ToolDefinition): ToolDefinition {
    const label = preset.label?.trim() || preset.name;
    const shown = describeSettings(base, preset);
    const description = `${preset.description?.trim() || base.description}${preset.description ? '' : ` [${label}]`}${shown ? ` — ${shown}` : ''}`;
    const values = { ...preset.settings, ...this.secretSettings(preset, base) };
    return {
      ...base,
      name: preset.name,
      description,
      execute: (input, context) => base.execute(input, context, values),
    };
  }
}
