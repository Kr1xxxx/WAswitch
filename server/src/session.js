// 后台网页登录：老板和主管填邮箱收验证码，换一个 7 天的会话令牌。网页放 localStorage，每个请求带 Authorization: Bearer。
// 不用 cookie，所以没有跨站请求伪造的问题。
// 老板邮箱是 Worker 的 secret OWNER_EMAIL：这个邮箱一定是老板，第一次登录时建档；老板进不去时改这个 secret 就行。
import { json, fail, now, uuid, randomToken, sha256hex, readJson, HttpError, audit, normalizeEmail } from './util.js';
import { limitCodeIp, issueCode, consumeCode } from './code.js';

export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_ROLES = ['owner', 'supervisor'];
const ownerEmail = (env) => normalizeEmail(env.OWNER_EMAIL);

function bearer(request) {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '');
  return m ? m[1] : '';
}

// 会话令牌 -> 用户。不通过抛 401（要重新登录）或 403（没有权限）
export async function resolveSession(request, db) {
  const token = bearer(request);
  if (!token) throw new HttpError(401, '请先登录');
  const row = await db.prepare(`SELECT u.id, u.name, u.email, u.role, u.group_id, u.disabled_at FROM admin_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256hex(token), now()).first();
  if (!row) throw new HttpError(401, '登录已过期，请重新登录');
  if (row.disabled_at || !ADMIN_ROLES.includes(row.role)) throw new HttpError(403, '这个账号没有后台权限');
  if (row.role === 'supervisor' && !row.group_id) throw new HttpError(403, '这个主管还没分组，请老板先分组');
  const { disabled_at: _d, ...user } = row;
  return user;
}

// 这个邮箱能不能登录后台：老板邮箱，或者没停用的老板、主管
async function mayAdmin(db, env, email) {
  if (email === ownerEmail(env)) return true;
  const u = await db.prepare('SELECT role, disabled_at FROM users WHERE email = ?').bind(email).first();
  return !!(u && !u.disabled_at && ADMIN_ROLES.includes(u.role));
}

async function requestCode(request, env) {
  const db = env.DB;
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email) return fail(400, '邮箱格式不对');
  await limitCodeIp(request, db);
  if (!(await mayAdmin(db, env, email))) return fail(404, '这个邮箱没有后台权限');
  return json(await issueCode(env, email, 'admin'));
}

// 老板邮箱登录：没有就建，有就确保是老板、没停用
async function ensureOwner(db, email) {
  const t = now();
  await db.prepare("INSERT INTO users (id, name, email, role, created_at) VALUES (?, '老板', ?, 'owner', ?) ON CONFLICT(email) DO NOTHING").bind(uuid(), email, t).run();
  const u = await db.prepare("UPDATE users SET role = 'owner', disabled_at = NULL WHERE email = ? RETURNING id, role, disabled_at").bind(email).first();
  return u;
}

async function login(request, env) {
  const db = env.DB;
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!(await consumeCode(request, env, email, body.code, 'admin'))) {
    await audit(db, '', 'admin.login_fail', email.slice(0, 120), '');
    return fail(400, '验证码不对或已过期');
  }
  const user = email === ownerEmail(env) ? await ensureOwner(db, email)
    : await db.prepare('SELECT id, role, disabled_at FROM users WHERE email = ?').bind(email).first();
  if (!user || user.disabled_at || !ADMIN_ROLES.includes(user.role)) return fail(403, '这个邮箱没有后台权限');
  const token = randomToken(32);
  const t = now();
  await db.prepare('INSERT INTO admin_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256hex(token), user.id, t, t + SESSION_MS).run();
  await audit(db, user.id, 'admin.login', user.id);
  return json({ token, expires_at: t + SESSION_MS });
}

async function logout(request, env) {
  const token = bearer(request);
  if (token) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(await sha256hex(token)).run();
  return json({ ok: true });
}

// 让这个人重新登录：所有电脑的令牌换成随机值、删掉后台会话
export function signOutStmts(db, userId, t) {
  return [
    db.prepare('UPDATE devices SET token_hash = lower(hex(randomblob(32))), logged_out_at = ? WHERE user_id = ? AND logged_out_at IS NULL').bind(t, userId),
    db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').bind(userId),
  ];
}

// 不需要会话的两个后台接口：要码、换会话（退出也在这里）
export async function handleOpenAdmin(request, env, path) {
  const m = request.method;
  if (m !== 'GET' && request.headers.get('x-waswitch-admin') !== '1') return fail(403, '缺少请求头');
  if (path === '/api/admin/code' && m === 'POST') return requestCode(request, env);
  if (path === '/api/admin/session') {
    if (m === 'POST') return login(request, env);
    if (m === 'DELETE') return logout(request, env);
  }
  return fail(405, '不支持这个方法');
}
