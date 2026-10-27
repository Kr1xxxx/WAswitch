// 断线提醒自检（不需要 Electron）：node scripts/check-offline.js
// 快进时间，看断线不满 2 分钟不弹、满了只弹一次、恢复不弹、冷却期内再断不弹、睡醒重新计时。
const assert = require('assert');
const { OfflineWatch, offlineMessage, DELAY_MS, COOLDOWN_MS } = require('../src/offline-watch');

let now = 1_000_000;
const w = new OfflineWatch({ now: () => now });
const step = (ms, ids) => { now += ms; return w.update(new Set(ids)); };
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`通过：${name}`); } catch (e) { failures += 1; console.log(`失败：${name}\n  ${e.message}`); }
};

check('断线不满 2 分钟就恢复：不弹、托盘不标', () => {
  assert.deepStrictEqual(step(0, ['a']).due, []);
  assert.deepStrictEqual(step(DELAY_MS - 1000, ['a']).due, []);
  assert.strictEqual(w.marked('a'), false);
  const r = step(1000 - 1, []);
  assert.deepStrictEqual(r.due, []);
  assert.strictEqual(r.changed, false);
});

check('断线满 2 分钟：弹一次，托盘标出', () => {
  step(0, ['a']);
  const r = step(DELAY_MS, ['a']);
  assert.deepStrictEqual(r.due, ['a']);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(w.marked('a'), true);
  assert.deepStrictEqual(w.markedIds(), ['a']);
});

check('同一次断线一直没好：不再弹', () => {
  for (let i = 0; i < 20; i += 1) assert.deepStrictEqual(step(60 * 1000, ['a']).due, []);
});

check('恢复：不弹，托盘标记去掉', () => {
  const r = step(15 * 1000, []);
  assert.deepStrictEqual(r.due, []);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(w.marked('a'), false);
});

check('弹过后 30 分钟内又断（节点时好时坏）：托盘标，但不再弹', () => {
  step(60 * 1000, ['a']);
  const r = step(DELAY_MS, ['a']);
  assert.deepStrictEqual(r.due, []);
  assert.strictEqual(w.marked('a'), true);
  step(1000, []);
});

check('冷却过后再断满 2 分钟：再弹一次', () => {
  now += COOLDOWN_MS;
  step(0, ['a']);
  assert.deepStrictEqual(step(DELAY_MS, ['a']).due, ['a']);
  step(1000, []);
});

check('几个号同时到点：一起返回（合成一条通知）', () => {
  step(0, ['b', 'c']);
  assert.deepStrictEqual(step(DELAY_MS, ['b', 'c']).due.sort(), ['b', 'c']);
  step(1000, []);
});

check('睡眠醒来：没满 2 分钟的断线重新计时', () => {
  const w2 = new OfflineWatch({ now: () => now });
  w2.update(new Set(['d']));
  now += 8 * 60 * 60 * 1000; // 睡了 8 小时
  w2.restart();
  assert.deepStrictEqual(w2.update(new Set(['d'])).due, []);
  now += DELAY_MS;
  assert.deepStrictEqual(w2.update(new Set(['d'])).due, ['d']);
});

check('删掉的号：记录清掉', () => {
  const w3 = new OfflineWatch({ now: () => now });
  w3.update(new Set(['e']));
  now += DELAY_MS;
  w3.update(new Set(['e']));
  w3.forget('e');
  assert.strictEqual(w3.marked('e'), false);
  assert.strictEqual(w3.lastPop.size, 0);
});

check('通知文案：一个号、几个号', () => {
  assert.deepStrictEqual(offlineMessage(['德国客户号']).title, '德国客户号');
  assert.ok(offlineMessage(['德国客户号']).body.includes('2 分钟'));
  const m = offlineMessage(['A', 'B', 'C', 'D']);
  assert.strictEqual(m.title, '4 个号断线了');
  assert.ok(m.body.startsWith('A、B、C 等'));
});

if (failures) { console.log(`${failures} 项失败`); process.exit(1); }
console.log('全部通过');
