import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import zlib from 'node:zlib';
import type { ClientMessage, ServerMessage } from '@mimi/shared';
import { deleteAgent, listAgents, loadAgent, saveAgent, serializeAgent } from '../agents/loader.ts';
import { AppSettings } from '../app/app-settings.ts';
import { renderIconIco, renderIconPng } from '../app/icon.ts';
import { AuthStore } from '../providers/auth-store.ts';
import { ModelCatalog } from '../providers/catalog.ts';
import { DiscoveryError, discoverModels } from '../providers/discovery.ts';
import { parseModelRef, ProviderRegistry } from '../providers/registry.ts';
import { startServer } from '../server/server.ts';
import { makeTestRoot, testCoreParts } from './core-helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-app-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('app settings: token is created once; providers, models and Google client persist', () => {
  const file = path.join(tmp, 'nested/app-settings.json');
  const first = AppSettings.load(file);
  assert.ok(first.token.length >= 24);
  assert.equal(AppSettings.load(file).token, first.token, 'the token survives restarts');

  const env: NodeJS.ProcessEnv = {};
  first.setKeys({ GOOGLE_OAUTH_CLIENT_ID: ' client-id ', DEEPSEEK_API_KEY: 'sk', PATH: 'evil', MIMI_TOKEN: 'evil' }, env);
  assert.deepEqual(env, { GOOGLE_OAUTH_CLIENT_ID: 'client-id' }, 'only the Google client values are accepted here');
  first.setProvider('my-llm', { def: { name: 'My LLM', npm: '@ai-sdk/openai-compatible', api: 'http://localhost:1234/v1', models: { m1: {} } }, models: ['m1'] });
  first.setDefaults({ model: 'my-llm/m1', vision_model: 'other/x', small_model: '' });
  first.setAllowedDirs([' C:\\work ', '']);

  const reloaded = AppSettings.load(file);
  const fresh: NodeJS.ProcessEnv = { ALLOWED_DIRS: 'old' };
  reloaded.applyToEnv(fresh);
  assert.deepEqual(fresh, { GOOGLE_OAUTH_CLIENT_ID: 'client-id', ALLOWED_DIRS: 'C:\\work' });
  assert.deepEqual(reloaded.providerDefs()['my-llm']!.api, 'http://localhost:1234/v1');
  assert.deepEqual(reloaded.listedModels(), { 'my-llm': ['m1'] });

  reloaded.removeProvider('my-llm');
  assert.deepEqual(reloaded.defaults, { vision_model: 'other/x' }, 'defaults on a removed provider are cleared');
  assert.deepEqual(AppSettings.load(file).providers, {});

  assert.equal(AppSettings.load(file).timezone, '', 'no zone chosen yet');
  reloaded.setTimezone('Asia/Singapore');
  assert.equal(AppSettings.load(file).timezone, 'Asia/Singapore');
  assert.throws(() => reloaded.setTimezone('Mars/Olympus'), /Unknown time zone/);
  reloaded.clearTimezone();
  assert.equal(AppSettings.load(file).timezone, '');
});

test('credentials are stored like opencode auth.json', () => {
  const file = path.join(tmp, 'auth/auth.json');
  const auth = new AuthStore(file);
  assert.equal(auth.get('opencode'), undefined);
  auth.set('opencode', ' sk-zen ');
  auth.set('my-llm', 'local');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    opencode: { type: 'api', key: 'sk-zen' },
    'my-llm': { type: 'api', key: 'local' },
  });

  const reloaded = new AuthStore(file);
  assert.deepEqual(reloaded.providers(), ['opencode', 'my-llm']);
  reloaded.remove('my-llm');
  assert.equal(new AuthStore(file).has('my-llm'), false);
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(new AuthStore(file).providers(), [], 'a broken file is treated as empty');
});

