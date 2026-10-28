// 管理后台接口。进来之前 index.js 已经验过 Access JWT，这里按邮箱查人和权限。
// 权限只在这里判断：老板 owner 看全部；主管 supervisor 只管本组；坐席 agent 不能登录后台。
import { pushReady } from './crm.js';
import { json, fail, now, uuid, randomCode, sha256hex, readJson, HttpError, str, oneOf, country, COLORS_RE, audit } from './util.js';

const CODE_TTL_MS = 15 * 60 * 1000;
const ONLINE_MS = 6 * 60 * 1000;

async function resolveAdmin(db, email, env) {
  let user = await db.prepare('SELECT id, name, email, role, group_id, disabled_at FROM users WHERE email = ?').bind(email).first();
  const owner = String(env.OWNER_EMAIL || '').trim().toLowerCase();
  if (!user && owner && email === owner) {
    // 第一次登录的老板：自动建档
    const id = uuid();
    await db.prepare("INSERT INTO users (id, name, email, role, created_at) VALUES (?, ?, ?, 'owner', ?)").bind(id, '老板', email, now()).run();
    await audit(db, id, 'owner.bootstrap', id);
    user = { id, name: '老板', email, role: 'owner', group_id: null, disabled_at: null };
  }
  if (!user || user.disabled_at || user.role === 'agent') throw new HttpError(403, '这个邮箱没有后台权限');
  if (user.role === 'supervisor' && !user.group_id) throw new HttpError(403, '这个主管还没分组，请老板先分组');
  return user;
}

const isOwner = (me) => me.role === 'owner';
const inScope = (me, groupId) => isOwner(me) || (!!groupId && groupId === me.group_id);
function need(cond, msg = '没有权限') { if (!cond) throw new HttpError(403, msg); }
function found(row, msg = '找不到') { if (!row) throw new HttpError(404, msg); return row; }

// 版本由数据库触发器在同一事务中生成，不在提交前分配。
function seatStmt(db, deviceId, accountId, visible) {
  return db.prepare(`INSERT INTO device_seats (device_id, account_id, visible, version) VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id, account_id) DO UPDATE SET visible = excluded.visible`).bind(deviceId, accountId, visible ? 1 : 0, 0);
}

// ---------- 读 ----------

async function me(db, user) {
  const groups = await db.prepare('SELECT id, name FROM groups ORDER BY name').all();
  const ap = await db.prepare("SELECT value FROM meta WHERE key = 'allow_private'").first();
  return json({ user, groups: groups.results, settings: { allow_private: !ap || ap.value !== 0 }, server_time: now() });
}

async function overview(db, user, env) {
  const where = isOwner(user) ? 'WHERE a.deleted_at IS NULL' : 'WHERE a.deleted_at IS NULL AND a.group_id = ?';
  const stmt = db.prepare(`SELECT a.id, a.label, a.number_label, a.group_id, a.mode, a.color, a.expected_country, a.note, a.crm_sync, a.crm_stored, a.crm_dropped, a.crm_pushed_at, a.user_id, a.device_id,
      u.name AS user_name, d.name AS device_name, d.last_seen_at, d.revoked_at, d.app_version,
      st.state, st.unread, st.proxy_ok, st.proxy_ms, st.exit_ip, st.exit_country, st.exit_changed, st.reported_at
    FROM wa_accounts a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN devices d ON d.id = a.device_id
    LEFT JOIN account_status st ON st.account_id = a.id AND st.device_id = a.device_id ${where} ORDER BY a.label`);
  const rows = await (isOwner(user) ? stmt : stmt.bind(user.group_id)).all();
  const t = now();
  const authFail = await db.prepare("SELECT value FROM meta WHERE key = 'crm_auth_fail_at'").first();
  return json({
    server_time: t,
    // 聊天同步：推送开没开、来财最近一次拒绝签名的时间（0 = 没有）
    crm: { push: pushReady(env), auth_fail_at: authFail ? authFail.value : 0 },
    accounts: rows.results.map((r) => ({ ...r, device_online: !!(r.device_id && !r.revoked_at && t - r.last_seen_at < ONLINE_MS) })),
  });
}

