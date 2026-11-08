const dns = require('dns').promises;
const net = require('net');

function isPrivateIp(ip) {
  if (!ip) return true;
  // IPv4-mapped IPv6
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  // IPv6 localhost & unique local
  if (ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:')) {
    return true;
  }

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 127.0.0.0/8
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 (Link-Local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // Broadcast / Multicast
    if (parts[0] >= 224) return true;
  }

  return false;
}

/**
 * Sanitizes input URL and verifies it does not target private networks (SSRF prevention).
 * Returns { valid: boolean, url: string, reason?: string }
 */
async function validateAndSanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, reason: 'URL megadása kötelező' };
  }

  let trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, reason: 'Üres URL' };
  }

  // Allow special blank reset page
  if (trimmed === 'about:blank') {
    return { valid: true, url: 'about:blank' };
  }

  // Auto-prepend https if missing scheme
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = 'https://' + trimmed;
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    return { valid: false, reason: 'Érvénytelen URL formátum' };
  }

  // Only allow http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Csak HTTP és HTTPS címek engedélyezettek' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and internal names
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.onion')
  ) {
    return { valid: false, reason: 'Belső hálózati címek nem érhetők el (SSRF védelem)' };
  }

  // If direct IP address is given, check directly
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      return { valid: false, reason: 'Privát/helyi IP-címek nem érhetők el (SSRF védelem)' };
    }
    return { valid: true, url: parsed.toString() };
  }

  // Resolve hostname through DNS to protect against DNS rebinding / private IP resolutions
  try {
    const lookup = await dns.lookup(hostname);
    if (isPrivateIp(lookup.address)) {
      return { valid: false, reason: 'A tartomány belső privát hálózatra mutat (SSRF védelem)' };
    }
  } catch (err) {
    // DNS resolution failure is handled naturally by the browser navigation
  }

  return { valid: true, url: parsed.toString() };
}

module.exports = {
  isPrivateIp,
  validateAndSanitizeUrl
};
