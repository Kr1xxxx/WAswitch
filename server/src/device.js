// 设备接口：登记、加入团队、同步。只认设备令牌，不认 Access。
// 规则见设计文档：只收白名单字段；只有显式 403 {revoked:true} 才让客户端停号。
import { uploadChats } from './crm.js';
import { json, fail, now, uuid, randomToken, sha256hex, normalizeCode, readJson, HttpError, str, int, oneOf, country, ipText, COLORS_RE } from './util.js';

export const PROTOCOL = 1;
const STATES = ['ready', 'loading', 'needs_qr', 'proxy_down', 'needs_proxy', 'error', 'banned', 'stopped'];
const EVENT_KINDS = ['dropped', 'recovered', 'exit_changed', 'proxy_down', 'proxy_up', 'banned'];
const DETAIL_ENUM = ['', 'timeout', 'refused', 'auth', 'dns', 'tls', 'other'];
const PLATFORMS = ['win', 'mac', 'linux'];
const MAX_ACCOUNTS = 50;
const SEEN_EVERY_MS = 5 * 60 * 1000;
const ENROLL_LIMIT = 10; // 每个 IP 每 10 分钟最多试 10 次
const ENROLL_WINDOW_MS = 10 * 60 * 1000;

// 设备令牌 -> { device, user }。失败时抛出带状态码的错误
export async function authDevice(request, db) {
  const m = /^Bearer ([A-Za-z0-9_-]{40,60})$/.exec(request.headers.get('authorization') || '');
  if (!m) throw new HttpError(401, '缺少设备令牌');
  const hash = await sha256hex(m[1]);
  const row = await db.prepare(`SELECT d.id, d.user_id, d.revoked_at, d.last_seen_at, d.app_version, d.platform, d.mem_mb, d.low_mem,
      d.held_hides, d.confirm_hides, u.disabled_at, u.group_id FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`).bind(hash).first();
  if (!row) throw new HttpError(401, '设备令牌无效');
  if (row.revoked_at || row.disabled_at) throw new HttpError(403, '这台电脑已被管理员停用', { revoked: true, device_id: row.id });
  return row;
}

function checkProtocol(body) {
  if (body.v !== PROTOCOL) throw new HttpError(426, '这个版本的 WAswitch 太旧，请先更新');
}

// 本地账号 -> 团队账号的字段
function cleanLocalAccounts(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ACCOUNTS).map((a) => ({
    local_id: str(a && a.local_id, 40),
    name: str(a && a.name, 40) || '未命名',
    color: a && typeof a.color === 'string' && COLORS_RE.test(a.color) ? a.color : '',
    mode: oneOf(a && a.mode, ['web', 'lite'], 'web'),
  })).filter((a) => /^\d{1,20}$/.test(a.local_id));
}