async function events(db, user, accountId) {
  const a = found(await db.prepare('SELECT group_id FROM wa_accounts WHERE id = ? AND deleted_at IS NULL').bind(accountId).first());
  need(inScope(user, a.group_id));
  const rows = await db.prepare('SELECT at, kind, detail FROM status_events WHERE account_id = ? ORDER BY at DESC LIMIT 100').bind(accountId).all();
  return json({ events: rows.results });
}

async function listUsers(db, user) {
  const users = await (isOwner(user)
    ? db.prepare('SELECT id, name, email, role, group_id, disabled_at, created_at FROM users ORDER BY role, name')
    : db.prepare('SELECT id, name, email, role, group_id, disabled_at, created_at FROM users WHERE group_id = ? ORDER BY role, name').bind(user.group_id)).all();
  const devices = await (isOwner(user)
    ? db.prepare('SELECT id, user_id, name, app_version, platform, mem_mb, low_mem, held_hides, confirm_hides, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at')
    : db.prepare(`SELECT d.id, d.user_id, d.name, d.app_version, d.platform, d.mem_mb, d.low_mem, d.held_hides, d.confirm_hides, d.created_at, d.last_seen_at, d.revoked_at
        FROM devices d JOIN users u ON u.id = d.user_id WHERE u.group_id = ? ORDER BY d.created_at`).bind(user.group_id)).all();
  return json({ users: users.results, devices: devices.results, server_time: now() });
}

async function auditList(db, user, url) {
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  // 主管只看自己的操作
  const rows = await (isOwner(user)
    ? db.prepare(`SELECT l.id, l.actor_id, u.name AS actor_name, l.action, l.target, l.at, l.detail FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
        WHERE l.id < ? ORDER BY l.id DESC LIMIT 100`).bind(before)
    : db.prepare(`SELECT l.id, l.actor_id, u.name AS actor_name, l.action, l.target, l.at, l.detail FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
        WHERE l.actor_id = ? AND l.id < ? ORDER BY l.id DESC LIMIT 100`).bind(user.id, before)).all();
  return json({ entries: rows.results });
}

// ---------- 人 ----------

async function createUser(db, user, body) {
  const name = str(body.name, 40);
  if (!name) return fail(400, '请填写名字');
  const role = oneOf(body.role, ['owner', 'supervisor', 'agent'], 'agent');
  let groupId = str(body.group_id, 36) || null;
  const email = str(body.email, 120).toLowerCase() || null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, '邮箱格式不对');
  if (!isOwner(user)) {
    need(role === 'agent', '主管只能添加坐席');
    groupId = user.group_id;
  }
  if (role !== 'agent' && !email) return fail(400, '老板和主管要填邮箱（用来登录后台）');
  if (role === 'supervisor' && !groupId) return fail(400, '主管要选一个组');
  if (groupId) found(await db.prepare('SELECT id FROM groups WHERE id = ?').bind(groupId).first(), '没有这个组');
  if (email && await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()) return fail(409, '这个邮箱已经有人用了');
  const id = uuid();
  await db.prepare('INSERT INTO users (id, name, email, role, group_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, name, email, role, groupId, now()).run();
  await audit(db, user.id, 'user.create', id, { name, role, group_id: groupId });
  return json({ id });
}

async function targetUser(db, user, id) {
  const u = found(await db.prepare('SELECT id, name, email, role, group_id, disabled_at FROM users WHERE id = ?').bind(id).first(), '没有这个人');
  if (!isOwner(user)) need(u.role === 'agent' && u.group_id === user.group_id);
  return u;
}

