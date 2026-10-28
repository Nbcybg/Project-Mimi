import type http from 'node:http';

/**
 * The caller's address for counting wrong tokens. Behind a reverse proxy every connection
 * comes from the proxy, so `header` (set by that proxy, e.g. x-real-ip) names the caller;
 * the last entry of a list is the one the nearest proxy added, so a caller cannot forge it.
 */
export function clientAddress(request: http.IncomingMessage, header?: string): string {
  const value = header ? request.headers[header] : undefined;
  const forwarded = (Array.isArray(value) ? value.at(-1) : value)?.split(',').at(-1)?.trim();
  return forwarded || (request.socket.remoteAddress ?? 'unknown');
}

/**
 * Slows down token guessing: after too many wrong tokens from one address in a
 * window, that address is refused for a while, even with the right token.
 */
export class AuthLimiter {
  private readonly failures = new Map<string, { count: number; first: number; blockedUntil: number }>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly now: () => number;

  constructor(options: { maxFailures?: number; windowMs?: number; blockMs?: number; now?: () => number } = {}) {
    this.maxFailures = options.maxFailures ?? 10;
    this.windowMs = options.windowMs ?? 10 * 60_000;
    this.blockMs = options.blockMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
  }

  blocked(address: string): boolean {
    const entry = this.failures.get(address);
    return entry !== undefined && entry.blockedUntil > this.now();
  }

  fail(address: string): void {
    const now = this.now();
    const entry = this.failures.get(address);
    if (!entry || now - entry.first > this.windowMs) {
      this.failures.set(address, { count: 1, first: now, blockedUntil: 0 });
    } else {
      entry.count++;
      if (entry.count >= this.maxFailures) entry.blockedUntil = now + this.blockMs;
    }
    // Keep the map small: forget stale addresses.
    if (this.failures.size > 1000) {
      for (const [key, value] of this.failures) if (now - value.first > this.windowMs && value.blockedUntil < now) this.failures.delete(key);
    }
  }

  succeed(address: string): void {
    this.failures.delete(address);
  }
}
