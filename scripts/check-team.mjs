// 团队模式端到端自检：WAswitch 的同步模块（src/team）对着真的 Worker 代码 + 内存 SQLite。
// 不需要 Electron，不联网。node scripts/check-team.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fakeD1 } from '../server/test/fake-d1.mjs';
import worker from '../server/src/index.js';

const require = createRequire(import.meta.url);
const { TeamSync, TEAM_SERVER, GRACE_MS } = require('../src/team/index.js');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = 'https://team.example.com';

// ---- 后台：内存数据库；发信换成假的（从信里取码），老板用 OWNER_EMAIL 收码登录后台 ----
const db = fakeD1(path.join(root, 'server/migrations'));
const env = { DB: db, OWNER_EMAIL: 'boss@example.com', RESEND_API_KEY: 're_test', ASSETS: { fetch: async () => new Response('') } };
const mails = [];
const mail = { mode: 'ok' };
globalThis.fetch = async (url, opts) => {
  assert.equal(url, 'https://api.resend.com/emails');
  if (mail.mode === '500') return new Response('{"message":"x"}', { status: 500 });
  mails.push(JSON.parse(opts.body));
  return new Response('{}', { headers: { 'content-type': 'application/json' } });
};
const lastCode = (to) => { const m = [...mails].reverse().find((x) => x.to[0] === to); return m && /验证码 (\d{6})/.exec(m.text)[1]; };
// 测试里同一个邮箱要码很多次：清掉限速记录（60 秒重发间隔、每小时次数）
const resetLimits = () => db.raw.prepare("DELETE FROM rate_limits WHERE key LIKE 'code:%' OR key LIKE 'verify:%' OR key LIKE 'login:%'").run();
const adminReq = (p, body, token) => worker.fetch(new Request(`${SERVER}/api/admin/${p}`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'x-waswitch-admin': '1', ...(token ? { authorization: `Bearer ${token}` } : {}) },
}), env, {});
await adminReq('code', { email: 'boss@example.com' });
const bossToken = (await (await adminReq('session', { email: 'boss@example.com', code: lastCode('boss@example.com') })).json()).token;
assert.ok(bossToken, '老板登录后台');
async function boss(method, p, body) {
  const res = await worker.fetch(new Request(`${SERVER}/api/admin/${p}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: `Bearer ${bossToken}`, 'x-waswitch-admin': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  }), env, {});
  return res.json();
}

// 网络开关：模拟断网、401、HTML 错误页等
let net = 'ok';
const sent = [];
async function fetchImpl(url, opts) {
  assert.equal(opts.redirect, 'error');
  assert.ok(url.startsWith(`${SERVER}/api/device/`), url);
  assert.ok(!JSON.stringify(opts.headers).includes('cookie'));
  if (net === 'down') throw new TypeError('fetch failed');
  if (net === '401') return new Response('{"error":"x"}', { status: 401, headers: { 'content-type': 'application/json' } });
  if (net === '403plain') return new Response('{"error":"forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } });
  if (net === '403other') return new Response('{"revoked":true,"device_id":"00000000-0000-0000-0000-000000000000"}', { status: 403, headers: { 'content-type': 'application/json' } });
  if (net === 'html') return new Response('<html>Access login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (opts.body && url.endsWith('/sync')) sent.push(JSON.parse(opts.body));
  return worker.fetch(new Request(url, opts), env, {});
}
// 后台已经改不了登录策略（一律必须登录，迁移 0007）；这里直接改库，好测电脑端在各种策略下的表现
const setPolicy = async (login) => { db.raw.prepare("UPDATE meta SET value = ? WHERE key = 'login_policy'").run(['off', 'optional', 'required'].indexOf(login)); };

// ---- 一台模拟的 WAswitch ----
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(`enc:${t}`), decryptString: (b) => b.toString().replace(/^enc:/, '') };
const clock = { t: Date.now() };
function machine(name, accounts, dir = fs.mkdtempSync(path.join(os.tmpdir(), `team-${name}-`))) {
  const log = [];
  const m = { accounts, log, dir };
  const timers = { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} }; // 不自动跑，测试里手动 syncNow
  m.team = new TeamSync({
    dir, safeStorage: fakeSafe, appVersion: '0.4.0', platform: 'win32', server: SERVER, fetchImpl, timers, now: () => clock.t,
    hooks: {
      accounts: () => m.accounts,
      save: () => log.push('save'),
      statusOf: (a) => ({ state: 'ready', unread: a.unread || 0, proxy_ok: true, proxy_ms: 80, exit_ip: '1.2.3.4', exit_country: 'US', exit_changed: false }),
      deviceInfo: () => ({ mem_mb: 700, low_mem: false }),
      park: (a) => log.push(`park:${a.id}`),
      unpark: (a) => log.push(`unpark:${a.id}`),
      createSeat: (seat) => { const a = { id: String(9000 + m.accounts.length), name: seat.name, color: seat.color, mode: seat.mode, teamId: seat.teamId, teamHidden: false, teamNeedsProxy: true, teamNote: seat.note }; m.accounts.push(a); log.push(`create:${seat.teamId}`); return a; },
      refresh: () => log.push('refresh'),
    },
  });
  return m;
}
const acc = (id, name, extra = {}) => ({ id, name, color: '#16A34A', mode: 'web', proxy: 'socks5://127.0.0.1:7891', proxyPassword: 'SECRETPASS', ...extra });

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
console.log('团队模式端到端自检');

const me = await boss('GET', 'me');
assert.equal(me.user.role, 'owner');
const userA = await boss('POST', 'users', { name: 'Emma Schulz', email: 'emma@example.com' });
const userB = await boss('POST', 'users', { name: 'Lucas Martin', email: 'lucas@example.com' });
assert.ok(userA.id && userB.id, '后台加人');
// 要码、从假邮箱里取码、登录。每次先清掉限速记录
async function signIn(m, email) {
  resetLimits();
  const r = await m.team.requestCode({ email });
  if (!r.ok) return r;
  return m.team.login({ email, code: lastCode(email.trim().toLowerCase()) });
}
const A = machine('a', [acc('101', '一号'), acc('102', '二号'), acc('103', '三号'), acc('104', '私人号')]);

await test('后台地址写死；没登录时是 none，策略默认 off，不锁', async () => {
  assert.equal(TEAM_SERVER, 'https://wa.laicrm.com');
  const plain = new TeamSync({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-x-')), safeStorage: fakeSafe, hooks: A.team.hooks, server: 'http://evil.example.com' });
  assert.equal(plain.server, TEAM_SERVER, '不是 https 的地址不认');
  assert.equal(A.team.loginState(), 'none');
  assert.equal(A.team.policy(), 'off');
  assert.equal(A.team.locked(), false);
  assert.equal(A.team.isParked(A.accounts[3]), false);
});
await test('问策略：不带令牌；required 且没登录就锁，所有号都停着', async () => {
  await setPolicy('required');
  assert.deepEqual(await A.team.fetchPolicy(), { ok: true, policy: 'required' });
  assert.equal(A.team.locked(), true);
  assert.ok(A.accounts.every((a) => A.team.isParked(a)));
  net = 'down';
  assert.equal((await A.team.fetchPolicy()).offline, true);
  assert.equal(A.team.policy(), 'required', '连不上时用上次记下的');
  net = 'ok';
  await setPolicy('optional');
  await A.team.fetchPolicy();
  assert.equal(A.team.locked(), false);
});
await test('要验证码：没加入团队、停用、太频繁、发不出去、连不上，都只给一句话', async () => {
  assert.deepEqual(await A.team.requestCode({ email: 'nobody@example.com' }), { error: '这个邮箱还没加入团队，请找管理员' });
  assert.deepEqual(await A.team.requestCode({ email: 'not-an-email' }), { error: '邮箱格式不对' });
  await boss('PATCH', `users/${userB.id}`, { disabled: true });
  assert.deepEqual(await A.team.requestCode({ email: 'lucas@example.com' }), { error: '这个账号已停用' });
  await boss('PATCH', `users/${userB.id}`, { disabled: false });
  resetLimits();
  assert.deepEqual(await A.team.requestCode({ email: ' Emma@Example.com ' }), { ok: true, resendAfterS: 60 });
  const busy = await A.team.requestCode({ email: 'emma@example.com' });
  assert.match(busy.error, /^太频繁了，请 \d+ 秒后再试$/);
  assert.ok(busy.retryAfterS > 0 && busy.retryAfterS <= 60);
  resetLimits();
  mail.mode = '500';
  assert.deepEqual(await A.team.requestCode({ email: 'emma@example.com' }), { error: '验证码发不出去，请稍后再试' });
  mail.mode = 'ok';
  net = 'down';
  const r = await A.team.requestCode({ email: 'emma@example.com' });
  net = 'ok';
  assert.equal(r.error, '连不上团队后台');
  assert.equal(r.offline, true);
});
await test('登录失败：码不对、过期、账号停用、连不上，都不存令牌', async () => {
  resetLimits();
  await A.team.requestCode({ email: 'emma@example.com' });
  const good = lastCode('emma@example.com');
  const wrong = good === '000000' ? '111111' : '000000';
  assert.deepEqual(await A.team.login({ email: 'emma@example.com', code: wrong }), { error: '验证码不对或已过期', badCode: true });
  assert.deepEqual(await A.team.login({ email: 'emma@example.com', code: '12ab' }), { error: '验证码不对或已过期', badCode: true });
  resetLimits();
  await A.team.requestCode({ email: 'emma@example.com' });
  db.raw.prepare('UPDATE login_codes SET expires_at = 0').run();
  assert.deepEqual(await A.team.login({ email: 'emma@example.com', code: lastCode('emma@example.com') }), { error: '验证码不对或已过期', badCode: true }, '过期');
  net = 'down';
  const r = await A.team.login({ email: 'emma@example.com', code: '123456' });
  net = 'ok';
  assert.equal(r.error, '连不上团队后台');
  assert.equal(A.team.joined(), false);
  const noKey = new TeamSync({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-y-')), safeStorage: { isEncryptionAvailable: () => false }, hooks: A.team.hooks, server: SERVER, fetchImpl });
  assert.match((await noKey.requestCode({ email: 'emma@example.com' })).error, /加密/);
  assert.match((await noKey.login({ email: 'emma@example.com', code: '123456' })).error, /加密/);
});
await test('登录时 429：说等多少秒', async () => {
  const T = new TeamSync({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-z-')), safeStorage: fakeSafe, hooks: A.team.hooks, server: SERVER,
    fetchImpl: async () => new Response('{"retry_after_s":600}', { status: 429, headers: { 'content-type': 'application/json' } }) });
  assert.deepEqual(await T.login({ email: 'emma@example.com', code: '123456' }), { error: '太频繁了，请 600 秒后再试', retryAfterS: 600 });
});
await test('登录成功：令牌加密存盘，记下名字和策略', async () => {
  assert.deepEqual(await signIn(A, 'Emma@example.com'), { ok: true });
  assert.equal(A.team.loginState(), 'ok');
  assert.equal(A.team.snapshot().userName, 'Emma Schulz');
  assert.equal(A.team.snapshot().email, 'emma@example.com', '记下邮箱，下次预先填好');
  const file = fs.readFileSync(path.join(A.dir, 'team.json'), 'utf8');
  assert.ok(!/"token": "[A-Za-z0-9_-]{43}"/.test(file));
  assert.ok(file.includes('"policy": "optional"'));
  assert.deepEqual(await A.team.join(['101', '102', '103']), { ok: true });
  assert.ok(A.accounts.slice(0, 3).every((a) => /^[0-9a-f-]{36}$/.test(a.teamId)));
  assert.equal(A.accounts[3].teamId, undefined);
});
await test('同步：上传内容只有白名单字段，不含代理和密码；同步顺便刷新策略', async () => {
  sent.length = 0;
  A.accounts[0].unread = 2;
  await setPolicy('required');
  assert.deepEqual(await A.team.syncNow(), { ok: true });
  assert.equal(A.team.policy(), 'required');
  assert.equal(A.team.locked(), false, '登录着就不锁');
  const body = JSON.stringify(sent);
  for (const bad of ['SECRETPASS', '127.0.0.1:7891', '私人号', 'last_active', 'unread_since', lastCode('emma@example.com')]) assert.ok(!body.includes(bad), `不该上传 ${bad}`);
  assert.equal(sent[0].status.length, 3);
  assert.deepEqual(Object.keys(sent[0].status[0]).sort(), ['exit_changed', 'exit_country', 'exit_ip', 'proxy_ms', 'proxy_ok', 'state', 'team_id', 'unread']);
  const ov = await boss('GET', 'overview');
  assert.equal(ov.accounts.find((a) => a.id === A.accounts[0].teamId).unread, 2);
  assert.ok(A.team.snapshot().lastUpload.includes('"unread": 2'));
});
await test('事件：掉线记录随下次同步上传，成功后清空队列', async () => {
  A.team.recordEvent(A.accounts[0], 'dropped');
  A.team.recordEvent(A.accounts[3], 'dropped'); // 私人号不记
  A.team.recordEvent(A.accounts[0], 'whatever');
  sent.length = 0;
  await A.team.syncNow();
  assert.deepEqual(sent[0].events.map((e) => e.kind), ['dropped']);
  assert.equal(A.team.state.events.length, 0);
});
await test('断网、不带 revoked 的 403、别人的 revoked、HTML 页面：都只当离线，不停号', async () => {
  for (const mode of ['down', '403plain', '403other', 'html']) {
    net = mode;
    A.log.length = 0;
    A.team.recordEvent(A.accounts[1], 'proxy_down');
    const r = await A.team.syncNow();
    assert.equal(r.offline, true, mode);
    assert.ok(!A.log.some((x) => x.startsWith('park')), mode);
    assert.equal(A.team.loginState(), 'ok');
    assert.equal(A.team.locked(), false);
  }
  net = 'ok';
  sent.length = 0;
  assert.deepEqual(await A.team.syncNow(), { ok: true });
  assert.equal(sent[0].events.length, 4); // 离线期间的事件补报
  assert.equal(A.team.failures, 0);
});
await test('必须登录时连不上后台：7 天内照常用，超过 7 天才锁；一连上自动解锁，不用重新登录', async () => {
  net = 'down';
  clock.t += GRACE_MS - 60_000;
  await A.team.syncNow();
  assert.equal(A.team.locked(), false, '7 天内不锁');
  clock.t += 2 * 60_000;
  await A.team.syncNow();
  assert.equal(A.team.locked(), true, '超过 7 天锁上');
  assert.equal(A.team.loginState(), 'ok', '令牌还在');
  assert.ok(A.accounts.every((a) => A.team.isParked(a)));
  net = 'ok';
  assert.deepEqual(await A.team.syncNow(), { ok: true });
  assert.equal(A.team.locked(), false, '连上就解锁');
  assert.equal(A.team.isParked(A.accounts[0]), false);
});

const B = machine('b', [acc('201', 'B 的私人号')]);
await test('换人：原电脑隐藏这个号，新电脑新建一个待填代理的号', async () => {
  assert.deepEqual(await signIn(B, 'lucas@example.com'), { ok: true });
  const users = await boss('GET', 'users');
  const devB = users.devices.find((d) => d.user_id === userB.id).id;
  const t1 = A.accounts[0].teamId;
  await boss('POST', `accounts/${t1}/assign`, { device_id: devB });
  A.log.length = 0;
  await A.team.syncNow();
  assert.equal(A.accounts[0].teamHidden, true);
  assert.ok(A.log.includes('park:101'));
  assert.equal(A.team.isParked(A.accounts[0]), true);
  await B.team.syncNow();
  assert.ok(B.log.includes(`create:${t1}`));
  const seat = B.accounts.find((a) => a.teamId === t1);
  assert.equal(seat.teamNeedsProxy, true);
  assert.equal(seat.name, '一号');
  // 分回来：原电脑恢复显示（数据一直在）
  const devA = users.devices.find((d) => d.user_id === userA.id).id;
  await boss('POST', `accounts/${t1}/assign`, { device_id: devA });
  A.log.length = 0;
  await A.team.syncNow();
  assert.equal(A.accounts[0].teamHidden, false);
  assert.ok(A.log.includes('unpark:101'));
});
await test('一次要收回一半以上的号：先暂停，管理员确认后才执行', async () => {
  const [t1, t2] = [A.accounts[0].teamId, A.accounts[1].teamId];
  await boss('POST', `accounts/${t1}/unassign`);
  await boss('POST', `accounts/${t2}/unassign`);
  A.log.length = 0;
  await A.team.syncNow();
  assert.ok(!A.log.some((x) => x.startsWith('park')));
  assert.equal(A.team.state.held.length, 2);
  await A.team.syncNow(); // 把暂停数报上去
  const devA = (await boss('GET', 'users')).devices.find((d) => d.user_id === userA.id);
  assert.equal(devA.held_hides, 2);
  await boss('POST', `devices/${devA.id}/confirm-hides`);
  await A.team.syncNow();
  assert.ok(A.log.includes('park:101') && A.log.includes('park:102'));
  assert.equal(A.team.state.held.length, 0);
});
await test('私人号一律停着（公司不允许）：后台没有开关，传了也恢复不了', async () => {
  await A.team.syncNow();
  assert.equal(A.team.state.allowPrivate, false);
  assert.equal(A.team.isParked(A.accounts[3]), true);
  await boss('PUT', 'settings', { allow_private: true });
  A.log.length = 0;
  await A.team.syncNow();
  assert.equal(A.team.isParked(A.accounts[3]), true);
  assert.ok(!A.log.includes('unpark:104'));
});
await test('团队号一律同步到 CRM：坐席同步后这个号带上 teamCrm；后台关不掉', async () => {
  const mine = A.accounts.find((a) => a.teamId && !a.teamHidden);
  assert.deepEqual(await A.team.syncNow(), { ok: true });
  assert.equal(mine.teamCrm, true);
  await boss('PATCH', `accounts/${mine.teamId}`, { crm_sync: false });
  await A.team.syncNow();
  assert.equal(mine.teamCrm, true);
});
await test('提前同步只看状态变化，未读数不触发；离上一次同步至少 60 秒', async () => {
  let now = clock.t;
  const t0 = now;
  const waits = [];
  let st = 'ready';
  const T = new TeamSync({
    dir: A.dir, safeStorage: fakeSafe, appVersion: '0.4.0', platform: 'win32', server: SERVER, fetchImpl, now: () => now,
    timers: { setTimeout: (_f, ms) => { waits.push(ms); return {}; }, clearTimeout: () => {} },
    hooks: { ...A.team.hooks, statusOf: (a) => ({ state: st, unread: a.unread || 0, proxy_ms: 83 }) },
  });
  const mine = A.accounts.find((a) => a.teamId && !a.teamHidden);
  T.noteChange();
  assert.deepEqual(await T.syncNow(), { ok: true }); // 同步完排上正常的下一次（2 分钟后）
  assert.equal(T.statusList()[0].proxy_ms, 100); // 延迟取整到 50 毫秒
  waits.length = 0;
  for (let i = 0; i < 20; i += 1) { mine.unread = 10 + i; now += 1000; T.noteChange(); }
  assert.deepEqual(waits, [], '未读数变化不该提前同步');
  st = 'needs_qr';
  T.noteChange();
  assert.equal(waits.length, 1);
  assert.equal(now + waits[0], t0 + 60_000, '离上一次同步至少 60 秒');
  T.recordEvent(mine, 'dropped');
  assert.equal(waits.length, 1, '已经排了同一时间的同步，不再重排');
  mine.unread = 0;
  T.state.events.length = 0;
  T.persist();
  A.team.state = A.team.load();
});
await test('重启后从磁盘恢复登录状态；换了后台地址的旧文件不认', async () => {
  const again = new TeamSync({ dir: A.dir, safeStorage: fakeSafe, hooks: A.team.hooks, appVersion: '0.4.0', platform: 'darwin', server: SERVER, fetchImpl, now: () => clock.t, timers: { setTimeout: () => ({}), clearTimeout: () => {} } });
  assert.equal(again.loginState(), 'ok');
  assert.equal(again.policy(), 'required');
  assert.deepEqual(await again.syncNow(), { ok: true });
  const other = new TeamSync({ dir: A.dir, safeStorage: fakeSafe, hooks: A.team.hooks, fetchImpl });
  assert.equal(other.loginState(), 'none');
  assert.equal(other.policy(), 'off');
});
await test('停用电脑（403 revoked）：变成“已停用”，必须登录时整个锁上；恢复后自动回来', async () => {
  const devA = (await boss('GET', 'users')).devices.find((d) => d.user_id === userA.id && !d.revoked_at);
  await boss('POST', `devices/${devA.id}/revoke`);
  A.log.length = 0;
  assert.deepEqual(await A.team.syncNow(), { revoked: true });
  assert.equal(A.team.loginState(), 'disabled');
  assert.equal(A.team.locked(), true);
  assert.ok(A.log.includes('park:103'));
  assert.ok(A.accounts.every((a) => A.team.isParked(a)));
  assert.equal(A.accounts[2].teamHidden, false, '只是停着，不算收回');
  await setPolicy('optional');
  await A.team.fetchPolicy();
  assert.equal(A.team.locked(), false);
  assert.equal(A.team.isParked(A.accounts[2]), true, '提示登录时团队号照样停着');
  assert.equal(A.team.isParked(A.accounts[3]), false, '私人号照常');
  await setPolicy('required');
  await A.team.fetchPolicy();
  await boss('POST', `devices/${devA.id}/restore`);
  A.log.length = 0;
  assert.deepEqual(await A.team.syncNow(), { ok: true });
  assert.equal(A.team.loginState(), 'ok');
  assert.equal(A.team.locked(), false);
  assert.equal(A.accounts[2].teamHidden, false);
  assert.equal(A.team.state.cursor > 0, true, '恢复后从头拿了一遍坐席');
  assert.ok(A.log.includes('unpark:103'));
});
await test('401（令牌失效）：回到没登录，团队号停着；必须登录时锁上', async () => {
  net = '401';
  A.log.length = 0;
  const r = await A.team.syncNow();
  net = 'ok';
  assert.equal(r.loggedOut, true);
  assert.equal(A.team.loginState(), 'none');
  assert.equal(A.team.locked(), true);
  assert.ok(A.log.includes('park:103'));
  assert.equal(A.accounts[2].teamHidden, false, '不是收回，只是停着');
  assert.equal((await A.team.syncNow()).skipped, true, '没登录不同步');
});
await test('同一个人再登录：沿用这台设备，团队号直接回来', async () => {
  const dev = A.team.state.deviceId;
  A.log.length = 0;
  assert.deepEqual(await signIn(A, 'emma@example.com'), { ok: true });
  assert.equal(A.team.state.deviceId, dev);
  assert.equal(A.team.locked(), false);
  assert.equal(A.accounts[2].teamHidden, false);
  assert.equal(A.team.isParked(A.accounts[2]), false);
  await A.team.syncNow();
});
await test('退出登录：令牌在后台作废、本机删掉；团队号停着；必须登录时锁上', async () => {
  const tokenBefore = A.team.tokenPlain();
  A.log.length = 0;
  assert.deepEqual(await A.team.logout(), { ok: true });
  const old = await worker.fetch(new Request(`${SERVER}/api/device/sync`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenBefore}` }, body: JSON.stringify({ v: 1 }) }), env, {});
  assert.equal(old.status, 401, '旧令牌在后台作废');
  assert.equal(A.team.loginState(), 'none');
  assert.equal(A.team.locked(), true);
  assert.ok(A.log.includes('park:103'));
  assert.ok(!fs.readFileSync(path.join(A.dir, 'team.json'), 'utf8').includes('"userName": "Emma'));
  // 连不上后台也照样退出
  await signIn(A, 'emma@example.com');
  net = 'down';
  assert.deepEqual(await A.team.logout(), { ok: true });
  net = 'ok';
  assert.equal(A.team.loginState(), 'none');
});
await test('本机的设备被停用后再登录：说明已停用，device_id 留着不换', async () => {
  await A.team.logout();
  const dev = A.team.state.deviceId;
  await boss('POST', `devices/${dev}/revoke`);
  assert.deepEqual(await signIn(A, 'emma@example.com'), { error: '这台电脑已被管理员停用', disabled: true });
  assert.equal(A.team.state.deviceId, dev, 'device_id 没丢');
  assert.equal(A.team.loginState(), 'none');
  await boss('POST', `devices/${dev}/restore`);
});
await test('换人登录：新设备，本机原来的团队号先收起，等后台分配', async () => {
  const dev = A.team.state.deviceId;
  A.accounts[2].teamCrm = true;
  assert.deepEqual(await signIn(A, 'lucas@example.com'), { ok: true });
  assert.notEqual(A.team.state.deviceId, dev);
  assert.equal(A.accounts[2].teamHidden, true);
  assert.equal(A.accounts[2].teamCrm, false);
  assert.equal(A.team.isParked(A.accounts[2]), true);
  assert.equal(A.team.snapshot().userName, 'Lucas Martin');
});
console.log(`全部通过（${passed} 项）`);