async function updateUser(db, user, id, body) {
  const u = await targetUser(db, user, id);
  const sets = [];
  const vals = [];
  if (body.name !== undefined) { const n = str(body.name, 40); if (!n) return fail(400, '名字不能为空'); sets.push('name = ?'); vals.push(n); }
  if (body.disabled !== undefined) {
    need(u.id !== user.id, '不能停用自己');
    sets.push('disabled_at = ?'); vals.push(body.disabled ? now() : null);
  }
  if (isOwner(user)) {
    if (body.role !== undefined) {
      need(u.id !== user.id, '不能改自己的角色');
      // 不合法的角色直接拒绝，不能退回旧快照写回去（会覆盖并发的角色修改）
      if (!['owner', 'supervisor', 'agent'].includes(body.role)) return fail(400, '角色不对');
      sets.push('role = ?'); vals.push(body.role);
    }
    if (body.group_id !== undefined) {
      const g = str(body.group_id, 36) || null;
      if (g) found(await db.prepare('SELECT id FROM groups WHERE id = ?').bind(g).first(), '没有这个组');
      sets.push('group_id = ?'); vals.push(g);
    }
    if (body.email !== undefined) {
      const e = str(body.email, 120).toLowerCase() || null;
      if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return fail(400, '邮箱格式不对');
      sets.push('email = ?'); vals.push(e);
    }
  }
  if (!sets.length) return json({ ok: true });
  // 校验最终值与 UPDATE 是同一条语句。失败时不写任何字段，也不靠旧快照回滚。
  // 未修改字段直接取数据库当前值，避免并发角色变更使预检查失效。
  const guardVals = [];
  const proposed = (column) => {
    const i = sets.indexOf(`${column} = ?`);
    if (i < 0) return column;
    guardVals.push(vals[i]);
    return '?';
  };
  // 只改名字或停用时不做角色校验：停用是离职流程，不能被旧数据挡住
  const touched = (...cols) => cols.some((c) => sets.includes(`${c} = ?`));
  const guards = [];
  if (touched('role', 'email')) guards.push(`(${proposed('role')} = 'agent' OR ${proposed('email')} IS NOT NULL)`);
  if (touched('role', 'group_id')) guards.push(`(${proposed('role')} <> 'supervisor' OR ${proposed('group_id')} IS NOT NULL)`);
  if (!isOwner(user)) {
    guards.push("role = 'agent' AND group_id = ? AND EXISTS (SELECT 1 FROM users actor WHERE actor.id = ? AND actor.role = 'supervisor' AND actor.disabled_at IS NULL AND actor.group_id = ?)");
    guardVals.push(user.group_id, user.id, user.group_id);
  }
  const valid = guards.length ? guards.join(' AND ') : '1';
  let after;
  try {
    after = await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND ${valid}
      RETURNING role, group_id, email`).bind(...vals, id, ...guardVals).first();
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return fail(409, '这个邮箱已经有人用了');
    throw e;
  }
  if (!after) return isOwner(user)
    ? fail(400, '老板和主管要有邮箱，主管还要选择一个组')
    : fail(403, '权限或员工所属组已变化，请刷新后重试');
  await audit(db, user.id, 'user.update', id, body);
  // 换组不会自动搬走他名下的号：提醒老板，主管的管辖范围按账号的组算
  if (body.group_id !== undefined && isOwner(user)) {
    const left = await db.prepare('SELECT COUNT(*) AS n FROM wa_accounts WHERE user_id = ? AND deleted_at IS NULL AND group_id IS NOT ?').bind(id, after.group_id).first();
    if (left && left.n) return json({ ok: true, warning: `他名下还有 ${left.n} 个号在原来的组。需要的话，到“账号与坐席”里逐个改组。` });
  }
  return json({ ok: true });
}

async function enrollCode(db, user, id) {
  const u = await targetUser(db, user, id);
  if (u.disabled_at) return fail(400, '这个人已被停用');
  const code = randomCode(10);
  const expires = now() + CODE_TTL_MS;
  await db.prepare('INSERT INTO enroll_codes (code_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256hex(code), id, user.id, expires).run();
  await audit(db, user.id, 'device.code', id);
  return json({ code: `${code.slice(0, 5)}-${code.slice(5)}`, expires_at: expires });
}

// ---------- 设备 ----------

async function targetDevice(db, user, id) {
  const d = found(await db.prepare('SELECT d.id, d.user_id, d.revoked_at, u.group_id, u.role FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?').bind(id).first(), '没有这台电脑');
  if (!isOwner(user)) need(d.role === 'agent' && d.group_id === user.group_id);
  return d;
}

async function setDeviceRevoked(db, user, id, revoked) {
  await targetDevice(db, user, id);
  await db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').bind(revoked ? now() : null, id).run();
  await audit(db, user.id, revoked ? 'device.revoke' : 'device.restore', id);
  return json({ ok: true });
}

// 客户端一次要隐藏一半以上的号时会暂停执行并上报；管理员确认后下次同步才执行
async function confirmHides(db, user, id) {
  await targetDevice(db, user, id);
  await db.prepare('UPDATE devices SET confirm_hides = 1 WHERE id = ? AND held_hides > 0').bind(id).run();
  await audit(db, user.id, 'device.confirm_hides', id);
  return json({ ok: true });
}

async function renameDevice(db, user, id, body) {
  await targetDevice(db, user, id);
  const name = str(body.name, 40);
  if (!name) return fail(400, '名字不能为空');
  await db.prepare('UPDATE devices SET name = ? WHERE id = ?').bind(name, id).run();
  await audit(db, user.id, 'device.rename', id, { name });
  return json({ ok: true });
}

// ---------- 账号（坐席） ----------

async function targetAccount(db, user, id) {
  const a = found(await db.prepare('SELECT id, group_id, user_id, device_id FROM wa_accounts WHERE id = ? AND deleted_at IS NULL').bind(id).first(), '没有这个账号');
  need(inScope(user, a.group_id));
  return a;
}

async function updateAccount(db, user, id, body) {
  const a = await targetAccount(db, user, id);
  const sets = [];
  const vals = [];
  if (body.label !== undefined) { const v = str(body.label, 40); if (!v) return fail(400, '名称不能为空'); sets.push('label = ?'); vals.push(v); }
  if (body.number_label !== undefined) { sets.push('number_label = ?'); vals.push(str(body.number_label, 40)); }
  if (body.color !== undefined) { sets.push('color = ?'); vals.push(typeof body.color === 'string' && COLORS_RE.test(body.color) ? body.color : ''); }
  if (body.expected_country !== undefined) { sets.push('expected_country = ?'); vals.push(country(body.expected_country)); }
  if (body.note !== undefined) { sets.push('note = ?'); vals.push(str(body.note, 500)); }
  if (body.crm_sync !== undefined) {
    need(isOwner(user), '只有老板能开关聊天同步');
    sets.push('crm_sync = ?'); vals.push(body.crm_sync === true ? 1 : 0);
  }
  if (body.group_id !== undefined) {
    need(isOwner(user), '只有老板能改账号的组');
    const g = str(body.group_id, 36) || null;
    if (g) found(await db.prepare('SELECT id FROM groups WHERE id = ?').bind(g).first(), '没有这个组');
    sets.push('group_id = ?'); vals.push(g);
  }
  if (!sets.length) return json({ ok: true });
  sets.push('updated_at = ?'); vals.push(now());
  const stmts = [db.prepare(`UPDATE wa_accounts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id)];
  // 关掉聊天同步：这个号还没推出去的聊天一起删
  if (body.crm_sync !== undefined && body.crm_sync !== true) stmts.push(db.prepare('DELETE FROM crm_batches WHERE account_id = ?').bind(id));
  // 用事务内的当前归属刷新版本，不能用请求开始时读到的旧 device_id。
  stmts.push(db.prepare(`UPDATE device_seats SET visible = visible WHERE account_id = ? AND visible = 1
    AND device_id = (SELECT device_id FROM wa_accounts WHERE id = ?)`).bind(id, id));
  await db.batch(stmts);
  await audit(db, user.id, 'account.update', id, body);
  // 开 / 关聊天同步单独记一笔，方便以后查是谁、什么时候打开的
  if (body.crm_sync !== undefined) await audit(db, user.id, body.crm_sync === true ? 'account.crm_on' : 'account.crm_off', id);
  return json({ ok: true });
}

