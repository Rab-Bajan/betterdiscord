import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

/** Resolves a hostname to one address (dns.promises.lookup in production). */
export type HostLookup = (hostname: string) => Promise<{ address: string }>;

export type UrlCheck = { valid: true; url: string } | { valid: false; reason: string };

/** Loopback, private, link-local, unique-local, broadcast and multicast addresses (legacy browserSecurity.js). */
export function isPrivateIp(address: string | null | undefined): boolean {
  if (!address) return true;
  const ip = address.startsWith('::ffff:') ? address.substring(7) : address;
  if (ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:')) return true;
  if (!net.isIPv4(ip)) return false;
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.onion'];

/**
 * Normalises a user-entered URL (adds `https://`) and refuses anything that targets the
 * server's own network (SSRF protection), including hostnames that resolve to private
 * addresses. A failed DNS lookup is allowed: the browser navigation then fails by itself.
 */
export async function validateAndSanitizeUrl(rawUrl: unknown, lookup: HostLookup = dnsLookup): Promise<UrlCheck> {
  if (!rawUrl || typeof rawUrl !== 'string') return { valid: false, reason: 'URL megadása kötelező' };
  let trimmed = rawUrl.trim();
  if (!trimmed) return { valid: false, reason: 'Üres URL' };
  if (trimmed === 'about:blank') return { valid: true, url: 'about:blank' };
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'Érvénytelen URL formátum' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Csak HTTP és HTTPS címek engedélyezettek' };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || INTERNAL_SUFFIXES.some((s) => hostname.endsWith(s))) {
    return { valid: false, reason: 'Belső hálózati címek nem érhetők el (SSRF védelem)' };
  }
  if (net.isIP(hostname)) {
    return isPrivateIp(hostname)
      ? { valid: false, reason: 'Privát/helyi IP-címek nem érhetők el (SSRF védelem)' }
      : { valid: true, url: parsed.toString() };
  }
  try {
    const { address } = await lookup(hostname);
    if (isPrivateIp(address)) return { valid: false, reason: 'A tartomány belső privát hálózatra mutat (SSRF védelem)' };
  } catch {
    // Resolution failures are left to the browser navigation.
  }
  return { valid: true, url: parsed.toString() };
}
