import { createHash, randomBytes } from 'node:crypto';
import { loopbackReceiver, type ReceiverFactory } from '../oauth/callback.ts';

/**
 * "รายเดือน" logins: the user's existing subscription (Claude Pro/Max, ChatGPT plan,
 * a Google account's free Gemini credits) instead of an API key, like opencode's
 * Claude Code / Codex logins. Each preset knows where to send the browser and how the
 * provider expects the token exchange. Third parties move their endpoints; a preset
 * that stops working just fails its login instead of breaking anything else.
 */

export interface SubscriptionPreset {
  id: string;
  label: string;
  hint: string;
  /** The provider id the credential is stored under, and the model refs use. */
  providerId: string;
  npm: string;
  /** Base URL model calls go to. */
  api: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  /**
   * `paste`: the provider shows the code on a web page (no redirect to us); the user
   * pastes it back. `loopback`: the provider redirects to a local port with the code.
   */
  codeStyle: 'paste' | 'loopback';
  /** Send the token exchange as form-encoded (default) or JSON. */
  exchangeJson?: boolean;
  /** Extra headers on every model call (beta flags, app markers). */
  headers?: Record<string, string>;
  /** Known model ids, shown while the provider's own list is unreachable. */
  fallbackModels: string[];
  /** Where the provider lists its models (`GET` with the bearer token). */
  modelsUrl?: string;
  /** For `paste`: the fixed redirect the provider is registered with. */
  redirectUri?: string;
}

export const SUBSCRIPTION_PRESETS: SubscriptionPreset[] = [
  {
    id: 'claude',
    label: 'Claude Pro / Max',
    hint: 'ใช้เครดิตของแพ็กเกจรายเดือน Claude (ไม่มีค่า API เพิ่ม)',
    providerId: 'claude-subscription',
    npm: '@ai-sdk/anthropic',
    api: 'https://api.anthropic.com',
    authorizeUrl: 'https://console.anthropic.com/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    scopes: ['user:inference'],
    codeStyle: 'paste',
    exchangeJson: true,
    headers: { 'anthropic-beta': 'oauth-2025-04-20', 'x-app': 'cli' },
    fallbackModels: ['claude-opus-4-1-20250805', 'claude-sonnet-4-1-20250908', 'claude-haiku-4-5-20251001', 'claude-opus-4-5-20250929', 'claude-sonnet-4-5-20250929'],
    modelsUrl: 'https://api.anthropic.com/v1/models',
    redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT Plus / Pro (Codex)',
    hint: 'ใช้ credit ของแพ็กเกจ ChatGPT (ทดลอง: OpenAI เปลี่ยนจุดต่อได้)',
    providerId: 'chatgpt-subscription',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://chatgpt.com/backend-api/codex',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    scopes: ['openid', 'profile'],
    codeStyle: 'loopback',
    headers: { originator: 'mimi' },
    fallbackModels: ['gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5.1'],
    modelsUrl: 'https://chatgpt.com/backend-api/codex/models',
  },
  {
    id: 'gemini',
    label: 'บัญชี Google (Gemini)',
    hint: 'ใช้ credit ฟรีของบัญชี Google — เชื่อมต่อ Google แล้วเลือกได้ทันที',
    providerId: 'gemini-subscription',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authorizeUrl: '',
    tokenUrl: '',
    clientId: '',
    scopes: [],
    codeStyle: 'loopback',
    fallbackModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
  },
];

export const subscriptionOf = (id: string) => SUBSCRIPTION_PRESETS.find((preset) => preset.id === id);

export interface SubscriptionFlow {
  preset: SubscriptionPreset;
  /** The URL the user opens in the browser. */
  url: string;
  /** PKCE verifier; needed to exchange the code. */
  verifier: string;
  /** Loopback style: the promise of the redirected code; close() aborts it. */
  code?: Promise<string>;
  close(): void;
}

const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** Starts the browser part of a subscription login. */
export async function startSubscriptionFlow(preset: SubscriptionPreset, receiver: ReceiverFactory = loopbackReceiver): Promise<SubscriptionFlow> {
  const verifier = randomBytes(32).toString('base64url');
  if (preset.codeStyle === 'paste') {
    const params = new URLSearchParams({
      code: 'true',
      client_id: preset.clientId,
      response_type: 'code',
      redirect_uri: preset.redirectUri ?? 'http://localhost/callback',
      scope: preset.scopes.join(' '),
      code_challenge: challenge(verifier),
      code_challenge_method: 'S256',
      state: verifier,
    });
    return { preset, url: `${preset.authorizeUrl}?${params}`, verifier, close: () => {} };
  }
  const state = randomBytes(16).toString('hex');
  const receiverInstance = await receiver(state, { label: preset.label, path: '/callback', timeoutMs: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: preset.clientId,
    redirect_uri: receiverInstance.redirectUri,
    state,
    code_challenge: challenge(verifier),
    code_challenge_method: 'S256',
  });
  if (preset.scopes.length > 0) params.set('scope', preset.scopes.join(' '));
  return {
    preset,
    url: `${preset.authorizeUrl}?${params}`,
    verifier,
    code: receiverInstance.code.finally(() => receiverInstance.close()),
    close: () => receiverInstance.close(),
  };
}

/** Exchanges a code for tokens (returns the parsed JSON body). */
export async function exchangeSubscriptionCode(preset: SubscriptionPreset, code: string, verifier: string, fetchFn: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: code.split('#')[0] ?? code,
    client_id: preset.clientId,
    redirect_uri: preset.redirectUri ?? 'http://localhost/callback',
    code_verifier: verifier,
    ...(preset.codeStyle === 'paste' ? { state: verifier } : {}),
  };
  const response = await fetchFn(preset.tokenUrl, {
    method: 'POST',
    headers: preset.exchangeJson
      ? { 'content-type': 'application/json' }
      : { 'content-type': 'application/x-www-form-urlencoded' },
    body: preset.exchangeJson ? JSON.stringify(body) : new URLSearchParams(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok || !json.access_token) {
    throw new Error(`Login failed: ${String(json.error_description ?? json.error ?? `HTTP ${response.status}`)}`);
  }
  return json;
}

/** Refreshes an expiring login with its refresh token. */
export async function refreshSubscriptionToken(preset: SubscriptionPreset, refreshToken: string, fetchFn: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const response = await fetchFn(preset.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: preset.clientId }),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok || !json.access_token) throw new Error(`Refresh failed: ${String(json.error_description ?? json.error ?? `HTTP ${response.status}`)}`);
  return json;
}