async function assignAccount(db, user, id, body) {
  const a = await targetAccount(db, user, id);
  const deviceId = str(body.device_id, 36);
  const d = await targetDevice(db, user, deviceId);
  if (d.revoked_at) return fail(400, '这台电脑已停用');
  if (!isOwner(user)) need(d.group_id === a.group_id, '只能分给本组的人');
  const stmts = [];
  // 同一事务撤掉所有旧坐席，避免并发请求各自依据过时的归属留下有效坐席。
  stmts.push(db.prepare('UPDATE device_seats SET visible = 0 WHERE account_id = ? AND visible = 1').bind(id));
  stmts.push(db.prepare('UPDATE wa_accounts SET user_id = ?, device_id = ?, updated_at = ? WHERE id = ?').bind(d.user_id, deviceId, now(), id));
  stmts.push(seatStmt(db, deviceId, id, true));
  await db.batch(stmts);
  await audit(db, user.id, 'account.assign', id, { from: a.device_id, to: deviceId });
  return json({ ok: true });
}

async function unassignAccount(db, user, id) {
  const a = await targetAccount(db, user, id);
  await db.batch([
    db.prepare('UPDATE device_seats SET visible = 0 WHERE account_id = ? AND visible = 1').bind(id),
    db.prepare('UPDATE wa_accounts SET user_id = NULL, device_id = NULL, updated_at = ? WHERE id = ?').bind(now(), id),
  ]);
  await audit(db, user.id, 'account.unassign', id, { from: a.device_id });
  return json({ ok: true });
}

