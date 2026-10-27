import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Keeps workflow HTTP calls on the public internet unless a node opts in: a flow that
 * someone else edits (or an imported one) must not reach the router, the NAS, other
 * services on this machine, or a cloud metadata address.
 */

export type Lookup = (hostname: string) => Promise<string[]>;

const defaultLookup: Lookup = async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

function ipv4Private(address: string): boolean {
  const [a, b] = address.split('.').map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT (also Tailscale)
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast and reserved
  );
}

/** True for loopback, private, link-local and similar addresses. */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return ipv4Private(address);
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Private(mapped[1]!);
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
}

/** Throws unless the URL is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(url: string, lookup: Lookup = defaultLookup): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`only http(s) URLs are allowed, not ${parsed.protocol}`);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw blocked(host);
  const addresses = net.isIP(host) ? [host] : await lookup(host).catch(() => {
    throw new Error(`cannot resolve ${host}`);
  });
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw blocked(host);
}

const blocked = (host: string) =>
  new Error(`${host} is on the local network; tick "อนุญาตเรียกเครือข่ายภายใน" on this node if that is intended`);

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
/** Credentials must not follow a redirect to another origin. */
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|cookie2)$/i;
const SENSITIVE_HEADER_PART = /(^|[-_])(auth|token|secret|key|password|passwd|credential)([-_]|$)/i;

export interface SafeFetchOptions {
  /** Tests and connector runtimes inject their own fetch; production uses the global one. */
  fetchFn?: typeof fetch;
  lookup?: Lookup;
  /** The caller explicitly opted in to local/private destinations. */
  allowLocal?: boolean;
  /** Redirects followed before giving up; defaults to 5. */
  maxRedirects?: number;
}

/**
 * Fetches a URL while re-checking every redirect target. `assertPublicUrl` alone is not
 * enough: a public URL can redirect to the router or a cloud metadata address.
 */
export async function safeFetch(url: string, init: RequestInit = {}, options: SafeFetchOptions = {}): Promise<Response> {
  const call = options.fetchFn ?? fetch;
  const maxRedirects = options.maxRedirects ?? 5;
  const guard = !options.allowLocal && !(options.fetchFn && !options.lookup);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a URL`);
  }
  let request = init;
  for (let hop = 0; ; hop++) {
    if (guard) await assertPublicUrl(target.toString(), options.lookup);
    const response = await call(target, { ...request, redirect: 'manual' });
    const location = response.headers.get('location');
    if (!REDIRECT_STATUS.has(response.status) || !location) return response;
    if (hop >= maxRedirects) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`too many redirects for ${url}`);
    }
    await response.body?.cancel().catch(() => {});
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      return response;
    }
    const headers = new Headers(request.headers);
    if (next.origin !== target.origin) {
      for (const name of [...headers.keys()]) {
        if (SENSITIVE_HEADER.test(name) || SENSITIVE_HEADER_PART.test(name)) headers.delete(name);
      }
    }
    request = { ...request, headers };
    const method = String(request.method ?? 'GET').toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      headers.delete('content-type');
      headers.delete('content-length');
      request = { ...request, method: 'GET', body: undefined };
    }
    target = next;
  }
}
