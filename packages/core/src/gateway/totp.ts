import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps), the
 * kind every authenticator app (Google Authenticator, 1Password, Authy, …) produces.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_MS = 30_000;
const DIGITS = 6;
/** Codes one step before or after are accepted, for clocks that drift a little. */
const WINDOW = 1;

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new 160-bit secret, base32 as authenticator apps expect it. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one 30-second step. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(binary).padStart(DIGITS, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / TOTP_STEP_MS);
}

/**
 * The step a code belongs to, or null when it is wrong. A step at or before `lastStep`
 * is refused, so a code that was already used (or seen over a shoulder) cannot sign in again.
 */
export function verifyTotp(secret: string, code: unknown, nowMs: number, lastStep = -1): number | null {
  if (typeof code !== 'string') return null;
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const current = totpStep(nowMs);
  let found: number | null = null;
  for (let step = current - WINDOW; step <= current + WINDOW; step += 1) {
    // Every candidate is compared, so the time taken does not say which one matched.
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(given)) && step > lastStep && found === null) found = step;
  }
  return found;
}

/** The link an authenticator app reads (as a QR code or pasted); the secret is in it. */
export function totpUri(secret: string, account: string, issuer = 'Mimi'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_MS / 1000}`;
}
