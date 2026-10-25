// 第二轮回归：请求交错、失败写入原子性、收回期间采集和请求体字节上限。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fakeD1 } from '../server/test/fake-d1.mjs';
import { handleAdmin } from '../server/src/admin.js';
import { handleDevice } from '../server/src/device.js';
import { sha256hex, readJson } from '../server/src/util.js';

const require = createRequire(import.meta.url);
const { TeamSync } = require('../src/team');
const { CrmQueue } = require('../src/crm/queue');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dirs = [], databases = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-review2-')); dirs.push(dir); return dir; };
const safe = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: text => Buffer.from(text), decryptString: buf => buf.toString() };
const timers = { setTimeout: () => ({ unref() {} }), clearTimeout() {} };
let passed = 0, failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
async function fixture() {
  const db = fakeD1(path.join(root, 'server/migrations')); databases.push(db.raw);
  const owner = crypto.randomUUID(), agent = crypto.randomUUID(), group = crypto.randomUUID();
  db.raw.prepare('INSERT INTO groups(id,name) VALUES(?,?)').run(group, 'Group');
  db.raw.prepare('INSERT INTO users(id,name,email,role,created_at) VALUES(?,?,?,?,0)').run(owner, 'Owner', 'owner@example.com', 'owner');
  db.raw.prepare('INSERT INTO users(id,name,email,role,group_id,created_at) VALUES(?,?,?,?,?,0)').run(agent, 'Supervisor', 'supervisor@example.com', 'supervisor', group);
  const devices = [];
  for (let i = 0; i < 2; i++) {
    const id = crypto.randomUUID(), token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    db.raw.prepare('INSERT INTO devices(id,user_id,name,token_hash,created_at) VALUES(?,?,?,?,0)').run(id, agent, `Device ${i}`, await sha256hex(token));
    devices.push({ id, token });
  }
  const account = crypto.randomUUID();
  db.raw.prepare('INSERT INTO wa_accounts(id,label,device_id,user_id,group_id,created_at,updated_at) VALUES(?,?,?,?,?,0,0)').run(account, 'Account', devices[0].id, agent, group);
  db.raw.prepare('INSERT INTO device_seats VALUES(?,?,1,0)').run(devices[0].id, account);
  const admin = (method, route, body = {}) => handleAdmin(new Request(`https://team.example/api/admin/${route}`, {
    method, headers: { 'content-type': 'application/json', 'x-waswitch-admin': '1' }, body: JSON.stringify(body),
  }), { DB: db }, `/api/admin/${route}`, { email: 'owner@example.com' });
  const sync = (device, unread, events = []) => handleDevice(new Request('https://team.example/api/device/sync', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${device.token}` },
    body: JSON.stringify({ v: 1, cursor: 0, status: [{ team_id: account, state: 'ready', unread }], events }),
  }), { DB: db }, '/api/device/sync');
  function delayBatch() {
    const batch = db.batch.bind(db);
    let enter, release, hold = true;
    const entered = new Promise(r => { enter = r; }), gate = new Promise(r => { release = r; });
    db.batch = async stmts => { if (hold) { hold = false; enter(); await gate; } return batch(stmts); };
    return { entered, release: () => { db.batch = batch; release(); } };
  }
  return { db, owner, agent, devices, account, admin, sync, delayBatch };
}

try {
  console.log('第二轮问题回归');
  await test('批量收回暂停时立即撤销 CRM 授权，清理队列，重新分配后才恢复', async () => {
    const accounts = [1, 2, 3].map(i => ({ id: String(i), teamId: crypto.randomUUID(), teamCrm: true, teamHidden: false }));
    const queue = new CrmQueue({ dir: tmp(), safeStorage: safe, timers });
    for (const a of accounts) { const since = queue.enable(a.id); queue.add(a.id, { mid: a.id, peer: '123456789', text: 'sample', at: since }); }
    queue.saveNow();
    let seats = accounts.map(a => ({ team_id: a.teamId, visible: false, crm_sync: false })), confirm = false, reconcile;
    const stopped = [];
    const team = new TeamSync({ dir: tmp(), safeStorage: safe, timers,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, seats, confirm_hides: confirm, cursor: 1 }), { headers: { 'content-type': 'application/json' } }),
      hooks: { accounts: () => accounts, save() {}, park() {}, unpark() {}, createSeat() {}, statusOf: () => ({}), deviceInfo: () => ({}), refresh: () => reconcile() } });
    team.state.server = 'https://team.example'; team.state.token = Buffer.from('token').toString('base64');
    // 调用实际主进程的采集撤销代码，确认队列删除和轻量采集停止，而非测试里模拟清理。
    const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
    reconcile = vm.runInNewContext(main.slice(main.indexOf('const crmOn ='), main.indexOf('// 网页版号：只读员工正在看的对话')) + '\ncrmReconcile;', {
      crmQueue: queue, team, accounts, isParked: a => team.isParked(a), isLite: () => true,
      crmWebReader: { forget() {} }, liteHost: { setCrm: (id, since) => { if (!since) stopped.push(id); } },
    });
    await team.syncNow();
    assert.equal(team.state.held.length, 3);
    assert(accounts.every(a => !a.teamHidden), '确认前仍暂停隐藏');
    assert(accounts.every(a => a.teamCrm === false), '收回一到达就必须撤销采集授权');
    assert.equal(queue.enabledIds().length, 0, '撤销授权应触发保存和清理');
    assert.deepEqual(stopped.sort(), ['1', '2', '3']);
    seats = [{ team_id: accounts[0].teamId, visible: true, crm_sync: true }];
    await team.syncNow();
    assert.equal(accounts[0].teamCrm, true);
    assert(!team.state.held.includes(accounts[0].teamId));
    seats = []; confirm = true; await team.syncNow();
    assert(accounts.slice(1).every(a => a.teamHidden && !a.teamCrm));
  });

  await test('升级启动时撤销已持久化待确认收回的 CRM 授权，不等待下次同步', () => {
    const dir = tmp(), teamId = crypto.randomUUID(), accounts = [{ id: '1', teamId, teamCrm: true }];
    fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify({ held: [teamId] }));
    let saved = false;
    new TeamSync({ dir, safeStorage: safe, timers, hooks: { accounts: () => accounts, save: () => { saved = true; } } });
    assert.equal(accounts[0].teamCrm, false); assert(saved);
  });

  await test('旧设备延迟状态事务不能覆盖新归属设备，也不能补写旧设备事件', async () => {
    const f = await fixture(), delayed = f.delayBatch();
    const old = f.sync(f.devices[0], 999, [{ team_id: f.account, kind: 'banned', at: Date.now() }]);
    await delayed.entered;
    try {
      assert.equal((await f.admin('POST', `accounts/${f.account}/assign`, { device_id: f.devices[1].id })).status, 200);
      assert.equal((await f.sync(f.devices[1], 7)).status, 200);
    } finally { delayed.release(); }
    assert.equal((await old).status, 200);
    const status = f.db.raw.prepare('SELECT device_id,unread FROM account_status WHERE account_id=?').get(f.account);
    assert.equal(status.device_id, f.devices[1].id);
    assert.equal(status.unread, 7);
    assert.equal(f.db.raw.prepare('SELECT COUNT(*) AS n FROM status_events').get().n, 0);
  });

  await test('设备被停用后，先前排队的状态与事件事务不能再写入', async () => {
    const f = await fixture(), delayed = f.delayBatch();
    const old = f.sync(f.devices[0], 999, [{ team_id: f.account, kind: 'banned' }]);
    await delayed.entered;
    try { assert.equal((await f.admin('POST', `devices/${f.devices[0].id}/revoke`)).status, 200); }
    finally { delayed.release(); }
    await old;
    assert.equal(f.db.raw.prepare('SELECT COUNT(*) AS n FROM account_status').get().n, 0);
    assert.equal(f.db.raw.prepare('SELECT COUNT(*) AS n FROM status_events').get().n, 0);
  });

  await test('无效用户更新返回 400 时，名称、组、禁用状态和邮箱都不变', async () => {
    const f = await fixture();
    const row = () => ({ ...f.db.raw.prepare('SELECT * FROM users WHERE id=?').get(f.agent) });
    const before = row();
    assert.equal((await f.admin('PATCH', `users/${f.agent}`, { name: 'changed', disabled: true, email: '' })).status, 400);
    assert.deepEqual(row(), before);
    assert.equal((await f.admin('PATCH', `users/${f.agent}`, { group_id: '' })).status, 400);
    assert.deepEqual(row(), before);
    assert.equal((await f.admin('PATCH', `users/${f.agent}`, { role: 'agent', email: '', group_id: '' })).status, 200);
    assert.equal(row().email, null);
  });

  await test('用户更新提交时重新验证角色约束，不能用过时快照清空新主管邮箱', async () => {
    const f = await fixture();
    await f.admin('PATCH', `users/${f.agent}`, { role: 'agent' });
    const prepare = f.db.prepare.bind(f.db);
    let enter, release;
    const entered = new Promise(r => { enter = r; }), gate = new Promise(r => { release = r; });
    let paused = false;
    f.db.prepare = sql => {
      const stmt = prepare(sql);
      if (!/^UPDATE users SET/.test(sql) || paused) return stmt;
      paused = true;
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...args) => {
        const bound = bind(...args);
        for (const method of ['first', 'run']) {
          const run = bound[method].bind(bound);
          bound[method] = async () => { enter(); await gate; return run(); };
        }
        return bound;
      };
      return stmt;
    };
    const clear = f.admin('PATCH', `users/${f.agent}`, { name: 'stale', email: '' });
    await entered;
    try { assert.equal((await f.admin('PATCH', `users/${f.agent}`, { role: 'supervisor' })).status, 200); }
    finally { release(); }
    assert.equal((await clear).status, 400);
    const row = f.db.raw.prepare('SELECT role,email,name FROM users WHERE id=?').get(f.agent);
    assert.equal(row.role, 'supervisor'); assert.equal(row.email, 'supervisor@example.com'); assert.equal(row.name, 'Supervisor');
  });

  await test('JSON 请求上限按 UTF-8 字节计算，并保持合法中文请求可读', async () => {
    const request = text => new Request('https://team.example/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    await assert.rejects(readJson(request('中'.repeat(30)), 64), e => e.status === 413);
    assert.deepEqual(await readJson(request('中文'), 64), { text: '中文' });
  });

  await test('未声明长度的超限请求提前取消流，不把整个请求读入内存', async () => {
    let pulls = 0, cancelled = false;
    const stream = new ReadableStream({ pull(ctl) { pulls++; if (pulls <= 100) ctl.enqueue(new Uint8Array(32).fill(32)); else ctl.close(); }, cancel() { cancelled = true; } });
    const request = new Request('https://team.example/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' });
    await assert.rejects(readJson(request, 64), e => e.status === 413);
    assert(cancelled); assert(pulls < 10, `不应读完 ${pulls} 块`);
  });
  console.log(`${passed} 项通过，${failed} 项失败`);
  if (failed) process.exitCode = 1;
} finally {
  for (const db of databases) db.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}
