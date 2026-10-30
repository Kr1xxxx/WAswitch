// 自检：账号数据放哪、老电脑搬到 D 盘（src/datadir.js）。node scripts/check-datadir.js
// 每种预案（没有 D 就 C）一条：没有 D 盘、D 盘写不进、新装、老电脑搬家、空间不够、复制一半失败、校对不上、
// D 盘后来打不开、D 盘回来、删 C 盘旧数据、D 盘已有数据不覆盖、24 小时 / 3 次的重试规则。
// Linux、Mac、Windows 都能跑（platform 注入成 win32；D 盘用临时文件夹代替）。Windows CI 上另外用一个不存在的盘符测「没有 D 盘」
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const dd = require('../src/datadir');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'datadir-'));
let seq = 0;
// 每个用例一套：home（C 盘的 %APPDATA%\WAswitch）、root（D:\WAswitch，默认不存在）
function box({ root = false, old = false } = {}) {
  const base = path.join(tmpRoot, String(++seq));
  const home = path.join(base, 'C', 'WAswitch');
  const rootDir = path.join(base, 'D', 'WAswitch');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.dirname(rootDir), { recursive: true });
  if (root) fs.mkdirSync(rootDir);
  if (old) writeOld(home);
  return { home, root: rootDir, data: path.join(rootDir, 'data') };
}
// 一份「老电脑」的账号数据：账号表、网页号分区（含缓存）、轻量号、Chromium 的 Local State、MCP 文件、锁文件
function writeOld(home) {
  const w = (rel, body) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  w('accounts.json', JSON.stringify([{ id: 'a1', name: 'Hamburg' }]));
  w('Local State', '{"os_crypt":{"encrypted_key":"x"}}');
  w('Partitions/wa-a1/Cookies', 'cookie-bytes'.repeat(100));
  w('Partitions/wa-a1/IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/000003.log', 'idb'.repeat(500));
  w('Partitions/wa-a1/Cache/Cache_Data/data_0', 'cache'.repeat(1000));
  w('Partitions/wa-a1/Code Cache/js/index', 'cc');
  w('lite/a2/creds.json', '{"me":"x"}');
  w('translations/a1/c.json', '{}');
  w('settings.json', '{}');
  w('GPUCache/data_1', 'gpu');
  w('lockfile', '');
  w('modules/mcp/waswitch-mcp.js', '// mcp');
  w('mcp.json', '{"enabled":true}');
  w('mcp-token.json', '{"token":"t"}');
  w('mcp-ai-log.json', '[]');
}
const win = (b, extra = {}) => dd.resolve({ platform: 'win32', home: b.home, root: b.root, ...extra });
const fakeApp = (home) => ({ paths: { userData: home }, isPackaged: true, getPath(k) { return this.paths[k]; }, setPath(k, v) { this.paths[k] = v; } });
const bigDisk = () => ({ bavail: 1e9, bsize: 4096 });
const noWait = () => {};

// ---------- 选位置 ----------

test('Mac / 从源码运行：不动 userData', () => {
  const b = box({ root: true });
  const app = fakeApp(b.home);
  app.isPackaged = false;
  const r = dd.apply(app, { platform: 'win32', root: b.root });
  assert.equal(r.active, false);
  assert.equal(app.getPath('userData'), b.home);
  const r2 = dd.apply(fakeApp(b.home), { platform: 'darwin', root: b.root });
  assert.equal(r2.dir, b.home);
  assert.ok(!fs.existsSync(path.join(b.home, dd.POINTER)));
});

test('没有 D 盘：用 C，不建 D:\\WAswitch，不写指针', () => {
  const b = box();
  const r = win(b);
  assert.equal(r.dir, b.home);
  assert.equal(r.fallback, false);
  assert.ok(!fs.existsSync(b.root), '软件自己不建 D:\\WAswitch');
  assert.ok(!fs.existsSync(path.join(b.home, dd.POINTER)));
});

