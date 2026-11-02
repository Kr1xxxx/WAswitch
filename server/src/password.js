// 登录名和密码：PBKDF2-SHA256，16 字节随机盐。比较用常数时间。
import { HttpError } from './util.js';

// Workers 的 WebCrypto 最多支持 100,000 次。免费版每个请求 10 ms CPU，登录很少，偶尔超出平台允许；
// 真的超了可以设变量 PASS_ITER（10000–100000），已有的密码在下次登录时自动换成新次数。
export const MAX_ITER = 100000;
export const passIter = (env) => {
  const n = Number(env && env.PASS_ITER);
  return Number.isInteger(n) && n >= 10000 && n <= MAX_ITER ? n : MAX_ITER;
};

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));

// 登录名：小写，只允许 a-z 0-9 . _ -，2–32 位。不合格返回空串
export function normalizeLogin(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^[a-z0-9._-]{2,32}$/.test(s) ? s : '';
}

// 密码：8–128 位（只限长度，不限字符）
export function checkPassword(v) {
  if (typeof v !== 'string' || v.length < 8) throw new HttpError(400, '密码至少 8 位');
  if (v.length > 128) throw new HttpError(400, '密码太长');
  return v;
}

async function derive(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}

export async function hashPassword(password, env) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iter = passIter(env);
  return { pass_hash: hex(await derive(password, salt, iter)), pass_salt: hex(salt), pass_iter: iter };
}

export function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d |= a[i] ^ b[i];
  return d === 0;
}

const DUMMY_SALT = new Uint8Array(16);
// 用户不存在或没设密码时也算一遍，不让响应时间暴露登录名是否存在
export async function verifyPassword(password, user, env) {
  const ok = !!(user && user.pass_hash && user.pass_salt && Number.isInteger(user.pass_iter) && user.pass_iter >= 1000 && user.pass_iter <= MAX_ITER);
  const got = await derive(typeof password === 'string' ? password.slice(0, 128) : '', ok ? unhex(user.pass_salt) : DUMMY_SALT, ok ? user.pass_iter : passIter(env));
  return ok && typeof password === 'string' && password.length <= 128 && sameBytes(got, unhex(user.pass_hash));
}

// 改密码的语句：同时让这个人所有电脑的令牌和后台会话失效
export function passwordStmts(db, userId, h, t) {
  return [
    db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iter = ?, pass_changed_at = ? WHERE id = ?').bind(h.pass_hash, h.pass_salt, h.pass_iter, t, userId),
    db.prepare("UPDATE devices SET token_hash = lower(hex(randomblob(32))), logged_out_at = ? WHERE user_id = ? AND logged_out_at IS NULL").bind(t, userId),
    db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').bind(userId),
  ];
}
