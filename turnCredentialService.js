// ICE-szerverek (STUN + TURN). A TURN hitelesítő adatok rövid életűek (coturn "use-auth-secret" /
// TURN REST API séma): username = lejárat:felhasználó, credential = HMAC-SHA1(secret, username).
// A tartós TURN_SECRET sosem hagyja el a szervert.
//
// Környezeti változók:
//   TURN_URLS    pl. "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp"
//   TURN_SECRET  a coturn static-auth-secret értéke
//   TURN_TTL     érvényesség másodpercben (alap: 3600)
//   STUN_URLS    vesszővel elválasztott STUN lista (alap: publikus Google/Cloudflare)
const crypto = require('crypto');

const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
];

const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

function getIceServers(accountId) {
  const stun = list(process.env.STUN_URLS);
  const iceServers = [{ urls: stun.length ? stun : DEFAULT_STUN }];

  const turnUrls = list(process.env.TURN_URLS);
  const secret = process.env.TURN_SECRET;
  let ttl = 0;
  if (turnUrls.length && secret) {
    ttl = Math.max(60, parseInt(process.env.TURN_TTL, 10) || 3600);
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${String(accountId).replace(/[^\w-]/g, '')}`;
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
  }
  return { iceServers, ttl, turnEnabled: ttl > 0 };
}

module.exports = { getIceServers };
