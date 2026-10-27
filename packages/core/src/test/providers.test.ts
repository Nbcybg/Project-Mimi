import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadCatalog, ModelCatalog } from '../providers/catalog.ts';
import { PROVIDER_ID, ProviderStore } from '../providers/provider-store.ts';
import { parseModelRef, ProviderRegistry } from '../providers/registry.ts';
import { ModelRouter } from '../providers/routing.ts';
import { parseSettings } from '../providers/settings.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-catalog-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A small slice of models.dev, in its real shape. */
const CATALOG = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    env: ['DEEPSEEK_API_KEY'],
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.deepseek.com',
    models: {
      'deepseek-flash': {
        name: 'DeepSeek Flash',
        attachment: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1_000_000, output: 393_216 },
        cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
      },
      'deepseek-old': { name: 'Old', status: 'deprecated', limit: { context: 64_000 }, cost: { input: 1, output: 2 } },
    },
  },
  google: {
    id: 'google',
    name: 'Google',
    env: ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
    npm: '@ai-sdk/google',
    models: {
      'gemini-pro': {
        name: 'Gemini Pro',
        modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
        limit: { context: 1_048_576, output: 65_536 },
        cost: { input: 2, output: 12, cache_read: 0.2, context_over_200k: { input: 4, output: 18, cache_read: 0.4 } },
      },
    },
  },
  exotic: { id: 'exotic', name: 'Exotic', env: ['EXOTIC_KEY'], npm: 'exotic-ai-provider', models: { m1: {} } },
  broken: 'not an object',
};

const registry = (overrides: unknown = {}, env: NodeJS.ProcessEnv = {}) =>
  new ProviderRegistry(
    new ModelCatalog(CATALOG),
    parseSettings({ model: 'deepseek/deepseek-flash', provider: overrides }, env).provider,
    env,
  );

test('settings: defaults, opencode-style keys, and typos are rejected', () => {
  const settings = parseSettings({ model: 'deepseek/deepseek-flash' });
  assert.equal(settings.small_model, undefined);
  assert.deepEqual(settings.provider, {});
  assert.deepEqual(settings.compaction, { auto: true, threshold: 0.65, keep_recent: 0.25, summary_budget: 0.15 });
  assert.deepEqual(settings.memory, { auto_write: true, profile_max_chars: 4000 });

  assert.throws(() => parseSettings({}), /model/);
  assert.throws(() => parseSettings({ model: 'No Slash' }), /provider/);
  assert.equal(parseSettings({ model: 'creative' }).model, 'creative', 'a preset name from the model pool');
  assert.throws(() => parseSettings({ model: 'a/b', smal_model: 'a/b' }), /smal_model/);
  assert.throws(() => parseSettings({ model: 'a/b', compaction: { threshold: 2 } }), /threshold/);
});

test('settings: {env:NAME} is substituted in string values', () => {
  const settings = parseSettings(
    { model: 'local/m', provider: { local: { npm: 'x', options: { apiKey: '{env:MY_KEY}', baseURL: 'http://{env:HOST}/v1' } } } },
    { MY_KEY: 'secret', HOST: 'localhost:1234' },
  );
  assert.deepEqual(settings.provider.local!.options, { apiKey: 'secret', baseURL: 'http://localhost:1234/v1' });
});

test('model references split on the first slash only', () => {
  assert.deepEqual(parseModelRef('openrouter/anthropic/claude'), { provider: 'openrouter', model: 'anthropic/claude' });
  assert.throws(() => parseModelRef('nope'), /Invalid model reference/);
  assert.throws(() => parseModelRef('provider/'), /Invalid model reference/);
});

test('registry: model metadata comes from the catalog', () => {
  const info = registry().info(parseModelRef('deepseek/deepseek-flash'));
  assert.equal(info.name, 'DeepSeek Flash');
  assert.equal(info.contextLimit, 1_000_000);
  assert.equal(info.imageInput, true);
  assert.deepEqual(info.cost, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.15, over200k: undefined });
  // DeepSeek is listed as OpenAI-compatible upstream; the dedicated SDK package is used instead.
  assert.equal(info.npm, '@ai-sdk/deepseek');

  const pro = registry().info(parseModelRef('google/gemini-pro'));
  assert.deepEqual(pro.cost!.over200k, { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 4 });
});

