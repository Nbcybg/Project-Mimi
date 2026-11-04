import type { NativePushPlatform } from '@mimi/shared';
import { NativePushSender, type NativePushConfig, type NativePushMessage, type NativePushResult, type NativePushTarget } from './native-push.ts';
import type { NativePushTransport } from './notifications.ts';

/**
 * Push through the accounts gateway (Q3: the FCM / APNs / WNS keys live in one place). A core
 * with MIMI_PUSH_RELAY_URL sends each push to the gateway's `POST /push/relay`, signed with its
 * own MIMI_TOKEN (the core token the gateway already keeps for it), and gets the push service's
 * answer back, so dead tokens are still forgotten here.
 */

/** What the gateway can deliver, and the Entra ID app id a Windows app makes its channel for. */
export interface PushInfo {
  platforms: NativePushPlatform[];
  wnsRemoteId?: string;
}

const PLATFORMS: NativePushPlatform[] = ['fcm', 'apns', 'wns'];
const INFO_MS = 10 * 60_000;

/** The body of `POST /push/relay`. */
export interface RelayRequest {
  target: NativePushTarget;
  message: NativePushMessage;
  urgency: 'normal' | 'high';
}

export class PushRelayClient {
  private cached: { info: PushInfo; at: number } | undefined;
  private readonly url: string;
  private readonly token: string;
  private readonly deps: { fetch?: typeof fetch; now?: () => number };

  constructor(url: string, token: string, deps: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.url = url;
    this.token = token;
    this.deps = deps;
  }

  private get fetchImpl(): typeof fetch {
    return this.deps.fetch ?? fetch;
  }

  async send(request: RelayRequest): Promise<NativePushResult> {
    try {
      const response = await this.fetchImpl(`${this.url}/push/relay`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(20_000),
      });
      const answer = (await response.json().catch(() => null)) as NativePushResult | null;
      if (response.ok && answer && typeof answer.ok === 'boolean') return answer;
      return { ok: false, gone: false, status: response.status, reason: `push relay: HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, gone: false, status: 0, reason: `push relay: ${(error as Error).message}` };
    }
  }

  /** What the gateway can push to (asked again every ten minutes); nothing when it cannot be reached. */
  async info(): Promise<PushInfo> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cached && now - this.cached.at < INFO_MS) return this.cached.info;
    try {
      const response = await this.fetchImpl(`${this.url}/push/relay`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(10_000) });
      const answer = (await response.json().catch(() => ({}))) as Partial<PushInfo>;
      const info: PushInfo = {
        platforms: Array.isArray(answer.platforms) ? answer.platforms.filter((platform): platform is NativePushPlatform => PLATFORMS.includes(platform)) : [],
        ...(typeof answer.wnsRemoteId === 'string' && answer.wnsRemoteId ? { wnsRemoteId: answer.wnsRemoteId } : {}),
      };
      if (response.ok) this.cached = { info, at: now };
      return info;
    } catch {
      return { platforms: [] };
    }
  }
}

/**
 * The core's push: its own keys first, then the gateway for the platforms it has no keys for.
 * Undefined when neither can push anywhere.
 */
export function corePushTransport(config: NativePushConfig | undefined, coreToken: string | undefined, deps: { fetch?: typeof fetch } = {}): (NativePushTransport & { info(): Promise<PushInfo> }) | undefined {
  if (!config) return undefined;
  const local = config.fcm || config.apns || config.wns ? new NativePushSender(config, deps) : undefined;
  const relay = config.relayUrl && coreToken ? new PushRelayClient(config.relayUrl, coreToken, deps) : undefined;
  if (!local && !relay) return undefined;
  return {
    // A token is kept either way; with a relay the gateway says whether it could deliver.
    available: (platform) => Boolean(local?.available(platform) || relay),
    send: (target, message, urgency) =>
      local?.available(target.platform) ? local.send(target, message, urgency) : relay!.send({ target, message, urgency }),
    info: async () => {
      const own = PLATFORMS.filter((platform) => local?.available(platform));
      const far = relay ? await relay.info() : { platforms: [] };
      const wnsRemoteId = local?.wnsRemoteId ?? far.wnsRemoteId;
      return { platforms: [...new Set([...own, ...far.platforms])], ...(wnsRemoteId ? { wnsRemoteId } : {}) };
    },
  };
}
