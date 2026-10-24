// 校验 Cloudflare Access 带来的 JWT（Cf-Access-Jwt-Assertion）。
// Access 已经在门口拦过一次；这里再验一遍，防止有人绕过 Access 直接打到 Worker。
// 需要环境变量：ACCESS_TEAM_DOMAIN（如 xxx.cloudflareaccess.com）、ACCESS_AUD（Access 应用的 AUD 标签）。

const CERT_TTL_MS = 60 * 60 * 1000;
let certCache = { domain: '', at: 0, keys: new Map() };

const b64urlDecode = (s) => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const decodePart = (s) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));

async function loadKeys(domain, fetchImpl, force = false) {
  if (!force && certCache.domain === domain && Date.now() - certCache.at < CERT_TTL_MS) return certCache.keys;
  const res = await fetchImpl(`https://${domain}/cdn-cgi/access/certs`, { redirect: 'error' });
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    keys.set(jwk.kid, key);
  }
  certCache = { domain, at: Date.now(), keys };
  return keys;
}

// 通过返回 { email }，不通过返回 null
export async function verifyAccess(request, env, fetchImpl = fetch) {
  const domain = String(env.ACCESS_TEAM_DOMAIN || '').trim();
  const aud = String(env.ACCESS_AUD || '').trim();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) || !aud) return null; // 没配置好就一律拒绝
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = decodePart(parts[0]);
    payload = decodePart(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  let keys = await loadKeys(domain, fetchImpl);
  if (!keys.has(header.kid)) keys = await loadKeys(domain, fetchImpl, true); // 公钥轮换
  const key = keys.get(header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const nowS = Math.floor(Date.now() / 1000);
  if (payload.iss !== `https://${domain}`) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (typeof payload.exp !== 'number' || payload.exp < nowS - 30) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > nowS + 30) return null;
  if (typeof payload.email !== 'string' || !payload.email.includes('@')) return null;
  return { email: payload.email.toLowerCase(), iat: payload.iat };
}

export function _resetCertCache() { certCache = { domain: '', at: 0, keys: new Map() }; }