test('registry: the settings file overrides and extends the catalog', () => {
  const custom = registry({
    deepseek: { models: { 'deepseek-flash': { limit: { context: 50_000 }, cost: { output: 9 }, options: { effort: 'low' } } } },
    local: {
      npm: '@ai-sdk/openai-compatible',
      name: 'LM Studio',
      options: { baseURL: 'http://localhost:1234/v1' },
      models: { 'my-model': { limit: { context: 8192 } } },
    },
  });

  const flash = custom.info(parseModelRef('deepseek/deepseek-flash'));
  assert.equal(flash.contextLimit, 50_000);
  assert.equal(flash.outputLimit, 393_216, 'unset fields keep the catalog value');
  assert.deepEqual({ input: flash.cost!.input, output: flash.cost!.output }, { input: 0.15, output: 9 });
  assert.deepEqual(flash.options, { effort: 'low' });

  const local = custom.info(parseModelRef('local/my-model'));
  assert.deepEqual({ ctx: local.contextLimit, cost: local.cost, npm: local.npm }, { ctx: 8192, cost: null, npm: '@ai-sdk/openai-compatible' });
});

test('registry: unknown providers and models fail with guidance', () => {
  assert.throws(() => registry().info(parseModelRef('nowhere/x')), /Unknown provider "nowhere"/);
  assert.throws(
    () => registry().info(parseModelRef('deepseek/deepseek-flsh')),
    (error: Error) =>
      /Unknown model "deepseek\/deepseek-flsh"/.test(error.message) &&
      /deepseek-flash/.test(error.message) &&
      !/deepseek-old/.test(error.message) &&
      /provider\.deepseek\.models/.test(error.message),
  );
  assert.throws(() => registry().info(parseModelRef('broken/x')), /Unknown provider "broken"/);
  // A provider defined with nothing but models is treated as OpenAI-compatible, as in opencode.
  assert.equal(registry({ bare: { models: { m: {} } } }).info(parseModelRef('bare/m')).npm, '@ai-sdk/openai-compatible');
});