async function addAccounts(db, user, deviceId, list) {
  const out = [];
  const stmts = [];
  for (const a of list) {
    const id = uuid();
    const t = now();
    stmts.push(db.prepare(`INSERT INTO wa_accounts (id, label, group_id, user_id, device_id, mode, color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, a.name, user.group_id || null, user.user_id, deviceId, a.mode, a.color, t, t));
    stmts.push(db.prepare('INSERT INTO device_seats (device_id, account_id, visible, version) VALUES (?, ?, 1, 0)').bind(deviceId, id));
    out.push({ local_id: a.local_id, team_id: id });
  }
  if (stmts.length) await db.batch(stmts);
  return out;
}

async function allowPrivate(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'allow_private'").first();
  return !row || row.value !== 0;
}

async function rateLimit(db, key, limit, windowMs) {
  const t = now();
  const row = await db.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END
    RETURNING count`).bind(key, t, t - windowMs, t - windowMs, t).first();
  if (row.count > limit) throw new HttpError(429, '尝试太多次，请 10 分钟后再试');
}

async function enroll(request, env) {
  const db = env.DB;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  await rateLimit(db, `enroll:${ip}`, ENROLL_LIMIT, ENROLL_WINDOW_MS);
  const body = await readJson(request);
  checkProtocol(body);
  const code = normalizeCode(body.code);
  if (code.length !== 10) return fail(400, '登记码不对');
  const codeHash = await sha256hex(code);
  const t = now();
  // 先占用登记码：只有一个请求能把 used_at 从空改成时间
  const used = await db.prepare('UPDATE enroll_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id')
    .bind(t, codeHash, t).first();
  if (!used) return fail(400, '登记码不对、已用过或已过期');
  const user = await db.prepare('SELECT id AS user_id, group_id, disabled_at FROM users WHERE id = ?').bind(used.user_id).first();
  if (!user || user.disabled_at) return fail(400, '这个员工已被停用');
  const token = randomToken(32);
  const deviceId = uuid();
  const d = body.device || {};
  await db.prepare(`INSERT INTO devices (id, user_id, name, token_hash, app_version, platform, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(deviceId, user.user_id, str(d.name, 40) || '未命名电脑', await sha256hex(token),
    str(d.app_version, 20), oneOf(d.platform, PLATFORMS, ''), t, t).run();
  const accounts = await addAccounts(db, user, deviceId, cleanLocalAccounts(body.accounts));
  return json({ device_id: deviceId, token, accounts, allow_private: await allowPrivate(db) });
}

async function join(request, env) {
  const db = env.DB;
  const dev = await authDevice(request, db);
  const body = await readJson(request);
  checkProtocol(body);
  const list = cleanLocalAccounts(body.accounts);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM device_seats WHERE device_id = ? AND visible = 1').bind(dev.id).first();
  if (count.n + list.length > MAX_ACCOUNTS) return fail(400, `一台电脑最多 ${MAX_ACCOUNTS} 个团队号`);
  const accounts = await addAccounts(db, { user_id: dev.user_id, group_id: dev.group_id }, dev.id, list);
  return json({ accounts });
}

function cleanStatus(s) {
  return {
    account_id: str(s.team_id, 36),
    state: oneOf(s.state, STATES, 'error'),
    unread: int(s.unread, 0, 100000, 0),
    proxy_ok: s.proxy_ok === true ? 1 : s.proxy_ok === false ? 0 : null,
    proxy_ms: int(s.proxy_ms, 0, 60000, null),
    exit_ip: ipText(s.exit_ip),
    exit_country: country(s.exit_country),
    exit_changed: s.exit_changed === true ? 1 : 0,
  };
}
const SAME_KEYS = ['state', 'unread', 'proxy_ok', 'proxy_ms', 'exit_ip', 'exit_country', 'exit_changed', 'device_id'];

// 请求开始后的归属和停用状态仍可能变化；写入时在同一事务重新检查。
const MAY_REPORT = `EXISTS (SELECT 1 FROM wa_accounts a
  JOIN device_seats s ON s.account_id = a.id AND s.device_id = a.device_id AND s.visible = 1
  JOIN devices d ON d.id = a.device_id JOIN users u ON u.id = d.user_id
  WHERE a.id = ? AND a.device_id = ? AND a.deleted_at IS NULL
    AND d.revoked_at IS NULL AND u.disabled_at IS NULL)`;

async function sync(request, env) {
  const db = env.DB;
  const dev = await authDevice(request, db);
  const body = await readJson(request, 256 * 1024);
  checkProtocol(body);
  const t = now();
  const stmts = [];

  // 设备信息：5 分钟写一次在线时间，信息变了也写
  const d = body.device || {};
  const info = { app_version: str(d.app_version, 20), platform: oneOf(d.platform, PLATFORMS, ''), mem_mb: int(d.mem_mb, 0, 1e6, 0), low_mem: d.low_mem === true ? 1 : 0, held_hides: int(d.held_hides, 0, 1000, 0) };
  // 管理员确认过收回、客户端也执行完了（报 0），清掉确认标记
  const confirm = dev.confirm_hides === 1 && info.held_hides === 0 ? 0 : dev.confirm_hides;
  if (t - dev.last_seen_at >= SEEN_EVERY_MS || info.app_version !== dev.app_version || info.platform !== dev.platform || info.low_mem !== dev.low_mem
    || info.held_hides !== dev.held_hides || confirm !== dev.confirm_hides) {
    stmts.push(db.prepare('UPDATE devices SET last_seen_at = ?, app_version = ?, platform = ?, mem_mb = ?, low_mem = ?, held_hides = ?, confirm_hides = ? WHERE id = ?')
      .bind(t, info.app_version, info.platform, info.mem_mb, info.low_mem, info.held_hides, confirm, dev.id));
  }

  // 只收这台电脑当前可见的团队号
  const seats = await db.prepare(`SELECT s.account_id, st.state, st.unread, st.proxy_ok, st.proxy_ms, st.exit_ip, st.exit_country, st.exit_changed, st.device_id
    FROM device_seats s JOIN wa_accounts a ON a.id = s.account_id AND a.device_id = s.device_id AND a.deleted_at IS NULL
    LEFT JOIN account_status st ON st.account_id = s.account_id WHERE s.device_id = ? AND s.visible = 1`).bind(dev.id).all();
  const mine = new Map(seats.results.map((r) => [r.account_id, r]));

  const status = Array.isArray(body.status) ? body.status.slice(0, 100) : [];
  for (const raw of status) {
    if (!raw || typeof raw !== 'object') continue;
    const s = cleanStatus(raw);
    const old = mine.get(s.account_id);
    if (!old) continue; // 不是分给这台电脑的号，丢掉
    s.device_id = dev.id;
    if (old.state !== null && SAME_KEYS.every((k) => old[k] === s[k])) continue; // 没变化不写
    stmts.push(db.prepare(`INSERT INTO account_status (account_id, device_id, state, unread, proxy_ok, proxy_ms, exit_ip, exit_country, exit_changed, reported_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${MAY_REPORT}
      ON CONFLICT(account_id) DO UPDATE SET device_id = excluded.device_id, state = excluded.state,
      unread = excluded.unread, proxy_ok = excluded.proxy_ok, proxy_ms = excluded.proxy_ms, exit_ip = excluded.exit_ip,
      exit_country = excluded.exit_country, exit_changed = excluded.exit_changed, reported_at = excluded.reported_at`)
      .bind(s.account_id, dev.id, s.state, s.unread, s.proxy_ok, s.proxy_ms, s.exit_ip, s.exit_country, s.exit_changed, t, s.account_id, dev.id));
  }

  // 状态变化记录：客户端时间按它报的 now 换算成服务器时间
  const clientNow = Number.isFinite(body.now) ? body.now : t;
  const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
  for (const e of events) {
    if (!e || typeof e !== 'object' || !mine.has(e.team_id) || !EVENT_KINDS.includes(e.kind)) continue;
    const detail = country(e.detail) || (DETAIL_ENUM.includes(e.detail) ? e.detail : '');
    const at = Number.isFinite(e.at) ? Math.min(t, Math.max(t - 7 * 864e5, t - (clientNow - e.at))) : t;
    stmts.push(db.prepare(`INSERT INTO status_events (account_id, at, kind, detail)
      SELECT ?, ?, ?, ? WHERE ${MAY_REPORT}`).bind(e.team_id, at, e.kind, detail, e.team_id, dev.id));
  }
  if (stmts.length) await db.batch(stmts);

  // 坐席增量：比客户端手上版本新的显示记录（含显式隐藏）
  const cursor = int(body.cursor, 0, Number.MAX_SAFE_INTEGER, 0);
  const rows = await db.prepare(`SELECT s.account_id, s.visible, s.version, a.device_id, a.deleted_at, a.label, a.color, a.mode, a.expected_country, a.note, a.crm_sync
    FROM device_seats s JOIN wa_accounts a ON a.id = s.account_id WHERE s.device_id = ? AND s.version > ? ORDER BY s.version LIMIT 200`)
    .bind(dev.id, cursor).all();
  const list = rows.results;
  const interval = Math.min(900, Math.max(60, Number(env.SYNC_INTERVAL_S) || 120));
  return json({
    ok: true,
    device_id: dev.id,
    seats: list.map((r) => ({ team_id: r.account_id, visible: r.visible === 1 && r.deleted_at == null && r.device_id === dev.id, name: r.label, color: r.color, mode: r.mode, expected_country: r.expected_country, note: r.note, crm_sync: r.visible === 1 && r.crm_sync === 1 && r.deleted_at == null && r.device_id === dev.id })),
    cursor: list.length ? list[list.length - 1].version : cursor,
    more: list.length === 200,
    allow_private: await allowPrivate(db),
    confirm_hides: dev.confirm_hides === 1,
    next_sync_s: interval,
    server_time: t,
  });
}

export async function handleDevice(request, env, path) {
  if (request.method !== 'POST') return fail(405, '只支持 POST');
  if (path === '/api/device/enroll') return enroll(request, env);
  if (path === '/api/device/join') return join(request, env);
  if (path === '/api/device/sync') return sync(request, env);
  if (path === '/api/device/chats') return uploadChats(request, env, await authDevice(request, env.DB));
  return fail(404, '没有这个接口');
}

