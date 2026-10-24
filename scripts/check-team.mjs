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
const { TeamSync } = require('../src/team/index.js');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---- 后台：内存数据库 + 假的 Access ----
const DOMAIN = 'acme.cloudflareaccess.com';
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
globalThis.fetch = async () => new Response(JSON.stringify({ keys: [{ ...pub, kid: 'k1' }] }), { headers: { 'content-type': 'application/json' } });
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
async function jwt(email) {
  const head = enc({ alg: 'RS256', kid: 'k1' });
  const body = enc({ email, aud: ['aud'], iss: `https://${DOMAIN}`, exp: Math.floor(Date.now() / 1000) + 600 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}
const db = fakeD1(path.join(root, 'server/migrations/0001_init.sql'));
const env = { DB: db, ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: 'aud', OWNER_EMAIL: 'boss@example.com', ASSETS: { fetch: async () => new Response('') } };
async function boss(method, p, body) {
  const res = await worker.fetch(new Request(`https://team.example.com/api/admin/${p}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'cf-access-jwt-assertion': await jwt('boss@example.com'), 'x-waswitch-admin': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  }), env, {});
  return res.json();
}

// 网络开关：模拟断网、401、HTML 错误页等
let net = 'ok';
const sent = [];
async function fetchImpl(url, opts) {
  assert.equal(opts.redirect, 'error');
  assert.ok(!JSON.stringify(opts.headers).includes('cookie'));
  if (net === 'down') throw new TypeError('fetch failed');
  if (net === '401') return new Response('{"error":"x"}', { status: 401, headers: { 'content-type': 'application/json' } });
  if (net === '403plain') return new Response('{"error":"forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } });
  if (net === '403other') return new Response('{"revoked":true,"device_id":"00000000-0000-0000-0000-000000000000"}', { status: 403, headers: { 'content-type': 'application/json' } });
  if (net === 'html') return new Response('<html>Access login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (opts.body) sent.push(JSON.parse(opts.body));
  return worker.fetch(new Request(url, opts), env, {});
}

// ---- 一台模拟的 WAswitch ----
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(`enc:${t}`), decryptString: (b) => b.toString().replace(/^enc:/, '') };
function machine(name, accounts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `team-${name}-`));
  const log = [];
  const m = { accounts, log, dir };
  const timers = { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} }; // 不自动跑，测试里手动 syncNow
  m.team = new TeamSync({
    dir, safeStorage: fakeSafe, appVersion: '0.4.0', platform: 'win32', fetchImpl, timers,
    hooks: {
      accounts: () => m.accounts,
      save: () => log.push('save'),
      statusOf: (a) => ({ state: 'ready', unread: a.unread || 0, proxy_ok: true, proxy_ms: 80, exit_ip: '1.2.3.4', exit_country: 'US', exit_changed: false }),
      deviceInfo: () => ({ mem_mb: 700, low_mem: false }),
      park: (a) => log.push(`park:${a.id}`),
      unpark: (a) => log.push(`unpark:${a.id}`),
      createSeat: (seat) => { const a = { id: String(9000 + m.accounts.length), name: seat.name, color: seat.color, mode: seat.mode, teamId: seat.teamId, teamHidden: false, teamNeedsProxy: true, teamNote: seat.note }; m.accounts.push(a); log.push(`create:${seat.teamId}`); return a; },
      refresh: () => {},
    },
  });
  return m;
}
const acc = (id, name, extra = {}) => ({ id, name, color: '#16A34A', mode: 'web', proxy: 'socks5://127.0.0.1:7891', proxyPassword: 'SECRETPASS', ...extra });

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
console.log('团队模式端到端自检');

const me = await boss('GET', 'me');
const agent = await boss('POST', 'users', { name: '坐席A' });
const code = async () => (await boss('POST', `users/${agent.id}/enroll-code`)).code;
const A = machine('a', [acc('101', '一号'), acc('102', '二号'), acc('103', '三号'), acc('104', '私人号')]);
assert.equal(me.user.role, 'owner');

await test('没勾选上传清单、不是 https 地址都不能登记', async () => {
  assert.match((await A.team.enroll({ server: 'https://team.example.com', code: 'x' })).error, /确认/);
  assert.match((await A.team.enroll({ server: 'http://team.example.com', code: 'x', consent: true })).error, /https/);
});
await test('登记：选中的号加入团队，私人号不动；令牌加密存盘', async () => {
  const r = await A.team.enroll({ server: 'https://team.example.com/', code: await code(), deviceName: '前台', localIds: ['101', '102', '103'], consent: true });
  assert.deepEqual(r, { ok: true });
  assert.ok(A.accounts.slice(0, 3).every((a) => /^[0-9a-f-]{36}$/.test(a.teamId)));
  assert.equal(A.accounts[3].teamId, undefined);
  const file = fs.readFileSync(path.join(A.dir, 'team.json'), 'utf8');
  assert.ok(!/"token": "[A-Za-z0-9_-]{43}"/.test(file));
  assert.equal(A.team.isParked(A.accounts[3]), false);
});
await test('同步：上传内容只有白名单字段，不含代理和密码', async () => {
  sent.length = 0;
  A.accounts[0].unread = 2;
  assert.deepEqual(await A.team.syncNow(), { ok: true });
  const body = JSON.stringify(sent);
  for (const bad of ['SECRETPASS', '127.0.0.1:7891', '私人号', 'last_active', 'unread_since']) assert.ok(!body.includes(bad), `不该上传 ${bad}`);
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
await test('断网、401、不带 revoked 的 403、别人的 revoked、HTML 页面：都只当离线，不停号', async () => {
  for (const mode of ['down', '401', '403plain', '403other', 'html']) {
    net = mode;
    A.log.length = 0;
    A.team.recordEvent(A.accounts[1], 'proxy_down');
    const r = await A.team.syncNow();
    assert.equal(r.offline, true, mode);
    assert.ok(!A.log.some((x) => x.startsWith('park')), mode);
    assert.equal(A.team.state.revoked, false);
  }
  net = 'ok';
  sent.length = 0;
  assert.deepEqual(await A.team.syncNow(), { ok: true });
  assert.equal(sent[0].events.length, 5); // 离线期间的事件补报
  assert.equal(A.team.failures, 0);
});

const B = machine('b', [acc('201', 'B 的私人号')]);
await test('换人：原电脑隐藏这个号，新电脑新建一个待填代理的号', async () => {
  await B.team.enroll({ server: 'https://team.example.com', code: await code(), deviceName: '二号机', localIds: [], consent: true });
  const users = await boss('GET', 'users');
  const devB = users.devices.find((d) => d.name === '二号机').id;
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
  const devA = users.devices.find((d) => d.name === '前台').id;
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
  const devA = (await boss('GET', 'users')).devices.find((d) => d.name === '前台');
  assert.equal(devA.held_hides, 2);
  await boss('POST', `devices/${devA.id}/confirm-hides`);
  await A.team.syncNow();
  assert.ok(A.log.includes('park:101') && A.log.includes('park:102'));
  assert.equal(A.team.state.held.length, 0);
});
await test('后台不允许私人号：私人号停着；再允许就恢复', async () => {
  await boss('PUT', 'settings', { allow_private: false });
  A.log.length = 0;
  await A.team.syncNow();
  assert.ok(A.log.includes('park:104'));
  assert.equal(A.team.isParked(A.accounts[3]), true);
  await boss('PUT', 'settings', { allow_private: true });
  await A.team.syncNow();
  assert.equal(A.team.isParked(A.accounts[3]), false);
  assert.ok(A.log.includes('unpark:104'));
});
await test('停用电脑：团队号全部停着，私人号照常；重新登记后团队号仍然隐藏，等后台分配', async () => {
  const devA = (await boss('GET', 'users')).devices.find((d) => d.name === '前台');
  await boss('POST', `devices/${devA.id}/revoke`);
  A.log.length = 0;
  assert.deepEqual(await A.team.syncNow(), { revoked: true });
  assert.ok(A.log.includes('park:103'));
  assert.equal(A.team.isParked(A.accounts[2]), true);
  assert.equal(A.team.isParked(A.accounts[3]), false);
  assert.equal((await A.team.syncNow()).skipped, true); // 停用后不再同步
  await A.team.enroll({ server: 'https://team.example.com', code: await code(), deviceName: '前台-新', localIds: [], consent: true });
  assert.equal(A.team.isParked(A.accounts[2]), true);
});
await test('重启后从磁盘恢复状态', async () => {
  const again = new TeamSync({ dir: A.dir, safeStorage: fakeSafe, hooks: A.team.hooks, appVersion: '0.4.0', platform: 'darwin', fetchImpl, timers: { setTimeout: () => ({}), clearTimeout: () => {} } });
  assert.equal(again.enrolled(), true);
  assert.equal(again.state.server, 'https://team.example.com');
  assert.deepEqual(await again.syncNow(), { ok: true });
});
console.log(`全部通过（${passed} 项）`);