test('D:\\WAswitch 写不进去（data 被同名文件占着）：用 C', () => {
  const b = box({ root: true });
  fs.writeFileSync(b.data, 'not a folder');
  const r = win(b);
  assert.equal(r.dir, b.home);
  assert.ok(!fs.existsSync(path.join(b.home, dd.POINTER)));
});

test('D:\\WAswitch 本身是个文件：用 C', () => {
  const b = box();
  fs.writeFileSync(b.root, 'x');
  assert.equal(win(b).dir, b.home);
});

test('新装的电脑：C 盘没数据、D 能用 → D:\\WAswitch\\data，写指针；下次还是 D', () => {
  const b = box({ root: true });
  // MCP 文件和指针不算账号数据
  fs.mkdirSync(path.join(b.home, 'modules', 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(b.home, 'mcp.json'), '{}');
  const app = fakeApp(b.home);
  const r = dd.apply(app, { platform: 'win32', root: b.root });
  assert.equal(r.dir, b.data);
  assert.equal(r.fresh, true);
  assert.equal(app.getPath('userData'), b.data);
  assert.equal(app.getPath('sessionData'), b.data, 'sessionData 跟着改');
  assert.deepEqual(dd.readPointer(b.home), { dir: b.data, cleanC: false });
  const again = win(b);
  assert.equal(again.dir, b.data);
  assert.equal(again.fresh, false);
});

test('新装的电脑 %APPDATA%\\WAswitch 还不存在：指针照样写出来（D 盘以后打不开才有提示）', () => {
  const b = box({ root: true });
  fs.rmSync(b.home, { recursive: true });
  const r = win(b);
  assert.equal(r.dir, b.data);
  assert.deepEqual(dd.readPointer(b.home), { dir: b.data, cleanC: false });
  fs.renameSync(b.root, `${b.root}-x`);
  const f = win(b);
  assert.equal(f.fallback, true, '有指针，D 盘打不开时有提示');
  assert.equal(f.wanted, b.data);
});

test('老电脑：C 盘有数据 → 先留在 C，不写指针；空闲时该搬', () => {
  const b = box({ root: true, old: true });
  const app = fakeApp(b.home);
  const r = dd.apply(app, { platform: 'win32', root: b.root });
  assert.equal(r.dir, b.home);
  assert.equal(app.getPath('userData'), b.home);
  assert.equal(dd.readPointer(b.home), null);
  assert.equal(dd.shouldMove(r), true);
});

test('老电脑但没有 D 盘：不搬', () => {
  const b = box({ old: true });
  const r = dd.apply(fakeApp(b.home), { platform: 'win32', root: b.root });
  assert.equal(dd.shouldMove(r), false);
  const m = dd.move({ home: b.home, root: b.root, wait: noWait });
  assert.equal(m.ok, false);
  assert.ok(!fs.existsSync(b.root));
  assert.equal(dd.readPointer(b.home), null);
});

// ---------- 搬家 ----------

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

test('老电脑搬家成功：整份复制、跳过缓存和锁文件、MCP 留在 C、C 盘一点没动、写指针', () => {
  const b = box({ root: true, old: true });
  const before = snapshot(b.home);
  const m = dd.move({ home: b.home, root: b.root, statfs: bigDisk, wait: noWait });
  assert.equal(m.ok, true, JSON.stringify(m));
  const after = snapshot(b.home);
  delete after[dd.STATE];
  delete after[dd.POINTER];
  assert.deepEqual(after, before, 'C 盘那份没动');
  const d = snapshot(b.data);
  for (const k of ['accounts.json', 'Local State', path.join('Partitions', 'wa-a1', 'Cookies'), path.join('lite', 'a2', 'creds.json'), path.join('translations', 'a1', 'c.json'),
    path.join('Partitions', 'wa-a1', 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb', '000003.log')]) {
    assert.equal(d[k], before[k], `${k} 搬过去了`);
  }
  for (const k of Object.keys(d)) {
    assert.ok(!/(^|[\\/])(Cache|Code Cache|GPUCache)([\\/]|$)/.test(k), `缓存没搬：${k}`);
    assert.ok(!['lockfile', 'mcp.json', 'mcp-token.json', 'mcp-ai-log.json'].includes(k) && !k.startsWith('modules'), `留在 C 的没搬：${k}`);
  }
  assert.ok(!fs.existsSync(`${b.data}.tmp`));
  const p = dd.readPointer(b.home);
  assert.equal(p.dir, b.data);
  assert.equal(p.cleanC, true);
  // 下次启动用 D
  const app = fakeApp(b.home);
  const r = dd.apply(app, { platform: 'win32', root: b.root });
  assert.equal(r.dir, b.data);
  assert.equal(app.getPath('userData'), b.data);
  assert.equal(dd.shouldMove(r), false, '搬过了不再搬');
});

test('D 盘空间不够：不搬，C 不动，D 盘不留东西，24 小时后再看', () => {
  const b = box({ root: true, old: true });
  const before = snapshot(b.home);
  const r = dd.apply(fakeApp(b.home), { platform: 'win32', root: b.root });
  const t0 = Date.now();
  dd.noteAttempt(b.home, t0);
  const m = dd.move({ home: b.home, root: b.root, statfs: () => ({ bavail: 1, bsize: 1024 }), wait: noWait });
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'nospace');
  assert.equal(dd.readPointer(b.home), null);
  assert.ok(!fs.existsSync(`${b.data}.tmp`));
  const after = snapshot(b.home);
  delete after[dd.STATE];
  assert.deepEqual(after, before);
  assert.equal(dd.readState(b.home).error, 'nospace');
  assert.equal(dd.shouldMove(r, { now: t0 + 3600 * 1000 }), false, '1 小时后不再试');
  assert.equal(dd.shouldMove(r, { now: t0 + dd.RETRY_MS + 1 }), true, '24 小时后再试');
});

test('最多试 3 次', () => {
  const b = box({ root: true, old: true });
  const r = dd.apply(fakeApp(b.home), { platform: 'win32', root: b.root });
  let t = dd.RETRY_MS + 1;
  for (let i = 0; i < dd.MAX_TRIES; i++) { assert.equal(dd.shouldMove(r, { now: t }), true); dd.noteAttempt(b.home, t); t += dd.RETRY_MS + 1; }
  assert.equal(dd.shouldMove(r, { now: t }), false);
});

test('复制到一半失败（D 盘满了 / 断电）：删掉 D 盘半截的，C 盘一点没动，不写指针', () => {
  const b = box({ root: true, old: true });
  const before = snapshot(b.home);
  let copied = 0;
  const cp = (from, to, opts) => fs.cpSync(from, to, { ...opts, filter: (src) => { if (opts.filter(src) === false) return false; if (++copied > 6) { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; } return true; } });
  const m = dd.move({ home: b.home, root: b.root, statfs: bigDisk, cp, wait: noWait });
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'copy');
  assert.ok(copied > 6, '确实复制了一部分');
  assert.ok(!fs.existsSync(`${b.data}.tmp`), '半截的删掉了');
  assert.ok(!dd.hasData(b.data));
  assert.equal(dd.readPointer(b.home), null);
  const after = snapshot(b.home);
  delete after[dd.STATE];
  assert.deepEqual(after, before);
  assert.equal(win(b).dir, b.home, '下次启动还是 C');
});

test('被杀毒软件锁住（EBUSY）：等一会儿重试，成了就搬', () => {
  const b = box({ root: true, old: true });
  let calls = 0;
  let waited = 0;
  const cp = (from, to, opts) => { if (++calls < 3) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; } return fs.cpSync(from, to, opts); };
  const m = dd.move({ home: b.home, root: b.root, statfs: bigDisk, cp, wait: () => { waited++; } });
  assert.equal(m.ok, true);
  assert.equal(calls, 3);
  assert.equal(waited, 2);
});

