import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loopbackReceiver, type ReceiverFactory } from '../oauth/callback.ts';

/** Outlook mail, Outlook calendar, Microsoft To Do and OneDrive, plus offline access so the sign-in lasts. */
export const MICROSOFT_SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.ReadWrite',
  'Tasks.ReadWrite',
  'Files.Read',
];
export const GRAPH = 'https://graph.microsoft.com/v1.0';
const authority = (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;

export interface MicrosoftCredentials {
  /** "Application (client) ID" of the app the user registered in Azure / Entra. */
  clientId: string | undefined;
  /** `common` works for personal and work accounts; a tenant id restricts it to one organization. */
  tenant: string;
  /**
   * Only for an app whose redirect URI is under the "Web" platform (a confidential client,
   * e.g. one made for n8n): Microsoft then requires the secret at every token request.
   * Without one the app signs in as a public client ("Mobile and desktop applications").
   */
  clientSecret?: string;
}

export interface MicrosoftAuthOptions {
  /** Read on every use, so a client id saved while the core is running takes effect. */
  credentials: () => MicrosoftCredentials;
  tokenFile: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export class MicrosoftNotConfiguredError extends Error {
  constructor(missing: string) {
    super(
      `Microsoft is not connected (${missing}). In the app, open Settings, enter the client ID of your Azure app and press "Connect Microsoft".`,
    );
    this.name = 'MicrosoftNotConfiguredError';
  }
}

/** Either one auth, or a resolver that picks one per account id (`undefined` = the default account). */
export type MicrosoftAuthSource = MicrosoftAuth | ((account?: string) => MicrosoftAuth);

/** Normalizes the two forms the tool factories accept, so tests can keep passing a single auth. */
export function microsoftAuthResolver(source: MicrosoftAuthSource): (account?: string) => MicrosoftAuth {
  return typeof source === 'function' ? source : () => source;
}

/**
 * Signs in to Microsoft as a public client (no secret: the app runs on the user's own
 * machine), or with the client secret when one is saved, and calls Microsoft Graph. Microsoft replaces the refresh token on every
 * refresh, so the newest one is written back to the token file each time.
 */
export class MicrosoftAuth {
  private readonly options: MicrosoftAuthOptions;
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(options: MicrosoftAuthOptions) {
    this.options = options;
  }

  static fromEnv(env: NodeJS.ProcessEnv, tokenFile: string): MicrosoftAuth {
    return new MicrosoftAuth({
      credentials: () => ({
        clientId: env.MICROSOFT_CLIENT_ID,
        tenant: env.MICROSOFT_TENANT || 'common',
        clientSecret: env.MICROSOFT_CLIENT_SECRET || undefined,
      }),
      tokenFile,
    });
  }

  reset(): void {
    this.cached = null;
  }

  get hasClient(): boolean {
    return Boolean(this.options.credentials().clientId);
  }

  private refreshToken(): string | undefined {
    try {
      return (JSON.parse(fs.readFileSync(this.options.tokenFile, 'utf8')) as { refresh_token?: string }).refresh_token;
    } catch {
      return undefined;
    }
  }

  private storeRefreshToken(refreshToken: string): void {
    fs.mkdirSync(path.dirname(this.options.tokenFile), { recursive: true });
    fs.writeFileSync(this.options.tokenFile, JSON.stringify({ refresh_token: refreshToken }, null, 2), { mode: 0o600 });
  }

  get isConfigured(): boolean {
    return this.hasClient && Boolean(this.refreshToken());
  }

  async accessToken(): Promise<string> {
    const now = this.options.now?.() ?? Date.now();
    if (this.cached && this.cached.expiresAt > now + 60_000) return this.cached.token;
    const { clientId, tenant, clientSecret } = this.options.credentials();
    if (!clientId) throw new MicrosoftNotConfiguredError('no client ID');
    const refreshToken = this.refreshToken();
    if (!refreshToken) throw new MicrosoftNotConfiguredError('not signed in');

    const response = await (this.options.fetchFn ?? fetch)(`${authority(tenant)}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: MICROSOFT_SCOPES.join(' '),
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      }),
    });
    const body = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error_description?: string;
      error?: string;
    };
    if (!response.ok || !body.access_token) {
      throw new Error(
        `Microsoft sign-in has expired or was revoked (${(body.error_description ?? body.error ?? String(response.status)).split('\n')[0]}). Connect Microsoft again in Settings.`,
      );
    }
    if (body.refresh_token && body.refresh_token !== refreshToken) this.storeRefreshToken(body.refresh_token);
    this.cached = { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
    return this.cached.token;
  }

  /** Calls a Microsoft Graph endpoint (a path under v1.0) and returns the parsed JSON body. */
  async request<T>(
    pathAndQuery: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const response = await (this.options.fetchFn ?? fetch)(`${GRAPH}${pathAndQuery}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text.slice(0, 300);
      try {
        detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
      } catch {
        // keep the raw text
      }
      throw new Error(`Microsoft Graph error ${response.status}: ${detail}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * Starts the sign-in: the user opens `url`, Microsoft redirects back with a code, and the
   * code is exchanged (with PKCE) for a refresh token. On a computer the redirect goes to a
   * temporary listener on localhost (the Azure app needs `http://localhost` under "Mobile and
   * desktop applications"); a core on a server passes its own `receiver`, and the Azure app
   * needs that public `/oauth/callback` address under the same platform, or under "Web"
   * when the account has a client secret.
   */
  async startSignIn(receiverFactory: ReceiverFactory = loopbackReceiver): Promise<{ url: string; done: Promise<void> }> {
    const { clientId, tenant, clientSecret } = this.options.credentials();
    if (!clientId) throw new MicrosoftNotConfiguredError('no client ID');
    const state = randomBytes(16).toString('hex');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const receiver = await receiverFactory(state, { label: 'Microsoft', host: 'localhost' });
    const { redirectUri } = receiver;

    const url = `${authority(tenant)}/authorize?${new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: MICROSOFT_SCOPES.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    })}`;

    const done = receiver.code
      .then(async (value) => {
        const response = await (this.options.fetchFn ?? fetch)(`${authority(tenant)}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            code: value,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: verifier,
            scope: MICROSOFT_SCOPES.join(' '),
            ...(clientSecret ? { client_secret: clientSecret } : {}),
          }),
        });
        const token = (await response.json()) as { refresh_token?: string; error_description?: string; error?: string };
        if (!response.ok || !token.refresh_token) {
          throw new Error(
            `Microsoft did not return a refresh token: ${(token.error_description ?? token.error ?? String(response.status)).split('\n')[0]}`,
          );
        }
        this.storeRefreshToken(token.refresh_token);
        this.reset();
      })
      .finally(() => receiver.close());
    done.catch(() => {}); // callers decide whether to await it
    return { url, done };
  }
}
