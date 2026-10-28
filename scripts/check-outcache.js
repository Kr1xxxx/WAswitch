// 发出的译文记录自检（话术不重复翻）：同一句中文 + 同一种语言 + 同一个模式第二次不再调翻译；
// 中文改了、换语言、换模式、改模式提示词都重新翻；fresh（重新翻译）重新调并更新记录；失败不记；
// 存到磁盘，重启（新的 TrStore）后还在；最多留 OUT_MAX 条。不连网络。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TrStore } = require('../src/trstore');
const { makeOutTranslate, OUT_ACC, OUT_CHAT } = require('../src/outcache');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-outcache-'));
  let store = new TrStore(dir);
  const calls = [];
  let n = 0;
  let fail = false;
  const run = makeOutTranslate({
    store: () => store,
    translate: async (a) => { calls.push(`${a.text}|${a.target}|${a.mode.prompt}`); n += 1; return fail ? { error: '网络', kind: 'network' } : { text: `${a.target}:${a.text}#${n}`, warn: [] }; },
    warnOf: () => [],
  });
  const biz = { id: 'm1', prompt: '商务', temperature: 0.3 };
  const r1 = await run({ text: '您好，货已发出', target: '英语', mode: biz, context: [{ out: false, text: 'a' }] });
  assert.strictEqual(r1.text, '英语:您好，货已发出#1');
  assert(!r1.cached);
  // 第二次：同一句、同语言、同模式（上下文不同也一样）——不调翻译
  const r2 = await run({ text: '您好，货已发出', target: '英语', mode: biz, context: [] });
  assert.strictEqual(r2.text, r1.text);
  assert.strictEqual(r2.cached, true);
  assert.strictEqual(calls.length, 1, '同一句话术同语言第二次不能再调翻译');
  // 前后空格不算不同
  assert((await run({ text: ' 您好，货已发出\n', target: '英语', mode: biz })).cached);
  // 换语言、改中文、换模式、改模式提示词：都重新翻
  assert(!(await run({ text: '您好，货已发出', target: '德语', mode: biz })).cached);
  assert(!(await run({ text: '您好，货已发出。', target: '英语', mode: biz })).cached);
  assert(!(await run({ text: '您好，货已发出', target: '英语', mode: { id: 'm2', prompt: '口语' } })).cached);
  assert(!(await run({ text: '您好，货已发出', target: '英语', mode: { ...biz, prompt: '商务（改过）' } })).cached);
  assert.strictEqual(calls.length, 5);
  // 重新翻译：调模型，并更新记录
  const r3 = await run({ text: '您好，货已发出', target: '英语', mode: biz }, true);
  assert(!r3.cached && r3.text.endsWith('#6'));
  const r4 = await run({ text: '您好，货已发出', target: '英语', mode: biz });
  assert(r4.cached && r4.text === r3.text, '重新翻译后记下的是新的一版');
  // 翻译失败不记，下次照样调
  fail = true;
  assert((await run({ text: '新的一句', target: '英语', mode: biz })).error);
  fail = false;
  assert(!(await run({ text: '新的一句', target: '英语', mode: biz })).cached);
  // 重启后还在（写盘，文件里没有中文原文）
  store.flush();
  const file = path.join(dir, OUT_ACC, `${OUT_CHAT}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  assert(Object.keys(JSON.parse(raw)).every((k) => /^[0-9a-f]{24}$/.test(k)), '文件里只存 hash 和译文，不存原文');
  assert(!raw.includes('商务'), '不存模式提示词');
  store = new TrStore(dir);
  const before = calls.length;
  const r5 = await run({ text: '您好，货已发出', target: '英语', mode: biz });
  assert(r5.cached && r5.text === r3.text);
  assert.strictEqual(calls.length, before);
  // 上限：最多留 3000 条，最早的先删
  store.put('x1', 'c', 'a', { tr: 'A' });
  for (let i = 0; i < 5; i += 1) { store.put('x1', 'c', `t${i}`, { tr: `T${i}` }); store.load('x1', 'c').data[require('../src/trstore').textKey(`t${i}`)].at = 1000 + i; }
  store.cap('x1', 'c', 3);
  assert.strictEqual(Object.keys(store.load('x1', 'c').data).length, 3);
  assert(!store.get('x1', 'c', 't0') && !store.get('x1', 'c', 't1') && store.get('x1', 'c', 't4'));
  store.flush();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('发出的译文记录自检通过');
})().catch((e) => { console.error(e); process.exit(1); });