test('一直锁着：放弃，留在 C', () => {
  const b = box({ root: true, old: true });
  const cp = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
  const m = dd.move({ home: b.home, root: b.root, statfs: bigDisk, cp, wait: noWait });
  assert.equal(m.ok, false);
  assert.equal(dd.readPointer(b.home), null);
  assert.ok(!fs.existsSync(`${b.data}.tmp`));
});

test('复制完对不上（少了文件）：不用 D 盘那份', () => {
  const b = box({ root: true, old: true });
  const cp = (from, to, opts) => fs.cpSync(from, to, { ...opts, filter: (src) => opts.filter(src) && !src.endsWith('creds.json') });
  const m = dd.move({ home: b.home, root: b.root, statfs: bigDisk, cp, wait: noWait });
  assert.equal(m.ok, false);
  assert.match(m.reason, /^verify/);
  assert.equal(dd.readPointer(b.home), null);
  assert.ok(!fs.existsSync(`${b.data}.tmp`));
  assert.ok(!dd.hasData(b.data));
});

test('D:\\WAswitch\\data 里已经有账号数据：不覆盖', () => {
  const b = box({ root: true, old: true });
  fs.mkdirSync(b.data);
  fs.writeFileSync(path.join(b.data, 'accounts.json'), '[{"id":"d"}]');
  const m = dd.move({ home: b.home, root: b.root, statfs: bigDisk, wait: noWait });
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'exists');
  assert.equal(fs.readFileSync(path.join(b.data, 'accounts.json'), 'utf8'), '[{"id":"d"}]');
});

