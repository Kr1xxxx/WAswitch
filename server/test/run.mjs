// 团队后台自检：node server/test/run.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeD1 } from './fake-d1.mjs';
import worker from '../src/index.js';
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
const env = { DB: db, ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD, OWNER_EMAIL: 'Boss@Example.com', SYNC_INTERVAL_S: '120', ASSETS: { fetch: async () => new Response('<html>admin</html>', { headers: { 'content-type': 'text/html' } }) } };

async function call(method, p, { token, body, jwtFor, headers = {}, rawJwt } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = `Bearer ${token}`;
  if (jwtFor) h['cf-access-jwt-assertion'] = await jwt(jwtFor);
  if (rawJwt) h['cf-access-jwt-assertion'] = rawJwt;
  if (method !== 'GET' && jwtFor && h['x-waswitch-admin'] === undefined) h['x-waswitch-admin'] = '1';
  const res = await worker.fetch(new Request(`https://team.example.com${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, {});
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const admin = (email) => ({
  get: (p) => call('GET', `/api/admin/${p}`, { jwtFor: email }),
  post: (p, body = {}) => call('POST', `/api/admin/${p}`, { jwtFor: email, body }),
  patch: (p, body) => call('PATCH', `/api/admin/${p}`, { jwtFor: email, body }),
  put: (p, body) => call('PUT', `/api/admin/${p}`, { jwtFor: email, body }),
  del: (p) => call('DELETE', `/api/admin/${p}`, { jwtFor: email }),
});
const sync = (token, body) => call('POST', '/api/device/sync', { token, body: { v: 1, now: Date.now(), cursor: 0, ...body } });
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

console.log('团队后台自检');
const boss = admin('boss@example.com');

await test('没有 Access 登录：管理接口和管理页面都拒绝', async () => {
  assert.equal((await call('GET', '/api/admin/me')).status, 403);
  assert.equal((await call('GET', '/admin/')).status, 403);
  assert.equal((await call('GET', '/anything')).status, 403);
});
await test('绕路径：点段被规范化后仍要 JWT；编码斜杠和重复斜杠直接 404', async () => {
  assert.equal((await call('GET', '/api/device/%2e%2e/admin/me')).status, 403);
  assert.equal((await call('GET', '/api/device%2f..%2fadmin/me', { jwtFor: 'boss@example.com' })).status, 404);
  assert.equal((await call('GET', '/api//admin/me', { jwtFor: 'boss@example.com' })).status, 404);
});
await test('JWT 的 aud、iss、过期、签名任何一项不对都拒绝', async () => {
  for (const bad of [await jwt('boss@example.com', { aud: 'x' }), await jwt('boss@example.com', { iss: 'https://evil.cloudflareaccess.com' }),
    await jwt('boss@example.com', { exp: 1 }), await jwt('boss@example.com', { key: other.privateKey })]) {
    assert.equal((await call('GET', '/api/admin/me', { rawJwt: bad })).status, 403);
  }
});
await test('没配 Access 环境变量时一律拒绝', async () => {
  const saved = env.ACCESS_AUD; env.ACCESS_AUD = '';
  assert.equal((await boss.get('me')).status, 403);
  env.ACCESS_AUD = saved;
});
await test('老板第一次登录自动建档；管理页面加安全头', async () => {
  const r = await boss.get('me');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'owner');
  const page = await call('GET', '/admin/', { jwtFor: 'boss@example.com' });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('access-control-allow-origin'), null);
});
await test('陌生邮箱进不了后台', async () => {
  assert.equal((await admin('nobody@example.com').get('me')).status, 403);
});
await test('改数据的请求不带自定义头就拒绝', async () => {
  const r = await call('POST', '/api/admin/groups', { jwtFor: 'boss@example.com', body: { name: 'x' }, headers: { 'x-waswitch-admin': '' } });
  assert.equal(r.status, 403);
});

let gA, gB, sup, agentA, agentB;
await test('建组、主管、坐席；主管只能加本组坐席', async () => {
  gA = (await boss.post('groups', { name: 'A 组' })).data.id;
  gB = (await boss.post('groups', { name: 'B 组' })).data.id;
  sup = (await boss.post('users', { name: '主管甲', email: 'sup@example.com', role: 'supervisor', group_id: gA })).data.id;
  assert.ok(sup);
  assert.equal((await boss.post('users', { name: '没邮箱主管', role: 'supervisor', group_id: gA })).status, 400);
  const s = admin('sup@example.com');
  assert.equal((await s.post('users', { name: '想当主管', email: 'x@example.com', role: 'supervisor' })).status, 403);
  agentA = (await s.post('users', { name: '坐席A', group_id: gB })).data.id; // group_id 被忽略，强制本组
  agentB = (await boss.post('users', { name: '坐席B', group_id: gB })).data.id;
  const list = (await s.get('users')).data.users;
  assert.deepEqual(list.map((u) => u.name).sort(), ['主管甲', '坐席A'].sort());
});

let codeA, tokA, devA, acc1, acc2;
await test('登记码只能用一次；登记时带上本机账号', async () => {
  codeA = (await admin('sup@example.com').post(`users/${agentA}/enroll-code`)).data.code;
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
  assert.equal((await admin('sup@example.com').post(`accounts/${acc1}/assign`, { device_id: devB })).status, 200);
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
  assert.equal((await admin('sup@example.com').patch(`accounts/${acc1}`, { crm_sync: true })).status, 403);
  assert.equal((await boss.patch(`accounts/${acc1}`, { crm_sync: true })).status, 200);
  const r = await sync(tokB, { cursor: before });
  assert.equal(r.data.seats[0].crm_sync, true);
  assert.equal((await boss.get('overview')).data.accounts.find((a) => a.id === acc1).crm_sync, 1);
  await boss.patch(`accounts/${acc1}`, { crm_sync: false });
  const actions = db.raw.prepare('SELECT action FROM audit_log WHERE target = ? ORDER BY at').all(acc1).map((r) => r.action);
  assert.ok(actions.includes('account.crm_on') && actions.includes('account.crm_off'), '开关聊天同步要记操作记录');
  assert.equal((await sync(tokB, { cursor: r.data.cursor })).data.seats[0].crm_sync, false);
});
await test('主管看不到别组的号，也不能分配', async () => {
  const s = admin('sup@example.com');
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
  assert.equal((await admin('sup@example.com').del(`accounts/${acc1}`)).status, 403);
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
  const mine = (await admin('sup@example.com').get('audit')).data.entries;
  assert.ok(all.length > mine.length && mine.length > 0);
  assert.ok(mine.every((e) => e.actor_id === sup));
});
await test('Access 公钥缓存：不是每个请求都去拉', async () => {
  _resetCertCache(); certFetches = 0;
  for (let i = 0; i < 5; i += 1) await boss.get('me');
  assert.equal(certFetches, 1);
});
await test('每日清理任务能跑', async () => {
  await worker.scheduled({}, env);
});
console.log(`全部通过（${passed} 项）`);
