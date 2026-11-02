// 团队后台自检：node server/test/run.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fakeD1 } from './fake-d1.mjs';
import worker from '../src/index.js';
import { chunkMessages } from '../src/crm.js';
import { _resetCertCache } from '../src/access.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOMAIN = 'acme.cloudflareaccess.com';
const AUD = 'aud-123';

// ---- 假的 Access 公钥和 JWT ----
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
let certFetches = 0;
globalThis.fetch = async (url) => {
  assert.equal(url, `https://${DOMAIN}/cdn-cgi/access/certs`);
  certFetches += 1;
  return new Response(JSON.stringify({ keys: [{ ...pub, kid: 'k1' }] }), { headers: { 'content-type': 'application/json' } });
};
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
async function jwt(email, { aud = AUD, iss = `https://${DOMAIN}`, exp = Math.floor(Date.now() / 1000) + 600, key = kp.privateKey, kid = 'k1' } = {}) {
  const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
  const body = enc({ email, aud: [aud], iss, exp, iat: Math.floor(Date.now() / 1000) });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}

const db = fakeD1(path.join(here, '../migrations'));
const env = { DB: db, SYNC_INTERVAL_S: '120', ASSETS: { fetch: async () => new Response('<html>admin</html>', { headers: { 'content-type': 'text/html' } }) } };
const PW = 'correct horse 1';
const SETUP = 'test-setup-code-0123';

