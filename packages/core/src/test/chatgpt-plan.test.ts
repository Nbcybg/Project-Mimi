import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ChatGptPlan } from '../providers/chatgpt-plan.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-chatgpt-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const ISSUER = 'https://auth.openai.com';
const CLIENT = 'oaiapp_test';

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signing = `${part({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${part(claims)}`;
  return `${signing}.${createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url')}`;
}

interface Call {
  url: string;
  body: URLSearchParams;
}

/** OpenAI, as far as sign-in goes: JWKS, token and revoke endpoints. */
function fakeOpenAI(options: { scope?: string; nonce?: (sent: string) => string; refresh?: 'ok' | 'invalid_grant' } = {}) {
  const calls: Call[] = [];
  let lastNonce = '';
  let issued = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [JWK] });
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url, body });
    if (url.endsWith('/oauth/revoke')) return new Response('{}');
    if (body.get('grant_type') === 'refresh_token') {
      if (options.refresh === 'invalid_grant') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      issued++;
      return Response.json({ access_token: `access-r${issued}`, refresh_token: `refresh-r${issued}`, expires_in: 3600 });
    }
    const idToken = jwt({
      iss: ISSUER,
      aud: CLIENT,
      sub: 'user-1',
      email: 'me@example.com',
      exp: Math.floor(Date.now() / 1000) + 600,
      nonce: options.nonce ? options.nonce(lastNonce) : lastNonce,
    });
    return Response.json({
      access_token: 'access-1',
      id_token: idToken,
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: options.scope ?? 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    });
  }) as typeof fetch;
  return {
    calls,
    fetchFn,
    /** What the browser does after the user approves: land on the loopback redirect. */
    async approve(authUrl: string, extra: Record<string, string> = { client_id: CLIENT }) {
      const params = new URL(authUrl).searchParams;
      lastNonce = params.get('nonce')!;
      const back = new URL(params.get('redirect_uri')!);
      back.searchParams.set('code', 'code-1');
      back.searchParams.set('state', params.get('state')!);
      for (const [key, value] of Object.entries(extra)) back.searchParams.set(key, value);
      return fetch(back);
    },
  };
}

const file = (name: string) => path.join(tmp, name);

test('first sign-in registers the app, checks the tokens and keeps them in a private file', async () => {
  const openai = fakeOpenAI();
  const plan = new ChatGptPlan(file('first.json'), { fetchFn: openai.fetchFn });
  const { url, done } = await plan.start();

  const params = new URL(url).searchParams;
  assert.equal(new URL(url).origin + new URL(url).pathname, 'https://auth.openai.com/api/accounts/authorize');
  assert.equal(params.get('client_id'), 'dynamic_agent_client');
  assert.equal(params.get('agent_name_hint'), 'Mimi');
  assert.match(params.get('ext_agent_host_id')!, /^urn:uuid:/);
  assert.equal(params.get('resource'), 'https://api.openai.com/v1');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.ok(params.get('scope')!.includes('chatgpt.tokens.use.direct'));
  assert.match(params.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

  await openai.approve(url);
  await done;

  const exchange = openai.calls.find((call) => call.body.get('grant_type') === 'authorization_code')!;
  assert.equal(exchange.body.get('client_id'), CLIENT, 'the issued id replaces the registration id');
  assert.equal(exchange.body.get('code'), 'code-1');
  assert.ok(exchange.body.get('code_verifier'));
  assert.equal(exchange.body.get('resource'), 'https://api.openai.com/v1');
  assert.equal(plan.connected, true);
  assert.equal(plan.email, 'me@example.com');
  assert.equal(await plan.accessToken(), 'access-1');

  // A new process picks the account up, and the host id stays the same.
  const again = new ChatGptPlan(file('first.json'), { fetchFn: openai.fetchFn });
  assert.equal(again.connected, true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file('first.json')).mode & 0o777, 0o600);
});

test('a returning sign-in reuses the issued client id and hints the account', async () => {
  const openai = fakeOpenAI();
  const first = new ChatGptPlan(file('return.json'), { fetchFn: openai.fetchFn });
  const one = await first.start();
  await openai.approve(one.url);
  await one.done;

  const second = new ChatGptPlan(file('return.json'), { fetchFn: openai.fetchFn });
  const two = await second.start();
  const params = new URL(two.url).searchParams;
  assert.equal(params.get('client_id'), CLIENT);
  assert.equal(params.get('login_hint'), 'me@example.com');
  assert.ok(params.get('id_token_hint'));
  assert.equal(params.has('agent_name_hint'), false);
  await openai.approve(two.url, {});
  await two.done;
});

