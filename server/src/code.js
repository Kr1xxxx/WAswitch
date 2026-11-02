// 邮箱验证码（设备登录和后台登录共用）。
// 6 位数字，均匀随机；库里只存 SHA-256(purpose:email:code)；同一邮箱同一用途只留最新一个；
// 10 分钟有效，最多试 5 次，用一次就删。码不写日志，也不进 audit_log。
import { now, sha256hex, HttpError, rateLimit, refundRate } from './util.js';
import { sendCode } from './mail.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const RESEND_AFTER_S = 60;
const MAX_ATTEMPTS = 5;
const HOUR = 60 * 60 * 1000;
const tooFast = (n) => `太频繁了，请 ${n} 秒后再试`;
export const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';

// 拒绝采样：只用 < 4,294,000,000 的数，取模 1,000,000 没有偏差
function sixDigits() {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4294000000) return String(buf[0] % 1000000).padStart(6, '0');
  }
}

const codeHash = (purpose, email, code) => sha256hex(`${purpose}:${email}:${code}`);

// 每个 IP 每小时最多要 50 次码（查不到的邮箱也算），在查人之前调。
// 登录成功时退回一次：一个办公室几十台电脑共用出口 IP，不会被前面的人用光
const CODE_IP_LIMIT = 50;
const codeIpKey = (request) => `code:ip:${clientIp(request)}`;
export async function limitCodeIp(request, db) {
  await rateLimit(db, codeIpKey(request), CODE_IP_LIMIT, HOUR, tooFast);
}

// 给 email 发一个新码。调用前已经确认这个邮箱可以收码。发不出去抛 503，并删掉刚生成的码
export async function issueCode(env, email, purpose) {
  const db = env.DB;
  await rateLimit(db, `code:mail1:${purpose}:${email}`, 1, RESEND_AFTER_S * 1000, tooFast);
  await rateLimit(db, `code:mailh:${purpose}:${email}`, 5, HOUR, tooFast);
  const code = sixDigits();
  const hash = await codeHash(purpose, email, code);
  const t = now();
  await db.prepare(`INSERT INTO login_codes (email, purpose, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, ?, 0, ?)
    ON CONFLICT(email, purpose) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`)
    .bind(email, purpose, hash, t + CODE_TTL_MS, t).run();
  if (!(await sendCode(env, email, code))) {
    await db.prepare('DELETE FROM login_codes WHERE email = ? AND purpose = ? AND code_hash = ?').bind(email, purpose, hash).run();
    throw new HttpError(503, '验证码发不出去，请稍后再试');
  }
  return { ok: true, resend_after_s: RESEND_AFTER_S };
}

function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// 验证并用掉一个码。对了返回 true；不对（错、过期、试满、没要过、已经用过）都返回 false
export async function consumeCode(request, env, email, code, purpose) {
  const db = env.DB;
  const ipKey = `verify:ip:${clientIp(request)}`;
  await rateLimit(db, ipKey, 10, 10 * 60 * 1000);
  if (!email || typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  // 先占一次尝试：并发的请求各自加一，试满 5 次以后谁也拿不到
  const row = await db.prepare(`UPDATE login_codes SET attempts = attempts + 1
    WHERE email = ? AND purpose = ? AND expires_at > ? AND attempts < ? RETURNING code_hash`)
    .bind(email, purpose, now(), MAX_ATTEMPTS).first();
  if (!row) return false;
  const want = await codeHash(purpose, email, code);
  if (!sameHex(row.code_hash, want)) return false;
  // 只有真的删掉了这一行才算：同一个码不能用两次
  const del = await db.prepare('DELETE FROM login_codes WHERE email = ? AND purpose = ? AND code_hash = ?').bind(email, purpose, want).run();
  if (del.meta.changes !== 1) return false;
  await refundRate(db, [ipKey, codeIpKey(request)]);
  return true;
}
