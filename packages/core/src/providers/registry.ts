import { randomUUID } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ReasoningEffort } from '@mimi/shared';
import type { EmbeddingModel, LanguageModel, SystemModelMessage } from 'ai';
import type { AuthStore } from './auth-store.ts';
import type { ModelCatalog } from './catalog.ts';
import type { ModelDef, ProviderDef, Settings } from './settings.ts';

type SharedProviderOptions = NonNullable<SystemModelMessage['providerOptions']>;

/** Sampling settings of a model preset; anything left out uses the provider's default. */
export interface SamplingParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  /** Reasoning effort ("none" … "max"); passed to the AI SDK, which maps it per provider. */
  reasoning?: ReasoningEffort;
}

export interface ModelRef {
  provider: string;
  model: string;
  /** Set when the reference came from a preset of the model pool. */
  params?: SamplingParams;
}

/** USD per 1M tokens. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Rates that apply when the prompt is larger than 200k tokens. */
  over200k?: Omit<ModelCost, 'over200k'>;
}

export interface ModelInfo {
  ref: ModelRef;
  name: string;
  /** SDK package that speaks this model's API dialect. */
  npm: string;
  baseURL: string | undefined;
  contextLimit: number;
  outputLimit: number | undefined;
  /** null when no price is known; such calls are logged with cost 0. */
  cost: ModelCost | null;
  imageInput: boolean;
  toolCall: boolean;
  /** False for models that do not produce text (image, speech, embeddings). */
  textOutput: boolean;
  /** Per-model provider options from the settings file. */
  options: Record<string, unknown>;
}

/** A provider after catalog, settings file and in-app changes are merged. */
export interface ResolvedProvider {
  id: string;
  name: string;
  npm: string;
  api: string | undefined;
  env: string[];
  options: Record<string, unknown>;
  models: Record<string, ModelDef>;
}

/** Where credentials and user-added providers come from, besides the settings file. */
export interface RegistrySources {
  /** Credentials created by connecting a provider (user/data/auth.json). */
  auth?: AuthStore;
  /** Providers added or changed inside the app; layered over the settings file. */
  extra?: () => Record<string, ProviderDef>;
  /** Model ids a provider reported when it was connected; when present, only these are offered. */
  listed?: () => Record<string, string[]>;
}

interface ProviderSdk {
  languageModel(modelId: string): LanguageModel;
  embeddingModel?(modelId: string): EmbeddingModel;
  textEmbeddingModel?(modelId: string): EmbeddingModel;
  imageModel?(modelId: string): unknown;
  speechModel?(modelId: string): unknown;
  videoModel?(modelId: string): unknown;
}
type ProviderFactory = (options: Record<string, unknown>) => ProviderSdk;

/** Provider packages shipped with the core; anything else is imported by name on demand. */
const BUNDLED: Record<string, ProviderFactory> = {
  '@ai-sdk/deepseek': createDeepSeek,
  '@ai-sdk/google': createGoogleGenerativeAI,
  '@ai-sdk/anthropic': createAnthropic,
  '@ai-sdk/openai-compatible': createOpenAICompatible as unknown as ProviderFactory,
};

/** Use the dedicated SDK package where the catalog only lists the generic OpenAI-compatible one. */
const PREFERRED_NPM: Record<string, string> = { deepseek: '@ai-sdk/deepseek' };

/** The package for a provider the user adds by URL, as in opencode. */
export const CUSTOM_PROVIDER_NPM = '@ai-sdk/openai-compatible';

const DEFAULT_CONTEXT_LIMIT = 128_000;

/** How this app names itself to provider gateways. */
const CLIENT_USER_AGENT = 'mimi/0.4.0';

/**
 * opencode's gateways ask clients to identify themselves with their own user agent and a
 * stable session id; Go refuses calls without `x-opencode-session`. The id is stable per
 * provider client, which is what routing and prompt caching need.
 */
