// 团队后台自检：node server/test/run.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
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
// 假的 Resend：记下发出去的信，从正文里取码
const mail = { sent: [], mode: 'ok' };
const lastCode = (to) => { const m = [...mail.sent].reverse().find((x) => x.to[0] === to); return m && /验证码 (\d{6})/.exec(m.text)[1]; };
globalThis.fetch = async (url, opts = {}) => {
  if (url === 'https://api.resend.com/emails') {
    assert.equal(opts.redirect, 'manual'); // Workers 不支持 'error'
    assert.equal(opts.headers.authorization, `Bearer ${env.RESEND_API_KEY}`);
    if (mail.mode === 'down') throw new TypeError('fetch failed');
    if (mail.mode === '500') return new Response('{"message":"x"}', { status: 500 });
    if (mail.mode === '302') return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } });
    mail.sent.push(JSON.parse(opts.body));
    return new Response('{"id":"m1"}', { headers: { 'content-type': 'application/json' } });
  }
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
const env = { DB: db, SYNC_INTERVAL_S: '120', RESEND_API_KEY: 're_test_key', OWNER_EMAIL: ' Boss@Example.com ', ASSETS: { fetch: async () => new Response('<html>admin</html>', { headers: { 'content-type': 'text/html' } }) } };

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
// 限速记录清掉（测试里同一个邮箱要码很多次）
const resetLimits = () => db.raw.prepare("DELETE FROM rate_limits WHERE key LIKE 'code:%' OR key LIKE 'verify:%'").run();
// 后台：要码、收码、换会话，之后带会话令牌
const sessions = new Map();
async function adminLogin(email) {
  resetLimits();
  const c = await call('POST', '/api/admin/code', { body: { email } });
  assert.equal(c.status, 200, `${email} 要后台验证码：${JSON.stringify(c.data)}`);
  const r = await call('POST', '/api/admin/session', { body: { email, code: lastCode(email) } });
  assert.equal(r.status, 200, `${email} 登录后台：${JSON.stringify(r.data)}`);
  return r.data.token;
}
async function sessionFor(email) {
  if (!sessions.has(email)) sessions.set(email, await adminLogin(email));
  return sessions.get(email);
}
const admin = (email) => {
  const go = async (method, p, body) => call(method, `/api/admin/${p}`, { token: await sessionFor(email), body });
  return { get: (p) => go('GET', p), post: (p, body = {}) => go('POST', p, body), patch: (p, body) => go('PATCH', p, body), put: (p, body) => go('PUT', p, body), del: (p) => go('DELETE', p) };
};
const sync = (token, body) => call('POST', '/api/device/sync', { token, body: { v: 1, now: Date.now(), cursor: 0, ...body } });
const DEVICE = { name: '笔记本', app_version: '1.0.5', platform: 'mac' };
const devCode = (email, ip) => call('POST', '/api/device/code', { body: { v: 1, email }, ip });
const devLoginCode = (email, code, extra = {}) => call('POST', '/api/device/login', { body: { v: 1, email, code, device: DEVICE, ...extra }, ip: extra.ip });
// 软件登录一次：要码、取码、登录
async function devLogin(email, extra = {}) {
  resetLimits();
  const c = await devCode(email);
  if (c.status !== 200) return c;
  return devLoginCode(email, lastCode(email), extra);
}
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
  assert.equal((await call('POST', '/api/admin/setup', { body: {} })).status, 401, '初始化接口已经没有了');
});
await test('绕路径：点段被规范化后仍要会话；编码斜杠和重复斜杠直接 404', async () => {
  assert.equal((await call('GET', '/api/device/%2e%2e/admin/me')).status, 401);
  assert.equal((await call('GET', '/api/device%2f..%2fadmin/me')).status, 404);
  assert.equal((await call('GET', '/api//admin/me')).status, 404);
});
let ownerId;
await test('老板邮箱（OWNER_EMAIL）第一次登录后台：收码、建出老板；码和正文只在邮件里', async () => {
  const c = await call('POST', '/api/admin/code', { body: { email: 'BOSS@example.com' } });
  assert.deepEqual([c.status, c.data], [200, { ok: true, resend_after_s: 60 }]);
  const m = mail.sent.at(-1);
  assert.deepEqual(m.to, ['boss@example.com']);
  assert.equal(m.from, 'WAswitch <no-reply@laicrm.com>');
  assert.match(m.subject, /^WAswitch 验证码 \d{6}$/);
  const code = lastCode('boss@example.com');
  assert.equal(m.text, `验证码 ${code}，10 分钟内有效。不是你本人操作，可以不理会。`);
  const row = db.raw.prepare('SELECT * FROM login_codes').get();
  assert.ok(!JSON.stringify(row).includes(code), '库里只有哈希');
  assert.equal(row.expires_at - row.sent_at, 10 * 60 * 1000);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0, '要码不建人');
  const r = await call('POST', '/api/admin/session', { body: { email: 'boss@example.com', code } });
  assert.equal(r.status, 200);
  assert.ok(r.data.expires_at - Date.now() > 6.9 * 864e5 && r.data.expires_at - Date.now() <= 7 * 864e5, '会话 7 天');
  const me = (await call('GET', '/api/admin/me', { token: r.data.token })).data.user;
  assert.deepEqual([me.role, me.name, me.email], ['owner', '老板', 'boss@example.com']);
  ownerId = me.id;
  assert.ok(!JSON.stringify(db.raw.prepare('SELECT * FROM audit_log').all()).includes(code), '操作记录里没有码');
  assert.equal((await call('POST', '/api/admin/session', { body: { email: 'boss@example.com', code } })).status, 400, '同一个码只能用一次');
  sessions.set('boss@example.com', r.data.token);
});
await test('老板邮箱：被改成别的角色或停用后，用老板邮箱登录又变回老板', async () => {
  db.raw.prepare("UPDATE users SET role = 'agent', disabled_at = 1 WHERE id = ?").run(ownerId);
  const tok = await adminLogin('boss@example.com');
  assert.equal((await call('GET', '/api/admin/me', { token: tok })).data.user.role, 'owner');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  sessions.set('boss@example.com', tok);
});
const boss = admin('boss@example.com');
await test('验证码：错 5 次后对的码也不行；过期不行；没要过不行；不是 6 位数字不行；错误都是同一句话', async () => {
  resetLimits();
  await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' } });
  const good = lastCode('boss@example.com');
  const bad = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i += 1) {
    const r = await call('POST', '/api/admin/session', { body: { email: 'boss@example.com', code: bad }, ip: `4.4.4.${i}` });
    assert.deepEqual([r.status, r.data.error], [400, '验证码不对或已过期']);
  }
  assert.equal((await call('POST', '/api/admin/session', { body: { email: 'boss@example.com', code: good }, ip: '4.4.5.1' })).status, 400, '试满 5 次作废');
  resetLimits();
  await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' } });
  db.raw.prepare('UPDATE login_codes SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await call('POST', '/api/admin/session', { body: { email: 'boss@example.com', code: lastCode('boss@example.com') } })).status, 400, '过期');
  assert.equal((await call('POST', '/api/admin/session', { body: { email: 'nobody@example.com', code: '123456' } })).status, 400);
  assert.equal((await call('POST', '/api/admin/session', { body: { email: 'boss@example.com', code: 123456 } })).status, 400);
  const fails = JSON.stringify(db.raw.prepare("SELECT * FROM audit_log WHERE action = 'admin.login_fail'").all());
  assert.ok(fails.includes('boss@example.com') && !fails.includes(good));
});
await test('验证码：新码一出旧码作废；并发用同一个码只有一个成功', async () => {
  resetLimits();
  await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' } });
  const first = lastCode('boss@example.com');
  resetLimits();
  await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' } });
  const second = lastCode('boss@example.com');
  if (first !== second) assert.equal((await call('POST', '/api/admin/session', { body: { email: 'boss@example.com', code: first } })).status, 400);
  const rs = await Promise.all([1, 2, 3].map((i) => call('POST', '/api/admin/session', { body: { email: 'boss@example.com', code: second }, ip: `3.3.3.${i}` })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
});
await test('验证码是 6 位均匀数字', async () => {
  const seen = new Set();
  for (let i = 0; i < 30; i += 1) { resetLimits(); await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' } }); seen.add(lastCode('boss@example.com')); }
  assert.ok([...seen].every((c) => /^\d{6}$/.test(c)));
  assert.ok(seen.size > 25);
});
await test('后台要码：陌生邮箱 404 不发信；格式不对 400；不带自定义头 403', async () => {
  resetLimits();
  const before = mail.sent.length;
  const r = await call('POST', '/api/admin/code', { body: { email: 'stranger@example.com' } });
  assert.deepEqual([r.status, r.data.error], [404, '这个邮箱没有后台权限']);
  assert.equal((await call('POST', '/api/admin/code', { body: { email: 'not-an-email' } })).status, 400);
  assert.equal((await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' }, headers: { 'x-waswitch-admin': '' } })).status, 403);
  assert.equal(mail.sent.length, before);
});
await test('要码限速：同一邮箱 60 秒 1 次（带 retry_after_s），1 小时 5 次；同一 IP 1 小时 50 次，登录成功的不占', async () => {
  resetLimits();
  assert.equal((await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' } })).status, 200);
  const r = await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' } });
  assert.equal(r.status, 429);
  assert.ok(r.data.retry_after_s > 50 && r.data.retry_after_s <= 60);
  assert.match(r.data.error, /^太频繁了，请 \d+ 秒后再试$/);
  resetLimits();
  for (let i = 0; i < 5; i += 1) {
    db.raw.prepare("DELETE FROM rate_limits WHERE key LIKE 'code:mail1:%'").run();
    assert.equal((await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' }, ip: `2.2.2.${i}` })).status, 200);
  }
  db.raw.prepare("DELETE FROM rate_limits WHERE key LIKE 'code:mail1:%'").run();
  assert.equal((await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' }, ip: '2.2.3.1' })).status, 429, '1 小时 5 次');
  resetLimits();
  // 同一个办公室：60 个人先后要码并登录成功，都不被挡
  for (let i = 0; i < 60; i += 1) {
    db.raw.prepare("DELETE FROM rate_limits WHERE key LIKE 'code:mail%'").run();
    assert.equal((await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' }, ip: '1.1.1.2' })).status, 200, `第 ${i + 1} 个`);
    assert.equal((await call('POST', '/api/admin/session', { body: { email: 'boss@example.com', code: lastCode('boss@example.com') }, ip: '1.1.1.2' })).status, 200);
  }
  for (let i = 0; i < 50; i += 1) await call('POST', '/api/admin/code', { body: { email: `x${i}@example.com` }, ip: '1.1.1.1' });
  assert.equal((await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' }, ip: '1.1.1.1' })).status, 429, '同一 IP 1 小时 50 次');
  resetLimits();
});
await test('验证时同一 IP 10 分钟最多 10 次', async () => {
  resetLimits();
  for (let i = 0; i < 10; i += 1) await call('POST', '/api/admin/session', { body: { email: `y${i}@example.com`, code: '123456' }, ip: '9.8.7.6' });
  assert.equal((await call('POST', '/api/admin/session', { body: { email: 'boss@example.com', code: '123456' }, ip: '9.8.7.6' })).status, 429);
  resetLimits();
});
await test('发信失败：Resend 报错、跳转或连不上时 503，刚生成的码删掉；没配 RESEND_API_KEY 也是 503', async () => {
  for (const mode of ['500', '302', 'down']) {
    resetLimits();
    db.raw.prepare('DELETE FROM login_codes').run();
    mail.mode = mode;
    const r = await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' } });
    assert.deepEqual([r.status, r.data.error], [503, '验证码发不出去，请稍后再试']);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM login_codes').get().n, 0, mode);
  }
  mail.mode = 'ok';
  const key = env.RESEND_API_KEY; delete env.RESEND_API_KEY;
  resetLimits();
  assert.equal((await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' } })).status, 503);
  env.RESEND_API_KEY = key;
  env.MAIL_FROM = 'Team <team@example.com>';
  resetLimits();
  await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' } });
  assert.equal(mail.sent.at(-1).from, 'Team <team@example.com>');
  delete env.MAIL_FROM;
  resetLimits();
});
await test('后台退出后会话失效；过期的会话失效；库里不存明文令牌', async () => {
  const tok = await adminLogin('boss@example.com');
  assert.equal((await call('DELETE', '/api/admin/session', { token: tok })).status, 200);
  assert.equal((await call('GET', '/api/admin/me', { token: tok })).status, 401);
  const tok2 = await adminLogin('boss@example.com');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM admin_sessions WHERE token_hash = ?').get(tok2).n, 0);
  db.raw.prepare('UPDATE admin_sessions SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await call('GET', '/api/admin/me', { token: tok2 })).status, 401);
  db.raw.prepare('DELETE FROM admin_sessions').run();
  sessions.clear();
});
await test('改数据的请求不带自定义头就拒绝', async () => {
  const r = await call('POST', '/api/admin/groups', { token: await sessionFor('boss@example.com'), body: { name: 'x' }, headers: { 'x-waswitch-admin': '' } });
  assert.equal(r.status, 403);
});
await test('配了 Cloudflare Access 时两道都要过；只配一半一律拒绝；设备接口不受影响', async () => {
  const tok = await sessionFor('boss@example.com');
  Object.assign(env, { ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD });
  assert.equal((await call('GET', '/api/admin/me', { token: tok })).status, 403, '只有会话');
  assert.equal((await call('GET', '/api/admin/me', { jwtFor: 'boss@example.com' })).status, 401, '只有 Access');
  assert.equal((await call('GET', '/api/admin/me', { token: tok, jwtFor: 'boss@example.com' })).status, 200);
  assert.equal((await call('GET', '/admin/')).status, 403);
  assert.equal((await call('POST', '/api/admin/code', { body: { email: 'boss@example.com' } })).status, 403);
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
await test('建组、主管、坐席：要填名字和邮箱；主管只能加本组坐席', async () => {
  gA = (await boss.post('groups', { name: 'A 组' })).data.id;
  gB = (await boss.post('groups', { name: 'B 组' })).data.id;
  sup = (await boss.post('users', { name: '主管甲', email: ' Sup@Example.com', role: 'supervisor', group_id: gA })).data.id;
  assert.ok(sup);
  assert.equal(db.raw.prepare('SELECT email FROM users WHERE id = ?').get(sup).email, 'sup@example.com');
  assert.equal((await boss.post('users', { name: '没邮箱', role: 'agent' })).status, 400);
  assert.equal((await boss.post('users', { name: '坏邮箱', email: 'nope' })).status, 400);
  assert.equal((await boss.post('users', { name: '重名', email: 'SUP@example.com' })).status, 409);
  assert.equal((await boss.post('users', { name: '没组主管', email: 'nogroup@example.com', role: 'supervisor' })).status, 400);
  const s = admin('sup@example.com');
  assert.equal((await s.post('users', { name: '想当主管', email: 'x1@example.com', role: 'supervisor' })).status, 403);
  agentA = (await s.post('users', { name: '坐席A', email: 'anna@example.com', group_id: gB })).data.id; // group_id 被忽略，强制本组
  agentB = (await boss.post('users', { name: '坐席B', email: 'ben@example.com', group_id: gB })).data.id;
  const list = (await s.get('users')).data.users;
  assert.deepEqual(list.map((u) => u.name).sort(), ['主管甲', '坐席A'].sort());
});
await test('坐席拿不到后台验证码；设备码不能登后台，后台码也不能登软件', async () => {
  resetLimits();
  assert.equal((await call('POST', '/api/admin/code', { body: { email: 'anna@example.com' } })).status, 404);
  assert.equal((await devCode('sup@example.com')).status, 200);
  assert.equal((await call('POST', '/api/admin/session', { body: { email: 'sup@example.com', code: lastCode('sup@example.com') } })).status, 400);
  resetLimits();
  await call('POST', '/api/admin/code', { body: { email: 'sup@example.com' } });
  assert.equal((await devLoginCode('sup@example.com', lastCode('sup@example.com'))).status, 400);
  db.raw.prepare('DELETE FROM login_codes').run();
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
await test('同步到 CRM 没有开关：看得见的号一律随坐席下发 crm_sync，后台关不掉', async () => {
  const first = await sync(tokB, {});
  assert.equal(first.data.seats[0].crm_sync, true);
  const before = first.data.cursor;
  // 老板和主管传 crm_sync 都不报错，但什么也不改、不记操作
  assert.equal((await admin('sup@example.com').patch(`accounts/${acc1}`, { crm_sync: false })).status, 200);
  assert.equal((await boss.patch(`accounts/${acc1}`, { crm_sync: false })).status, 200);
  const r = await sync(tokB, { cursor: before });
  assert.equal(r.data.cursor, before, '没有改动就没有新版本');
  assert.equal((await sync(tokB, {})).data.seats[0].crm_sync, true);
  const actions = db.raw.prepare('SELECT action FROM audit_log WHERE target = ?').all(acc1).map((x) => x.action);
  assert.ok(!actions.some((x) => x.startsWith('account.crm_')));
  assert.equal(db.raw.prepare('SELECT crm_sync FROM wa_accounts WHERE id = ?').get(acc1).crm_sync, 0, '库里的旧列不会被写');
  assert.ok(!('crm_sync' in (await boss.get('overview')).data.accounts[0]), '后台总览不再带这一列');
  // 和别的字段一起传时，只改别的字段，操作记录里也不带 crm_sync
  await boss.patch(`accounts/${acc1}`, { note: '只接美国客户', crm_sync: false });
  const upd = db.raw.prepare("SELECT detail FROM audit_log WHERE target = ? AND action = 'account.update' ORDER BY id DESC").get(acc1);
  assert.ok(!upd.detail.includes('crm_sync'));
});
await test('升级前就登记的电脑：迁移 0006 给看得见的号出新版本，旧游标也拿到 crm_sync；看不见的号不动', async () => {
  const cur = (await sync(tokB, {})).data.cursor;
  assert.equal((await sync(tokB, { cursor: cur })).data.seats.length, 0, '没改动时旧游标拿不到坐席');
  const hidden = db.raw.prepare('SELECT device_id, account_id, version FROM device_seats WHERE visible = 0').all();
  db.raw.exec(fs.readFileSync(path.join(here, '../migrations/0006_crm_all_numbers.sql'), 'utf8'));
  const r = await sync(tokB, { cursor: cur });
  assert.ok(r.data.seats.length >= 1);
  assert.ok(r.data.seats.every((x) => x.visible === true && x.crm_sync === true));
  assert.ok(r.data.cursor > cur);
  for (const h of hidden) assert.equal(db.raw.prepare('SELECT version FROM device_seats WHERE device_id = ? AND account_id = ?').get(h.device_id, h.account_id).version, h.version, '看不见的坐席版本不变');
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
  const r = await chats(tokB, acc1, [msg('3EB0AAAA0001')]);
  assert.equal(r.status, 503);
  assert.equal(r.data.crm_paused, true);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM crm_batches').get().n, 0);
});
Object.assign(env, { CRM_PUSH: '1', CRM_KEY: Buffer.alloc(32, 7).toString('base64'), LAICRM_SECRET: CRM_SECRET, LAICRM: laicrm });
await test('CRM 上传：只收这台电脑上的号（不看旧的 crm_sync 列）；不合格的条目拒收', async () => {
  assert.equal(db.raw.prepare('SELECT crm_sync FROM wa_accounts WHERE id = ?').get(acc1).crm_sync, 0);
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
  assert.equal(first.staff.email, 'anna@example.com');
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
  const parts = chunkMessages({ v: 1, batch_id: 'x', account: { id: 'a', label: '号', phone: '' }, staff: { name: '', email: '' } }, msgs);
  assert.ok(parts.length >= 4);
  assert.equal(parts.flat().length, 100);
  for (const p of parts) assert.ok(Buffer.byteLength(JSON.stringify({ v: 1, batch_id: 'x', account: { id: 'a', label: '号', phone: '' }, staff: { name: '', email: '' }, messages: p })) <= 256 * 1024);
});
await test('CRM 推送：员工没有邮箱时，推送里的邮箱是空字符串', async () => {
  resetRate();
  db.raw.prepare('UPDATE users SET email = NULL WHERE id = ?').run(agentA);
  await chats(tokB, acc1, [msg('3EB0EEEE0001')]);
  laicrm.calls = [];
  await cron();
  db.raw.prepare('UPDATE users SET email = ? WHERE id = ?').run('anna@example.com', agentA);
  assert.equal(laicrm.calls[0].staff.name, '坐席A');
  assert.equal(laicrm.calls[0].staff.email, '');
});
await test('CRM：超过 7 天没推出去的聊天会删', async () => {
  db.raw.prepare("INSERT INTO crm_batches (id, account_id, device_id, n, iv, data, created_at) VALUES ('old', ?, ?, 1, 'x', 'x', ?)").run(acc1, devB, Date.now() - 8 * 864e5);
  await cron();
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM crm_batches').get().n, 0);
  Object.assign(env, { CRM_PUSH: '0' });
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
  const pending = () => db.raw.prepare('SELECT COUNT(*) AS n FROM crm_batches WHERE account_id = ?').get(acc1).n;
  db.raw.prepare("INSERT INTO crm_batches (id, account_id, device_id, n, iv, data, created_at) VALUES ('p1', ?, ?, 1, 'x', 'x', ?)").run(acc1, devB, Date.now());
  await boss.post(`accounts/${acc1}/unassign`);
  assert.equal((await admin('sup@example.com').del(`accounts/${acc1}`)).status, 403);
  assert.equal((await boss.del(`accounts/${acc1}`)).status, 200);
  assert.equal(pending(), 0, '删号时没推出去的聊天一起删');
  // 删号之后残留的批次（比如删号前一刻才进来的）推送时也丢掉，不推给来财
  db.raw.prepare("INSERT INTO crm_batches (id, account_id, device_id, n, iv, data, created_at) VALUES ('p2', ?, ?, 1, 'x', 'x', ?)").run(acc1, devB, Date.now());
  Object.assign(env, { CRM_PUSH: '1' });
  laicrm.calls = [];
  await cron();
  Object.assign(env, { CRM_PUSH: '0' });
  assert.equal(pending(), 0);
  assert.equal(laicrm.calls.length, 0);
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
await test('私人号一律不允许：同步下发 false；后台没有这个开关，传了也不理', async () => {
  assert.equal((await sync(tokA, {})).data.allow_private, false);
  assert.equal((await boss.put('settings', { allow_private: true })).status, 200);
  assert.equal((await sync(tokA, {})).data.allow_private, false);
  assert.equal((await boss.get('me')).data.settings.allow_private, undefined);
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
// ---- 软件登录 ----
await test('登录策略：一律必须登录（迁移 0007）；不要令牌；后台改不了；同步和登录都带上', async () => {
  assert.deepEqual((await call('GET', '/api/device/policy')).data, { v: 1, login: 'required' });
  assert.equal((await call('POST', '/api/device/policy', { body: {} })).status, 405);
  assert.equal((await admin('sup@example.com').put('settings', { login_policy: 'off' })).status, 403);
  for (const p of ['off', 'optional', 'always']) {
    assert.equal((await boss.put('settings', { login_policy: p })).status, 200);
    assert.equal((await call('GET', '/api/device/policy')).data.login, 'required');
    assert.equal((await sync(tokA, {})).data.login, 'required');
    assert.equal((await boss.get('me')).data.settings.login_policy, 'required');
  }
  assert.deepEqual((await sync(tokA, {})).data.user, { name: '坐席A' });
});
let loginDev, loginTok;
await test('软件要码：成功；邮箱查不到 404 unknown；格式不对 400；协议版本不对 426', async () => {
  resetLimits();
  const before = mail.sent.length;
  assert.deepEqual((await devCode('nobody@example.com')).data, { error: '这个邮箱还没加入团队，请找管理员', unknown: true });
  assert.equal((await devCode('nobody@example.com')).status, 404);
  assert.equal((await devCode('bad')).status, 400);
  assert.equal((await call('POST', '/api/device/code', { body: { v: 9, email: 'anna@example.com' } })).status, 426);
  assert.equal(mail.sent.length, before);
  const r = await devCode(' ANNA@example.com ');
  assert.deepEqual([r.status, r.data], [200, { ok: true, resend_after_s: 60 }]);
  assert.deepEqual(mail.sent.at(-1).to, ['anna@example.com']);
});
await test('软件登录：成功拿到令牌和人名；码不对回「验证码不对或已过期」；失败只记邮箱', async () => {
  const bad = await devLoginCode('anna@example.com', '999999' === lastCode('anna@example.com') ? '888888' : '999999');
  assert.deepEqual([bad.status, bad.data.error], [400, '验证码不对或已过期']);
  const r = await devLoginCode('anna@example.com', lastCode('anna@example.com'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.user, { name: '坐席A' });
  assert.equal(r.data.login, 'required');
  assert.equal(r.data.allow_private, false);
  loginDev = r.data.device_id; loginTok = r.data.token;
  const row = db.raw.prepare('SELECT name, platform, app_version, token_hash FROM devices WHERE id = ?').get(loginDev);
  assert.deepEqual([row.name, row.platform, row.app_version], ['笔记本', 'mac', '1.0.5']);
  assert.notEqual(row.token_hash, loginTok);
  assert.equal((await sync(loginTok, {})).status, 200);
  assert.equal((await call('POST', '/api/device/login', { body: { v: 99, email: 'anna@example.com', code: '123456' } })).status, 426);
  const log = JSON.stringify(db.raw.prepare("SELECT * FROM audit_log WHERE action = 'device.login_fail'").all());
  assert.ok(log.includes('anna@example.com'));
});
await test('软件登录：带上次的设备号且是本人的就沿用（坐席不丢），旧令牌作废；别人的设备号就新建', async () => {
  const r = await devLogin('anna@example.com', { device_id: devB });
  assert.equal(r.data.device_id, devB);
  assert.equal((await sync(tokB, {})).status, 401, '旧令牌作废');
  tokB = r.data.token;
  assert.equal((await sync(tokB, {})).status, 200);
  const other = await devLogin('ben@example.com', { device_id: devB });
  assert.notEqual(other.data.device_id, devB);
  assert.equal((await sync(tokB, {})).status, 200, '别人登录不影响这台');
  assert.equal(db.raw.prepare('SELECT user_id FROM devices WHERE id = ?').get(other.data.device_id).user_id, agentB);
});
await test('停用：被停用的电脑带着设备号登录回 403 revoked；停用的人要码 403 disabled 且不发信；要了码再被停用，登录也 403', async () => {
  await boss.post(`devices/${devB}/revoke`);
  const r = await devLogin('anna@example.com', { device_id: devB });
  assert.deepEqual([r.status, r.data.revoked, r.data.device_id], [403, true, devB]);
  await boss.post(`devices/${devB}/restore`);
  resetLimits();
  assert.equal((await devCode('ben@example.com')).status, 200);
  const code = lastCode('ben@example.com');
  await boss.patch(`users/${agentB}`, { disabled: true });
  const before = mail.sent.length;
  resetLimits();
  const d = await devCode('ben@example.com');
  assert.deepEqual([d.status, d.data.disabled, d.data.error], [403, true, '这个账号已停用']);
  assert.equal(mail.sent.length, before);
  const l = await devLoginCode('ben@example.com', code);
  assert.deepEqual([l.status, l.data.disabled], [403, true]);
  await boss.patch(`users/${agentB}`, { disabled: false });
});
await test('退出登录：令牌失效（401，不是 403），设备记录和坐席留着，后台看得出已退出', async () => {
  const r = await devLogin('anna@example.com');
  assert.equal((await call('POST', '/api/device/logout', { token: r.data.token, body: {} })).status, 200);
  const s = await sync(r.data.token, {});
  assert.equal(s.status, 401);
  assert.equal(s.data.revoked, undefined);
  const d = (await boss.get('users')).data.devices.find((x) => x.id === r.data.device_id);
  assert.ok(d.logged_out_at > 0);
  const back = await devLogin('anna@example.com', { device_id: r.data.device_id });
  assert.equal(back.data.device_id, r.data.device_id);
  assert.equal((await boss.get('users')).data.devices.find((x) => x.id === r.data.device_id).logged_out_at, null);
});
await test('让他重新登录：这个人所有电脑的令牌和后台会话都作废；主管只能对本组坐席', async () => {
  assert.equal((await admin('sup@example.com').post(`users/${agentB}/signout`)).status, 403);
  assert.equal((await sync(tokB, {})).status, 200);
  assert.equal((await admin('sup@example.com').post(`users/${agentA}/signout`)).status, 200);
  assert.equal((await sync(tokB, {})).status, 401);
  assert.equal((await sync(loginTok, {})).status, 401);
  assert.equal((await sync(tokA, {})).status, 401, '用登记码登记的电脑也作废');
  tokB = (await devLogin('anna@example.com', { device_id: devB })).data.token;
  tokA = (await devLogin('anna@example.com', { device_id: devA })).data.token;
  assert.equal((await sync(tokA, {})).status, 200);
  const supTok = await sessionFor('sup@example.com');
  assert.equal((await boss.post(`users/${sup}/signout`)).status, 200);
  assert.equal((await call('GET', '/api/admin/me', { token: supTok })).status, 401);
  sessions.delete('sup@example.com');
});
await test('改邮箱：主管能改本组坐席的；重名 409，格式不对 400；改了以后用新邮箱登录，旧邮箱查不到', async () => {
  assert.equal((await boss.patch(`users/${agentA}`, { email: 'BEN@example.com' })).status, 409);
  assert.equal((await boss.patch(`users/${agentA}`, { email: 'nope' })).status, 400);
  assert.equal((await admin('sup@example.com').patch(`users/${agentA}`, { email: 'anna.k@example.com' })).status, 200);
  resetLimits();
  assert.equal((await devCode('anna@example.com')).status, 404);
  assert.equal((await devLogin('anna.k@example.com', { device_id: devB })).status, 200);
  assert.equal((await boss.patch(`users/${agentB}`, { email: '' })).status, 200, '清空邮箱 = 这个人登录不了');
  resetLimits();
  assert.equal((await devCode('ben@example.com')).status, 404);
  await boss.patch(`users/${agentB}`, { email: 'ben@example.com' });
});
await test('定时任务只有一个（每 30 分钟）；每天 UTC 19:00 那次清理过期会话和旧记录，其它时候不清', async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(here, '../wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.deepEqual(cfg.triggers.crons, ['*/30 * * * *']);
  db.raw.prepare("INSERT INTO admin_sessions (token_hash, user_id, created_at, expires_at) VALUES ('old', ?, 0, 1)").run(ownerId);
  db.raw.prepare("INSERT INTO login_codes (email, purpose, code_hash, expires_at, sent_at) VALUES ('old@example.com', 'device', 'x', 1, 0)").run();
  await worker.scheduled({ cron: '*/30 * * * *', scheduledTime: Date.UTC(2026, 10, 2, 19, 30) }, env);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE token_hash = 'old'").get().n, 1);
  await worker.scheduled({ cron: '*/30 * * * *', scheduledTime: Date.UTC(2026, 10, 2, 19, 0) }, env);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE token_hash = 'old'").get().n, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE email = 'old@example.com'").get().n, 0);
});
await test('每日清理任务能跑', async () => {
  await worker.scheduled({}, env);
});
await test('后台页面：时间今年写「11/08 13:23」，别的年份写「12/30/25 13:23」；颜色下拉写中文名', async () => {
  const load = (file, extra) => {
    const ctx = vm.createContext({ module: { exports: {} }, ...extra });
    vm.runInContext(fs.readFileSync(path.join(here, '../public/admin', file), 'utf8'), ctx);
    return ctx.module.exports;
  };
  const RADIX = load('radix.js');
  const page = load('admin.js', { RADIX });
  const now = new Date(2026, 10, 10, 9, 0).getTime();
  assert.equal(page.time(new Date(2026, 10, 8, 13, 23, 37).getTime(), now), '11/08 13:23');
  assert.equal(page.time(new Date(2026, 0, 5, 9, 7, 59).getTime(), now), '01/05 09:07');
  assert.equal(page.time(new Date(2025, 11, 30, 13, 23).getTime(), now), '12/30/25 13:23');
  assert.equal(page.time(new Date(2009, 2, 4, 0, 5).getTime(), now), '03/04/09 00:05');
  assert.equal(page.time(new Date(2027, 0, 1, 23, 59).getTime(), now), '01/01/27 23:59');
  assert.deepEqual([...page.COLOR_NAMES], ['绿', '紫', '橙', '蓝', '红', '灰']);
  assert.equal(page.COLOR_NAMES.length, RADIX.ACCOUNT_COLORS.length);
  assert.deepEqual([...RADIX.ACCOUNT].map(([f]) => f), ['green', 'violet', 'orange', 'blue', 'crimson', 'slate'], '颜色顺序变了要同时改 COLOR_NAMES');
});
console.log(`全部通过（${passed} 项）`);