test('上次留下的半截 data.tmp：先删再搬', () => {
  const b = box({ root: true, old: true });
  fs.mkdirSync(`${b.data}.tmp`, { recursive: true });
  fs.writeFileSync(path.join(`${b.data}.tmp`, 'junk'), 'x');
  const m = dd.move({ home: b.home, root: b.root, statfs: bigDisk, wait: noWait });
  assert.equal(m.ok, true);
  assert.ok(!fs.existsSync(path.join(b.data, 'junk')));
});

// ---------- 搬过以后 ----------

test('已经搬到 D，后来 D 盘打不开：这次用 C，指针位置不改，以后不删 C 盘那份；D 回来自动回去', () => {
  const b = box({ root: true, old: true });
  assert.equal(dd.move({ home: b.home, root: b.root, statfs: bigDisk, wait: noWait }).ok, true);
  const hidden = `${b.root}-unplugged`;
  fs.renameSync(b.root, hidden); // 拔掉 D 盘
  const app = fakeApp(b.home);
  const r = dd.apply(app, { platform: 'win32', root: b.root });
  assert.equal(r.dir, b.home);
  assert.equal(r.fallback, true);
  assert.equal(r.wanted, b.data);
  assert.equal(app.getPath('userData'), b.home);
  assert.ok(dd.fallbackText(r).includes(b.data));
  assert.ok(!fs.existsSync(b.root), '没有在 D 盘建任何东西');
  const p = dd.readPointer(b.home);
  assert.equal(p.dir, b.data, '指针位置没改');
  assert.equal(p.cleanC, false, 'C 盘那份这次又用了，以后不删');
  assert.equal(dd.shouldMove(r), false, '有指针就不再搬');
  fs.renameSync(hidden, b.root); // 插回来
  const back = dd.apply(fakeApp(b.home), { platform: 'win32', root: b.root });
  assert.equal(back.dir, b.data);
  assert.equal(back.fallback, false);
  assert.equal(dd.fallbackText(back), '');
});

test('新装的电脑 D 盘打不开：用 C 启动，界面有提示，D 回来回到 D', () => {
  const b = box({ root: true });
  assert.equal(win(b).dir, b.data);
  fs.writeFileSync(path.join(b.data, 'accounts.json'), '[]');
  fs.renameSync(b.root, `${b.root}-x`);
  const r = win(b);
  assert.equal(r.dir, b.home);
  assert.equal(r.fallback, true);
  fs.renameSync(`${b.root}-x`, b.root);
  assert.equal(win(b).dir, b.data);
});