async function deleteAccount(db, user, id) {
  need(isOwner(user), '只有老板能删除账号记录');
  const a = await targetAccount(db, user, id);
  if (a.device_id) return fail(400, '先收回这个号，再删除记录');
  // 软删除：保留账号行和 visible=0 的显示记录。收回时离线的电脑，下次同步还能收到隐藏。
  // 名称、备注清空，后台列表里不再显示
  await db.batch([
    db.prepare('DELETE FROM account_status WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM status_events WHERE account_id = ?').bind(id),
    db.prepare('DELETE FROM crm_batches WHERE account_id = ?').bind(id),
    db.prepare("UPDATE wa_accounts SET deleted_at = ?, crm_sync = 0, label = '已删除', number_label = '', note = '', expected_country = '', updated_at = ? WHERE id = ?").bind(now(), now(), id),
  ]);
  await audit(db, user.id, 'account.delete', id);
  return json({ ok: true });
}

// ---------- 组和设置 ----------

async function createGroup(db, user, body) {
  need(isOwner(user));
  const name = str(body.name, 40);
  if (!name) return fail(400, '请填写组名');
  const id = uuid();
  await db.prepare('INSERT INTO groups (id, name) VALUES (?, ?)').bind(id, name).run();
  await audit(db, user.id, 'group.create', id, { name });
  return json({ id });
}

async function updateSettings(db, user, body) {
  need(isOwner(user));
  if (typeof body.allow_private === 'boolean') {
    await db.prepare("UPDATE meta SET value = ? WHERE key = 'allow_private'").bind(body.allow_private ? 1 : 0).run();
    await audit(db, user.id, 'settings.update', 'allow_private', { allow_private: body.allow_private });
  }
  return json({ ok: true });
}

// ---------- 路由 ----------

export async function handleAdmin(request, env, path, identity) {
  const db = env.DB;
  const user = await resolveAdmin(db, identity.email, env);
  const m = request.method;
  // 改数据的请求必须带自定义头并且是 JSON，挡住跨站表单
  if (m !== 'GET' && request.headers.get('x-waswitch-admin') !== '1') return fail(403, '缺少请求头');
  const body = m === 'POST' || m === 'PATCH' || m === 'PUT' ? await readJson(request) : null;
  const url = new URL(request.url);
  const seg = path.slice('/api/admin/'.length).split('/');
  const id = seg[1] || '';
  if (id && !/^[0-9a-f-]{36}$/.test(id)) return fail(404, '没有这个接口');
  const route = `${m} ${seg[0]}${seg.length > 1 ? '/:id' : ''}${seg[2] ? `/${seg[2]}` : ''}`;
  switch (route) {
    case 'GET me': return me(db, user);
    case 'GET overview': return overview(db, user, env);
    case 'GET accounts/:id/events': return events(db, user, id);
    case 'PATCH accounts/:id': return updateAccount(db, user, id, body);
    case 'POST accounts/:id/assign': return assignAccount(db, user, id, body);
    case 'POST accounts/:id/unassign': return unassignAccount(db, user, id);
    case 'DELETE accounts/:id': return deleteAccount(db, user, id);
    case 'GET users': return listUsers(db, user);
    case 'POST users': return createUser(db, user, body);
    case 'PATCH users/:id': return updateUser(db, user, id, body);
    case 'POST users/:id/enroll-code': return enrollCode(db, user, id);
    case 'PATCH devices/:id': return renameDevice(db, user, id, body);
    case 'POST devices/:id/revoke': return setDeviceRevoked(db, user, id, true);
    case 'POST devices/:id/restore': return setDeviceRevoked(db, user, id, false);
    case 'POST devices/:id/confirm-hides': return confirmHides(db, user, id);
    case 'POST groups': return createGroup(db, user, body);
    case 'PUT settings': return updateSettings(db, user, body);
    case 'GET audit': return auditList(db, user, url);
    default: return fail(404, '没有这个接口');
  }
}

