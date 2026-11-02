// 后台网页登录：老板和主管用登录名和密码换一个会话令牌（12 小时），网页放 sessionStorage，每个请求带 Authorization: Bearer。
// 不用 cookie，所以没有跨站请求伪造的问题。
// 初始化和找回：Worker 的 secret SETUP_CODE。还没有带密码的老板时用它建老板；以后用它重置老板的密码。
import { json, fail, now, uuid, randomToken, sha256hex, readJson, HttpError, str, audit, rateLimit } from './util.js';
import { normalizeLogin, checkPassword, hashPassword, passwordStmts, sameBytes } from './password.js';
import { checkLogin } from './device.js';

export const SESSION_MS = 12 * 60 * 60 * 1000;
const ADMIN_ROLES = ['owner', 'supervisor'];

function bearer(request) {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '');
  return m ? m[1] : '';
}

// 会话令牌 -> 用户。不通过抛 401（要重新登录）或 403（没有权限）
export async function resolveSession(request, db) {
  const token = bearer(request);
  if (!token) throw new HttpError(401, '请先登录');
  const row = await db.prepare(`SELECT u.id, u.name, u.login_name, u.role, u.group_id, u.disabled_at FROM admin_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(await sha256hex(token), now()).first();
  if (!row) throw new HttpError(401, '登录已过期，请重新登录');
  if (row.disabled_at || !ADMIN_ROLES.includes(row.role)) throw new HttpError(403, '这个账号没有后台权限');
  if (row.role === 'supervisor' && !row.group_id) throw new HttpError(403, '这个主管还没分组，请老板先分组');
  const { disabled_at: _d, ...user } = row;
  return user;
}

async function newSession(db, userId) {
  const token = randomToken(32);
  const t = now();
  await db.prepare('INSERT INTO admin_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256hex(token), userId, t, t + SESSION_MS).run();
  return { token, expires_at: t + SESSION_MS };
}

async function login(request, env) {
  const db = env.DB;
  const body = await readJson(request);
  const user = await checkLogin(request, env, body, 'admin');
  if (user.disabled_at || !ADMIN_ROLES.includes(user.role)) return fail(403, '这个账号没有后台权限');
  await audit(db, user.id, 'admin.login', user.id);
  return json(await newSession(db, user.id));
}

async function logout(request, env) {
  const token = bearer(request);
  if (token) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(await sha256hex(token)).run();
  return json({ ok: true });
}

// ---------- 初始化和找回 ----------

const setupCode = (env) => (typeof env.SETUP_CODE === 'string' && env.SETUP_CODE.length >= 12 ? env.SETUP_CODE : '');
const hasOwner = async (db) => !!(await db.prepare("SELECT 1 AS x FROM users WHERE role = 'owner' AND pass_hash IS NOT NULL AND disabled_at IS NULL").first());

async function setupState(env) {
  return json({ enabled: !!setupCode(env), needed: !(await hasOwner(env.DB)) });
}

async function codeMatches(env, given) {
  const want = setupCode(env);
  if (!want || typeof given !== 'string') return false;
  // 先各自哈希再比，长度不同也不提前返回
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(given)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(want)));
  return sameBytes(a, b);
}

async function setup(request, env) {
  const db = env.DB;
  if (!setupCode(env)) return fail(403, '还没有设置初始化口令 SETUP_CODE');
  await rateLimit(db, `setup:${request.headers.get('cf-connecting-ip') || 'unknown'}`, 10, 10 * 60 * 1000);
  const body = await readJson(request);
  if (!(await codeMatches(env, body.code))) {
    await audit(db, '', 'admin.setup_fail', '');
    return fail(400, '初始化口令不对');
  }
  const login = normalizeLogin(body.login);
  if (!login) return fail(400, '登录名只能用小写字母、数字和 . _ -，2 到 32 位');
  const h = await hashPassword(checkPassword(body.password), env);
  const t = now();
  if (!(await hasOwner(db))) {
    const name = str(body.name, 40) || '老板';
    const id = uuid();
    // 两个初始化请求同时到：只有一个能建出来
    let r;
    try {
      r = await db.prepare(`INSERT INTO users (id, name, role, login_name, pass_hash, pass_salt, pass_iter, pass_changed_at, created_at)
        SELECT ?, ?, 'owner', ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner' AND pass_hash IS NOT NULL AND disabled_at IS NULL)`)
        .bind(id, name, login, h.pass_hash, h.pass_salt, h.pass_iter, t, t).run();
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) return fail(409, '这个登录名已经有人用了');
      throw e;
    }
    if (r.meta.changes !== 1) return fail(409, '已经初始化过了，请刷新');
    await audit(db, id, 'admin.setup', id);
    return json({ ok: true, created: true, ...(await newSession(db, id)) });
  }
  // 已经有老板：只能重置老板的密码
  const owner = await db.prepare("SELECT id FROM users WHERE login_name = ? AND role = 'owner' AND disabled_at IS NULL").bind(login).first();
  if (!owner) return fail(400, '没有这个老板账号');
  await db.batch(passwordStmts(db, owner.id, h, t));
  await audit(db, owner.id, 'admin.setup_reset', owner.id);
  return json({ ok: true, created: false, ...(await newSession(db, owner.id)) });
}

// 不需要会话的两个后台接口
export async function handleOpenAdmin(request, env, path) {
  const m = request.method;
  if (m !== 'GET' && request.headers.get('x-waswitch-admin') !== '1') return fail(403, '缺少请求头');
  if (path === '/api/admin/session') {
    if (m === 'POST') return login(request, env);
    if (m === 'DELETE') return logout(request, env);
  }
  if (path === '/api/admin/setup') {
    if (m === 'GET') return setupState(env);
    if (m === 'POST') return setup(request, env);
  }
  return fail(405, '不支持这个方法');
}