test('删 C 盘旧数据：只在搬过之后；留下指针和 MCP 文件；全删完 cleanC 变 false', async () => {
  const b = box({ root: true, old: true });
  assert.equal(await dd.cleanOld(b.home), false, '没搬过不删');
  assert.ok(fs.existsSync(path.join(b.home, 'accounts.json')));
  assert.equal(dd.move({ home: b.home, root: b.root, statfs: bigDisk, wait: noWait }).ok, true);
  assert.equal(await dd.cleanOld(b.home), true);
  const left = fs.readdirSync(b.home).sort();
  assert.deepEqual(left, [dd.POINTER, dd.STATE, 'mcp-ai-log.json', 'mcp-token.json', 'mcp.json', 'modules'].sort());
  assert.equal(dd.readPointer(b.home).cleanC, false);
  assert.ok(dd.hasData(b.data), 'D 盘那份在');
  assert.equal(win(b).dir, b.data);
  assert.equal(await dd.cleanOld(b.home), false, '删过一次不再删');
});

test('D 盘打不开那次以后，不删 C 盘那份', async () => {
  const b = box({ root: true, old: true });
  dd.move({ home: b.home, root: b.root, statfs: bigDisk, wait: noWait });
  fs.renameSync(b.root, `${b.root}-x`);
  win(b);
  fs.renameSync(`${b.root}-x`, b.root);
  assert.equal(win(b).dir, b.data);
  assert.equal(await dd.cleanOld(b.home), false);
  assert.ok(fs.existsSync(path.join(b.home, 'accounts.json')));
});

test('指针指的 data 被删了、C 盘没数据：重新建，不会永远停在 C', () => {
  const b = box({ root: true });
  win(b);
  fs.rmSync(b.data, { recursive: true });
  const r = win(b);
  assert.equal(r.dir, b.data);
  assert.equal(r.fallback, false);
});

test('指针文件坏了：当没有指针（C 没数据就按新装处理）', () => {
  const b = box({ root: true });
  fs.writeFileSync(path.join(b.home, dd.POINTER), '{oops');
  assert.equal(win(b).dir, b.data);
});

// ---------- 同一台电脑几个 Windows 用户共用一个 D:\WAswitch ----------
// 第二个用户：另一个 home，同一个 root
function otherUser(b, name = 'B') {
  const home = path.join(path.dirname(path.dirname(b.home)), `C-${name}`, 'WAswitch');
  fs.mkdirSync(home, { recursive: true });
  return { ...b, home };
}
const owner = (b) => JSON.parse(fs.readFileSync(path.join(b.data, dd.OWNER), 'utf8'));

test('两个用户同一个 D：第一个用 D 并记上自己，第二个用自己的 C，读不到第一个的账号', () => {
  const a = box({ root: true });
  const ra = win(a);
  assert.equal(ra.dir, a.data);
  fs.writeFileSync(path.join(a.data, 'accounts.json'), JSON.stringify([{ id: 'acc-of-A' }]));
  assert.equal(owner(a).home, a.home);
  const b = otherUser(a);
  const rb = win(b);
  assert.equal(rb.dir, b.home, '第二个用户不能用第一个用户的 D:\\WAswitch\\data');
  assert.equal(rb.fresh, false);
  assert.ok(!fs.existsSync(path.join(b.home, dd.POINTER)), '第二个用户不写指向 D 的指针');
  assert.ok(!fs.existsSync(path.join(rb.dir, 'accounts.json')));
  assert.equal(owner(a).home, a.home, '记号还是第一个用户的');
  // 第一个用户下次照样用 D
  assert.equal(win(a).dir, a.data);
  // 第二个用户 C 盘有了数据也不搬过去，不会为它重启
  writeOld(b.home);
  const sb = dd.apply(fakeApp(b.home), { platform: 'win32', root: b.root });
  assert.equal(dd.shouldMove(sb), false);
  const m = dd.move({ home: b.home, root: b.root, statfs: bigDisk, wait: noWait });
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'owner');
  assert.equal(fs.readFileSync(path.join(a.data, 'accounts.json'), 'utf8'), JSON.stringify([{ id: 'acc-of-A' }]));
});

