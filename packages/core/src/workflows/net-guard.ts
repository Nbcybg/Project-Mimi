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