test('sign-in is refused without plan usage, with a wrong nonce, or after a state mismatch', async () => {
  const noScope = fakeOpenAI({ scope: 'openid profile email offline_access' });
  const a = await new ChatGptPlan(file('a.json'), { fetchFn: noScope.fetchFn }).start();
  await noScope.approve(a.url);
  await assert.rejects(a.done, /plan usage was not granted/);

  const badNonce = fakeOpenAI({ nonce: () => 'someone-else' });
  const b = await new ChatGptPlan(file('b.json'), { fetchFn: badNonce.fetchFn }).start();
  await badNonce.approve(b.url);
  await assert.rejects(b.done, /does not match this sign-in/);

  const openai = fakeOpenAI();
  const c = await new ChatGptPlan(file('c.json'), { fetchFn: openai.fetchFn }).start();
  const redirect = new URL(c.url).searchParams.get('redirect_uri')!;
  const response = await fetch(`${redirect}?code=x&state=wrong`);
  assert.equal(response.status, 400);
  const denied = await openai.approve(c.url, { client_id: CLIENT, error: 'access_denied' });
  assert.equal(denied.status, 400);
  await assert.rejects(c.done, /not completed/);
  assert.equal(openai.calls.some((call) => call.body.get('grant_type') === 'authorization_code'), false, 'no code is exchanged after a denial');
});

test('the token is refreshed shortly before it expires, once, and the rotated refresh token is kept', async () => {
  const openai = fakeOpenAI();
  let clock = Date.now();
  const plan = new ChatGptPlan(file('refresh.json'), { fetchFn: openai.fetchFn, now: () => clock });
  const flow = await plan.start();
  await openai.approve(flow.url);
  await flow.done;

  assert.equal(await plan.accessToken(), 'access-1');
  clock += 3600_000 - 30_000; // inside the safety margin
  const [one, two] = await Promise.all([plan.accessToken(), plan.accessToken()]);
  assert.equal(one, 'access-r1');
  assert.equal(two, 'access-r1');
  assert.equal(openai.calls.filter((call) => call.body.get('grant_type') === 'refresh_token').length, 1);
  clock += 3600_000;
  assert.equal(await plan.accessToken(), 'access-r2');
  assert.equal(openai.calls.filter((call) => call.body.get('grant_type') === 'refresh_token').at(-1)!.body.get('refresh_token'), 'refresh-r1');
});

test('a revoked sign-in asks the user to connect again; disconnect revokes and forgets', async () => {
  const openai = fakeOpenAI({ refresh: 'invalid_grant' });
  let clock = Date.now();
  const plan = new ChatGptPlan(file('revoked.json'), { fetchFn: openai.fetchFn, now: () => clock });
  const flow = await plan.start();
  await openai.approve(flow.url);
  await flow.done;
  clock += 7200_000;
  await assert.rejects(plan.accessToken(), /expired or was revoked/);

  await plan.disconnect();
  assert.equal(plan.connected, false);
  assert.ok(openai.calls.some((call) => call.url.endsWith('/oauth/revoke')));
  await assert.rejects(plan.accessToken(), /not connected/);
});

test('authFetch signs the call and turns storing off on Responses requests', async () => {
  const openai = fakeOpenAI();
  const plan = new ChatGptPlan(file('fetch.json'), { fetchFn: openai.fetchFn });
  const flow = await plan.start();
  await openai.approve(flow.url);
  await flow.done;

  const original = globalThis.fetch;
  let seen: { url: string; headers: Headers; body: unknown } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    return new Response('{}');
  }) as typeof fetch;
  try {
    await plan.authFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-x', input: [], stream: true, store: true }),
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen?.headers.get('authorization'), 'Bearer access-1');
  assert.equal((seen?.body as { store: boolean }).store, false);
  assert.equal((seen?.body as { stream: boolean }).stream, true);
});

test('the chatgpt-plan provider builds Responses models that go through the plan\'s signing fetch', async () => {
  const { ModelCatalog } = await import('../providers/catalog.ts');
  const { ProviderRegistry } = await import('../providers/registry.ts');
  const plan = new ChatGptPlan(file('registry.json'), { fetchFn: fakeOpenAI().fetchFn });
  const registry = new ProviderRegistry(new ModelCatalog({}), {}, {}, {
    chatgptPlan: plan,
    extra: () => ({ 'chatgpt-plan': { name: 'ChatGPT (plan)', npm: '@ai-sdk/openai', models: { 'gpt-x': { name: 'GPT X' } } } }),
    listed: () => ({ 'chatgpt-plan': ['gpt-x'] }),
  });
  assert.deepEqual(registry.available().map((entry) => entry.id), ['chatgpt-plan']);
  const model = (await registry.languageModel({ provider: 'chatgpt-plan', model: 'gpt-x' })) as { provider: string };
  assert.equal(model.provider, 'chatgpt-plan.responses');
});
