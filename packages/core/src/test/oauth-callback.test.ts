import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { startGoogleOAuth } from '../google/oauth-flow.ts';
import { MicrosoftAuth } from '../microsoft/auth.ts';
import { HostedCallbacks, loopbackReceiver, publicBaseUrl } from '../oauth/callback.ts';
import { startGenericOAuth } from '../oauth/generic-flow.ts';

// A core on a server cannot be reached at 127.0.0.1 from the user's browser, so OAuth
// providers send the browser back to the core's own /oauth/callback instead.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-oauth-cb-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Feeds one browser request to the callbacks and returns what the browser would see. */
function visit(callbacks: HostedCallbacks, href: string): { handled: boolean; status: number; body: string } {
  let status = 0;
  let body = '';
  const response = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(text?: string) {
      body = text ?? '';
    },
  } as unknown as http.ServerResponse;
  const handled = callbacks.handle('GET', new URL(href), response);
  return { handled, status, body };
}

test('public base address: MIMI_PUBLIC_URL, else Railway domain, else none (a computer)', () => {
  assert.equal(publicBaseUrl({}), undefined);
  assert.equal(publicBaseUrl({ RAILWAY_PUBLIC_DOMAIN: 'mimi.up.railway.app' }), 'https://mimi.up.railway.app');
  assert.equal(publicBaseUrl({ MIMI_PUBLIC_URL: 'https://gw.example.com/h/abc/', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' }), 'https://gw.example.com/h/abc');
  assert.throws(() => publicBaseUrl({ MIMI_PUBLIC_URL: 'http://mimi.example.com' }), /https/);
  assert.equal(new HostedCallbacks('https://gw.example.com/h/abc').redirectUri, 'https://gw.example.com/h/abc/oauth/callback');
});

test('hosted callback: Google sign-in finishes on the public address with the code it was sent', async () => {
  const callbacks = new HostedCallbacks('https://mimi.example.com');
  const realFetch = globalThis.fetch;
  let exchanged: URLSearchParams | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    exchanged = init?.body as URLSearchParams;
    return new Response(JSON.stringify({ refresh_token: 'rt-1' }), { status: 200 });
  }) as typeof fetch;
  try {
    const tokenFile = path.join(tmp, 'google.json');
    const flow = await startGoogleOAuth({ clientId: 'cid', clientSecret: 'secret', tokenFile, receiver: callbacks.receiver });
    const sent = new URL(flow.url);
    assert.equal(sent.searchParams.get('redirect_uri'), 'https://mimi.example.com/oauth/callback');
    assert.equal(callbacks.pending(), 1);

    // Another path, or an unknown state, is not this sign-in.
    assert.equal(visit(callbacks, 'https://mimi.example.com/other?code=x').handled, false);
    const stranger = visit(callbacks, 'https://mimi.example.com/oauth/callback?state=guess&code=x');
    assert.equal(stranger.status, 400);
    assert.equal(callbacks.pending(), 1, 'a wrong state does not end the sign-in');

    const ok = visit(callbacks, `https://mimi.example.com/oauth/callback?state=${sent.searchParams.get('state')}&code=the-code`);
    assert.equal(ok.status, 200);
    assert.match(ok.body, /connected to Google/);
    await flow.done;
    assert.equal(exchanged?.get('code'), 'the-code');
    assert.equal(exchanged?.get('redirect_uri'), 'https://mimi.example.com/oauth/callback', 'the exchange repeats the same redirect_uri');
    assert.equal(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).refresh_token, 'rt-1');

    // A link is used once.
    assert.equal(visit(callbacks, `https://mimi.example.com/oauth/callback?state=${sent.searchParams.get('state')}&code=again`).status, 400);
    assert.equal(callbacks.pending(), 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('hosted callback: a refused sign-in reports the reason; Microsoft and connectors use it too', async () => {
  const callbacks = new HostedCallbacks('https://mimi.example.com');
  const microsoft = new MicrosoftAuth({
    credentials: () => ({ clientId: 'ms-client', tenant: 'common' }),
    tokenFile: path.join(tmp, 'ms.json'),
    fetchFn: (async () => new Response(JSON.stringify({ refresh_token: 'ms-rt' }), { status: 200 })) as typeof fetch,
  });
  const msFlow = await microsoft.startSignIn(callbacks.receiver);
  const msState = new URL(msFlow.url).searchParams.get('state');
  assert.equal(new URL(msFlow.url).searchParams.get('redirect_uri'), 'https://mimi.example.com/oauth/callback');
  const refused = visit(callbacks, `https://mimi.example.com/oauth/callback?state=${msState}&error=access_denied&error_description=User%20said%20no`);
  assert.equal(refused.status, 400);
  await assert.rejects(msFlow.done, /Microsoft sign-in was not completed: User said no/);

  const generic = await startGenericOAuth({
    authorizeUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'gc',
    scopes: ['read'],
    fetchFn: (async () => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 })) as typeof fetch,
    receiver: callbacks.receiver,
  });
  const genericState = new URL(generic.url).searchParams.get('state');
  visit(callbacks, `https://mimi.example.com/oauth/callback?state=${genericState}&code=c`);
  assert.equal((await generic.done).accessToken, 'at');
});

test('loopback receiver (a computer): still the temporary local listener', async () => {
  const receiver = await loopbackReceiver('s1', { label: 'Google' });
  assert.match(receiver.redirectUri, /^http:\/\/127\.0\.0\.1:\d+$/);
  const response = await fetch(`${receiver.redirectUri}/?state=s1&code=local-code`);
  assert.equal(response.status, 200);
  assert.equal(await receiver.code, 'local-code');
  const microsoft = await loopbackReceiver('s2', { label: 'Microsoft', host: 'localhost' });
  assert.match(microsoft.redirectUri, /^http:\/\/localhost:\d+$/);
  microsoft.close();
});

test('Microsoft with a client secret (an app under the "Web" platform): the secret goes with the code and with refreshes', async () => {
  const callbacks = new HostedCallbacks('https://mimi.example.com');
  const bodies: URLSearchParams[] = [];
  const microsoft = new MicrosoftAuth({
    credentials: () => ({ clientId: 'ms-client', tenant: 'common', clientSecret: 'ms-secret' }),
    tokenFile: path.join(tmp, 'ms-web.json'),
    fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(new URLSearchParams(String(init?.body ?? '')));
      return Response.json({ refresh_token: 'ms-rt', access_token: 'ms-at', expires_in: 3600 });
    }) as typeof fetch,
  });
  const flow = await microsoft.startSignIn(callbacks.receiver);
  assert.equal(new URL(flow.url).searchParams.get('client_secret'), null, 'the secret never goes into the browser link');
  visit(callbacks, `https://mimi.example.com/oauth/callback?state=${new URL(flow.url).searchParams.get('state')}&code=c`);
  await flow.done;
  assert.equal(bodies[0]?.get('client_secret'), 'ms-secret');
  assert.equal(await microsoft.accessToken(), 'ms-at');
  assert.equal(bodies[1]?.get('grant_type'), 'refresh_token');
  assert.equal(bodies[1]?.get('client_secret'), 'ms-secret');
});
