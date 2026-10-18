import type { Capability } from '@mimi/shared';
import type { LanguageModel } from 'ai';
import {
  type ModelInfo,
  type ModelRef,
  parseModelRef,
  type ProviderRegistry,
  type SamplingParams,
} from './registry.ts';
import type { Settings } from './settings.ts';

/** The opencode-style model keys, usable globally (settings file) and per agent (frontmatter). */
export interface ModelSelection {
  model?: string;
  small_model?: string;
  vision_model?: string;
  transcript_model?: string;
}

/** What the rest of the core needs from the provider layer. */
export interface ModelService {
  /** Picks the model for a capability: agent override first, then the settings file. */
  resolve(capability: Capability, agent?: ModelSelection): ModelRef;
  info(ref: ModelRef): ModelInfo;
  languageModel(ref: ModelRef): Promise<LanguageModel>;
}

/** A named entry of the model pool: a model plus how to sample from it. */
export interface ModelPreset extends SamplingParams {
  model: string;
}

/** Turns a model string into a reference: a preset name is looked up, anything else is `provider/model`. */
export function resolveModelName(name: string, presets: Record<string, ModelPreset>): ModelRef {
  if (name.includes('/')) return parseModelRef(name);
  const preset = presets[name];
  if (!preset) {
    throw new Error(`Unknown model preset "${name}". Add it to the model pool, or use "<provider>/<model>".`);
  }
  const { model, ...params } = preset;
  const defined = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
  return { ...parseModelRef(model), ...(Object.keys(defined).length > 0 ? { params: defined } : {}) };
}

export class ModelRouter implements ModelService {
  private readonly defaults: () => ModelSelection & { model: string };
  private readonly registry: ProviderRegistry;
  private readonly presets: () => Record<string, ModelPreset>;

  /** `defaults` and `presets` may be functions, so changes made in the app apply without a restart. */
  constructor(
    defaults: Pick<Settings, keyof ModelSelection> | (() => ModelSelection & { model: string }),
    registry: ProviderRegistry,
    presets: () => Record<string, ModelPreset> = () => ({}),
  ) {
    this.defaults = typeof defaults === 'function' ? defaults : () => defaults;
    this.registry = registry;
    this.presets = presets;
  }

  /**
   * chat -> `model`; summarize -> `small_model`; vision -> `vision_model`;
   * transcript -> `transcript_model`. Anything unset falls back to the chat model.
   */
  resolve(capability: Capability, agent: ModelSelection = {}): ModelRef {
    const defaults = this.defaults();
    const chat = agent.model ?? defaults.model;
    const pick = (key: keyof ModelSelection) => agent[key] ?? defaults[key] ?? chat;
    const parse = (name: string) => resolveModelName(name, this.presets());
    switch (capability) {
      case 'chat':
        return parse(chat);
      case 'summarize':
        return parse(pick('small_model'));
      case 'vision':
        return parse(pick('vision_model'));
      case 'transcript':
        return parse(pick('transcript_model'));
    }
  }

  info(ref: ModelRef): ModelInfo {
    return this.registry.info(ref);
  }

  languageModel(ref: ModelRef): Promise<LanguageModel> {
    return this.registry.languageModel(ref);
  }
}
