import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/**
 * Uses the user's ChatGPT plan through OpenAI's "Sign in with ChatGPT" for open-source and
 * locally run apps: OAuth with PKCE on a loopback port, then the public Responses API with
 * the access token as bearer. OpenAI registers the app during the first sign-in. A Mimi
 * served from a public address is not covered by that program, so the server refuses there.
 */
export const CHATGPT_PLAN_ID = 'chatgpt-plan';
export const CHATGPT_PLAN_API = 'https://api.openai.com/v1';
export const CHATGPT_PLAN_NPM = '@ai-sdk/openai';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const AGENT_NAME = 'Mimi';
const CALLBACK_PATH = '/auth/callback';
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 60_000;

interface Account {
  email?: string;
  subject: string;
  /** The id OpenAI issued to this app for this ChatGPT account at the first sign-in. */
  clientId: string;
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
  savedAt: number;
}

interface Stored {
  /** Stable, opaque id of this machine; chosen before the first sign-in and never personal data. */
  hostId: string;
  account?: Account;
}

export interface ChatGptPlanOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function scopesOf(token: TokenResponse): string[] {
  if (typeof token.scope === 'string') return token.scope.split(/\s+/).filter(Boolean);
  // Some servers only put the grant in the access token.
  try {
    const claims = decodePart(token.access_token?.split('.')[1] ?? '');
    const value = claims.scope ?? claims.scp;
    if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  } catch {
    // not a JWT
  }
  return [];
}

export class ChatGptPlan {
  private readonly file: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private stored: Stored;
  private refreshing: Promise<string> | undefined;

  constructor(file: string, options: ChatGptPlanOptions = {}) {
    this.file = file;
    this.fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? FLOW_TIMEOUT_MS;
    this.stored = this.load();
  }

  private load(): Stored {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Stored>;
      if (typeof raw.hostId === 'string' && raw.hostId) {
        return { hostId: raw.hostId, ...(raw.account?.accessToken ? { account: raw.account } : {}) };
      }
    } catch {
      // first use
    }
    return { hostId: `urn:uuid:${randomUUID()}` };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.stored, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  get connected(): boolean {
    return this.stored.account !== undefined;
  }

  get email(): string | undefined {
    return this.stored.account?.email;
  }