test('registry: without a catalog, configured models still work with defaults', () => {
  const offline = new ProviderRegistry(new ModelCatalog(), { deepseek: { npm: '@ai-sdk/deepseek', env: ['DEEPSEEK_API_KEY'] } });
  const info = offline.info(parseModelRef('deepseek/anything'));
  assert.deepEqual({ ctx: info.contextLimit, cost: info.cost }, { ctx: 128_000, cost: null });
  assert.throws(() => offline.info(parseModelRef('google/x')), /Unknown provider "google". Connect it in the app's settings/);
});

test('registry: creates models for bundled SDKs and reports missing credentials or packages', async () => {
  const withKeys = registry({}, { DEEPSEEK_API_KEY: 'k1', GEMINI_API_KEY: 'k2', EXOTIC_KEY: 'k3' });
  const flash = await withKeys.languageModel(parseModelRef('deepseek/deepseek-flash'));
  assert.equal(typeof flash === 'string' ? flash : flash.modelId, 'deepseek-flash');
  const pro = await withKeys.languageModel(parseModelRef('google/gemini-pro'));
  assert.equal(typeof pro === 'string' ? pro : pro.modelId, 'gemini-pro');

  await assert.rejects(registry().languageModel(parseModelRef('deepseek/deepseek-flash')), /No API key for DeepSeek\. Connect "deepseek" in the app's settings, or set DEEPSEEK_API_KEY in \.env/);
  await assert.rejects(withKeys.languageModel(parseModelRef('exotic/m1')), /"exotic-ai-provider" \(for exotic\) is not installed/);
  await assert.rejects(withKeys.languageModel(parseModelRef('deepseek/typo')), /Unknown model/);

  const viaOption = registry({ deepseek: { options: { apiKey: 'from-settings' } } });
  assert.ok(await viaOption.languageModel(parseModelRef('deepseek/deepseek-flash')));
});

test('registry: lists only providers with credentials, without deprecated models', () => {
  const available = registry({}, { GOOGLE_GENERATIVE_AI_API_KEY: 'k' }).available();
  assert.deepEqual(available.map((provider) => provider.id), ['google']);

  const both = registry({ local: { npm: 'x', models: { m: {} } } }, { DEEPSEEK_API_KEY: 'k' }).available();
  assert.deepEqual(both.map((provider) => provider.id), ['deepseek', 'local']);
  assert.deepEqual(both[0]!.models.map((model) => model.ref.model), ['deepseek-flash']);
});

test('router: capability -> model key, agent override first, chat model as fallback', () => {
  const router = new ModelRouter(
    { model: 'deepseek/deepseek-flash', small_model: undefined, vision_model: 'google/gemini-pro', transcript_model: undefined },
    registry(),
  );
  const ref = (capability: Parameters<ModelRouter['resolve']>[0], agent = {}) => {
    const resolved = router.resolve(capability, agent);
    return `${resolved.provider}/${resolved.model}`;
  };

  assert.equal(ref('chat'), 'deepseek/deepseek-flash');
  assert.equal(ref('summarize'), 'deepseek/deepseek-flash', 'small_model unset -> chat model');
  assert.equal(ref('vision'), 'google/gemini-pro');
  assert.equal(ref('chat', { model: 'google/gemini-pro' }), 'google/gemini-pro');
  assert.equal(ref('summarize', { model: 'google/gemini-pro' }), 'google/gemini-pro', "falls back to the agent's chat model");
  assert.equal(ref('summarize', { small_model: 'deepseek/deepseek-flash' }), 'deepseek/deepseek-flash');
  assert.equal(ref('transcript', { transcript_model: 'google/gemini-pro' }), 'google/gemini-pro');
});

test('catalog: fresh cache is used as is; stale cache is refreshed; failures fall back', async () => {
  const cachePath = path.join(tmp, 'cache.json');
  let fetches = 0;
  const fetchOk = (async () => {
    fetches++;
    return new Response(JSON.stringify(CATALOG));
  }) as typeof fetch;
  const fetchFail = (async () => {
    fetches++;
    throw new Error('offline');
  }) as typeof fetch;

  // No cache, no network: empty but usable.
  assert.equal((await loadCatalog({ cachePath, fetchFn: fetchFail })).isEmpty, true);
  // First successful download writes the cache.
  const first = await loadCatalog({ cachePath, fetchFn: fetchOk });
  assert.equal(first.provider('deepseek')!.name, 'DeepSeek');
  assert.equal(first.provider('broken'), undefined, 'malformed entries are skipped');
  assert.ok(fs.existsSync(cachePath));

  fetches = 0;
  await loadCatalog({ cachePath, fetchFn: fetchOk });
  assert.equal(fetches, 0, 'fresh cache: no download');
  await loadCatalog({ cachePath, fetchFn: fetchOk, refresh: true });
  assert.equal(fetches, 1, 'refresh forces a download');

  const twoDaysLater = () => Date.now() + 2 * 24 * 60 * 60 * 1000;
  const stale = await loadCatalog({ cachePath, fetchFn: fetchFail, now: twoDaysLater });
  assert.equal(fetches, 2, 'stale cache: download attempted');
  assert.equal(stale.provider('google')!.name, 'Google', 'failed download falls back to the cache');

  fetches = 0;
  await loadCatalog({ cachePath, fetchFn: fetchOk, now: twoDaysLater, offline: true });
  assert.equal(fetches, 0, 'offline mode never downloads');
});

test('registry: a settings-file api beats per-model endpoints the catalog pinned', () => {
  const catalog = new ModelCatalog({
    gw: {
      name: 'Gateway',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://old.example/v1',
      env: ['GW_KEY'],
      models: {
        pinned: { provider: { api: 'https://pinned.example/v1' }, limit: { context: 8192 } },
        plain: { limit: { context: 8192 } },
      },
    },
  });
  const env = { GW_KEY: 'k' };

  // No override: the catalog's endpoint wins, including a per-model pin.
  const untouched = new ProviderRegistry(catalog, {}, env);
  assert.equal(untouched.info(parseModelRef('gw/pinned')).baseURL, 'https://pinned.example/v1');
  assert.equal(untouched.info(parseModelRef('gw/plain')).baseURL, 'https://old.example/v1');

  // Settings-file api: the user's URL replaces both, even where the catalog pinned one.
  const overridden = new ProviderRegistry(catalog, parseSettings({ model: 'gw/plain', provider: { gw: { api: 'https://new.example/v1' } } }).provider, env);
  assert.equal(overridden.info(parseModelRef('gw/pinned')).baseURL, 'https://new.example/v1');
  assert.equal(overridden.info(parseModelRef('gw/plain')).baseURL, 'https://new.example/v1');

  // A per-model api set in the settings file still wins over the provider-level one.
  const perModel = new ProviderRegistry(
    catalog,
    parseSettings({ model: 'gw/plain', provider: { gw: { api: 'https://new.example/v1', models: { pinned: { provider: { api: 'https://special.example/v1' } } } } } }).provider,
    env,
  );
  assert.equal(perModel.info(parseModelRef('gw/pinned')).baseURL, 'https://special.example/v1');
  assert.equal(perModel.info(parseModelRef('gw/plain')).baseURL, 'https://new.example/v1');
});

test('provider files: save, read, list, remove and one-time migration from app settings', () => {
  const dir = path.join(tmp, 'providers');
  const store = new ProviderStore(dir);
  const entry = { def: { name: 'My LLM', npm: '@ai-sdk/openai-compatible', api: 'http://localhost:1234/v1', models: { m1: { name: 'M1' } } }, models: ['m1'] };

  store.save('my-llm', entry);
  assert.ok(fs.existsSync(path.join(dir, 'my-llm.json')));
  assert.deepEqual(store.get('my-llm'), entry);
  assert.deepEqual(store.defs(), { 'my-llm': entry.def });
  assert.deepEqual(store.listed(), { 'my-llm': ['m1'] });
  assert.throws(() => store.save('Bad Id', entry), /Invalid provider id/);
  assert.equal(store.get('../../etc/passwd'), undefined);
  assert.equal(PROVIDER_ID.test('opencode-go'), true);

  // Migration copies providers from the legacy store; files already present win.
  const other = new ProviderStore(path.join(tmp, 'providers2'));
  const copied = other.migrate({ 'my-llm': entry, legacy: { def: { name: 'Legacy' }, models: [] } });
  assert.equal(copied, 2);
  assert.equal(other.migrate({ 'my-llm': { def: { name: 'Changed' }, models: [] }, changed: { def: { name: 'Changed' }, models: [] } }), 1);
  assert.equal(other.get('my-llm')!.def.name, 'My LLM', 'a provider file already on disk is not overwritten');
  assert.equal(other.get('changed')!.def.name, 'Changed');

  assert.equal(store.remove('my-llm'), true);
  assert.equal(store.remove('my-llm'), false);
});

test('registry: model ids a provider listed (or the user typed in) are known even without catalog metadata', () => {
  const catalog = new ModelCatalog({
    gw: { name: 'Gateway', npm: '@ai-sdk/openai-compatible', api: 'https://gw.example/v1', env: [], models: { old: { name: 'Old' } } },
  });
  const registry = new ProviderRegistry(catalog, {}, {}, { listed: () => ({ gw: ['old', 'new-free'] }) });
  assert.equal(registry.info({ provider: 'gw', model: 'new-free' }).name, 'new-free');
  assert.throws(() => registry.info({ provider: 'gw', model: 'missing' }), /Unknown model "gw\/missing"/);
});
