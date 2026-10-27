// 内存回收逻辑自检（不需要 Electron）：node scripts/check-memory.js
// 假的 electron.app 和假的网页，快进时间，看总上限会不会反复刷新。
const Module = require('module');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mem-'));

let fakeNow = Date.now();
Date.now = () => fakeNow;
const usage = new Map(); // pid -> MB
const realLoad = Module._load;
Module._load = function load(req, ...rest) {
  if (req === 'electron') {
    return { app: { getPath: () => userData, getAppMetrics: () => [...usage].map(([pid, mb]) => ({ pid, memory: { workingSetSize: mb * 1024 } })) } };
  }
  return realLoad.call(this, req, ...rest);
};
const { MemoryManager, loadSettings, saveSettings } = require('../src/memory');

// 0. 工作台默认停在“翻译”；切到别的页后存进设置，重启（重新读设置）还在那一页；写坏的值回到翻译
assert.strictEqual(loadSettings().panelTab, 'translate', '新装应默认翻译');
saveSettings({ ...loadSettings(), panelTab: 'replies' });
assert.strictEqual(loadSettings().panelTab, 'replies', '重启后应记住话术');
saveSettings({ ...loadSettings(), panelTab: 'bogus' });
assert.strictEqual(loadSettings().panelTab, 'translate', '坏值应回到翻译');
const legacy = { lockMinutes: 15 }; // 老版本的设置文件没有 panelTab
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(legacy));
assert.strictEqual(loadSettings().panelTab, 'translate', '老用户升级后默认翻译');
console.log('✓ 工作台默认翻译，并记住上次的页');

function setup(n, mb, settings) {
  const views = new Map();
  const reloads = [];
  for (let i = 0; i < n; i += 1) {
    const id = `a${i}`;
    usage.set(i + 1, mb);
    views.set(id, { webContents: { isDestroyed: () => false, isLoading: () => false, getOSProcessId: () => i + 1, reload: () => reloads.push(id) } });
  }
  const m = new MemoryManager({ recycleMB: 800, capMB: 2048, ...settings }, {
    views, isBackground: (id) => id !== 'a0', unreadOf: () => 0, onUpdate: () => {},
  });
  for (const id of views.keys()) m.markBackground(id, id !== 'a0');
  return { m, reloads };
}
const minutes = (k) => { fakeNow += k * 60 * 1000; };

// 1. 10 个账号各 350 MB、上限 2 GB：刚打开就超了，但刷新省不下来，一次都不刷，并建议调高上限
usage.clear();
let t = setup(10, 350);
for (let i = 0; i < 180; i += 1) { t.m.check(); minutes(1); }
assert.strictEqual(t.reloads.length, 0, `不应刷新，实际刷新了 ${t.reloads.length} 次`);
assert.ok(t.m.capAdvice > 2048 || t.m.capAdvice === -1, '应该建议调高上限');
console.log('✓ 10 个账号 × 350 MB，3 小时内 0 次刷新，建议上限', t.m.capAdvice);

// 2. 4 个账号，后台的涨到 900 MB：按涨幅回收，每个号 1 小时内最多 1 次
usage.clear();
t = setup(4, 350, { recycleMB: 0 });
for (let i = 0; i < 6; i += 1) { t.m.check(); minutes(1); } // 量底数
for (const pid of [2, 3, 4]) usage.set(pid, 900);
for (let i = 0; i < 60; i += 1) { t.m.check(); minutes(1); }
assert.ok(t.reloads.length >= 1 && t.reloads.length <= 3, `一小时内应刷新 1–3 次，实际 ${t.reloads.length}`);
assert.ok(!t.reloads.includes('a0'), '不能刷新正在看的账号');
assert.strictEqual(new Set(t.reloads).size, t.reloads.length, '同一个号一小时内只能刷一次');
console.log('✓ 超上限时只刷后台涨得多的号，一小时', t.reloads.length, '次');

// 3. 涨了也一直超（刷新后又涨回去）：每小时总共不超过 3 次
usage.clear();
t = setup(12, 150, { recycleMB: 0 });
for (let i = 0; i < 6; i += 1) { t.m.check(); minutes(1); }
for (let p = 2; p <= 12; p += 1) usage.set(p, 600);
for (let i = 0; i < 60; i += 1) { t.m.check(); minutes(1); }
assert.ok(t.reloads.length <= 3, `每小时最多 3 次，实际 ${t.reloads.length}`);
console.log('✓ 每小时总共', t.reloads.length, '次（上限 3）');

// 3b. 总开关「自动回收后台账号」关掉：两条线都不起作用，也不提示调上限
usage.clear();
t = setup(10, 350, { autoRecycle: false });
for (let i = 0; i < 6; i += 1) { t.m.check(); minutes(1); }
for (let p = 2; p <= 10; p += 1) usage.set(p, 1600);
for (let i = 0; i < 120; i += 1) { t.m.check(); minutes(1); }
assert.strictEqual(t.reloads.length, 0, `总开关关掉后不应刷新，实际 ${t.reloads.length} 次`);
assert.strictEqual(t.m.capAdvice, 0, '总开关关掉后不该建议调上限');
console.log('✓ 总开关关掉后 0 次自动刷新');

// 4. 立即清理：刚切走 30 秒内的不动，没涨的不动
(async () => {
  usage.clear();
  t = setup(3, 350, { recycleMB: 0, capMB: 0 });
  for (let i = 0; i < 6; i += 1) { t.m.check(); minutes(1); }
  usage.set(2, 800); usage.set(3, 360);
  let r = await t.m.cleanNow();
  assert.deepStrictEqual([r.recycled, r.fresh], [1, 1]);
  t.m.markBackground('a1', false); t.m.markBackground('a1', true); // 刚切走
  usage.set(2, 800);
  r = await t.m.cleanNow();
  assert.strictEqual(r.recycled, 0); assert.strictEqual(r.skipped, 1);
  console.log('✓ 立即清理跳过没涨的和刚切走的');
  console.log('全部通过');
})().catch((e) => { console.error(e); process.exit(1); });