  /**
   * Starts the sign-in: the user opens `url`; `done` resolves once the tokens are checked
   * and saved. The first sign-in registers this app with OpenAI, later ones reuse its id.
   */
  async start(): Promise<{ url: string; done: Promise<void> }> {
    const known = this.stored.account;
    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const verifier = randomBytes(32).toString('base64url');

    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}${CALLBACK_PATH}`;

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: known?.clientId ?? DYNAMIC_CLIENT,
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: CHATGPT_PLAN_API,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    if (known) {
      params.set('id_token_hint', known.idToken);
      if (known.email) params.set('login_hint', known.email);
    } else {
      params.set('agent_name_hint', AGENT_NAME);
      params.set('ext_agent_host_id', this.stored.hostId);
    }

    const callback = new Promise<{ code: string; clientId: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ChatGPT sign-in timed out')), this.timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        server.close();
      };
      server.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', redirectUri);
        const reply = (status: number, text: string) => {
          response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          response.end(text);
        };
        if (url.pathname !== CALLBACK_PATH) return reply(404, 'Not found.');
        if (url.searchParams.get('state') !== state) return reply(400, 'State mismatch. Start again.');
        finish();
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        if (error || !code) {
          const reason = (url.searchParams.get('error_description') ?? error ?? 'no code').split('\n')[0]!;
          reply(400, `Sign-in was not completed: ${reason}`);
          return reject(new Error(`ChatGPT sign-in was not completed: ${reason}`));
        }
        reply(200, 'Mimi is connected to ChatGPT. You can close this tab.');
        resolve({ code, clientId: url.searchParams.get('client_id') });
      });
    });
    callback.catch(() => {});

    const done = callback
      .then(async ({ code, clientId: issued }) => {
        // Registration hands back the id to use from now on; a returning sign-in must not change it.
        const clientId = known ? known.clientId : issued;
        if (!clientId || clientId === DYNAMIC_CLIENT) throw new Error('OpenAI did not issue a client id for Mimi.');
        if (known && issued && issued !== known.clientId) throw new Error('OpenAI answered for a different client id; sign in again.');
        const token = await this.tokenRequest({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource: CHATGPT_PLAN_API,
        });
        await this.accept(token, clientId, nonce, known);
      })
      .finally(() => server.close());
    done.catch(() => {});
    return { url: `${AUTHORIZE_URL}?${params}`, done };
  }

  private async tokenRequest(fields: Record<string, string>): Promise<TokenResponse> {
    const response = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
    const token = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok || !token.access_token) {
      const reason = token.error_description ?? token.error ?? String(response.status);
      const error = new Error(`ChatGPT sign-in failed: ${reason}`);
      (error as Error & { code?: string }).code = token.error;
      throw error;
    }
    return token;
  }

  private async accept(token: TokenResponse, clientId: string, nonce: string, previous: Account | undefined): Promise<void> {
    const scopes = scopesOf(token);
    if (!scopes.includes(PLAN_SCOPE)) {
      throw new Error('ChatGPT plan usage was not granted. Sign in again and allow Mimi to use your ChatGPT plan.');
    }
    if (!token.id_token) throw new Error('OpenAI did not return an identity token.');
    const claims = await this.verifyIdToken(token.id_token, clientId, nonce);
    if (previous && previous.subject !== claims.sub) {
      throw new Error('That is a different ChatGPT account. Disconnect the current one first.');
    }
    this.stored.account = {
      subject: claims.sub,
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
      clientId,
      idToken: token.id_token,
      accessToken: token.access_token!,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      expiresAt: this.now() + (token.expires_in ?? 3600) * 1000,
      scopes,
      savedAt: this.now(),
    };
    this.save();
  }

  /** Checks signature, issuer, audience, expiry and nonce of the identity token. */
  private async verifyIdToken(jwt: string, clientId: string, nonce: string): Promise<{ sub: string; email?: unknown }> {
    const [head, body, signature] = jwt.split('.');
    if (!head || !body || !signature) throw new Error('The identity token is malformed.');
    const header = decodePart(head);
    if (header.alg !== 'RS256') throw new Error('The identity token uses an unexpected algorithm.');
    const response = await this.fetchFn(JWKS_URL);
    const keys = ((await response.json()) as { keys?: Array<Record<string, unknown>> }).keys ?? [];
    const jwk = keys.find((key) => key.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
    if (!jwk) throw new Error('The identity token was signed with an unknown key.');
    const valid = verify(
      'RSA-SHA256',
      Buffer.from(`${head}.${body}`),
      createPublicKey({ key: jwk as never, format: 'jwk' }),
      Buffer.from(signature, 'base64url'),
    );
    if (!valid) throw new Error('The identity token signature is not valid.');
    const claims = decodePart(body);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== ISSUER) throw new Error('The identity token is from an unexpected issuer.');
    if (!audience.includes(clientId)) throw new Error('The identity token is for another app.');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < this.now()) throw new Error('The identity token has expired.');
    if (claims.nonce !== nonce) throw new Error('The identity token does not match this sign-in.');
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('The identity token has no subject.');
    return { sub: claims.sub, email: claims.email };
  }

  /** A bearer token that is valid now; refreshes (and stores the rotated refresh token) when it is about to expire. */
  accessToken(): Promise<string> {
    const account = this.stored.account;
    if (!account) return Promise.reject(new Error('ChatGPT is not connected. Connect it in the app\'s settings.'));
    if (account.expiresAt - REFRESH_MARGIN_MS > this.now()) return Promise.resolve(account.accessToken);
    this.refreshing ??= this.refresh(account).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refresh(account: Account): Promise<string> {
    if (!account.refreshToken) throw new Error('The ChatGPT sign-in expired. Connect it again in the app\'s settings.');
    let token: TokenResponse;
    try {
      token = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: account.refreshToken,
        client_id: account.clientId,
        resource: CHATGPT_PLAN_API,
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'invalid_grant') {
        throw new Error('The ChatGPT sign-in expired or was revoked. Connect it again in the app\'s settings.');
      }
      throw error;
    }
    const scopes = scopesOf(token);
    this.stored.account = {
      ...account,
      accessToken: token.access_token!,
      refreshToken: token.refresh_token ?? account.refreshToken,
      expiresAt: this.now() + (token.expires_in ?? 3600) * 1000,
      scopes: scopes.length > 0 ? scopes : account.scopes,
      ...(token.id_token ? { idToken: token.id_token } : {}),
      savedAt: this.now(),
    };
    this.save();
    return token.access_token!;
  }

  /** The models this account may use, in the server's order. */
  async listModels(): Promise<Array<{ id: string; name: string }>> {
    const response = await this.fetchFn(`${CHATGPT_PLAN_API}/models`, {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    });
    if (!response.ok) throw new Error(`Could not list ChatGPT plan models (${response.status}).`);
    const body = (await response.json()) as { models?: Array<{ slug?: string; display_name?: string; visibility?: string }> };
    return (body.models ?? [])
      .filter((model) => model.visibility === 'list' && model.slug)
      .map((model) => ({ id: model.slug!, name: model.display_name || model.slug! }));
  }

  /**
   * `fetch` for the OpenAI SDK: signs each call with a fresh token, and sets `store: false`
   * on Responses requests, which the program requires.
   */
  readonly authFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${await this.accessToken()}`);
    let body = init?.body;
    if (typeof body === 'string' && String(input instanceof Request ? input.url : input).endsWith('/responses')) {
      try {
        body = JSON.stringify({ ...(JSON.parse(body) as object), store: false });
      } catch {
        // not JSON: leave it
      }
    }
    return globalThis.fetch(input, { ...init, headers, body });
  };

  /** Forgets the account (keeping this machine's id) and tells OpenAI, best effort. */
  async disconnect(): Promise<void> {
    const account = this.stored.account;
    if (!account) return;
    delete this.stored.account;
    this.save();
    const token = account.refreshToken ?? account.accessToken;
    await this.fetchFn(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: account.clientId }),
    }).catch(() => {});
  }
}