test('两个用户：D:\\WAswitch\\data 空着、只有别人的记号 → 也不用', () => {
  const a = box({ root: true });
  win(a);
  const b = otherUser(a);
  assert.equal(win(b).dir, b.home);
});

test('D:\\WAswitch\\data 有账号数据但没记号（不知道是谁的）：新装的用户不用', () => {
  const b = box({ root: true });
  fs.mkdirSync(b.data);
  fs.writeFileSync(path.join(b.data, 'accounts.json'), '[{"id":"x"}]');
  assert.equal(win(b).dir, b.home);
  assert.ok(!fs.existsSync(path.join(b.data, dd.OWNER)));
});

test('D:\\WAswitch\\data 空着、没记号（安装包建的）：用，并记上自己', () => {
  const b = box({ root: true });
  fs.mkdirSync(b.data);
  assert.equal(win(b).dir, b.data);
  assert.equal(owner(b).home, b.home);
});

test('1.0.1 的老指针、还没有记号：照旧用 D，第一次启动补记成自己；之后别的用户就用不了', () => {
  const a = box({ root: true });
  fs.mkdirSync(a.data);
  fs.writeFileSync(path.join(a.data, 'accounts.json'), '[{"id":"a"}]');
  fs.writeFileSync(path.join(a.home, dd.POINTER), JSON.stringify({ dir: a.data, cleanC: false }));
  const r = win(a);
  assert.equal(r.dir, a.data);
  assert.equal(owner(a).home, a.home);
  assert.equal(win(otherUser(a)).dir, otherUser(a).home);
});

test('1.0.1 时两个用户已经共用：先启动的补记，后启动的去掉指针回 C，D 盘那份一点不动', () => {
  const a = box({ root: true });
  fs.mkdirSync(a.data);
  fs.writeFileSync(path.join(a.data, 'accounts.json'), '[{"id":"shared"}]');
  const b = otherUser(a);
  for (const h of [a.home, b.home]) fs.writeFileSync(path.join(h, dd.POINTER), JSON.stringify({ dir: a.data, cleanC: false }));
  assert.equal(win(a).dir, a.data);
  const rb = win(b);
  assert.equal(rb.dir, b.home);
  assert.equal(rb.shared, a.data);
  assert.equal(rb.fallback, false, '不是 D 盘打不开，不提示');
  assert.ok(!fs.existsSync(path.join(b.home, dd.POINTER)), '第二个用户的指针去掉了');
  assert.equal(fs.readFileSync(path.join(a.data, 'accounts.json'), 'utf8'), '[{"id":"shared"}]');
  assert.equal(owner(a).home, a.home);
  // 以后还是 C，第一个用户还是 D
  assert.equal(win(b).dir, b.home);
  assert.equal(win(a).dir, a.data);
});

test('记号坏了、指针是自己的：照旧用 D，重写成自己；新装的用户不认坏记号', () => {
  const a = box({ root: true });
  win(a);
  fs.writeFileSync(path.join(a.data, dd.OWNER), '{oops');
  assert.equal(win(otherUser(a)).dir, otherUser(a).home);
  assert.equal(win(a).dir, a.data);
  assert.equal(owner(a).home, a.home);
});

test('老电脑搬家：搬过去的 data 带着自己的记号；别人搬不进来', () => {
  const b = box({ root: true, old: true });
  const m = dd.move({ home: b.home, root: b.root, statfs: bigDisk, wait: noWait });
  assert.equal(m.ok, true);
  assert.equal(owner(b).home, b.home);
  assert.equal(win(b).dir, b.data);
  const c = otherUser(b, 'C2');
  writeOld(c.home);
  const sc = dd.apply(fakeApp(c.home), { platform: 'win32', root: c.root });
  assert.equal(sc.dir, c.home);
  assert.equal(dd.shouldMove(sc), false);
});

