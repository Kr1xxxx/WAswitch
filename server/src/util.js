// 小工具：JSON 响应、随机数、哈希、读请求体、字段清洗。

export const now = () => Date.now();

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

export const fail = (status, error, extra = {}) => json({ error, ...extra }, status);

export const uuid = () => crypto.randomUUID();

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(n = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

// 登记码：10 位，去掉 0/O/1/I/L 这类容易看错的字符
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function randomCode(len = 10) {
  const out = [];
  while (out.length < len) {
    const b = crypto.getRandomValues(new Uint8Array(1))[0];
    if (b < 248) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]); // 248 = 31*8，避免取模偏差
  }
  return out.join('');
}
export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 读 JSON 请求体：必须是 application/json，最多 maxBytes
export async function readJson(request, maxBytes = 64 * 1024) {
  // 先看声明的长度，太大的请求不读进内存
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, '请求太大');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, '请求太大');
  if (!text) return {}; // 没有请求体的 POST（比如“生成登记码”）
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, '请求必须是 JSON');
  try {
    const v = JSON.parse(text || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
    return v;
  } catch {
    throw new HttpError(400, 'JSON 格式不对');
  }
}

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// 字段清洗：不符合就用默认值，不抛错
export const str = (v, max, def = '') => (typeof v === 'string' ? v.trim().slice(0, max) : def);
export const int = (v, min, max, def = 0) => (Number.isInteger(v) && v >= min && v <= max ? v : def);
export const oneOf = (v, list, def) => (list.includes(v) ? v : def);
export const country = (v) => (typeof v === 'string' && /^[A-Z]{2}$/.test(v) ? v : '');
export const ipText = (v) => (typeof v === 'string' && /^[0-9a-fA-F:.]{2,45}$/.test(v) ? v : '');
export const COLORS_RE = /^#[0-9a-fA-F]{6}$/;

export async function audit(db, actorId, action, target = '', detail = '') {
  await db.prepare('INSERT INTO audit_log (actor_id, action, target, at, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(actorId, action, String(target), now(), typeof detail === 'string' ? detail : JSON.stringify(detail)).run();
}