function gatewayHeaders(baseURL: string | undefined): Record<string, string> {
  if (!baseURL) return {};
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname;
  } catch {
    return {};
  }
  if (hostname !== 'opencode.ai' && !hostname.endsWith('.opencode.ai')) return {};
  return { 'user-agent': CLIENT_USER_AGENT, 'x-opencode-session': randomUUID() };
}

/** Per-model options from the settings file, in the shape the AI SDK expects on a call. */
export function providerOptionsFor(info: ModelInfo): SharedProviderOptions | undefined {
  if (Object.keys(info.options).length === 0) return undefined;
  return { [info.ref.provider]: info.options } as SharedProviderOptions;
}

export function parseModelRef(ref: string): ModelRef {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Invalid model reference "${ref}". Expected "<provider>/<model>"`);
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

function toCost(cost: ModelDef['cost']): ModelCost | null {
  if (cost?.input === undefined || cost.output === undefined) return null;
  const rates = (part: { input: number; output: number; cache_read?: number; cache_write?: number }) => ({
    input: part.input,
    output: part.output,
    cacheRead: part.cache_read ?? part.input,
    cacheWrite: part.cache_write ?? part.input,
  });
  return {
    ...rates({ ...cost, input: cost.input, output: cost.output }),
    over200k: cost.context_over_200k ? rates(cost.context_over_200k) : undefined,
  };
}

function mergeModel(base: ModelDef | undefined, override: ModelDef | undefined): ModelDef {
  return {
    ...base,
    ...override,
    name: override?.name ?? base?.name,
    limit: { ...base?.limit, ...override?.limit },
    cost: base?.cost || override?.cost ? { ...base?.cost, ...override?.cost } : undefined,
    options: { ...base?.options, ...override?.options },
    provider: base?.provider || override?.provider ? { ...base?.provider, ...override?.provider } : undefined,
  };
}

/**
 * Resolves `provider/model` the way opencode does. Providers come from three layers:
 * the models.dev catalog, the `provider` block of the settings file, and providers the
 * user connected in the app (any OpenAI-compatible URL). A provider becomes usable
 * once it has a credential.
 */
export class ProviderRegistry {
  private readonly catalog: ModelCatalog;
  private readonly overrides: Settings['provider'];
  private readonly env: NodeJS.ProcessEnv;
  private readonly sources: RegistrySources;
  private readonly sdks = new Map<string, Promise<ProviderSdk>>();

  constructor(
    catalog: ModelCatalog,
    overrides: Settings['provider'],
    env: NodeJS.ProcessEnv = process.env,
    sources: RegistrySources = {},
  ) {
    this.catalog = catalog;
    this.overrides = overrides;
    this.env = env;
    this.sources = sources;
  }

  /** The merged definition of a provider; throws when nothing defines it. */
  describe(id: string): ResolvedProvider {
    const base = this.catalog.provider(id);
    const layers = [this.overrides[id], this.sources.extra?.()[id]].filter(
      (layer): layer is ProviderDef => layer !== undefined,
    );
    if (!base && layers.length === 0) {
      throw new Error(
        `Unknown provider "${id}". Connect it in the app's settings (id, URL, API key), or define it under "provider" in the settings file.`,
      );
    }
    const last = <K extends keyof ProviderDef>(key: K) => layers.findLast((layer) => layer[key] !== undefined)?.[key];

    const npm = last('npm') ?? PREFERRED_NPM[id] ?? base?.npm ?? CUSTOM_PROVIDER_NPM;
    const models: Record<string, ModelDef> = { ...base?.models };
    for (const layer of layers) {
      for (const [modelId, def] of Object.entries(layer.models ?? {})) {
        models[modelId] = mergeModel(models[modelId], def);
      }
    }
    // Ids the provider listed (or the user typed in) are real models even without metadata.
    for (const modelId of this.sources.listed?.()[id] ?? []) models[modelId] ??= {} as ModelDef;
    return {
      id,
      name: last('name') ?? base?.name ?? id,
      npm,
      // The catalog's base URL belongs to the catalog's package; a swapped-in SDK has its own default.
      api: last('api') ?? (npm === base?.npm ? base.api : undefined),
      env: last('env') ?? base?.env ?? [],
      options: Object.assign({}, base?.options, ...layers.map((layer) => layer.options)),
      models,
    };
  }

  /** Every provider of the models.dev catalog, for the "add provider" picker. */
  catalogProviders(): Array<{ id: string; name: string; baseURL: string | null }> {
    return this.catalog
      .providerIds()
      .flatMap((id) => {
        const provider = this.catalog.provider(id);
        return provider ? [{ id, name: provider.name ?? id, baseURL: provider.api ?? null }] : [];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Credential lookup order: settings file, stored credential, environment variable. */
  private apiKey(provider: ResolvedProvider): string | undefined {
    const configured = provider.options.apiKey;
    if (typeof configured === 'string' && configured) return configured;
    const stored = this.sources.auth?.get(provider.id);
    if (stored) return stored;
    for (const name of provider.env) {
      if (this.env[name]) return this.env[name];
    }
    return undefined;
  }

  private toInfo(provider: ResolvedProvider, modelId: string, def: ModelDef | undefined): ModelInfo {
    return {
      ref: { provider: provider.id, model: modelId },
      name: def?.name ?? modelId,
      npm: def?.provider?.npm ?? provider.npm,
      baseURL: def?.provider?.api ?? provider.api,
      contextLimit: def?.limit?.context ?? DEFAULT_CONTEXT_LIMIT,
      outputLimit: def?.limit?.output,
      cost: toCost(def?.cost),
      imageInput: def?.modalities?.input.includes('image') ?? def?.attachment ?? false,
      toolCall: def?.tool_call ?? true,
      textOutput: def?.modalities?.output.includes('text') ?? true,
      options: def?.options ?? {},
    };
  }

  /** Metadata for a model; throws with suggestions when the id is not known. */
  info(ref: ModelRef): ModelInfo {
    const provider = this.describe(ref.provider);
    const def = provider.models[ref.model];
    if (!def && !this.catalog.isEmpty) {
      const known = Object.entries(provider.models)
        .filter(([, model]) => model.status !== 'deprecated')
        .map(([id]) => id);
      throw new Error(
        `Unknown model "${formatModelRef(ref)}". Known ${ref.provider} models: ${known.join(', ') || 'none'}. ` +
          `Refresh the provider's model list in the app's settings, or add the model under provider.${ref.provider}.models in the settings file.`,
      );
    }
    return this.toInfo(provider, ref.model, def);
  }

  /** True when the provider can be called: it has a credential, or needs none. */
  hasCredentials(providerId: string): boolean {
    const provider = this.describe(providerId);
    return this.apiKey(provider) !== undefined || provider.env.length === 0;
  }

  /** The credential the provider would be called with, e.g. to re-list its models. */
  credentialFor(providerId: string): string | undefined {
    return this.apiKey(this.describe(providerId));
  }

  private async loadSdk(provider: ResolvedProvider, npm: string, baseURL: string | undefined): Promise<ProviderSdk> {
    const apiKey = this.apiKey(provider);
    if (!apiKey && provider.env.length > 0) {
      throw new Error(
        `No API key for ${provider.name}. Connect "${provider.id}" in the app's settings, or set ${provider.env.join(' or ')} in .env`,
      );
    }
    if (npm === CUSTOM_PROVIDER_NPM && !baseURL) {
      throw new Error(`Provider "${provider.id}" has no base URL. Set it in the app's settings.`);
    }

    let factory = BUNDLED[npm];
    if (!factory) {
      let module: Record<string, unknown>;
      try {
        module = (await import(npm)) as Record<string, unknown>;
      } catch {
        throw new Error(
          `Provider package "${npm}" (for ${provider.id}) is not installed. Run: npm install -w @mimi/core ${npm}`,
        );
      }
      const exportName = Object.keys(module).find((key) => key.startsWith('create'));
      if (!exportName) throw new Error(`"${npm}" does not export a provider factory`);
      factory = module[exportName] as ProviderFactory;
    }

    const configured = provider.options.headers;
    const headers = {
      ...gatewayHeaders(baseURL),
      ...(configured && typeof configured === 'object' ? (configured as Record<string, string>) : {}),
    };

    return factory({
      name: provider.id,
      ...(baseURL ? { baseURL } : {}),
      ...provider.options,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(apiKey ? { apiKey } : {}),
    });
  }

  /** Drops cached provider clients, so credentials changed at runtime are picked up. */
  reset(): void {
    this.sdks.clear();
  }

  async languageModel(ref: ModelRef): Promise<LanguageModel> {
    const info = this.info(ref); // validates the model id
    return (await this.sdkFor(ref.provider, info)).languageModel(ref.model);
  }

  /**
   * An embedding model (knowledge bases). The catalog does not list embedding models,
   * so the id is not checked here; the provider answers if it is wrong.
   */
  async embeddingModel(ref: ModelRef): Promise<EmbeddingModel> {
    const provider = this.describe(ref.provider);
    const sdk = await this.sdkFor(ref.provider, this.toInfo(provider, ref.model, provider.models[ref.model]));
    const make = sdk.embeddingModel ?? sdk.textEmbeddingModel;
    if (!make) throw new Error(`Provider "${ref.provider}" has no embedding models; use e.g. google/gemini-embedding-001.`);
    return make.call(sdk, ref.model);
  }

  /**
   * A model that makes pictures, speech or video. The catalog lists few of them, so the id
   * is not checked here; the provider answers if it is wrong.
   */
  async mediaModel<T>(kind: 'image' | 'speech' | 'video', ref: ModelRef): Promise<T> {
    const provider = this.describe(ref.provider);
    const sdk = await this.sdkFor(ref.provider, this.toInfo(provider, ref.model, provider.models[ref.model]));
    const make = { image: sdk.imageModel, speech: sdk.speechModel, video: sdk.videoModel }[kind];
    if (!make) {
      const what = { image: 'pictures', speech: 'speech', video: 'videos' }[kind];
      throw new Error(`Provider "${ref.provider}" cannot make ${what}; pick a model of a provider that can (e.g. google).`);
    }
    return make.call(sdk, ref.model) as T;
  }

  /** One client per provider and API dialect: a gateway may serve models in several. */
  private sdkFor(providerId: string, info: ModelInfo): Promise<ProviderSdk> {
    const key = `${providerId}\n${info.npm}\n${info.baseURL ?? ''}`;
    let sdk = this.sdks.get(key);
    if (!sdk) {
      sdk = this.loadSdk(this.describe(providerId), info.npm, info.baseURL);
      this.sdks.set(key, sdk);
      sdk.catch(() => this.sdks.delete(key));
    }
    return sdk;
  }

  /** Providers that can be called, with the models to offer for each. */
  available(): Array<{ id: string; name: string; models: ModelInfo[] }> {
    const extra = this.sources.extra?.() ?? {};
    const listed = this.sources.listed?.() ?? {};
    const ids = new Set([...this.catalog.providerIds(), ...Object.keys(this.overrides), ...Object.keys(extra)]);
    const result: Array<{ id: string; name: string; models: ModelInfo[] }> = [];
    for (const id of ids) {
      let provider: ResolvedProvider;
      try {
        provider = this.describe(id);
      } catch {
        continue;
      }
      // Providers without any key requirement (local servers) only count when configured.
      const configured = id in this.overrides || id in extra;
      if (!this.apiKey(provider) && !(configured && provider.env.length === 0)) continue;
      const offered = listed[id];
      const models = Object.entries(provider.models)
        .filter(([modelId, def]) => (offered ? offered.includes(modelId) : def.status !== 'deprecated'))
        .map(([modelId, def]) => this.toInfo(provider, modelId, def));
      result.push({ id, name: provider.name, models });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }
}