test('agent files: an agent with one model per capability round-trips through save and load', () => {
  const dir = path.join(tmp, 'agents-roundtrip');
  const agent = {
    name: 'mimi',
    displayName: 'มีมี่',
    skills: ['night-quiz'],
    description: 'เลขา: คุยทั่วไป',
    systemPrompt: 'You are Mimi.\n\n- Speak Thai.',
    models: { model: 'opencode-go/deepseek-v4-flash', vision_model: 'google/gemini-flash', transcript_model: 'google/gemini-flash', small_model: 'opencode-go/deepseek-v4.1-flash' },
    tools: ['read_memory', 'create_trigger'],
    canMessage: ['tim'],
    budgets: { maxRounds: 9, maxTokens: 50_000 },
  };
  assert.deepEqual(saveAgent(dir, agent), agent);
  assert.deepEqual(loadAgent(dir, 'mimi'), agent);
  const source = fs.readFileSync(path.join(dir, 'mimi', 'agent.md'), 'utf8');
  assert.ok(source.startsWith('---\nname: mimi\n'));
  assert.ok(source.includes('vision_model: google/gemini-flash\n'));
  assert.equal(serializeAgent(loadAgent(dir, 'mimi')), source, 'stable on re-save');

  // Capabilities left empty are simply absent; an invalid definition never reaches disk.
  saveAgent(dir, { ...agent, name: 'tim', models: {}, canMessage: ['mimi'] });
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'tim', 'agent.md'), 'utf8'), /model/);
  assert.throws(() => saveAgent(dir, { ...agent, name: 'Bad Name' }), /name/);
  assert.throws(() => saveAgent(dir, { ...agent, name: 'empty', systemPrompt: '  ' }), /body is empty/);
  assert.deepEqual(listAgents(dir), ['mimi', 'tim']);

  // Deleting an agent also takes it off the others' contact lists.
  assert.equal(deleteAgent(dir, 'mimi'), true);
  assert.equal(deleteAgent(dir, 'mimi'), false);
  assert.equal(deleteAgent(dir, '../tim'), false);
  assert.deepEqual(loadAgent(dir, 'tim').canMessage, []);
});

test('icon: a valid 256x256 RGBA PNG inside a one-image .ico', () => {
  const png = renderIconPng();
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]], [256, 256, 8, 6]);
  const idat = png.indexOf('IDAT');
  const pixels = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.equal(pixels.length, (256 * 4 + 1) * 256);
  const alphaAt = (x: number, y: number) => pixels[y * (256 * 4 + 1) + 1 + x * 4 + 3];
  assert.deepEqual([alphaAt(0, 0), alphaAt(128, 128)], [0, 255], 'transparent corner, solid centre');

  const ico = renderIconIco();
  assert.deepEqual([ico.readUInt16LE(2), ico.readUInt16LE(4), ico.readUInt32LE(14), ico.readUInt32LE(18)], [1, 1, png.length, 22]);
  assert.ok(ico.subarray(22).equals(png));
});

const GOOD_KEY = 'sk-good-key';

interface FakeProvider {
  /** Base URL to give the app, e.g. http://127.0.0.1:1234/v1 */
  url: string;
  requests: Array<{ path: string; authorization: string | undefined; body: string }>;
  close(): Promise<void>;
}