test('老电脑：D:\\WAswitch\\data 是空的、只有自己的记号 → 照样搬', () => {
  const b = box({ root: true, old: true });
  fs.mkdirSync(b.data);
  fs.writeFileSync(path.join(b.data, dd.OWNER), JSON.stringify({ home: b.home }));
  const s = dd.apply(fakeApp(b.home), { platform: 'win32', root: b.root });
  assert.equal(dd.shouldMove(s), true);
  assert.equal(dd.move({ home: b.home, root: b.root, statfs: bigDisk, wait: noWait }).ok, true);
});

test('老电脑复制的那几分钟里另一个用户第一次打开：他用 C，不会被搬家删掉刚写的东西', () => {
  const a = box({ root: true, old: true });
  const b = otherUser(a);
  let rb;
  const cp = (from, to, o) => { rb = win(b); fs.cpSync(from, to, o); };
  const m = dd.move({ home: a.home, root: a.root, cp, statfs: bigDisk, wait: noWait });
  assert.equal(m.ok, true);
  assert.equal(rb.dir, b.home, '复制期间 D:\\WAswitch\\data 已经记着 A');
  assert.equal(owner(a).home, a.home);
  assert.equal(win(a).dir, a.data);
});

test('搬家没成：把这次记上的记号拿掉，别的用户以后还能用这个空文件夹', () => {
  const a = box({ root: true, old: true });
  const m = dd.move({ home: a.home, root: a.root, statfs: () => ({ bavail: 1, bsize: 1 }), wait: noWait });
  assert.equal(m.ok, false);
  const m2 = dd.move({ home: a.home, root: a.root, cp: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }, statfs: bigDisk, wait: noWait });
  assert.equal(m2.reason, 'copy');
  assert.ok(!fs.existsSync(path.join(a.data, dd.OWNER)), '没留下记号');
  const b = otherUser(a);
  assert.equal(win(b).dir, b.data);
});

test('D 盘那份是别人的：界面和通知有一句说明；D 盘打不开的那句不变', () => {
  assert.match(dd.fallbackText({ shared: 'D:\\WAswitch\\data' }), /另一个 Windows 用户/);
  assert.match(dd.fallbackText({ fallback: true, wanted: 'D:\\WAswitch\\data' }), /D 盘打不开/);
  assert.equal(dd.fallbackText({}), '');
});

test('home 大小写不同也算同一个用户（Windows 路径不分大小写）', () => {
  const b = box({ root: true });
  fs.mkdirSync(b.data);
  fs.writeFileSync(path.join(b.data, dd.OWNER), JSON.stringify({ home: b.home.toUpperCase() }));
  assert.equal(dd.ownerOf(b.data, b.home), 'mine');
});

test('waitForExit：进程不在就马上返回', () => {
  const t = Date.now();
  dd.waitForExit(2 ** 22 + 12345, 2000);
  assert.ok(Date.now() - t < 1000);
});

// Windows CI：一个不存在的盘符当作「没有 D 盘」，走真实的 Windows 路径
if (process.platform === 'win32') {
  test('Windows：没有这个盘（Q:\\WAswitch）→ C', () => {
    const letter = ['Q', 'R', 'S', 'T'].find((l) => !fs.existsSync(`${l}:\\`));
    const home = path.join(tmpRoot, 'winhome');
    fs.mkdirSync(home, { recursive: true });
    const r = dd.resolve({ platform: 'win32', home, root: `${letter}:\\WAswitch` });
    assert.equal(r.dir, home);
    assert.equal(r.fallback, false);
    writeOld(home);
    const r2 = dd.apply(fakeApp(home), { platform: 'win32', root: `${letter}:\\WAswitch` });
    assert.equal(r2.dir, home);
    assert.equal(dd.shouldMove(r2), false);
  });
}

(async () => {
  let n = 0;
  for (const [name, fn] of tests) {
    await fn();
    console.log(`ok ${++n} ${name}`);
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`check-datadir: ${n} 项通过`);
})().catch((e) => { console.error(e); process.exit(1); });
