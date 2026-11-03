import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import type { Notification, NativePushPlatform } from '@mimi/shared';

/**
 * Push to the native apps without a library: Firebase Cloud Messaging (HTTP v1, a service
 * account signs a JWT that is traded for an access token) and Apple Push (HTTP/2, a .p8 key
 * signs a JWT itself). The keys belong to whoever publishes the apps, so they come from the
 * environment, never from the app.
 *
 * By default a push carries no message text: Google and Apple can read what they deliver,
 * unlike Web Push. The app fetches the text from `/api/notifications` (an Android data
 * message, an iOS notification service extension). MIMI_NATIVE_PUSH_CONTENT=full sends the
 * title and body as well.
 */

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  /** PEM of the service account's RSA key. */
  privateKey: string;
  tokenUri: string;
}

export interface ApnsCredentials {
  /** PEM of the .p8 key (EC P-256). */
  key: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id, used when a device registered without its own. */
  topic?: string;
}

export interface NativePushConfig {
  fcm?: FcmCredentials;
  apns?: ApnsCredentials;
  content: 'minimal' | 'full';
  /** Test seams: where FCM and APNs are reached. */
  fcmBaseUrl?: string;
  apnsHost?: string;
  apnsSandboxHost?: string;
}

/** What one push says. `unread` sets the app icon's badge. */
export interface NativePushMessage {
  id: number;
  kind: Notification['kind'];
  title: string;
  body: string;
  chatId: number | null;
  unread: number;
}

export interface NativePushTarget {
  platform: NativePushPlatform;
  token: string;
  bundleId?: string | null;
  sandbox?: boolean;
}

/** `gone`: the token will never work again (app removed, token rotated), so forget it. */
export type NativePushResult = { ok: true } | { ok: false; gone: boolean; status: number; reason: string };

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const APNS_HOST = 'https://api.push.apple.com';
const APNS_SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
/** Apple wants a provider token reused for up to an hour and refreshed at least that often. */
const APNS_JWT_MS = 50 * 60_000;

/** What a push without its text says, per kind. */
const MINIMAL_BODY: Record<Notification['kind'], string> = {
  reminder: 'เตือนความจำ',
  'task-result': 'งานเสร็จแล้ว',
  approval: 'มีเรื่องรออนุมัติ',
  message: 'มีข้อความใหม่',
  info: 'มีการแจ้งเตือน',
};

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/**
 * Reads a value that is either the text itself or the path of a file holding it. A PEM pasted
 * into one environment line has `\n` for its line breaks (`pem`); JSON keeps its own escapes.
 */
function textOrFile(value: string | undefined, looksLikeText: (text: string) => boolean, pem = false): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (looksLikeText(raw)) return pem ? raw.replace(/\\n/g, '\n') : raw;
  return fs.readFileSync(raw, 'utf8');
}

/** Native push settings from the environment; a platform without complete credentials stays off. */
export function nativePushConfig(env: NodeJS.ProcessEnv = process.env): NativePushConfig {
  const config: NativePushConfig = { content: env.MIMI_NATIVE_PUSH_CONTENT === 'full' ? 'full' : 'minimal' };
  try {
    const text = textOrFile(env.MIMI_FCM_SERVICE_ACCOUNT, (raw) => raw.startsWith('{'));
    if (text) {
      const account = JSON.parse(text) as Record<string, unknown>;
      const projectId = String(env.MIMI_FCM_PROJECT_ID || account.project_id || '');
      if (projectId && typeof account.client_email === 'string' && typeof account.private_key === 'string') {
        config.fcm = {
          projectId,
          clientEmail: account.client_email,
          privateKey: account.private_key,
          tokenUri: typeof account.token_uri === 'string' ? account.token_uri : 'https://oauth2.googleapis.com/token',
        };
      }
    }
  } catch (error) {
    console.warn(`MIMI_FCM_SERVICE_ACCOUNT ignored: ${(error as Error).message}`);
  }
  try {
    const key = textOrFile(env.MIMI_APNS_KEY, (raw) => raw.includes('BEGIN'), true);
    if (key && env.MIMI_APNS_KEY_ID && env.MIMI_APNS_TEAM_ID) {
      config.apns = { key, keyId: env.MIMI_APNS_KEY_ID.trim(), teamId: env.MIMI_APNS_TEAM_ID.trim(), topic: env.MIMI_APNS_TOPIC?.trim() || undefined };
    }
  } catch (error) {
    console.warn(`MIMI_APNS_KEY ignored: ${(error as Error).message}`);
  }
  return config;
}

export class NativePushSender {
  private readonly config: NativePushConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private fcmToken: { value: string; until: number } | undefined;
  private fcmKey: KeyObject | undefined;
  private apnsJwt: { value: string; at: number } | undefined;

