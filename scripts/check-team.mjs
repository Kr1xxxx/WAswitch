// 团队模式端到端自检：WAswitch 的同步模块（src/team）对着旧团队后台的 Worker 代码（server/）+ 内存 SQLite，
// 再加一个按来财 /api/device/* 新规矩回答的假后台（发码一律 200、错误是 { ok:false, error:'代码' }）。
// 软件里连的是来财（TEAM_SERVER），这里两种后台都测。不需要 Electron，不联网。node scripts/check-team.mjs
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
const joins = [];
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
  if (opts.body && url.endsWith('/join')) joins.push(JSON.parse(opts.body));
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
const A = machine('a', [acc('101', '一号', { phone: '+49 151 1111 2222' }), acc('102', '二号'), acc('103', '三号')]);

await test('后台地址写死；没登录时是 none；还没问到策略（连不上来财）时按必须登录算，锁上', async () => {
  assert.equal(TEAM_SERVER, 'https://laicrm.com');
  const plain = new TeamSync({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-x-')), safeStorage: fakeSafe, hooks: A.team.hooks, server: 'http://evil.example.com' });
  assert.equal(plain.server, TEAM_SERVER, '不是 https 的地址不认');
  assert.equal(A.team.loginState(), 'none');
  assert.equal(A.team.policy(), 'required');
  assert.equal(A.team.locked(), true);
  assert.equal(A.team.isParked(A.accounts[2]), true, '新装、连不上来财：号不能不登录就照常运行');
  net = 'down';
  assert.equal((await A.team.fetchPolicy()).offline, true);
  net = 'ok';
  assert.equal(A.team.locked(), true, '问不到策略还是锁着');
  // team.json 里的策略写坏了：也按必须登录
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-p-'));
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({ server: SERVER, policy: 'whatever' }));
  assert.equal(new TeamSync({ dir, safeStorage: fakeSafe, hooks: A.team.hooks, server: SERVER, fetchImpl }).policy(), 'required');
  await setPolicy('off');
  assert.deepEqual(await A.team.fetchPolicy(), { ok: true, policy: 'off' });
  assert.equal(A.team.locked(), false, '问到了 off 才不锁');
  assert.equal(A.team.isParked(A.accounts[2]), false);
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
await test('要验证码：格式不对、太频繁、发不出去、连不上，都只给一句话', async () => {
  assert.deepEqual(await A.team.requestCode({ email: 'not-an-email' }), { error: '邮箱格式不对' });
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
});
await test('登录后第一次同步：本机每个号自动加入团队，带上自己的号码', async () => {
  joins.length = 0;
  assert.deepEqual(await A.team.syncNow(), { ok: true });
  assert.ok(A.accounts.every((a) => /^[0-9a-f-]{36}$/.test(a.teamId)), '三个号都加入了');
  assert.equal(joins.length, 1);
  assert.deepEqual(joins[0].accounts.map((a) => [a.local_id, a.phone]), [['101', '+4915111112222'], ['102', ''], ['103', '']]);
  assert.deepEqual(Object.keys(joins[0].accounts[0]).sort(), ['color', 'local_id', 'mode', 'name', 'phone']);
  assert.ok(!JSON.stringify(joins).includes('SECRETPASS'));
  joins.length = 0;
  await A.team.syncNow();
  assert.equal(joins.length, 0, '都加入了就不再调 /join');
});
await test('同步：上传内容只有白名单字段，不含代理和密码；同步顺便刷新策略', async () => {
  sent.length = 0;
  A.accounts[0].unread = 2;
  await setPolicy('required');
  assert.deepEqual(await A.team.syncNow(), { ok: true });
  assert.equal(A.team.policy(), 'required');
  assert.equal(A.team.locked(), false, '登录着就不锁');
  const body = JSON.stringify(sent);
  for (const bad of ['SECRETPASS', '127.0.0.1:7891', '一号', 'last_active', 'unread_since', lastCode('emma@example.com')]) assert.ok(!body.includes(bad), `不该上传 ${bad}`);
  assert.equal(sent[0].status.length, 3);
  assert.deepEqual(Object.keys(sent[0].status[0]).sort(), ['exit_changed', 'exit_country', 'exit_ip', 'phone', 'proxy_ms', 'proxy_ok', 'state', 'team_id', 'unread']);
  assert.deepEqual(sent[0].status.map((x) => x.phone), ['+4915111112222', '', ''], '每个号自己的号码');
  const ov = await boss('GET', 'overview');
  assert.equal(ov.accounts.find((a) => a.id === A.accounts[0].teamId).unread, 2);
  assert.ok(A.team.snapshot().lastUpload.includes('"unread": 2'));
});
await test('事件：掉线记录随下次同步上传，成功后清空队列', async () => {
  A.team.recordEvent(A.accounts[0], 'dropped');
  A.team.recordEvent({ id: '999', name: '没加入的号' }, 'dropped'); // 不是团队号的不记
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
await test('新加的号马上自动加入团队（没有私人号）；加入前后都照常运行', async () => {
  await A.team.syncNow();
  assert.equal(A.team.state.allowPrivate, false);
  A.accounts.push(acc('104', '四号', { phone: '+44 7700 900123', mode: 'lite' }));
  assert.equal(A.team.isParked(A.accounts[3]), false, '还没加入时也不停着（不让新号消失）');
  joins.length = 0;
  A.log.length = 0;
  A.team.noteChange();
  await A.team.joining;
  assert.match(A.accounts[3].teamId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(joins[0].accounts, [{ local_id: '104', name: '四号', color: '#16A34A', mode: 'lite', phone: '+447700900123' }]);
  assert.equal(A.team.isParked(A.accounts[3]), false);
  assert.ok(!A.log.some((x) => x.endsWith(':104')), '一直在运行，不停也不重启');
  A.team.noteChange();
  assert.equal(A.team.joining, null, '同一批号不重复加入');
  await A.team.syncNow();
  assert.equal(A.accounts[3].teamCrm, true, '坐席同步后带上 CRM');
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
  // 旧版连的是别的后台（wa.laicrm.com）：登录不认；那边的团队号当作没加入（登录后自动加入来财），被收回的不动
  const copies = A.accounts.map((a) => ({ ...a }));
  let saved = 0;
  const other = new TeamSync({ dir: A.dir, safeStorage: fakeSafe, hooks: { ...A.team.hooks, accounts: () => copies, save: () => { saved += 1; } }, fetchImpl });
  assert.equal(other.loginState(), 'none');
  assert.equal(other.policy(), 'required', '旧后台的策略不认，按必须登录');
  assert.equal(saved, 1);
  for (const [i, a] of copies.entries()) {
    if (A.accounts[i].teamHidden) assert.equal(a.teamId, A.accounts[i].teamId, '收回的号不动');
    else {
      assert.deepEqual([a.teamId, a.teamCrm, a.teamNote], ['', false, ''], `${a.id} 当作没加入`);
      assert.equal(a.teamKeepQueue, true, '本机队列留着，重新加入后接着传');
      assert.equal(a.teamRejoin, true, '来财知道号码以前不上传');
    }
  }
  assert.deepEqual(other.pendingJoin(), copies.filter((a) => !a.teamHidden).map((a) => a.id));
  assert.equal(A.accounts.filter((a) => a.teamId).length, 4, '原来的账号没被改');
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
  assert.equal(A.accounts[2].teamCrm, true, '停用不撤 CRM 授权：本机队列留着，恢复或重新登录后接着传');
  await setPolicy('optional');
  await A.team.fetchPolicy();
  assert.equal(A.team.locked(), false);
  assert.equal(A.team.isParked(A.accounts[2]), true, '提示登录时团队号照样停着');
  assert.equal(A.team.isParked(A.accounts[3]), true, '团队号都停着');
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
  assert.equal(A.accounts[2].teamCrm, true, '401 不撤 CRM 授权：队列留着');
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
await test('换人登录：新设备，本机原来的团队号清掉 teamId，在新设备上重新加入（不收起）；收回的号不动', async () => {
  const dev = A.team.state.deviceId;
  A.accounts[2].teamCrm = true;
  const hiddenBefore = A.accounts.filter((a) => a.teamHidden).map((a) => [a.id, a.teamId]);
  let changed = 0;
  A.team.hooks.personChanged = () => { changed += 1; };
  assert.deepEqual(await signIn(A, 'lucas@example.com'), { ok: true });
  delete A.team.hooks.personChanged;
  assert.equal(changed, 1, '换了人：告诉主进程（删上一个人解不开的旧队列）');
  assert.notEqual(A.team.state.deviceId, dev);
  assert.equal(A.accounts[2].teamId, '');
  assert.equal(A.accounts[2].teamHidden, false);
  assert.equal(A.accounts[2].teamCrm, false);
  assert.equal(A.accounts[2].teamRejoin, true);
  assert.equal(A.accounts[2].teamKeepQueue, undefined, '换了人：队列不留');
  assert.equal(A.team.isParked(A.accounts[2]), false, '没加入的号照常运行，马上自动加入');
  assert.deepEqual(A.accounts.filter((a) => a.teamHidden).map((a) => [a.id, a.teamId]), hiddenBefore, '管理员收回的号还是收着');
  assert.equal(A.team.snapshot().userName, 'Lucas Martin');
});
// ---- 来财的新规矩（假后台）：发码一律 200；错误是 { ok:false, error:'代码' }；/join 和 /sync 带号码 ----
function laicai(handler) {
  const calls = [];
  const fetchLai = async (url, opts) => {
    assert.equal(opts.redirect, 'error');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path: new URL(url).pathname, body });
    const [status, data] = handler(new URL(url).pathname, body) || [404, { ok: false, error: 'not_found' }];
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchLai };
}
await test('来财：发码一律 200（不说邮箱是不是成员）；429 说等几秒；停用的账号登录时才说', async () => {
  const L = laicai((p, b) => {
    if (p === '/api/device/code') return b.email === 'busy@example.com' ? [429, { ok: false, error: 'rate', retry_after_s: 120 }] : [200, { ok: true, resend_after_s: 60 }];
    if (p === '/api/device/login') return [403, { ok: false, error: 'disabled' }];
    return null;
  });
  const T = new TeamSync({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-l-')), safeStorage: fakeSafe, hooks: A.team.hooks, server: SERVER, fetchImpl: L.fetchLai });
  assert.deepEqual(await T.requestCode({ email: 'nobody@example.com' }), { ok: true, resendAfterS: 60 });
  assert.deepEqual(await T.requestCode({ email: 'busy@example.com' }), { error: '太频繁了，请 120 秒后再试', retryAfterS: 120 });
  assert.deepEqual(await T.login({ email: 'nobody@example.com', code: '123456' }), { error: '这个账号已停用' });
  const old = fs.readFileSync(new URL('../src/team/index.js', import.meta.url), 'utf8');
  assert.ok(!old.includes('这个邮箱还没加入团队'), '没有“邮箱没加入团队”的说法了');
});
await test('来财：登录后同步，本机的号自动加入；/join 出错只给一句话、不把后台的代码当原话显示', async () => {
  const UUID = (n) => `00000000-0000-4000-8000-00000000000${n}`;
  let joinFails = true;
  const L = laicai((p, b) => {
    if (p === '/api/device/login') return [200, { device_id: UUID(9), token: 'K'.repeat(43), user: { name: 'Emma Schulz' }, allow_private: false, login: 'required' }];
    if (p === '/api/device/join') return joinFails ? [400, { ok: false, error: 'too_many' }] : [200, { accounts: b.accounts.map((a, i) => ({ local_id: a.local_id, team_id: UUID(i + 1) })) }];
    if (p === '/api/device/sync') return [200, { ok: true, device_id: UUID(9), seats: [], cursor: 0, more: false, allow_private: false, login: 'required', user: { name: 'Emma Schulz' }, confirm_hides: false, next_sync_s: 120, server_time: clock.t }];
    return null;
  });
  const accs = [acc('1', 'Sales DE', { phone: '+49 30 1234567' }), acc('2', 'Sales FR', { mode: 'lite', phone: '' })];
  const log = [];
  const T = new TeamSync({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-l2-')), safeStorage: fakeSafe, server: SERVER, fetchImpl: L.fetchLai, now: () => clock.t,
    timers: { setTimeout: () => ({}), clearTimeout: () => {} },
    hooks: { ...A.team.hooks, accounts: () => accs, save: () => {}, park: (a) => log.push(`park:${a.id}`), unpark: (a) => log.push(`unpark:${a.id}`), refresh: () => {} } });
  assert.deepEqual(log, [], '新装：没问到策略时按必须登录，号先停着');
  assert.deepEqual(await T.login({ email: 'emma@example.com', code: '123456' }), { ok: true });
  assert.deepEqual(log, ['unpark:1', 'unpark:2'], '登录后启动');
  log.length = 0;
  assert.deepEqual(await T.syncNow(), { ok: true }, '加入失败不影响同步');
  const err = await T.join(['1']);
  assert.equal(err.error, '加入团队没成功（400）');
  assert.ok(accs.every((a) => !a.teamId && !T.isParked(a)), '没加入的号照常运行，下次同步再加入');
  joinFails = false;
  assert.deepEqual(await T.syncNow(), { ok: true });
  assert.deepEqual(accs.map((a) => a.teamId), [UUID(1), UUID(2)]);
  const joinBody = L.calls.filter((c) => c.path === '/api/device/join').pop().body;
  assert.deepEqual(joinBody.accounts.map((a) => a.phone), ['+49301234567', '']);
  assert.ok(accs.every((a) => !T.isParked(a)));
  assert.deepEqual(log, [], '加入前后都在运行');
  await T.syncNow();
  const sync = L.calls.filter((c) => c.path === '/api/device/sync').pop().body;
  assert.deepEqual(sync.status.map((x) => x.phone), ['+49301234567', '']);
});
// ---- 按来财 /api/device/* 规矩的小假后台：设备只在 device_id 和人都对上时沿用；/join 按 (设备, 本机编号) 去重；坐席按设备给 ----
function laicaiCloud() {
  const c = { devices: [], numbers: [], seats: [], calls: [], loseJoin: 0, answer: null, seq: 0 };
  const uuid = () => `00000000-0000-4000-8000-${String(++c.seq).padStart(12, '0')}`;
  const ok = (data) => [200, data];
  c.fetchImpl = async (url, opts) => {
    assert.equal(opts.redirect, 'error');
    const p = new URL(url).pathname;
    const body = opts.body ? JSON.parse(opts.body) : null;
    const tok = (opts.headers.authorization || '').replace(/^Bearer /, '');
    c.calls.push({ path: p, body });
    const dev = c.devices.find((d) => d.token && d.token === tok);
    let r;
    if (c.answer && (r = c.answer(p, body, dev))) return new Response(JSON.stringify(r[1]), { status: r[0], headers: { 'content-type': 'application/json' } });
    if (p === '/api/device/policy') r = ok({ v: 1, login: 'required' });
    else if (p === '/api/device/login') {
      let d = c.devices.find((x) => x.id === body.device_id && x.email === body.email);
      if (!d) { d = { id: uuid(), email: body.email }; c.devices.push(d); }
      d.token = `T${c.seq++}`.padEnd(43, 'x');
      r = ok({ device_id: d.id, token: d.token, user: { name: body.email.split('@')[0] }, allow_private: false, login: 'required' });
    } else if (!dev) r = [401, { ok: false, error: 'login_required' }];
    else if (p === '/api/device/join') {
      const out = body.accounts.map((a) => {
        let seat = c.seats.find((x) => x.device === dev.id && x.local_id === a.local_id);
        if (!seat) {
          const n = { id: uuid(), phone: a.phone, name: a.name };
          c.numbers.push(n);
          seat = { device: dev.id, local_id: a.local_id, number: n.id, visible: true, version: ++c.seq };
          c.seats.push(seat);
        }
        return { local_id: a.local_id, team_id: seat.number };
      });
      if (c.loseJoin > 0) { c.loseJoin -= 1; const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }
      r = ok({ accounts: out });
    } else if (p === '/api/device/sync') {
      for (const st of body.status) { const n = c.numbers.find((x) => x.id === st.team_id); if (n && st.phone) n.phone = st.phone; }
      const list = c.seats.filter((x) => x.device === dev.id && x.version > body.cursor).sort((a, b) => a.version - b.version);
      r = ok({ ok: true, device_id: dev.id, seats: list.map((x) => ({ team_id: x.number, visible: x.visible, name: c.numbers.find((n) => n.id === x.number).name, crm_sync: x.visible })),
        cursor: list.length ? list[list.length - 1].version : body.cursor, more: false, allow_private: false, login: 'required', user: { name: dev.email.split('@')[0] }, confirm_hides: false, next_sync_s: 120 });
    } else if (p === '/api/device/logout') { dev.token = ''; r = ok({ ok: true }); }
    return new Response(JSON.stringify(r[1]), { status: r[0], headers: { 'content-type': 'application/json' } });
  };
  return c;
}
function laiMachine(cloud, accs, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lai-'))) {
  const m = { accounts: accs, log: [], dir };
  m.waits = [];
  m.team = new TeamSync({ dir, safeStorage: fakeSafe, server: SERVER, fetchImpl: cloud.fetchImpl, now: () => clock.t, timers: { setTimeout: (_f, ms) => { m.waits.push(ms); return {}; }, clearTimeout: () => {} },
    hooks: { ...A.team.hooks, accounts: () => m.accounts, save: () => {}, park: (a) => m.log.push(`park:${a.id}`), unpark: (a) => m.log.push(`unpark:${a.id}`), refresh: () => {},
      createSeat: (seat) => { const a = { id: String(9000 + m.accounts.length), name: seat.name, teamId: seat.teamId, teamHidden: false, teamCrm: seat.crm }; m.accounts.push(a); m.log.push(`create:${seat.teamId}`); return a; } } });
  return m;
}
const view = (accs) => accs.map((a) => ({ id: a.id, teamId: a.teamId, hidden: !!a.teamHidden, crm: !!a.teamCrm, rejoin: !!a.teamRejoin }));

await test('同一台电脑 A→B→A：每个人沿用自己的设备；号在新设备上重新加入，换回 A 时拿回 A 原来的团队号，不收起、不重复', async () => {
  const cloud = laicaiCloud();
  const accs = [acc('1', 'Sales UK', { phone: '+44 7700 900001' }), acc('2', 'Sales DE', { phone: '' })];
  const M = laiMachine(cloud, accs);
  const signInLai = (email) => M.team.login({ email, code: '123456' });
  assert.deepEqual(await signInLai('emma@example.com'), { ok: true });
  const devA = M.team.state.deviceId;
  await M.team.syncNow();
  await M.team.syncNow();
  const teamA = accs.map((a) => a.teamId);
  assert.ok(teamA.every((t) => /^[0-9a-f-]{36}$/.test(t)));
  assert.ok(accs.every((a) => a.teamCrm && !a.teamHidden && !a.teamRejoin));
  await M.team.logout();
  // B 登录：新设备；号清掉 teamId，在 B 的设备上加入（来财那边多出 B 的两行，A 的留着，管理员可以删）
  assert.deepEqual(await signInLai('lucas@example.com'), { ok: true });
  const devB = M.team.state.deviceId;
  assert.notEqual(devB, devA);
  assert.equal(cloud.calls.filter((x) => x.path === '/api/device/login').pop().body.device_id, undefined, 'B 在这台电脑上没用过设备：不带 A 的');
  assert.deepEqual(view(accs).map((a) => [a.teamId, a.hidden, a.rejoin]), [['', false, true], ['', false, true]]);
  assert.ok(accs.every((a) => !M.team.isParked(a)), '没收起：照常运行');
  await M.team.syncNow();
  await M.team.syncNow();
  const teamB = accs.map((a) => a.teamId);
  assert.ok(teamB.every((t, i) => t && t !== teamA[i]), 'B 的设备上是新的团队号');
  assert.deepEqual(accs.map((a) => [a.teamCrm, !!a.teamRejoin]), [[true, false], [true, true]], '带了号码的马上能传；没号码的等号码');
  const join = cloud.calls.filter((x) => x.path === '/api/device/join').pop().body.accounts;
  assert.deepEqual(join.map((a) => a.phone), ['+447700900001', ''], '重新加入带上号码');
  // 第二个号读到了自己的号码：下次同步报上去以后才开始上传
  accs[1].phone = '+49 30 1234567';
  await M.team.syncNow();
  assert.equal(accs[1].teamRejoin, undefined, '来财知道号码了');
  await M.team.logout();
  // A 再登录：带 A 自己的设备，拿回 A 原来的团队号
  assert.deepEqual(await signInLai('emma@example.com'), { ok: true });
  assert.equal(cloud.calls.filter((x) => x.path === '/api/device/login').pop().body.device_id, devA);
  assert.equal(M.team.state.deviceId, devA);
  M.log.length = 0;
  await M.team.syncNow();
  await M.team.syncNow();
  assert.deepEqual(accs.map((a) => a.teamId), teamA, '拿回 A 原来的团队号');
  assert.equal(accs.length, 2, '没有多出重复的号');
  assert.ok(!M.log.some((x) => x.startsWith('create:') || x.startsWith('park:')), JSON.stringify(M.log));
  assert.ok(accs.every((a) => a.teamCrm && !a.teamHidden && !a.teamRejoin && !M.team.isParked(a)));
  assert.equal(cloud.numbers.length, 4, '来财：A 的两行和 B 的两行');
  // 重启后 devices 表还在
  const again = laiMachine(cloud, accs, M.dir);
  assert.deepEqual(again.team.state.devices, { 'lucas@example.com': devB, 'emma@example.com': devA });
});

await test('同一个人换了设备（来财那边设备没了）：号重新加入，本机队列留着', async () => {
  const cloud = laicaiCloud();
  const accs = [acc('1', 'Sales UK', { phone: '+44 7700 900001' })];
  const M = laiMachine(cloud, accs);
  await M.team.login({ email: 'emma@example.com', code: '123456' });
  await M.team.syncNow();
  await M.team.syncNow();
  cloud.devices.length = 0;
  await M.team.logout();
  await M.team.login({ email: 'emma@example.com', code: '123456' });
  assert.deepEqual([accs[0].teamId, accs[0].teamKeepQueue, accs[0].teamRejoin, accs[0].teamRebackfill], ['', true, true, true], '队列留着时再补传一次（重新加入前的消息）');
  await M.team.syncNow();
  await M.team.syncNow();
  assert.ok(accs[0].teamId && accs[0].teamCrm);
  assert.equal(accs[0].teamKeepQueue, undefined, '来财同意同步以后按正常规则');
});

await test('加入的回答丢了（超时）：下次同步先重新加入再认坐席，不新建重复的号；还是没回答就先不认', async () => {
  const cloud = laicaiCloud();
  const accs = [acc('1', 'Sales UK', { phone: '+44 7700 900001' })];
  const M = laiMachine(cloud, accs);
  await M.team.login({ email: 'emma@example.com', code: '123456' });
  cloud.loseJoin = 3; // 第一次加入、第二次同步里的先加入和末尾的自动加入都丢回答
  await M.team.syncNow(); // 自动加入：来财加了，回答丢了
  assert.ok(!accs[0].teamId);
  assert.deepEqual(M.team.state.joinSent, ['1']);
  const cursor = M.team.state.cursor;
  await M.team.syncNow(); // 坐席来了；重新加入又丢了：先不认，cursor 不动
  assert.equal(accs.length, 1, '没有新建重复的号');
  assert.ok(!accs[0].teamId);
  assert.equal(M.team.state.cursor, cursor, '坐席下次再拿');
  await M.team.syncNow();
  assert.equal(accs.length, 1);
  assert.ok(/^[0-9a-f-]{36}$/.test(accs[0].teamId));
  assert.deepEqual(M.team.state.joinSent, []);
  await M.team.syncNow();
  assert.equal(accs[0].teamCrm, true);
  assert.ok(!M.log.some((x) => x.startsWith('create:')));
  // 后台的坐席带 local_id 时直接按本机编号认
  const B2 = laiMachine(cloud, [acc('5', 'Sales FR')]);
  B2.team.state.token = fakeSafe.encryptString('x').toString('base64');
  B2.team.applySeats([{ team_id: '00000000-0000-4000-8000-0000000000aa', local_id: '5', visible: true, crm_sync: true }], false);
  assert.deepEqual(view(B2.accounts), [{ id: '5', teamId: '00000000-0000-4000-8000-0000000000aa', hidden: false, crm: true, rejoin: false }]);
});

await test('加入的回答里少了号（编号不合格被丢掉）：再试的间隔翻倍到 5 分钟，成功后恢复', async () => {
  const cloud = laicaiCloud();
  const accs = [acc('1', 'Sales UK', { phone: '+44 7700 900001' }), acc('2', 'Sales DE', { phone: '+49 30 1234567' })];
  const M = laiMachine(cloud, accs);
  await M.team.login({ email: 'emma@example.com', code: '123456' });
  let drop = true;
  cloud.answer = (p, b, d) => {
    if (p !== '/api/device/join' || !drop) return null;
    return [200, { accounts: b.accounts.filter((a) => a.local_id === '1').map((a) => ({ local_id: a.local_id, team_id: '00000000-0000-4000-8000-0000000000b1' })) }];
  };
  const joinWaits = [];
  for (let i = 0; i < 8; i += 1) {
    M.waits.length = 0;
    await M.team.join(M.team.pendingJoin());
    joinWaits.push(M.waits.at(-1));
  }
  assert.deepEqual(joinWaits, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]);
  drop = false;
  M.waits.length = 0;
  await M.team.join(M.team.pendingJoin());
  assert.equal(M.waits.at(-1), 1000, '都拿到了：恢复 1 秒后同步');
  assert.equal(M.team.joinDelay, 0);
  assert.ok(accs.every((a) => a.teamId));
});

await test('401 login_required（管理员按了“重新登录”）：回到登录页，设备、团队号、CRM 授权都留着；只有 403 revoked 才是停用', async () => {
  const cloud = laicaiCloud();
  const accs = [acc('1', 'Sales UK', { phone: '+44 7700 900001' })];
  const M = laiMachine(cloud, accs);
  await M.team.login({ email: 'emma@example.com', code: '123456' });
  await M.team.syncNow();
  await M.team.syncNow();
  const dev = M.team.state.deviceId;
  const team1 = accs[0].teamId;
  cloud.answer = (p) => (p === '/api/device/sync' ? [401, { ok: false, error: 'login_required' }] : null);
  const r = await M.team.syncNow();
  assert.equal(r.loggedOut, true);
  assert.equal(M.team.loginState(), 'none', '登录页，不是“已停用”');
  assert.equal(M.team.snapshot().lastError, '登录已失效，请重新登录');
  assert.equal(M.team.state.deviceId, dev);
  assert.deepEqual([accs[0].teamId, accs[0].teamHidden, accs[0].teamCrm], [team1, false, true]);
  cloud.answer = null;
  await M.team.login({ email: 'emma@example.com', code: '123456' });
  assert.equal(M.team.state.deviceId, dev, '同一台设备');
  assert.equal(accs[0].teamId, team1);
  cloud.answer = (p, b, d) => (p === '/api/device/sync' ? [403, { ok: false, error: 'revoked', revoked: true, device_id: d.id }] : null);
  assert.deepEqual(await M.team.syncNow(), { revoked: true });
  assert.equal(M.team.loginState(), 'disabled');
  assert.equal(M.team.snapshot().lastError, '这台电脑已被管理员停用');
});
// 来财没有删除接口：本机删掉的团队号，坐席还留在后台。重新登录（cursor 归零）或管理员改了这个号，同步时都不能再建回来
await test('本机删掉的团队号：后台改资料、重新登录、重启后都不再建回来', async () => {
  await boss('POST', 'users', { name: 'Sophie Laurent', email: 'sophie@example.com' });
  const D = machine('del', [acc('301', 'Sophie 主号', { phone: '+33 6 12 34 56 78' }), acc('302', 'Sophie 小号', { phone: '+33 6 98 76 54 32' })]);
  assert.deepEqual(await signIn(D, 'sophie@example.com'), { ok: true });
  await D.team.syncNow();
  await D.team.syncNow();
  const gone = D.accounts.find((a) => a.id === '302');
  assert.ok(gone.teamId, '先加入团队');
  // 软件里删号（main.js removeAccount）
  D.team.forget(gone);
  D.accounts = D.accounts.filter((a) => a.id !== '302');
  const creates = () => D.log.filter((x) => x.startsWith('create'));
  D.log.length = 0;
  clock.t += 3 * 60 * 1000;
  await D.team.syncNow();
  const seat = (await boss('GET', 'overview')).accounts.find((x) => x.id === gone.teamId);
  assert.ok(seat, '后台的坐席还在');
  assert.equal((await boss('PATCH', `accounts/${seat.id}`, { note: 'VIP' })).ok, true);
  clock.t += 3 * 60 * 1000;
  await D.team.syncNow();
  assert.deepEqual(creates(), [], '管理员改了资料：不建回来');
  await D.team.logout();
  assert.deepEqual(await signIn(D, 'sophie@example.com'), { ok: true });
  assert.equal(D.team.state.cursor, 0);
  await D.team.syncNow();
  assert.deepEqual(creates(), [], '重新登录从头拿坐席：不建回来');
  // 重启软件：记录在 team.json 里
  const again = machine('del2', D.accounts, D.dir);
  await again.team.syncNow();
  assert.deepEqual(again.log.filter((x) => x.startsWith('create')), [], '重启后也不建回来');
  assert.ok(again.team.state.removed.includes(gone.teamId));
  assert.ok(D.accounts.some((a) => a.id === '301' && a.teamId), '没删的号照常');
});
// 号还没收到 /join 的回答就被删了：来财按本机编号（local_id）给回的坐席也不建
await test('还没加入完就删掉的号：按本机编号给回的坐席不建', async () => {
  const E = machine('del3', []);
  E.team.state.removed = [];
  E.team.forget({ id: '401', teamId: '' });
  E.team.applySeats([{ team_id: '11111111-2222-4333-8444-555555555555', local_id: '401', visible: true, name: 'x' }], false);
  assert.deepEqual(E.log.filter((x) => x.startsWith('create')), []);
  E.team.applySeats([{ team_id: '11111111-2222-4333-8444-666666666666', local_id: '402', visible: true, name: 'y' }], false);
  assert.equal(E.log.filter((x) => x.startsWith('create')).length, 1, '别的坐席照常建');
});
// 同一台电脑 A 删号、换 B 登录、A 再登录：A 的设备从头拿坐席，删掉的号也不能回来（换人不清记录）
await test('A 删号、B 登录、A 再登录：删掉的号不建回来', async () => {
  const cloud = laicaiCloud();
  const M = laiMachine(cloud, [acc('1', 'Sales UK', { phone: '+44 7700 900001' }), acc('2', 'Sales DE', { phone: '+49 30 1234567' })]);
  const signInLai = (email) => M.team.login({ email, code: '123456' });
  assert.deepEqual(await signInLai('emma@example.com'), { ok: true });
  await M.team.syncNow(); await M.team.syncNow();
  const gone = M.accounts.find((a) => a.id === '2');
  assert.ok(gone.teamId);
  M.team.forget(gone);
  M.accounts = M.accounts.filter((a) => a.id !== '2');
  await M.team.syncNow();
  await M.team.logout();
  assert.deepEqual(await signInLai('lucas@example.com'), { ok: true });
  await M.team.syncNow(); await M.team.syncNow();
  await M.team.logout();
  assert.deepEqual(await signInLai('emma@example.com'), { ok: true });
  M.log.length = 0;
  await M.team.syncNow(); await M.team.syncNow(); await M.team.syncNow();
  assert.deepEqual(M.log.filter((x) => x.startsWith('create')), [], 'A 回来：不建回来');
});
// 写不进 team.json（磁盘满、文件被占用）：forget 不能抛错让删号停在半路，内存里照样记下
await test('记下删掉的号时写不进 team.json：不抛错，照样不建回来', async () => {
  const F = machine('del4', []);
  F.team.dir = path.join(F.dir, 'missing', 'dir');
  const warn = console.warn;
  console.warn = () => {};
  try { F.team.forget({ id: '501', teamId: '11111111-2222-4333-8444-777777777777' }); } finally { console.warn = warn; }
  assert.equal(F.team.isRemoved({ team_id: '11111111-2222-4333-8444-777777777777' }), true);
  assert.equal(F.team.isRemoved({ team_id: '11111111-2222-4333-8444-888888888888', local_id: '501' }), true);
});
console.log(`全部通过（${passed} 项）`);
