// 深查问题的回归：实际接口的交错提交、代理认证回调、跨时区采集、过期清理和锁屏已读。
// 不连接 WhatsApp、代理商或生产后台；Electron 回调使用假的 session/事件源。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fakeD1 } from '../server/test/fake-d1.mjs';
import { handleAdmin } from '../server/src/admin.js';
import { handleDevice } from '../server/src/device.js';
import { sha256hex } from '../server/src/util.js';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const { canEncrypt } = require('../src/secure-storage');
const { CrmQueue, MAX_AGE_MS } = require('../src/crm/queue');
const { webItem, WebReader } = require('../src/crm/web');
const { parsePre } = require('../src/wa-page');
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-regression-')); dirs.push(d); return d; };
const safe = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: s => Buffer.from(`sealed:${s}`),
  decryptString: b => { if (!b.toString().startsWith('sealed:')) throw Error('invalid'); return b.toString().slice(7); },
};
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

async function fixture() {
  const db = fakeD1(path.join(root, 'server/migrations'));
  const owner = crypto.randomUUID(), agent = crypto.randomUUID();
  db.raw.prepare('INSERT INTO users(id,name,email,role,created_at) VALUES(?,?,?,?,0)').run(owner, 'Owner', 'owner@example.com', 'owner');
  db.raw.prepare('INSERT INTO users(id,name,role,created_at) VALUES(?,?,?,0)').run(agent, 'Agent', 'agent');
  const devices = [];
  for (let i = 0; i < 3; i++) {
    const id = crypto.randomUUID(), token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    db.raw.prepare('INSERT INTO devices(id,user_id,name,token_hash,created_at) VALUES(?,?,?,?,0)').run(id, agent, `Device ${i}`, await sha256hex(token));
    devices.push({ id, token });
  }
  function account() {
    const id = crypto.randomUUID();
    db.raw.prepare('INSERT INTO wa_accounts(id,label,user_id,device_id,created_at,updated_at) VALUES(?,?,?,?,0,0)').run(id, 'Account', agent, devices[0].id);
    db.raw.prepare('INSERT INTO device_seats VALUES(?,?,1,0)').run(devices[0].id, id);
    return id;
  }
  const admin = (method, route, body) => handleAdmin(new Request(`https://team.example/api/admin/${route}`, {
    method, headers: { 'content-type': 'application/json', 'x-waswitch-admin': '1' }, body: JSON.stringify(body),
  }), { DB: db }, `/api/admin/${route}`, { email: 'owner@example.com' });
  const sync = async (device, cursor = 0, status = []) => {
    const res = await handleDevice(new Request('https://team.example/api/device/sync', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${device.token}` }, body: JSON.stringify({ v: 1, cursor, status }),
    }), { DB: db }, '/api/device/sync');
    assert.equal(res.status, 200); return res.json();
  };
  // 暂停第一个事务，允许第二个请求先提交；不篡改被测接口的业务逻辑。
  function delayBatch() {
    const batch = db.batch.bind(db);
    let enter, release, hold = true;
    const entered = new Promise(r => { enter = r; });
    const gate = new Promise(r => { release = r; });
    db.batch = async stmts => { if (hold) { hold = false; enter(); await gate; } return batch(stmts); };
    return { entered, release: () => { release(); db.batch = batch; } };
  }
  return { db, devices, account, admin, sync, delayBatch };
}

try {
  console.log('深查问题回归');
  await test('提交顺序反转后，客户端仍能在后续增量中拿到收回指令', async () => {
    const f = await fixture(), a = f.account(), b = f.account();
    const initial = await f.sync(f.devices[0]);
    const delayed = f.delayBatch();
    const first = f.admin('POST', `accounts/${a}/unassign`, {});
    await delayed.entered;
    assert.equal((await f.admin('PATCH', `accounts/${b}`, { label: 'changed' })).status, 200);
    const middle = await f.sync(f.devices[0], initial.cursor);
    assert(middle.seats.some(s => s.team_id === b));
    delayed.release(); assert.equal((await first).status, 200);
    const last = await f.sync(f.devices[0], middle.cursor);
    assert(last.seats.some(s => s.team_id === a && s.visible === false));
    assert(last.cursor > middle.cursor);
  });

  await test('并发分配只留下一个有效坐席，落选电脑收到隐藏且不能上报该号', async () => {
    const f = await fixture(), a = f.account(), delayed = f.delayBatch();
    const one = f.admin('POST', `accounts/${a}/assign`, { device_id: f.devices[1].id });
    await delayed.entered;
    assert.equal((await f.admin('POST', `accounts/${a}/assign`, { device_id: f.devices[2].id })).status, 200);
    delayed.release(); assert.equal((await one).status, 200);
    const visible = f.db.raw.prepare('SELECT device_id FROM device_seats WHERE account_id=? AND visible=1').all(a);
    assert.deepEqual(visible.map(r => r.device_id), [f.devices[1].id]);
    const losing = await f.sync(f.devices[2], 0, [{ team_id: a, state: 'ready', unread: 999 }]);
    assert(losing.seats.some(s => s.team_id === a && !s.visible && !s.crm_sync));
    assert.equal(f.db.raw.prepare('SELECT COUNT(*) AS n FROM account_status WHERE account_id=?').get(a).n, 0);
    assert.throws(() => f.db.raw.prepare('UPDATE device_seats SET visible=1 WHERE device_id=? AND account_id=?').run(f.devices[2].id, a), /UNIQUE/);
  });

  await test('延迟的改名请求不会重新激活旧电脑；事务失败不会提前消耗版本', async () => {
    const f = await fixture(), a = f.account(), delayed = f.delayBatch();
    const rename = f.admin('PATCH', `accounts/${a}`, { label: 'renamed' }); await delayed.entered;
    assert.equal((await f.admin('POST', `accounts/${a}/assign`, { device_id: f.devices[1].id })).status, 200);
    const initial = await f.sync(f.devices[1]);
    delayed.release(); assert.equal((await rename).status, 200);
    const updated = await f.sync(f.devices[1], initial.cursor);
    assert(updated.seats.some(s => s.team_id === a && s.visible && s.name === 'renamed'));
    assert.equal(f.db.raw.prepare('SELECT visible FROM device_seats WHERE account_id=? AND device_id=?').get(a, f.devices[0].id).visible, 0);
    const version = f.db.raw.prepare("SELECT value FROM meta WHERE key='version'").get().value;
    await assert.rejects(f.db.batch([
      f.db.prepare('UPDATE device_seats SET visible=0 WHERE account_id=?').bind(a),
      f.db.prepare('INSERT INTO groups(id,name) VALUES(NULL,NULL)'),
    ]));
    assert.equal(f.db.raw.prepare("SELECT value FROM meta WHERE key='version'").get().value, version);
    assert.equal(f.db.raw.prepare('SELECT visible FROM device_seats WHERE account_id=? AND device_id=?').get(a, f.devices[1].id).visible, 1);
  });

  await test('升级迁移修复已有重复坐席，并生成客户端能读取的新隐藏版本', async () => {
    const db = new DatabaseSync(':memory:');
    for (const name of ['0001_init.sql', '0002_crm_sync.sql']) db.exec(fs.readFileSync(path.join(root, 'server/migrations', name), 'utf8'));
    db.exec("INSERT INTO users(id,name,role,created_at) VALUES('u','u','agent',0); INSERT INTO devices(id,user_id,name,token_hash,created_at) VALUES('d1','u','d1','t1',0),('d2','u','d2','t2',0); INSERT INTO wa_accounts(id,label,device_id,created_at,updated_at) VALUES('a','a','d2',0,0); INSERT INTO device_seats VALUES('d1','a',1,8),('d2','a',1,9); UPDATE meta SET value=9 WHERE key='version';");
    db.exec(fs.readFileSync(path.join(root, 'server/migrations/0003_atomic_seats.sql'), 'utf8'));
    const old = db.prepare("SELECT visible,version FROM device_seats WHERE device_id='d1'").get();
    assert.equal(old.visible, 0); assert(old.version > 9);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_seats WHERE visible=1').get().n, 1);
    db.close();
  });

  // 加载真实 proxy 模块，只替换 Electron 依赖。
  const proxyModule = { exports: {} }, proxyRequire = createRequire(path.join(root, 'src/proxy.js'));
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/proxy.js'), 'utf8'), {
    module: proxyModule, exports: proxyModule.exports, URL, Buffer,
    require: id => id === 'electron' ? { net: {}, session: {}, safeStorage: safe } : proxyRequire(id),
  });
  const proxy = proxyModule.exports;
  await test('同网关不同凭据按 session 归属；未知后台请求有歧义时取消认证', async () => {
    let login;
    const sa = {}, sb = {}, accounts = [
      { id: '1', mode: 'web', proxy: 'http://session-A@gateway.example:8080', proxyPassword: safe.encryptString('pw-A').toString('base64') },
      { id: '2', mode: 'web', proxy: 'http://session-B@gateway.example:8080', proxyPassword: safe.encryptString('pw-B').toString('base64') },
    ];
    const source = main.slice(main.indexOf("app.on('login',"), main.indexOf('// ---------- 设置 ----------'));
    vm.runInNewContext(source, { app: { on: (_name, fn) => { login = fn; } }, proxy, accounts,
      isLite: a => a.mode === 'lite', isParked: () => false,
      session: { fromPartition: p => p === 'persist:wa-1' ? sa : sb },
    });
    const challenge = wc => { let result; login({ preventDefault() {} }, wc, {}, { isProxy: true, host: 'gateway.example', port: 8080 }, (...args) => { result = args; }); return result; };
    assert.deepEqual(challenge({ session: sb }), ['session-B', 'pw-B']);
    assert.deepEqual(challenge({ session: sa }), ['session-A', 'pw-A']);
    assert.deepEqual(challenge(null), []);
    assert.deepEqual(challenge({ session: {} }), []);
    accounts[1].proxy = accounts[0].proxy; accounts[1].proxyPassword = accounts[0].proxyPassword;
    assert.deepEqual(challenge(null), ['session-A', 'pw-A']);
  });

  await test('页面时区与主进程不同：旧消息拒收，新消息保留正确绝对时间', async () => {
    const inZone = (zone, text) => {
      const previous = process.env.TZ;
      try { process.env.TZ = zone; return parsePre(text); }
      finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
    };
    const since = Date.parse('2026-10-25T11:00:00Z'), now = Date.parse('2026-10-25T12:00:00Z');
    const old = inZone('Asia/Singapore', '[18:00, 2026/10/25] Sender: ');
    const fresh = inZone('America/New_York', '[07:30, 2026/10/25] Sender: ');
    assert.equal(old.at, Date.parse('2026-10-25T10:00:00Z'));
    assert.equal(fresh.at, Date.parse('2026-10-25T11:30:00Z'));
    const msg = t => ({ id: 'false_123456789@c.us_ID', text: 'hello', t });
    assert.equal(webItem(msg(old), since, now), null);
    assert.equal(webItem(msg(fresh), since, now).item.at, fresh.at);
    assert.deepEqual(webItem(msg({ at: now + 3600000, ambig: false }), since, now), { skip: 'notime' });
    assert.equal(inZone('America/New_York', '[02:30, 2026/3/8] Sender: '), null, '不存在的夏令时时间不能自动进位');
  });

  await test('已读过的对话滚动出现无时间历史时不采集，也不反复累计跳过', async () => {
    const reader = new WebReader(), now = Date.now();
    const msg = id => ({ id: `false_123456789@c.us_${id}`, text: 'old', t: null });
    assert.equal(reader.collect('1', [msg('initial')], now - 60000, now).items.length, 0);
    const scroll = reader.collect('1', [msg('older')], now - 60000, now + 15000);
    assert.equal(scroll.items.length, 0); assert.equal(scroll.notime, 1);
    assert.equal(reader.collect('1', [msg('older')], now - 60000, now + 30000).notime, 0);
  });

  await test('闲置过期队列在重启、读取和定时清理时都从内存和磁盘移除', async () => {
    let now = Date.now();
    const dir = tmp(), deps = { dir, safeStorage: safe, now: () => now, timers: { setTimeout: () => 1, clearTimeout() {} } };
    const add = (q, mid) => q.add('1', { mid, peer: '123456789', at: now, text: mid });
    const q = new CrmQueue(deps); q.enable('1'); add(q, 'old'); q.saveNow();
    now += MAX_AGE_MS + 86400000;
    const reopened = new CrmQueue(deps);
    assert.equal(reopened.peek('1').length, 0); assert.equal(reopened.stats('1').queued, 0);
    const contents = () => JSON.parse(safe.decryptString(fs.readFileSync(path.join(dir, 'crm-queue.bin')))).accs['1'].items;
    assert.equal(contents().length, 0);
    add(reopened, 'idle'); reopened.saveNow(); now += MAX_AGE_MS + 1;
    reopened.sweep(); assert.equal(contents().length, 0);
    add(reopened, 'read'); reopened.saveNow(); now += MAX_AGE_MS + 1;
    assert.equal(reopened.stats('1').queued, 0); assert.equal(contents().length, 0);
  });

  await test('锁屏时真实 incoming 回调不发已读，解锁后仍正常发送', async () => {
    const liteHost = new EventEmitter(), reads = [];
    liteHost.read = (...args) => reads.push(args);
    const context = { liteHost, notifier: {}, locked: true, activeId: '1', page: 'account',
      win: { isVisible: () => true, isFocused: () => true }, liteOpen: new Map([['1', 'jid']]), problems: new Map(), Date,
    };
    vm.createContext(context);
    vm.runInContext(main.slice(main.indexOf('function userIsReading('), main.indexOf('function syncLiteWatch(')) + '\nbindLiteEvents();', context);
    liteHost.emit('incoming', { id: '1', jid: 'jid' }); assert.equal(reads.length, 0);
    context.locked = false;
    liteHost.emit('incoming', { id: '1', jid: 'jid' }); assert.deepEqual(reads, [['1', 'jid']]);
  });

  await test('basic_text 或钥匙环异常拒绝保存轻量密钥、代理密码和设备令牌', async () => {
    let encrypts = 0;
    const weak = { ...safe, getSelectedStorageBackend: () => 'basic_text', encryptString: s => { encrypts++; return Buffer.from(s); } };
    assert.equal(canEncrypt(weak, 'linux'), false);
    assert.equal(canEncrypt({ ...weak, getSelectedStorageBackend: () => { throw Error('keyring'); } }, 'linux'), false);
    assert.equal(canEncrypt(safe, 'linux'), true);
    const context = { crypto: require('node:crypto'), safeStorage: weak, canEncrypt: s => canEncrypt(s, 'linux') };
    vm.createContext(context);
    vm.runInContext(main.slice(main.indexOf('function newLiteKey()'), main.indexOf('\nfunction liteKeyOf(')), context);
    assert.throws(() => vm.runInContext('newLiteKey()', context), /钥匙环/);
    const { TeamSync } = require('../src/team');
    let requests = 0;
    const team = new TeamSync({ dir: tmp(), safeStorage: weak, hooks: {}, platform: 'linux', fetchImpl: async () => { requests++; throw Error('network'); } });
    if (process.platform === 'linux') {
      assert((await team.enroll({ consent: true, server: 'https://team.example', code: '123' })).error.includes('钥匙环'));
      assert.equal(requests, 0);
      // 与应用使用同一检查函数的真实 proxy 模块。
      const weakProxy = { exports: {} };
      vm.runInNewContext(fs.readFileSync(path.join(root, 'src/proxy.js'), 'utf8'), {
        module: weakProxy, exports: weakProxy.exports, URL, Buffer,
        require: id => id === 'electron' ? { net: {}, session: {}, safeStorage: weak } : proxyRequire(id),
      });
      assert.throws(() => weakProxy.exports.encryptPassword('password'), /钥匙环/);
    }
    assert.equal(encrypts, 0);
  });
  await test('每种问题都有问题代码，界面不再说“发给我们”', () => {
    const { PROBLEM_CODES } = require('../src/problem-codes');
    const kinds = new Set([...main.matchAll(/setProblem\([^{]*\{\s*kind: '(\w+)'/g)].map(m => m[1]));
    kinds.add(/TEAM_PROXY_PROBLEM = \{\s*kind: '(\w+)'/.exec(main)[1]);
    // 页面打不开的提示由 loadProblem 按错误码生成
    const load = main.slice(main.indexOf('function loadProblem('), main.indexOf('\n}\n', main.indexOf('function loadProblem(')));
    for (const m of load.matchAll(/kind: '(\w+)'/g)) kinds.add(m[1]);
    const lite = main.slice(main.indexOf('const LITE_PROBLEMS = {'), main.indexOf('\n};', main.indexOf('const LITE_PROBLEMS = {')));
    for (const m of lite.matchAll(/^  (\w+): \(/gm)) kinds.add(m[1]);
    assert.ok(kinds.size >= 12, `只找到 ${kinds.size} 种问题`);
    for (const k of kinds) assert.match(PROBLEM_CODES[k] || '', /^[A-Z]\d$/, `问题 ${k} 没有代码`);
    const shell = fs.readFileSync(path.join(root, 'src/shell/shell.js'), 'utf8');
    assert.ok(!/发给我们/.test(main + shell));
  });
  console.log(`全部通过（${passed} 项）`);
} finally {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}
