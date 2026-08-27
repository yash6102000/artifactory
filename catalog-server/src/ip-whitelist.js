// Admin console access control (Phase 1 plan: "before this touches even the
// 5-10 pilot machines, put this behind basic auth / the office network / a
// VPN"). This implements the "office network" option: /admin is blocked by
// default and only reachable from IPs/CIDR ranges an operator explicitly
// whitelists via ADMIN_IP_WHITELIST.
//
// Default-deny: with no env var set, only localhost can reach /admin. That
// keeps local dev working without ever accidentally shipping an open admin
// console — the office network/VPN range has to be added on purpose.

const DEFAULT_WHITELIST = '127.0.0.1,::1,::ffff:127.0.0.1';

function parseWhitelist(raw) {
  return (raw || DEFAULT_WHITELIST)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function ipToInt(ipv4) {
  const parts = ipv4.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// Strips the ::ffff: prefix Node adds to IPv4 addresses on a dual-stack socket.
function normalizeIp(ip) {
  if (!ip) return ip;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function matchesEntry(ip, entry) {
  if (entry === ip) return true;

  if (entry.includes('/')) {
    const [rangeIp, prefixStr] = entry.split('/');
    const prefix = Number(prefixStr);
    const target = ipToInt(ip);
    const range = ipToInt(rangeIp);
    if (target === null || range === null || Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (target & mask) === (range & mask);
  }

  return false;
}

function isWhitelisted(ip, raw = process.env.ADMIN_IP_WHITELIST) {
  const normalized = normalizeIp(ip);
  const entries = parseWhitelist(raw);
  return entries.some((entry) => matchesEntry(normalized, entry));
}

module.exports = { isWhitelisted, normalizeIp, parseWhitelist };
