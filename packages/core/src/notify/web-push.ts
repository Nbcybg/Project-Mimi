import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Web Push without a library: VAPID (RFC 8292) signs who is sending, and the payload is
 * encrypted for the one browser that subscribed (RFC 8291, "aes128gcm"). The push
 * service (Google, Mozilla, Apple, Microsoft) only relays bytes it cannot read.
 */

export interface PushSubscriptionKeys {
  endpoint: string;
  /** The browser's P-256 public key, base64url. */
  p256dh: string;
  /** The browser's 16-byte auth secret, base64url. */
  auth: string;
}

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url: what the browser's subscribe() needs. */
  publicKey: string;
  privateKey: crypto.KeyObject;
}

const b64url = (data: Buffer) => data.toString('base64url');
const fromB64url = (text: string) => Buffer.from(text, 'base64url');

/** This server's VAPID key pair, made once and kept machine-local. */
export function loadOrCreateVapid(file: string): VapidKeys {
  let jwk: crypto.JsonWebKey | undefined;
  try {
    jwk = JSON.parse(fs.readFileSync(file, 'utf8')) as crypto.JsonWebKey;
  } catch {
    // first start: make one below
  }
  if (!jwk?.d || !jwk.x || !jwk.y) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    jwk = privateKey.export({ format: 'jwk' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(jwk), { encoding: 'utf8', mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = b64url(Buffer.concat([Buffer.from([4]), fromB64url(jwk.x!), fromB64url(jwk.y!)]));
  return { publicKey, privateKey };
}

/** The `Authorization` header for one push service (the JWT audience is its origin). */
export function vapidHeader(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

/**
 * Encrypts one message for a subscription (RFC 8291, single record). `fixed` pins the
 * sender key and salt, for the RFC's test vector only.
 */
export function encryptPayload(
  plaintext: Buffer,
  subscription: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  fixed?: { privateKey: Buffer; salt: Buffer },
): Buffer {
  const receiverKey = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);
  if (receiverKey.length !== 65 || receiverKey[0] !== 4) throw new Error('push subscription: bad p256dh key');
  if (authSecret.length < 16) throw new Error('push subscription: bad auth secret');
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const senderKey = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(receiverKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverKey, senderKey]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = fixed?.salt ?? crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the text, then the 0x02 "last record" delimiter.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([senderKey.length]), senderKey, body]);
}

export interface PushResult {
  status: number;
  /** The subscription no longer exists (uninstalled, permission revoked): forget it. */
  gone: boolean;
}

/** Sends one notification payload (JSON) to one subscription. */
export async function sendPush(
  subscription: PushSubscriptionKeys,
  payload: unknown,
  options: { vapid: VapidKeys; subject: string; ttlSeconds?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; fetchFn?: typeof fetch },
): Promise<PushResult> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), subscription);
  const response = await (options.fetchFn ?? fetch)(subscription.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidHeader(subscription.endpoint, options.vapid, options.subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(options.ttlSeconds ?? 24 * 3600),
      urgency: options.urgency ?? 'normal',
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  await response.arrayBuffer().catch(() => undefined);
  return { status: response.status, gone: response.status === 404 || response.status === 410 };
}
