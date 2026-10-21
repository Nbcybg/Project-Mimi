import fs from 'node:fs';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
];
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface GoogleCredentials {
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** From the environment; takes precedence over the token file. */
  refreshToken: string | undefined;
}

export interface GoogleAuthOptions extends Partial<GoogleCredentials> {
  /** Read on every use, so credentials saved while the core is running take effect. */
  credentials?: () => GoogleCredentials;
  /** Written by `npm run google-auth`. */
  tokenFile: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/** Thrown when the Google account is not connected yet; the message tells the user what to do. */
export class GoogleNotConfiguredError extends Error {
  constructor(missing: string) {
    super(
      `Google is not connected (${missing}). Put GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env, then run: npm run google-auth`,
    );
    this.name = 'GoogleNotConfiguredError';
  }
}

/** Either one auth, or a resolver that picks one per account id (`undefined` = the default account). */
export type GoogleAuthSource = GoogleAuth | ((account?: string) => GoogleAuth);

/** Normalizes the two forms the tool factories accept, so tests can keep passing a single auth. */
export function googleAuthResolver(source: GoogleAuthSource): (account?: string) => GoogleAuth {
  return typeof source === 'function' ? source : () => source;
}

/** Turns the stored refresh token into short-lived access tokens, and calls Google APIs with them. */
export class GoogleAuth {
  private readonly options: GoogleAuthOptions;
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(options: GoogleAuthOptions) {
    this.options = options;
  }

  static fromEnv(env: NodeJS.ProcessEnv, tokenFile: string): GoogleAuth {
    return new GoogleAuth({
      credentials: () => ({
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
      }),
      tokenFile,
    });
  }

  private credentials(): Partial<GoogleCredentials> {
    return this.options.credentials?.() ?? this.options;
  }

  /** Forgets the cached access token, e.g. after the account was (re)connected. */
  reset(): void {
    this.cached = null;
  }

  get hasClient(): boolean {
    const { clientId, clientSecret } = this.credentials();
    return Boolean(clientId && clientSecret);
  }

  private refreshToken(): string | undefined {
    const fromEnv = this.credentials().refreshToken;
    if (fromEnv) return fromEnv;
    try {
      const stored = JSON.parse(fs.readFileSync(this.options.tokenFile, 'utf8')) as { refresh_token?: string };
      return stored.refresh_token;
    } catch {
      return undefined;
    }
  }

  get isConfigured(): boolean {
    return this.hasClient && Boolean(this.refreshToken());
  }

  async accessToken(): Promise<string> {
    const now = this.options.now?.() ?? Date.now();
    if (this.cached && this.cached.expiresAt > now + 60_000) return this.cached.token;

    const { clientId, clientSecret } = this.credentials();
    if (!clientId || !clientSecret) throw new GoogleNotConfiguredError('client id/secret missing');
    const refreshToken = this.refreshToken();
    if (!refreshToken) throw new GoogleNotConfiguredError('no refresh token');

    const response = await (this.options.fetchFn ?? fetch)(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const body = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!response.ok || !body.access_token) {
      throw new Error(`Google token refresh failed: ${body.error_description ?? body.error ?? response.status}. Run "npm run google-auth" again.`);
    }
    this.cached = { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
    return this.cached.token;
  }

  /** Calls a Google REST endpoint and returns the parsed JSON body. */
  async request<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await (this.options.fetchFn ?? fetch)(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
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
      throw new Error(`Google API error ${response.status}: ${detail}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