/** A stand-in for an OpenAI-compatible provider: lists models, streams one chat answer. */
async function fakeProvider(modelIds: string[]): Promise<FakeProvider> {
  const requests: FakeProvider['requests'] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push({ path: request.url ?? '', authorization: request.headers.authorization, body });
      if (request.headers.authorization !== `Bearer ${GOOD_KEY}`) {
        response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"bad key"}}');
      } else if (request.url === '/v1/models') {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ object: 'list', data: modelIds.map((id) => ({ id, object: 'model', context_length: 64_000 })) }));
      } else if (request.url === '/v1/chat/completions') {
        const model = (JSON.parse(body) as { model: string }).model;
        const chunk = (delta: object, finish: string | null, usage?: object) =>
          `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(chunk({ role: 'assistant', content: 'สวัสดีจาก ' }, null));
        response.write(chunk({ content: model }, null));
        response.write(chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }));
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test('model discovery: lists models, and says what is wrong when it cannot', async () => {
  const provider = await fakeProvider(['zeta', 'alpha']);
  const npm = '@ai-sdk/openai-compatible';

  assert.deepEqual(await discoverModels({ npm, baseURL: `${provider.url}/`, apiKey: GOOD_KEY }), [
    { id: 'alpha', name: undefined, contextLimit: 64_000 },
    { id: 'zeta', name: undefined, contextLimit: 64_000 },
  ]);
  await assert.rejects(discoverModels({ npm, baseURL: provider.url, apiKey: 'wrong' }), /rejected the API key \(HTTP 401\)/);
  await assert.rejects(discoverModels({ npm, baseURL: `${provider.url}/nothing`, apiKey: GOOD_KEY }), /answered HTTP 404.*list the model ids by hand/);
  await assert.rejects(discoverModels({ npm, baseURL: undefined, apiKey: GOOD_KEY }), DiscoveryError);
  await assert.rejects(discoverModels({ npm, baseURL: 'http://127.0.0.1:1/v1', apiKey: GOOD_KEY }), /Could not reach/);

  // Google's dialect: "models/<id>" names, token limits, non-chat models filtered out.
  const google = (async () =>
    Response.json({
      models: [
        { name: 'models/gemini-pro', displayName: 'Gemini Pro', inputTokenLimit: 1_000_000, supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding-1', supportedGenerationMethods: ['embedContent'] },
      ],
    })) as typeof fetch;
  assert.deepEqual(await discoverModels({ npm: '@ai-sdk/google', baseURL: undefined, apiKey: 'k', fetchFn: google }), [
    { id: 'gemini-pro', name: 'Gemini Pro', contextLimit: 1_000_000 },
  ]);
  await provider.close();
});

test('registry: stored credentials, app-added providers and per-model API dialects', async () => {
  const catalog = new ModelCatalog({
    gateway: {
      name: 'Gateway',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://gateway.example/v1',
      env: ['GATEWAY_API_KEY'],
      models: {
        'open-model': { name: 'Open', cost: { input: 1, output: 2 } },
        'claude-like': { name: 'Claude-like', provider: { npm: '@ai-sdk/anthropic' } },
        'gpt-like': { name: 'GPT-like', provider: { npm: '@ai-sdk/openai' } },
        'painter': { name: 'Painter', modalities: { input: ['text'], output: ['image'] } },
      },
    },
  });
  const auth = new AuthStore(path.join(tmp, 'registry-auth.json'));
  let extra = {};
  let listed: Record<string, string[]> = {};
  const registry = new ProviderRegistry(catalog, {}, {}, { auth, extra: () => extra, listed: () => listed });

  assert.equal(registry.hasCredentials('gateway'), false);
  await assert.rejects(registry.languageModel(parseModelRef('gateway/open-model')), /No API key for Gateway. Connect "gateway" in the app's settings/);
  auth.set('gateway', 'sk-stored');
  assert.equal(registry.credentialFor('gateway'), 'sk-stored');
  assert.deepEqual(registry.available().map((provider) => provider.id), ['gateway']);

  // One provider, three dialects: each model gets the SDK that speaks its API.
  const open = registry.info(parseModelRef('gateway/open-model'));
  assert.deepEqual({ npm: open.npm, url: open.baseURL, text: open.textOutput }, { npm: '@ai-sdk/openai-compatible', url: 'https://gateway.example/v1', text: true });
  assert.equal(registry.info(parseModelRef('gateway/claude-like')).npm, '@ai-sdk/anthropic');
  assert.equal(registry.info(parseModelRef('gateway/painter')).textOutput, false);
  const viaCompatible = await registry.languageModel(parseModelRef('gateway/open-model'));
  const viaAnthropic = await registry.languageModel(parseModelRef('gateway/claude-like'));
  assert.notEqual((viaCompatible as { provider: string }).provider, (viaAnthropic as { provider: string }).provider);
  await assert.rejects(registry.languageModel(parseModelRef('gateway/gpt-like')), /"@ai-sdk\/openai" \(for gateway\) is not installed/);

  // A provider that exists nowhere but in the app: just a URL and the models it reported.
  await assert.rejects(async () => registry.describe('home-lab'), /Unknown provider "home-lab". Connect it in the app's settings/);
  extra = { 'home-lab': { name: 'Home lab', api: 'http://10.0.0.5:8000/v1', models: { 'llama-big': { limit: { context: 32_000 } } } } };
  const lab = registry.info(parseModelRef('home-lab/llama-big'));
  assert.deepEqual({ npm: lab.npm, url: lab.baseURL, ctx: lab.contextLimit, cost: lab.cost }, { npm: '@ai-sdk/openai-compatible', url: 'http://10.0.0.5:8000/v1', ctx: 32_000, cost: null });
  assert.ok(await registry.languageModel(parseModelRef('home-lab/llama-big')), 'no key needed for a provider without one');
  assert.throws(() => registry.info(parseModelRef('home-lab/unknown')), /Refresh the provider's model list/);

  // The live model list of a connected provider decides what is offered.
  listed = { gateway: ['open-model', 'brand-new'] };
  extra = { ...extra, gateway: { models: { 'brand-new': {} } } };
  const offered = registry.available().find((provider) => provider.id === 'gateway')!.models;
  assert.deepEqual(offered.map((model) => [model.ref.model, model.name, model.cost?.input ?? null]), [['open-model', 'Open', 1], ['brand-new', 'brand-new', null]]);
  assert.deepEqual(registry.catalogProviders(), [{ id: 'gateway', name: 'Gateway', baseURL: 'https://gateway.example/v1' }]);
});

/** Minimal request/response client for the settings and memory screens. */
async function connect(url: string, token: string) {
  const socket = new WebSocket(url);
  const inbox: ServerMessage[] = [];
  let wake: (() => void) | null = null;
  socket.addEventListener('message', (event) => {
    inbox.push(JSON.parse(String(event.data)) as ServerMessage);
    wake?.();
  });
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
  const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
  send({ type: 'hello', role: 'client', token });
  const waitFor = async <T extends ServerMessage>(match: (message: ServerMessage) => message is T, from = 0): Promise<T> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = inbox.slice(from).find(match);
      if (found) return found;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    throw new Error(`timed out; got ${inbox.slice(from).map((reply) => reply.type).join(', ')}`);
  };
  /** Sends a message and returns the first reply of the wanted type that arrives after it. */
  const ask = <T extends ServerMessage['type']>(message: ClientMessage, type: T) => {
    const from = inbox.length;
    send(message);
    return waitFor((reply): reply is Extract<ServerMessage, { type: T }> => reply.type === type, from);
  };
  return { ask, send, waitFor, inbox, close: () => socket.close() };
}

test('connect a provider the opencode way: URL + key -> models fetched, credential created, chat works', async () => {
  const provider = await fakeProvider(['kimi-k3', 'brand-new', 'deepseek-v4-flash']);
  const parts = testCoreParts();
  // The catalog knows "opencode" (with metadata for one model); "home-lab" is the user's own.
  const catalog = new ModelCatalog({
    opencode: {
      name: 'OpenCode',
      npm: '@ai-sdk/openai-compatible',
      api: provider.url,
      env: ['OPENCODE_API_KEY'],
      models: { 'kimi-k3': { name: 'Kimi K3', tool_call: true, cost: { input: 0.6, output: 2.5 } }, 'retired-model': { name: 'Retired' } },
    },
  });
  delete process.env.OPENCODE_API_KEY;
  const server = await startServer({ ...parts.config, token: 'app-token', host: '127.0.0.1', port: 0 }, { settings: parts.settings, catalog });
  const client = await connect(`ws://127.0.0.1:${server.port}/ws`, 'app-token');

  const before = (await client.ask({ type: 'settings-get' }, 'settings')).settings;
  assert.deepEqual({ providers: before.providers, models: before.models, ready: before.ready }, { providers: [], models: [], ready: false });
  assert.deepEqual(before.catalog, [{ id: 'opencode', name: 'OpenCode', baseURL: provider.url }]);

  // A wrong key: nothing is stored.
  const refused = await client.ask({ type: 'provider-connect', id: 'opencode', apiKey: 'sk-wrong' }, 'error');
  assert.match(refused.message, /rejected the API key/);
  assert.equal(server.core.auth.has('opencode'), false);

  // Catalog provider: only the key is needed; the URL comes from the catalog.
  const connected = await client.ask({ type: 'provider-connect', id: 'OpenCode', apiKey: GOOD_KEY }, 'settings');
  assert.ok(!JSON.stringify(connected).includes(GOOD_KEY), 'the key is never sent back');
  assert.deepEqual(connected.settings.providers, [
    { id: 'opencode', name: 'OpenCode', baseURL: provider.url, connected: true, custom: false, models: 3, modelIds: ['brand-new', 'deepseek-v4-flash', 'kimi-k3'] },
  ]);
  assert.deepEqual(
    connected.settings.models.map((model) => model.ref).sort(),
    ['opencode/brand-new', 'opencode/deepseek-v4-flash', 'opencode/kimi-k3'],
    'exactly what the provider listed: no retired catalog model',
  );
  assert.match(connected.settings.models.find((model) => model.ref === 'opencode/kimi-k3')!.label, /Kimi K3 \(\$0\.6\/\$2\.5\)/, 'catalog metadata is kept');
  assert.deepEqual(JSON.parse(fs.readFileSync(parts.config.authPath, 'utf8')), { opencode: { type: 'api', key: GOOD_KEY } });
  assert.deepEqual(provider.requests.at(-1), { path: '/v1/models', authorization: `Bearer ${GOOD_KEY}`, body: '' });

  // A provider of the user's own: id + URL + key.
  const noUrl = await client.ask({ type: 'provider-connect', id: 'home-lab', apiKey: GOOD_KEY }, 'error');
  assert.match(noUrl.message, /not in the catalog: give its API base URL/);
  const custom = await client.ask({ type: 'provider-connect', id: 'home-lab', name: 'Home lab', baseURL: `${provider.url}/`, apiKey: GOOD_KEY }, 'settings');
  assert.deepEqual(custom.settings.providers.find((entry) => entry.id === 'home-lab'), {
    id: 'home-lab',
    name: 'Home lab',
    baseURL: provider.url,
    connected: true,
    custom: true,
    models: 3,
    modelIds: ['brand-new', 'deepseek-v4-flash', 'kimi-k3'],
  });

  // Pick the model for Mimi and talk through the user's URL.
  const mimi = (await client.ask({ type: 'agents-list' }, 'agents')).agents.find((agent) => agent.name === 'mimi')!;
  const edited = await client.ask(
    { type: 'agent-save', renameFrom: 'mimi', agent: { ...mimi, models: { model: 'home-lab/brand-new', vision_model: 'opencode/kimi-k3' } } },
    'agents',
  );
  assert.deepEqual(edited.agents.find((agent) => agent.name === 'mimi')!.models, { model: 'home-lab/brand-new', vision_model: 'opencode/kimi-k3' });
  assert.equal((await client.ask({ type: 'settings-get' }, 'settings')).settings.ready, true);
  const from = client.inbox.length;
  client.send({ type: 'send', text: 'สวัสดี' });
  await client.waitFor((message): message is Extract<ServerMessage, { type: 'event' }> => message.type === 'event' && message.event.type === 'run-finish', from);
  const events = client.inbox.slice(from).flatMap((message) => (message.type === 'event' ? [message.event] : []));
  assert.equal(events.flatMap((event) => (event.type === 'text-delta' ? [event.text] : [])).join(''), 'สวัสดีจาก brand-new');
  const finish = events.find((event) => event.type === 'run-finish')!;
  assert.deepEqual(finish.type === 'run-finish' && [finish.reason, finish.usage.inputTokens, finish.usage.outputTokens], ['stop', 12, 4]);
  const chat = provider.requests.find((request) => request.path === '/v1/chat/completions')!;
  assert.equal(chat.authorization, `Bearer ${GOOD_KEY}`);
  assert.equal((JSON.parse(chat.body) as { model: string }).model, 'brand-new');

  // Refresh keeps the stored credential; manual model ids work when a URL cannot list.
  const refreshed = await client.ask({ type: 'provider-connect', id: 'home-lab' }, 'settings');
  assert.equal(refreshed.settings.providers.find((entry) => entry.id === 'home-lab')!.models, 3);
  const manual = await client.ask({ type: 'provider-connect', id: 'no-list', baseURL: 'http://127.0.0.1:1/v1', models: ['a-model', ' b-model '] }, 'settings');
  assert.deepEqual(manual.settings.models.filter((model) => model.ref.startsWith('no-list/')).map((model) => model.ref), ['no-list/a-model', 'no-list/b-model']);

  // Editing a provider changes its files without touching the credential or the network.
  const updated = await client.ask({ type: 'provider-update', id: 'home-lab', name: 'Home Lab 2', baseURL: 'http://127.0.0.1:9/v1', models: ['brand-new'] }, 'settings');
  assert.deepEqual(updated.settings.providers.find((entry) => entry.id === 'home-lab'), {
    id: 'home-lab',
    name: 'Home Lab 2',
    baseURL: 'http://127.0.0.1:9/v1',
    connected: true,
    custom: true,
    models: 1,
    modelIds: ['brand-new'],
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(parts.root, 'user', 'providers', 'home-lab.json'), 'utf8')), {
    def: {
      name: 'Home Lab 2',
      npm: '@ai-sdk/openai-compatible',
      api: 'http://127.0.0.1:9/v1',
      models: { 'brand-new': { limit: { context: 64_000 } } },
    },
    models: ['brand-new'],
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(parts.config.authPath, 'utf8')), {
    opencode: { type: 'api', key: GOOD_KEY },
    'home-lab': { type: 'api', key: GOOD_KEY },
  }, 'editing keeps the stored key');
  const badUpdate = await client.ask({ type: 'provider-update', id: 'home-lab', baseURL: 'ftp://nope' }, 'error');
  assert.match(badUpdate.message, /http:\/\/ or https:\/\//);

  // Removing a provider deletes its credential and frees the agents that used it.
  const removed = await client.ask({ type: 'provider-remove', id: 'home-lab' }, 'settings');
  assert.equal(removed.settings.providers.some((entry) => entry.id === 'home-lab'), false);
  assert.equal(server.core.auth.has('home-lab'), false);
  assert.equal(removed.settings.ready, false, "Mimi's chat model lost its provider");

  const invalid = await client.ask({ type: 'provider-connect', id: 'Bad Id!', baseURL: provider.url }, 'error');
  assert.match(invalid.message, /Provider id: use lowercase/);
  const unknownModel = await client.ask({ type: 'settings-save', defaults: { model: 'opencode/no-such-model' } }, 'error');
  assert.match(unknownModel.message, /Unknown model "opencode\/no-such-model"/);

  client.close();
  await server.close();
  await provider.close();
  fs.rmSync(parts.root, { recursive: true, force: true });
});