async function call(method, p, { token, body, jwtFor, headers = {}, rawJwt, ip } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (jwtFor) h['cf-access-jwt-assertion'] = await jwt(jwtFor);
  if (rawJwt) h['cf-access-jwt-assertion'] = rawJwt;
  if (ip) h['cf-connecting-ip'] = ip;
  if (method !== 'GET' && p.startsWith('/api/admin/') && h['x-waswitch-admin'] === undefined) h['x-waswitch-admin'] = '1';
  const res = await worker.fetch(new Request(`https://team.example.com${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, {});
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
// 后台：按登录名登录一次，之后带会话令牌
const sessions = new Map();
async function sessionFor(login, password = PW) {
  if (!sessions.has(login)) {
    const r = await call('POST', '/api/admin/session', { body: { login, password } });
    assert.equal(r.status, 200, `${login} 登录后台：${JSON.stringify(r.data)}`);
    sessions.set(login, r.data.token);
  }
  return sessions.get(login);
}
const admin = (login) => {
  const go = async (method, p, body) => call(method, `/api/admin/${p}`, { token: await sessionFor(login), body });
  return { get: (p) => go('GET', p), post: (p, body = {}) => go('POST', p, body), patch: (p, body) => go('PATCH', p, body), put: (p, body) => go('PUT', p, body), del: (p) => go('DELETE', p) };
};
const sync = (token, body) => call('POST', '/api/device/sync', { token, body: { v: 1, now: Date.now(), cursor: 0, ...body } });
const devLogin = (login, password, extra = {}) => call('POST', '/api/device/login', { body: { v: 1, login, password, device: { name: '笔记本', app_version: '1.0.5', platform: 'mac' }, ...extra }, ip: extra.ip });
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

console.log('团队后台自检');

await test('没登录：管理接口 401；后台页面直接给（里面没有数据）；别的地址 404', async () => {
  assert.equal((await call('GET', '/api/admin/me')).status, 401);
  assert.equal((await call('GET', '/api/admin/me', { token: 'A'.repeat(43) })).status, 401);
  const page = await call('GET', '/admin/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.equal((await call('GET', '/anything')).status, 404);
});
await test('绕路径：点段被规范化后仍要会话；编码斜杠和重复斜杠直接 404', async () => {
  assert.equal((await call('GET', '/api/device/%2e%2e/admin/me')).status, 401);
  assert.equal((await call('GET', '/api/device%2f..%2fadmin/me')).status, 404);
  assert.equal((await call('GET', '/api//admin/me')).status, 404);
});
await test('初始化：没设 SETUP_CODE 一律拒绝', async () => {
  assert.deepEqual((await call('GET', '/api/admin/setup')).data, { enabled: false, needed: true });
  assert.equal((await call('POST', '/api/admin/setup', { body: { code: '', login: 'boss', password: PW } })).status, 403);
  env.SETUP_CODE = 'short';
  assert.equal((await call('POST', '/api/admin/setup', { body: { code: 'short', login: 'boss', password: PW } })).status, 403, '太短的口令不算设置了');
  env.SETUP_CODE = SETUP;
});
await test('初始化：口令不对、登录名不合格、密码太短都拒绝；不带自定义头拒绝', async () => {
  assert.equal((await call('POST', '/api/admin/setup', { body: { code: 'wrong-code-000000', login: 'boss', password: PW } })).status, 400);
  assert.equal((await call('POST', '/api/admin/setup', { body: { code: SETUP, login: '老板', password: PW } })).status, 400);
  assert.equal((await call('POST', '/api/admin/setup', { body: { code: SETUP, login: 'boss', password: 'short' } })).status, 400);
  assert.equal((await call('POST', '/api/admin/setup', { body: { code: SETUP, login: 'boss', password: PW }, headers: { 'x-waswitch-admin': '' } })).status, 403);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  const fails = db.raw.prepare("SELECT detail FROM audit_log WHERE action = 'admin.setup_fail'").all();
  assert.ok(fails.length >= 1 && !JSON.stringify(fails).includes('wrong-code'), '记失败，不记口令');
});
let ownerId;
await test('初始化：建出老板并直接登录；库里只有哈希；之后只能用口令重置老板密码', async () => {
  const r = await call('POST', '/api/admin/setup', { body: { code: SETUP, name: '老板', login: ' Boss ', password: 'first password' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.created, true);
  const row = db.raw.prepare('SELECT * FROM users').get();
  ownerId = row.id;
  assert.deepEqual([row.role, row.login_name, row.pass_iter], ['owner', 'boss', 100000]);
  assert.equal(row.pass_hash.length, 64);
  assert.ok(!JSON.stringify(row).includes('first password'));
  assert.equal((await call('GET', '/api/admin/me', { token: r.data.token })).data.user.role, 'owner');
  assert.equal((await call('GET', '/api/admin/setup')).data.needed, false);
  // 再用口令：不会多建一个老板，而是重置这个老板的密码，旧会话失效
  assert.equal((await call('POST', '/api/admin/setup', { body: { code: SETUP, name: 'x', login: 'someone', password: PW } })).status, 400);
  const again = await call('POST', '/api/admin/setup', { body: { code: SETUP, login: 'BOSS', password: PW } });
  assert.equal(again.status, 200);
  assert.equal(again.data.created, false);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get().n, 1);
  assert.equal((await call('GET', '/api/admin/me', { token: r.data.token })).status, 401);
  assert.equal((await call('POST', '/api/admin/session', { body: { login: 'boss', password: 'first password' } })).status, 400);
});
await test('初始化：两个请求同时到只建出一个老板', async () => {
  const fresh = fakeD1(path.join(here, '../migrations'));
  const e2 = { ...env, DB: fresh };
  const req = (login) => worker.fetch(new Request('https://team.example.com/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-waswitch-admin': '1' }, body: JSON.stringify({ code: SETUP, login, password: PW }) }), e2, {});
  const rs = await Promise.all([req('boss1'), req('boss2')]);
  assert.equal(fresh.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get().n, 1);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400]);
});
const boss = admin('boss');
await test('后台登录：错的密码和不存在的登录名回一样的话；退出后会话失效；过期的会话失效', async () => {
  const bad = await call('POST', '/api/admin/session', { body: { login: 'boss', password: 'nope nope' } });
  const none = await call('POST', '/api/admin/session', { body: { login: 'ghost', password: 'nope nope' } });
  assert.deepEqual([bad.status, none.status], [400, 400]);
  assert.equal(bad.data.error, none.data.error);
  const r = await call('POST', '/api/admin/session', { body: { login: 'boss', password: PW } });
  assert.equal(r.status, 200);
  assert.ok(r.data.expires_at - Date.now() > 11.9 * 3600e3 && r.data.expires_at - Date.now() <= 12 * 3600e3);
  assert.equal((await call('GET', '/api/admin/me', { token: r.data.token })).status, 200);
  assert.equal((await call('DELETE', '/api/admin/session', { token: r.data.token })).status, 200);
  assert.equal((await call('GET', '/api/admin/me', { token: r.data.token })).status, 401);
  const r2 = await call('POST', '/api/admin/session', { body: { login: 'boss', password: PW } });
  db.raw.prepare('UPDATE admin_sessions SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await call('GET', '/api/admin/me', { token: r2.data.token })).status, 401);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM admin_sessions WHERE token_hash = ?').get(r2.data.token)?.n, 0, '库里不存明文令牌');
  db.raw.prepare('DELETE FROM admin_sessions').run();
  sessions.clear();
});
await test('改数据的请求不带自定义头就拒绝', async () => {
  const r = await call('POST', '/api/admin/groups', { token: await sessionFor('boss'), body: { name: 'x' }, headers: { 'x-waswitch-admin': '' } });
  assert.equal(r.status, 403);
});
await test('配了 Cloudflare Access 时两道都要过；只配一半一律拒绝；设备接口不受影响', async () => {
  const tok = await sessionFor('boss');
  Object.assign(env, { ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD });
  assert.equal((await call('GET', '/api/admin/me', { token: tok })).status, 403, '只有会话');
  assert.equal((await call('GET', '/api/admin/me', { jwtFor: 'boss@example.com' })).status, 401, '只有 Access');
  assert.equal((await call('GET', '/api/admin/me', { token: tok, jwtFor: 'boss@example.com' })).status, 200);
  assert.equal((await call('GET', '/admin/')).status, 403);
  assert.equal((await call('POST', '/api/admin/session', { body: { login: 'boss', password: PW } })).status, 403);
  for (const bad of [await jwt('boss@example.com', { aud: 'x' }), await jwt('boss@example.com', { iss: 'https://evil.cloudflareaccess.com' }),
    await jwt('boss@example.com', { exp: 1 }), await jwt('boss@example.com', { key: other.privateKey })]) {
    assert.equal((await call('GET', '/api/admin/me', { token: tok, rawJwt: bad })).status, 403);
  }
  _resetCertCache(); certFetches = 0;
  for (let i = 0; i < 5; i += 1) await call('GET', '/api/admin/me', { token: tok, jwtFor: 'boss@example.com' });
  assert.equal(certFetches, 1, 'Access 公钥有缓存');
  env.ACCESS_TEAM_DOMAIN = '';
  assert.equal((await call('GET', '/api/admin/me', { token: tok, jwtFor: 'boss@example.com' })).status, 403);
  assert.equal((await call('GET', '/api/device/policy')).status, 200);
  env.ACCESS_AUD = '';
  assert.equal((await call('GET', '/api/admin/me', { token: tok })).status, 200);
});

let gA, gB, sup, agentA, agentB;
await test('建组、主管、坐席：要填登录名和初始密码；主管只能加本组坐席', async () => {
  gA = (await boss.post('groups', { name: 'A 组' })).data.id;
  gB = (await boss.post('groups', { name: 'B 组' })).data.id;
  sup = (await boss.post('users', { name: '主管甲', login_name: 'Sup', password: PW, role: 'supervisor', group_id: gA })).data.id;
  assert.ok(sup);
  assert.equal((await boss.post('users', { name: '没登录名', password: PW, role: 'supervisor', group_id: gA })).status, 400);
  assert.equal((await boss.post('users', { name: '密码太短', login_name: 'short', password: '1234567' })).status, 400);
  assert.equal((await boss.post('users', { name: '重名', login_name: 'SUP', password: PW })).status, 409);
  assert.equal((await boss.post('users', { name: '没组主管', login_name: 'nogroup', password: PW, role: 'supervisor' })).status, 400);
  const s = admin('sup');
  assert.equal((await s.post('users', { name: '想当主管', login_name: 'x1', password: PW, role: 'supervisor' })).status, 403);
  agentA = (await s.post('users', { name: '坐席A', login_name: 'anna', password: PW, group_id: gB })).data.id; // group_id 被忽略，强制本组
  agentB = (await boss.post('users', { name: '坐席B', login_name: 'ben', password: PW, group_id: gB })).data.id;
  const list = (await s.get('users')).data.users;
  assert.deepEqual(list.map((u) => u.name).sort(), ['主管甲', '坐席A'].sort());
  assert.ok(list.every((u) => u.has_password === 1 && !('pass_hash' in u) && !('pass_salt' in u)), '密码哈希不发给网页');
});
await test('坐席不能登录后台', async () => {
  const r = await call('POST', '/api/admin/session', { body: { login: 'anna', password: PW } });
  assert.equal(r.status, 403);
});

let codeA, tokA, devA, acc1, acc2;
await test('登记码只能用一次；登记时带上本机账号', async () => {
  codeA = (await admin('sup').post(`users/${agentA}/enroll-code`)).data.code;
  assert.match(codeA, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const body = { v: 1, code: codeA.toLowerCase(), device: { name: '前台电脑', app_version: '0.4.0', platform: 'win' },
    accounts: [{ local_id: '1700000000001', name: '美国号', color: '#25d366', mode: 'web' }, { local_id: '1700000000002', name: '小号', mode: 'lite' }, { local_id: '../x', name: '坏的' }] };
  const r = await call('POST', '/api/device/enroll', { body });
  assert.equal(r.status, 200);
  assert.equal(r.data.accounts.length, 2);
  tokA = r.data.token; devA = r.data.device_id;
  [acc1, acc2] = r.data.accounts.map((a) => a.team_id);
  assert.equal((await call('POST', '/api/device/enroll', { body })).status, 400);
  const row = db.raw.prepare('SELECT token_hash FROM devices WHERE id = ?').get(devA);
  assert.notEqual(row.token_hash, tokA);
  assert.equal(row.token_hash.length, 64);
});
await test('协议版本不对返回 426', async () => {
  assert.equal((await call('POST', '/api/device/sync', { token: tokA, body: { v: 99 } })).status, 426);
});

await test('同步：拿到坐席；只收分给自己的号和白名单字段', async () => {
  const r = await sync(tokA, {
    device: { app_version: '0.4.0', platform: 'win', mem_mb: 900, hostname: 'SECRET-PC' },
    status: [
      { team_id: acc1, state: 'ready', unread: 3, proxy_ok: true, proxy_ms: 120, exit_ip: '1.2.3.4', exit_country: 'US', message: '你好，这是聊天内容', proxy_password: 'p' },
      { team_id: '00000000-0000-0000-0000-000000000000', state: 'ready', unread: 1 },
    ],
    events: [{ team_id: acc1, kind: 'dropped', at: Date.now() - 1000, detail: '错误原文 C:\\Users\\bob' }, { team_id: acc1, kind: 'exit_changed', detail: 'DE' }, { team_id: acc1, kind: 'hacked' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.seats.length, 2);
  assert.ok(r.data.seats.every((s) => s.visible === true));
  assert.equal(r.data.next_sync_s, 120);
  const st = db.raw.prepare('SELECT * FROM account_status').all();
  assert.equal(st.length, 1);
  assert.equal(st[0].unread, 3);
  const dump = JSON.stringify(db.raw.prepare('SELECT * FROM account_status').all()) + JSON.stringify(db.raw.prepare('SELECT * FROM status_events').all()) + JSON.stringify(db.raw.prepare('SELECT * FROM devices').all());
  for (const secret of ['聊天内容', 'proxy_password', 'SECRET-PC', 'bob', 'hacked']) assert.ok(!dump.includes(secret), `不该存 ${secret}`);
  const ev = db.raw.prepare('SELECT kind, detail FROM status_events ORDER BY id').all().map((e) => ({ ...e }));
  assert.deepEqual(ev, [{ kind: 'dropped', detail: '' }, { kind: 'exit_changed', detail: 'DE' }]);
});
await test('状态没变化时不写数据库（省免费写入额度）', async () => {
  const before = db.writes;
  db.raw.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), devA);
  const r = await sync(tokA, { device: { app_version: '0.4.0', platform: 'win', mem_mb: 950 }, status: [{ team_id: acc1, state: 'ready', unread: 3, proxy_ok: true, proxy_ms: 120, exit_ip: '1.2.3.4', exit_country: 'US' }], cursor: 999 });
  assert.equal(r.status, 200);
  assert.equal(db.writes, before);
});

let tokB, devB;
await test('换人：原电脑收到显式隐藏，新电脑收到显示', async () => {
  const code = (await boss.post(`users/${agentA}/enroll-code`)).data.code;
  const r = await call('POST', '/api/device/enroll', { body: { v: 1, code, device: { name: '第二台' }, accounts: [] } });
  tokB = r.data.token; devB = r.data.device_id;
  const first = await sync(tokA, {});
  const cursorA = first.data.cursor;
  assert.equal((await admin('sup').post(`accounts/${acc1}/assign`, { device_id: devB })).status, 200);
  const a = await sync(tokA, { cursor: cursorA });
  assert.deepEqual(a.data.seats.map((s) => [s.team_id, s.visible]), [[acc1, false]]);
  const b = await sync(tokB, {});
  assert.deepEqual(b.data.seats.map((s) => [s.team_id, s.visible]), [[acc1, true]]);
  // 原电脑再报 acc1 的状态会被丢掉
  await sync(tokA, { status: [{ team_id: acc1, state: 'needs_qr', unread: 0 }] });
  assert.equal(db.raw.prepare('SELECT state FROM account_status WHERE account_id = ?').get(acc1).state, 'ready');
});
await test('改账号名称后，持有它的电脑拿到新名称；备注只从后台下发', async () => {
  const before = (await sync(tokB, {})).data.cursor;
  await boss.patch(`accounts/${acc1}`, { label: '美国号-新', note: '只接美国客户', expected_country: 'us' });
  const r = await sync(tokB, { cursor: before });
  assert.equal(r.data.seats[0].name, '美国号-新');
  assert.equal(r.data.seats[0].note, '只接美国客户');
  assert.equal(r.data.seats[0].expected_country, '');
});
await test('同步到 CRM 的开关：只有老板能开，随坐席下发', async () => {
  const before = (await sync(tokB, {})).data.cursor;
  assert.equal((await admin('sup').patch(`accounts/${acc1}`, { crm_sync: true })).status, 403);
  assert.equal((await boss.patch(`accounts/${acc1}`, { crm_sync: true })).status, 200);
  const r = await sync(tokB, { cursor: before });
  assert.equal(r.data.seats[0].crm_sync, true);
  assert.equal((await boss.get('overview')).data.accounts.find((a) => a.id === acc1).crm_sync, 1);
  await boss.patch(`accounts/${acc1}`, { crm_sync: false });
  const actions = db.raw.prepare('SELECT action FROM audit_log WHERE target = ? ORDER BY at').all(acc1).map((r) => r.action);
  assert.ok(actions.includes('account.crm_on') && actions.includes('account.crm_off'), '开关聊天同步要记操作记录');
  assert.equal((await sync(tokB, { cursor: r.data.cursor })).data.seats[0].crm_sync, false);
});
// ---- 同步到 CRM 第 2 步：上传、加密暂存、推给来财 ----
const CRM_SECRET = 'test-laicrm-secret-0123456789abcdef';
const laicrm = { calls: [], mode: 'ok', seen: new Set(),
  async fetch(req) {
    const body = await req.text();
    const ts = req.headers.get('x-waswitch-timestamp');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(CRM_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`))).toString('hex');
    assert.equal(req.headers.get('x-waswitch-signature'), `sha256=${sig}`, '签名要对');
    assert.ok(Math.abs(Date.now() - Number(ts)) < 60000);
    assert.ok(Buffer.byteLength(body) <= 256 * 1024, '每批不超过 256 KB');
    const data = JSON.parse(body);
    laicrm.calls.push(data);
    if (laicrm.mode === '500') return new Response('x', { status: 500 });
    if (laicrm.mode === '401') return new Response('x', { status: 401 });
    const results = data.messages.map((m) => ({ id: m.id, status: m.peer !== '447700900123' ? 'unmatched' : laicrm.seen.has(m.id) ? 'duplicate' : (laicrm.seen.add(m.id), 'stored') }));
    if (laicrm.mode === 'partial') results.pop();
    if (laicrm.mode === 'foreign') results[0] = { id: 'f'.repeat(32), status: 'stored' };
    return new Response(JSON.stringify({ results }), { headers: { 'content-type': 'application/json' } });
  } };