  constructor(config: NativePushConfig, deps: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.config = config;
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** True when this core holds the credentials to push to that platform. */
  available(platform: NativePushPlatform): boolean {
    return platform === 'fcm' ? Boolean(this.config.fcm) : Boolean(this.config.apns);
  }

  async send(target: NativePushTarget, message: NativePushMessage, urgency: 'normal' | 'high'): Promise<NativePushResult> {
    if (!this.available(target.platform)) return { ok: false, gone: false, status: 0, reason: `no ${target.platform} credentials on this core` };
    return target.platform === 'fcm' ? this.sendFcm(target.token, message, urgency) : this.sendApns(target, message, urgency);
  }

  private text(message: NativePushMessage): { title: string; body: string } {
    if (this.config.content === 'full') return { title: message.title, body: message.body.slice(0, 1000) };
    return { title: 'Mimi', body: MINIMAL_BODY[message.kind] ?? MINIMAL_BODY.info };
  }

  // ---------- FCM ----------

  private async fcmAccessToken(): Promise<string> {
    const fcm = this.config.fcm!;
    if (this.fcmToken && this.fcmToken.until > this.now()) return this.fcmToken.value;
    this.fcmKey ??= createPrivateKey(fcm.privateKey);
    const iat = Math.floor(this.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
      JSON.stringify({ iss: fcm.clientEmail, scope: FCM_SCOPE, aud: fcm.tokenUri, iat, exp: iat + 3600 }),
    )}`;
    const assertion = `${unsigned}.${b64url(sign('RSA-SHA256', Buffer.from(unsigned), this.fcmKey))}`;
    const response = await this.fetchImpl(fcm.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const answer = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!response.ok || !answer.access_token) throw new Error(`FCM sign-in failed: HTTP ${response.status}`);
    this.fcmToken = { value: answer.access_token, until: this.now() + Math.max(60, (answer.expires_in ?? 3600) - 60) * 1000 };
    return answer.access_token;
  }

  private async sendFcm(token: string, message: NativePushMessage, urgency: 'normal' | 'high'): Promise<NativePushResult> {
    const fcm = this.config.fcm!;
    const access = await this.fcmAccessToken();
    const text = this.text(message);
    // A data message: the app always builds the notification itself (actions, grouping, the
    // text it fetched), and Android still delivers a high-priority one to a stopped app.
    const data: Record<string, string> = {
      id: String(message.id),
      kind: message.kind,
      chatId: message.chatId === null ? '' : String(message.chatId),
      unread: String(message.unread),
      title: text.title,
      body: text.body,
      content: this.config.content,
    };
    const base = this.config.fcmBaseUrl ?? 'https://fcm.googleapis.com';
    const response = await this.fetchImpl(`${base}/v1/projects/${encodeURIComponent(fcm.projectId)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token, data, android: { priority: urgency === 'high' ? 'HIGH' : 'NORMAL' } } }),
    });
    if (response.ok) return { ok: true };
    const reply = await response.text().catch(() => '');
    if (response.status === 401) this.fcmToken = undefined;
    const gone = response.status === 404 || /UNREGISTERED|not a valid FCM registration token/i.test(reply);
    return { ok: false, gone, status: response.status, reason: reply.slice(0, 200) || `HTTP ${response.status}` };
  }

  // ---------- APNs ----------

  private apnsProviderToken(): string {
    const apns = this.config.apns!;
    if (this.apnsJwt && this.now() - this.apnsJwt.at < APNS_JWT_MS) return this.apnsJwt.value;
    const at = this.now();
    const unsigned = `${b64url(JSON.stringify({ alg: 'ES256', kid: apns.keyId }))}.${b64url(JSON.stringify({ iss: apns.teamId, iat: Math.floor(at / 1000) }))}`;
    const signature = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey(apns.key), dsaEncoding: 'ieee-p1363' });
    this.apnsJwt = { value: `${unsigned}.${b64url(signature)}`, at };
    return this.apnsJwt.value;
  }

  private sendApns(target: NativePushTarget, message: NativePushMessage, urgency: 'normal' | 'high'): Promise<NativePushResult> {
    const apns = this.config.apns!;
    const topic = target.bundleId || apns.topic;
    if (!topic) return Promise.resolve({ ok: false, gone: false, status: 0, reason: 'no APNs topic (bundle id)' });
    const text = this.text(message);
    const payload = {
      aps: {
        alert: text,
        sound: 'default',
        badge: message.unread,
        // Lets the app's notification service extension fetch the text before it is shown.
        'mutable-content': 1,
        ...(message.chatId !== null ? { 'thread-id': `chat-${message.chatId}` } : {}),
      },
      id: message.id,
      kind: message.kind,
      chatId: message.chatId,
      content: this.config.content,
    };
    const host = target.sandbox ? (this.config.apnsSandboxHost ?? APNS_SANDBOX_HOST) : (this.config.apnsHost ?? APNS_HOST);
    const authorization = `bearer ${this.apnsProviderToken()}`;
    return new Promise((resolve) => {
      const session = http2.connect(host);
      const finish = (result: NativePushResult) => {
        session.close();
        resolve(result);
      };
      session.on('error', (error) => finish({ ok: false, gone: false, status: 0, reason: error.message }));
      const request = session.request({
        ':method': 'POST',
        ':path': `/3/device/${target.token}`,
        authorization,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': urgency === 'high' ? '10' : '5',
        'content-type': 'application/json',
      });
      let status = 0;
      let body = '';
      request.setEncoding('utf8');
      request.on('response', (headers) => (status = Number(headers[':status'] ?? 0)));
      request.on('data', (chunk: string) => (body += chunk));
      request.on('end', () => {
        if (status === 200) return finish({ ok: true });
        let reason = body;
        try {
          reason = String((JSON.parse(body) as { reason?: unknown }).reason ?? body);
        } catch {
          // not JSON
        }
        if (status === 403 && reason === 'ExpiredProviderToken') this.apnsJwt = undefined;
        const gone = status === 410 || (status === 400 && /BadDeviceToken|DeviceTokenNotForTopic|Unregistered/.test(reason));
        finish({ ok: false, gone, status, reason: reason.slice(0, 200) || `HTTP ${status}` });
      });
      request.on('error', (error) => finish({ ok: false, gone: false, status, reason: error.message }));
      request.end(JSON.stringify(payload));
    });
  }
}