test('settings screen: folders and the Google client can be changed', async () => {
  const parts = testCoreParts();
  const server = await startServer({ ...parts.config, token: 'app-token', host: '127.0.0.1', port: 0 }, parts.coreOptions);
  const client = await connect(`ws://127.0.0.1:${server.port}/ws`, 'app-token');
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  const noClient = await client.ask({ type: 'google-connect' }, 'error');
  assert.match(noClient.message, /Save the Google OAuth client ID and secret first/);

  const workDir = path.join(parts.root, 'my-files');
  const saved = await client.ask(
    { type: 'settings-save', keys: { GOOGLE_OAUTH_CLIENT_ID: 'client-id', GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret' }, allowedDirs: [workDir] },
    'settings',
  );
  assert.ok(!JSON.stringify(saved).includes('client-secret'));
  assert.deepEqual(saved.settings.google, { hasClient: true, connected: false });
  assert.deepEqual(saved.settings.allowedDirs, [workDir]);
  assert.ok(fs.existsSync(workDir));
  assert.deepEqual(server.core.deps.allowedDirs, [workDir], 'tools see the new folder list immediately');

  const zone = await client.ask({ type: 'settings-save', timezone: 'Asia/Singapore' }, 'settings');
  assert.equal(zone.settings.timezone, 'Asia/Singapore');
  assert.equal(typeof server.core.deps.timezone === 'function' ? server.core.deps.timezone() : server.core.deps.timezone, 'Asia/Singapore', 'the agent sees the new zone at once');
  const badZone = await client.ask({ type: 'settings-save', timezone: 'Not/AZone' }, 'error');
  assert.match(badZone.message, /Unknown time zone/);

  client.close();
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  await server.close();
  delete process.env.MIMI_TIMEZONE;
  fs.rmSync(parts.root, { recursive: true, force: true });
});

test('memory screen: list, save, edit and delete through the socket', async () => {
  const parts = testCoreParts();
  const server = await startServer({ ...parts.config, token: 'app-token', host: '127.0.0.1', port: 0 }, parts.coreOptions);
  const client = await connect(`ws://127.0.0.1:${server.port}/ws`, 'app-token');

  assert.deepEqual((await client.ask({ type: 'memory-list' }, 'memory')).entries, []);
  await client.ask({ type: 'memory-save', path: 'profile', content: '- ชื่อ: ต้น' }, 'memory');
  const listed = await client.ask({ type: 'memory-save', path: 'people/nok', description: 'น้องสาว', content: 'เกิด 3 มีนาคม' }, 'memory');
  assert.deepEqual(listed.entries.map((entry) => [entry.path, entry.layer, entry.content]), [['profile', 1, '- ชื่อ: ต้น'], ['people/nok', 2, 'เกิด 3 มีนาคม']]);

  const invalid = await client.ask({ type: 'memory-save', path: 'topics/new', content: 'x' }, 'error');
  assert.match(invalid.message, /needs a one-line description/);

  const afterDelete = await client.ask({ type: 'memory-delete', path: 'people/nok' }, 'memory');
  assert.deepEqual(afterDelete.entries.map((entry) => entry.path), ['profile']);
  assert.equal(server.core.memory.get('profile')!.content, '- ชื่อ: ต้น');

  client.close();
  await server.close();
  fs.rmSync(parts.root, { recursive: true, force: true });
});
