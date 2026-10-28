import { createHash, randomBytes } from 'node:crypto';
import { loopbackReceiver, type ReceiverFactory } from './callback.ts';

export interface GenericOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
}

export interface GenericOAuthOptions {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** Extra provider parameters, e.g. `{ audience: '...', pkce: true }`. */
  extra?: Record<string, unknown>;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Where the provider sends the code back; a temporary local port when not given. */
  receiver?: ReceiverFactory;
}

export interface GenericOAuthFlow {
  /** The provider page the user opens; the callback lands on a temporary local port or the core's public callback. */
  url: string;
  done: Promise<GenericOAuthTokens>;
}

const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

function stringParams(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number') out[key] = String(item);
  }
  return out;
}

function challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface OAuthCallbackOptions {
  tokenUrl: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  codeVerifier?: string;
  extra?: Record<string, unknown>;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/** Exchanges an authorization code for tokens; used by the loopback flow and fixed callbacks. */
export async function handleOAuthCallback(options: OAuthCallbackOptions): Promise<GenericOAuthTokens> {
  const fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
  });
  if (options.clientSecret) body.set('client_secret', options.clientSecret);
  if (options.codeVerifier) body.set('code_verifier', options.codeVerifier);
  for (const [key, item] of Object.entries(stringParams(options.extra))) {
    if (!body.has(key)) body.set(key, item);
  }
  const response = await fetchFn(options.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const token = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !token.access_token) {
    throw new Error(
      `Connector sign-in failed: ${token.error_description ?? token.error ?? response.status}`,
    );
  }
  return {
    accessToken: token.access_token,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    ...(token.expires_in ? { expiresAt: now() + token.expires_in * 1000 } : {}),
  };
}

/**
 * Generic OAuth2 authorization-code flow for native connectors. The user opens the
 * returned URL; the provider redirects to a temporary 127.0.0.1 listener. PKCE is
 * enabled with `extra.pkce`, and provider-specific authorize/token parameters can be
 * supplied in `extra.authorizeParams` / `extra.tokenParams`.
 */
export async function startGenericOAuth(options: GenericOAuthOptions): Promise<GenericOAuthFlow> {
  const fetchFn = options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? FLOW_TIMEOUT_MS;
  const state = randomBytes(16).toString('hex');
  const pkce = options.extra?.pkce === true;
  const verifier = pkce ? randomBytes(32).toString('base64url') : undefined;

  const receiver = await (options.receiver ?? loopbackReceiver)(state, { label: 'Connector', path: '/callback', timeoutMs });
  const { redirectUri } = receiver;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: redirectUri,
    state,
  });
  if (options.scopes.length > 0) params.set('scope', options.scopes.join(' '));
  if (verifier) {
    params.set('code_challenge', challenge(verifier));
    params.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(stringParams(options.extra?.authorizeParams))) {
    if (!params.has(key)) params.set(key, value);
  }
  const url = `${options.authorizeUrl}${options.authorizeUrl.includes('?') ? '&' : '?'}${params}`;

  const done = receiver.code
    .then((value) =>
      handleOAuthCallback({
        tokenUrl: options.tokenUrl,
        code: value,
        redirectUri,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        codeVerifier: verifier,
        extra: options.extra?.tokenParams as Record<string, unknown> | undefined,
        fetchFn,
        now,
      }),
    )
    .finally(() => receiver.close());

  return { url, done };
}