const chats = (token, team_id, items) => call('POST', '/api/device/chats', { token, body: { v: 1, team_id, items } });
const cron = () => worker.scheduled({ cron: '*/30 * * * *' }, env);
const msg = (k, extra = {}) => ({ k, peer: '447700900123', out: false, at: Date.now() - 60000, approx: false, text: '你好 price list', ...extra });
const resetRate = () => db.raw.prepare("DELETE FROM rate_limits WHERE key LIKE 'chats:%'").run();

await test('CRM 上传：推送没配齐时回 503，电脑留着本机队列', async () => {
  await boss.patch(`accounts/${acc1}`, { crm_sync: true });
  const r = await chats(tokB, acc1, [msg('3EB0AAAA0001')]);
  assert.equal(r.status, 503);
  assert.equal(r.data.crm_paused, true);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM crm_batches').get().n, 0);
});
Object.assign(env, { CRM_PUSH: '1', CRM_KEY: Buffer.alloc(32, 7).toString('base64'), LAICRM_SECRET: CRM_SECRET, LAICRM: laicrm });
await test('CRM 上传：只收这台电脑上、开着同步的号；不合格的条目拒收', async () => {
  assert.equal((await chats(tokA, acc1, [msg('3EB0AAAA0001')])).status, 409, '号不在这台电脑上');
  assert.equal((await chats(tokB, acc2, [msg('3EB0AAAA0001')])).status, 409);
  const r = await chats(tokB, acc1, [msg('3EB0AAAA0001'), msg('3EB0AAAA0002', { at: Date.now() - 120000, out: true }), msg('bad', { peer: '12345' }), msg('3EB0AAAA0003', { peer: '1234567890123456' }), { k: '../x' }]);
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.accepted, r.data.rejected], [2, 3]);
  const dump = JSON.stringify(db.raw.prepare('SELECT * FROM crm_batches').all());
  assert.ok(!dump.includes('price') && !dump.includes('447700900123'), '暂存的是密文');
});
await test('CRM 上传：每个号每 10 分钟最多 3 次', async () => {
  assert.equal((await chats(tokB, acc1, [])).status, 200);
  assert.equal((await chats(tokB, acc1, [])).status, 200);
  assert.equal((await chats(tokB, acc1, [])).status, 429);
  resetRate();
});
await test('CRM 推送：签名、按时间排序、消息编号稳定；写进来财后删掉，对不上的也删、只计数', async () => {
  await chats(tokB, acc1, [msg('3EB0AAAA0004', { peer: '8613800000000' })]);
  laicrm.calls = [];
  await cron();
  assert.equal(laicrm.calls.length, 2);
  const first = laicrm.calls[0];
  assert.equal(first.account.id, acc1);
  assert.equal(first.staff.name, '坐席A');
  assert.ok(first.messages.every((m) => /^[0-9a-f]{32}$/.test(m.id)));
  assert.deepEqual(first.messages.map((m) => m.dir), ['out', 'in'], '按时间从早到晚');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM crm_batches').get().n, 0);
  const a = db.raw.prepare('SELECT crm_stored, crm_dropped FROM wa_accounts WHERE id = ?').get(acc1);
  assert.deepEqual([a.crm_stored, a.crm_dropped], [2, 1]);
  // 同一条消息再传一次（比如换了电脑）：编号一样，来财回 duplicate
  resetRate();
  await chats(tokB, acc1, [msg('3EB0AAAA0001')]);
  laicrm.calls = [];
  await cron();
  assert.equal(laicrm.calls[0].messages[0].id, first.messages[1].id);
  assert.equal(db.raw.prepare('SELECT crm_stored FROM wa_accounts WHERE id = ?').get(acc1).crm_stored, 3);
});
await test('CRM 推送：来财出错、少回结果、回了不是这批的编号时整批留着下一轮重推', async () => {
  for (const mode of ['500', 'partial', 'foreign']) {
    resetRate();
    await chats(tokB, acc1, [msg(`3EB0BBBB${mode}`.replace(/[^A-Za-z0-9]/g, 'X')), msg('3EB0BBBB0002')]);
    laicrm.mode = mode;
    await cron();
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM crm_batches').get().n, 1, mode);
    laicrm.mode = 'ok';
    await cron();
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM crm_batches').get().n, 0, mode);
  }
});
await test('CRM 推送：签名被拒时停推并在后台提示，恢复后提示消失', async () => {
  resetRate();
  await chats(tokB, acc1, [msg('3EB0CCCC0001')]);
  laicrm.mode = '401';
  await cron();
  assert.ok((await boss.get('overview')).data.crm.auth_fail_at > 0);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM crm_batches').get().n, 1);
  laicrm.mode = 'ok';
  await cron();
  const o = (await boss.get('overview')).data;
  assert.equal(o.crm.auth_fail_at, 0);
  assert.equal(o.crm.push, true);
});
await test('CRM 推送：长中文消息按字节拆成多批，每批 ≤256 KB', async () => {
  const msgs = Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(32, '0'), peer: '447700900123', dir: 'in', at: i, approx: false, text: '中'.repeat(3000) }));
  const parts = chunkMessages({ v: 1, batch_id: 'x', account: { id: 'a', label: '号', phone: '' }, staff: { name: '' } }, msgs);
  assert.ok(parts.length >= 4);
  assert.equal(parts.flat().length, 100);
  for (const p of parts) assert.ok(Buffer.byteLength(JSON.stringify({ v: 1, batch_id: 'x', account: { id: 'a', label: '号', phone: '' }, staff: { name: '' }, messages: p })) <= 256 * 1024);
});
await test('CRM：关掉同步时，没推出去的聊天一起删；超过 7 天的也删', async () => {
  resetRate();
  await chats(tokB, acc1, [msg('3EB0DDDD0001')]);
  await boss.patch(`accounts/${acc1}`, { crm_sync: false });
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM crm_batches').get().n, 0);
  db.raw.prepare("INSERT INTO crm_batches (id, account_id, device_id, n, iv, data, created_at) VALUES ('old', ?, ?, 1, 'x', 'x', ?)").run(acc1, devB, Date.now() - 8 * 864e5);
  await cron();
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM crm_batches').get().n, 0);
  Object.assign(env, { CRM_PUSH: '0' });
});
await test('主管看不到别组的号，也不能分配', async () => {
  const s = admin('sup');
  await boss.patch(`accounts/${acc2}`, { group_id: gB });
  const ov = (await s.get('overview')).data.accounts.map((a) => a.id);
  assert.ok(ov.includes(acc1) && !ov.includes(acc2));
  assert.equal((await s.post(`accounts/${acc2}/unassign`)).status, 403);
  assert.equal((await s.get(`accounts/${acc2}/events`)).status, 403);
});
await test('停用电脑：同步返回 403 + revoked + 本机 id；假令牌只是 401', async () => {
  assert.equal((await boss.post(`devices/${devA}/revoke`)).status, 200);
  const r = await sync(tokA, {});
  assert.equal(r.status, 403);
  assert.equal(r.data.revoked, true);
  assert.equal(r.data.device_id, devA);
  const fake = await sync('A'.repeat(43), {});
  assert.equal(fake.status, 401);
  assert.equal(fake.data.revoked, undefined);
  await boss.post(`devices/${devA}/restore`);
  assert.equal((await sync(tokA, {})).status, 200);
});
await test('停用员工等于停用他的所有电脑', async () => {
  await boss.patch(`users/${agentA}`, { disabled: true });
  assert.equal((await sync(tokB, {})).data.revoked, true);
  await boss.patch(`users/${agentA}`, { disabled: false });
});
await test('收回后才能删除记录；只有老板能删；删除是软删除，离线的电脑之后仍收到隐藏', async () => {
  const offlineCursor = (await sync(tokB, {})).data.cursor; // 电脑 B 之后一直离线
  assert.equal((await boss.del(`accounts/${acc1}`)).status, 400);
  await boss.post(`accounts/${acc1}/unassign`);
  assert.equal((await admin('sup').del(`accounts/${acc1}`)).status, 403);
  assert.equal((await boss.del(`accounts/${acc1}`)).status, 200);
  assert.ok(!(await boss.get('overview')).data.accounts.some((a) => a.id === acc1));
  assert.equal((await boss.del(`accounts/${acc1}`)).status, 404);
  const r = await sync(tokB, { cursor: offlineCursor });
  assert.deepEqual(r.data.seats.map((x) => [x.team_id, x.visible]), [[acc1, false]]);
  assert.equal(r.data.seats[0].note, '');
});
await test('客户端暂停的收回：上报后台，管理员确认后下发，执行完清掉', async () => {
  await sync(tokA, { device: { held_hides: 3 } });
  assert.equal(db.raw.prepare('SELECT held_hides FROM devices WHERE id = ?').get(devA).held_hides, 3);
  assert.equal((await sync(tokA, { device: { held_hides: 3 } })).data.confirm_hides, false);
  assert.equal((await boss.post(`devices/${devA}/confirm-hides`)).status, 200);
  assert.equal((await sync(tokA, { device: { held_hides: 3 } })).data.confirm_hides, true);
  await sync(tokA, { device: { held_hides: 0 } });
  assert.equal(db.raw.prepare('SELECT confirm_hides FROM devices WHERE id = ?').get(devA).confirm_hides, 0);
});
await test('私人号开关随同步下发', async () => {
  await boss.put('settings', { allow_private: false });
  assert.equal((await sync(tokA, {})).data.allow_private, false);
});
await test('登记接口按 IP 限速', async () => {
  let last;
  for (let i = 0; i < 12; i += 1) last = await call('POST', '/api/device/enroll', { body: { v: 1, code: 'AAAAA-AAAAA' }, headers: { 'cf-connecting-ip': '9.9.9.9' } });
  assert.equal(last.status, 429);
});
await test('操作记录：老板看全部，主管只看自己的', async () => {
  const all = (await boss.get('audit')).data.entries;
  const mine = (await admin('sup').get('audit')).data.entries;
  assert.ok(all.length > mine.length && mine.length > 0);
  assert.ok(mine.every((e) => e.actor_id === sup));
});
// ---- 登录 ----
await test('登录策略：默认提示登录；不要令牌；只有老板能改；同步和登录都带上', async () => {
  assert.deepEqual((await call('GET', '/api/device/policy')).data, { v: 1, login: 'optional' });
  assert.equal((await call('POST', '/api/device/policy', { body: {} })).status, 405);
  assert.equal((await admin('sup').put('settings', { login_policy: 'required' })).status, 403);
  assert.equal((await boss.put('settings', { login_policy: 'always' })).status, 400);
  for (const p of ['required', 'off', 'optional']) {
    assert.equal((await boss.put('settings', { login_policy: p })).status, 200);
    assert.equal((await call('GET', '/api/device/policy')).data.login, p);
    assert.equal((await sync(tokA, {})).data.login, p);
    assert.equal((await boss.get('me')).data.settings.login_policy, p);
  }
  assert.deepEqual((await sync(tokA, {})).data.user, { name: '坐席A' });
});
let loginDev, loginTok;
await test('软件登录：成功拿到令牌和人名；错的密码、不存在的账号回同一句话；失败只记登录名', async () => {
  const r = await devLogin('ANNA', PW);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.user, { name: '坐席A' });
  assert.equal(r.data.login, 'optional');
  assert.equal(typeof r.data.allow_private, 'boolean');
  loginDev = r.data.device_id; loginTok = r.data.token;
  const row = db.raw.prepare('SELECT name, platform, app_version, token_hash FROM devices WHERE id = ?').get(loginDev);
  assert.deepEqual([row.name, row.platform, row.app_version], ['笔记本', 'mac', '1.0.5']);
  assert.notEqual(row.token_hash, loginTok);
  assert.equal((await sync(loginTok, {})).status, 200);
  const bad = await devLogin('anna', 'wrong password', { ip: '7.7.7.1' });
  const none = await devLogin('nobody', 'wrong password', { ip: '7.7.7.1' });
  assert.deepEqual([bad.status, none.status, bad.data.error], [400, 400, '账号或密码不对']);
  assert.equal(none.data.error, bad.data.error);
  assert.equal((await call('POST', '/api/device/login', { body: { v: 99, login: 'anna', password: PW } })).status, 426);
  const log = JSON.stringify(db.raw.prepare("SELECT * FROM audit_log WHERE action = 'device.login_fail'").all());
  assert.ok(log.includes('anna') && !log.includes('wrong password'));
});
await test('软件登录：带上次的设备号且是本人的就沿用（坐席不丢），旧令牌作废；别人的设备号就新建', async () => {
  const r = await devLogin('anna', PW, { device_id: devB });
  assert.equal(r.data.device_id, devB);
  assert.equal((await sync(tokB, {})).status, 401, '旧令牌作废');
  tokB = r.data.token;
  assert.equal((await sync(tokB, {})).status, 200);
  const other = await devLogin('ben', PW, { device_id: devB });
  assert.notEqual(other.data.device_id, devB);
  assert.equal((await sync(tokB, {})).status, 200, '别人登录不影响这台');
  assert.equal(db.raw.prepare('SELECT user_id FROM devices WHERE id = ?').get(other.data.device_id).user_id, agentB);
});
await test('软件登录：被停用的电脑带着设备号登录回 403 revoked；被停用的人回 403 disabled', async () => {
  await boss.post(`devices/${devB}/revoke`);
  const r = await devLogin('anna', PW, { device_id: devB });
  assert.deepEqual([r.status, r.data.revoked, r.data.device_id], [403, true, devB]);
  await boss.post(`devices/${devB}/restore`);
  await boss.patch(`users/${agentB}`, { disabled: true });
  const d = await devLogin('ben', PW);
  assert.deepEqual([d.status, d.data.disabled, d.data.error], [403, true, '这个账号已停用']);
  const wrong = await devLogin('ben', 'not the password', { ip: '7.7.7.2' });
  assert.equal(wrong.status, 400, '密码不对时不透露账号被停用');
  await boss.patch(`users/${agentB}`, { disabled: false });
});
await test('退出登录：令牌失效（401，不是 403），设备记录和坐席留着，后台看得出已退出', async () => {
  const r = await devLogin('anna', PW);
  assert.equal((await call('POST', '/api/device/logout', { token: r.data.token, body: {} })).status, 200);
  const s = await sync(r.data.token, {});
  assert.equal(s.status, 401);
  assert.equal(s.data.revoked, undefined);
  const d = (await boss.get('users')).data.devices.find((x) => x.id === r.data.device_id);
  assert.ok(d.logged_out_at > 0);
  const back = await devLogin('anna', PW, { device_id: r.data.device_id });
  assert.equal(back.data.device_id, r.data.device_id);
  assert.equal((await boss.get('users')).data.devices.find((x) => x.id === r.data.device_id).logged_out_at, null);
});
await test('重置密码：这个人所有电脑的令牌和后台会话都失效；旧密码不能用；主管只能重置本组坐席', async () => {
  assert.equal((await admin('sup').post(`users/${agentB}/password`, { password: 'new password 2' })).status, 403);
  assert.equal((await admin('sup').post(`users/${agentA}/password`, { password: 'short' })).status, 400);
  assert.equal((await sync(tokB, {})).status, 200);
  assert.equal((await admin('sup').post(`users/${agentA}/password`, { password: 'new password 2' })).status, 200);
  assert.equal((await sync(tokB, {})).status, 401);
  assert.equal((await sync(loginTok, {})).status, 401);
  assert.equal((await sync(tokA, {})).status, 401, '用登记码登记的电脑也失效');
  assert.equal((await devLogin('anna', PW, { ip: '7.7.7.3' })).status, 400);
  const r = await devLogin('anna', 'new password 2', { device_id: devB });
  tokB = r.data.token;
  tokA = (await devLogin('anna', 'new password 2', { device_id: devA })).data.token;
  assert.equal((await sync(tokA, {})).status, 200);
  // 主管自己的后台会话
  const supTok = await sessionFor('sup');
  await boss.post(`users/${sup}/password`, { password: 'sup password 2' });
  assert.equal((await call('GET', '/api/admin/me', { token: supTok })).status, 401);
  sessions.delete('sup');
  await sessionFor('sup', 'sup password 2');
});
await test('改登录名：重名 409，格式不对 400；改了以后用新名字登录', async () => {
  assert.equal((await boss.patch(`users/${agentA}`, { login_name: 'BEN' })).status, 409);
  assert.equal((await boss.patch(`users/${agentA}`, { login_name: 'a' })).status, 400);
  assert.equal((await admin('sup').patch(`users/${agentA}`, { login_name: 'anna.k' })).status, 200);
  assert.equal((await devLogin('anna.k', 'new password 2', { device_id: devB })).status, 200);
});
await test('登录限速：同一个登录名 10 分钟最多错 10 次（换 IP 也不行），同一个 IP 也是；成功的登录不占额度', async () => {
  db.raw.prepare("DELETE FROM rate_limits WHERE key LIKE 'login:%'").run();
  for (let i = 0; i < 15; i += 1) assert.equal((await devLogin('ben', PW)).status, 200, '同一个 IP 成功登录很多次');
  for (let i = 0; i < 10; i += 1) assert.equal((await devLogin('ben', 'bad password', { ip: `8.8.8.${i}` })).status, 400);
  assert.equal((await devLogin('ben', PW, { ip: '8.8.9.1' })).status, 429, '密码对也先挡住');
  assert.equal((await call('POST', '/api/admin/session', { body: { login: 'ben', password: PW }, ip: '8.8.9.2' })).status, 429, '后台登录同一个额度');
  for (let i = 0; i < 10; i += 1) await devLogin(`nobody${i}`, 'bad password', { ip: '6.6.6.6' });
  assert.equal((await devLogin('anna.k', 'new password 2', { ip: '6.6.6.6' })).status, 429);
  // 并发：先计数再验密码，同时打 20 个也最多 10 个进得去
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => devLogin('boss', 'bad password', { ip: `5.5.5.${i}` })));
  assert.equal(rs.filter((r) => r.status === 400).length, 10);
  db.raw.prepare("DELETE FROM rate_limits WHERE key LIKE 'login:%'").run();
});
await test('改了 PASS_ITER：下次登录时自动按新次数重算，密码不变', async () => {
  env.PASS_ITER = '20000';
  assert.equal((await devLogin('ben', PW)).status, 200);
  assert.equal(db.raw.prepare('SELECT pass_iter FROM users WHERE id = ?').get(agentB).pass_iter, 20000);
  delete env.PASS_ITER;
  assert.equal((await devLogin('ben', PW)).status, 200);
  assert.equal(db.raw.prepare('SELECT pass_iter FROM users WHERE id = ?').get(agentB).pass_iter, 100000);
});
await test('定时任务只有一个（每 30 分钟）；每天 UTC 19:00 那次清理过期会话和旧记录，其它时候不清', async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(here, '../wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(cfg.triggers.crons, ['*/30 * * * *']);
  db.raw.prepare("INSERT INTO admin_sessions (token_hash, user_id, created_at, expires_at) VALUES ('old', ?, 0, 1)").run(ownerId);
  await worker.scheduled({ cron: '*/30 * * * *', scheduledTime: Date.UTC(2026, 10, 2, 19, 30) }, env);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE token_hash = 'old'").get().n, 1);
  await worker.scheduled({ cron: '*/30 * * * *', scheduledTime: Date.UTC(2026, 10, 2, 19, 0) }, env);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE token_hash = 'old'").get().n, 0);
});
await test('每日清理任务能跑', async () => {
  await worker.scheduled({}, env);
});
console.log(`全部通过（${passed} 项）`);
