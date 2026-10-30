// 收到的消息自动翻译时同时发给免费服务商（智谱、混元），用先翻出来的（shen 2026-10-29「哪个翻出来用哪个」）：
// 先回来的成功就用、别的马上取消；先回来的报错就等别的；都失败才用付费的备用（一次一条）；默认是付费的不一起发。
// 用假的网络会话，不发任何真实请求。
const T = require('../src/translate.js');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-race-'));
const ss = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from('E' + t), decryptString: (b) => b.toString().slice(1) };
const plan = {}; // host -> { ms, status }
const log = []; // { host, aborted }
let paidNow = 0;
let paidMax = 0;
const fake = { fetch: (url, opt) => new Promise((res, rej) => {
  const host = new URL(url).hostname;
  const p = plan[host] || { ms: 10 };
  const row = { host, aborted: false };
  log.push(row);
  const deepl = /deepl/.test(host);
  if (deepl) { paidNow += 1; paidMax = Math.max(paidMax, paidNow); }
  const t = setTimeout(() => {
    if (deepl) paidNow -= 1;
    const st = p.status || 200;
    const text = deepl ? JSON.stringify({ translations: [{ text: `DL` }] }) : JSON.stringify({ choices: [{ message: { content: host.includes('tokenhub') ? 'HY' : 'ZP' } }] });
    res({ ok: st < 300, status: st, body: null, headers: { get: () => null }, text: async () => (st < 300 ? text : '{"error":{"message":"x"}}') });
  }, p.ms);
  opt.signal.addEventListener('abort', () => { clearTimeout(t); if (deepl) paidNow -= 1; row.aborted = true; rej(new Error('ab')); });
}) };
const tr = new T.Translator({ seed: false, dir, safeStorage: ss, sessionFor: () => fake, retryMs: 5 });
tr.setLashTerms(false);
tr.setWigTerms(false);
const mode = { prompt: '把用户的文字翻译成中文。', direction: 'in' };

(async () => {
  const zp = tr.saveProvider({ preset: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', key: 'k-zp' }).id;
  const dl = tr.saveProvider({ preset: 'deepl', key: 'k-dl:fx' }).id;
  tr.setRoles({ primaryId: zp, fallbackId: dl });
  // 只有智谱有密钥：只发给智谱，和以前一样
  assert.deepStrictEqual(tr.raceSet().map((p) => p.id), [zp]);
  log.length = 0;
  let r = await tr.raceFree({ text: 'Hello', mode, target: '中文' });
  assert.strictEqual(r.text, 'ZP');
  assert.deepStrictEqual(log.map((x) => x.host), ['open.bigmodel.cn']);

  const hy = tr.saveProvider({ preset: 'hunyuan', baseUrl: 'https://tokenhub.tencentmaas.com/v1', model: 'hy-mt2-plus', key: 'k-hy' }).id;
  assert.deepStrictEqual(tr.raceSet().map((p) => p.id), [zp, hy], '默认的排第一');
  // 混元先翻出来：用混元的，智谱那条马上取消
  plan['open.bigmodel.cn'] = { ms: 160 };
  plan['tokenhub.tencentmaas.com'] = { ms: 80 };
  log.length = 0;
  let t0 = Date.now();
  r = await tr.raceFree({ text: 'Hello', mode, target: '中文' });
  assert.strictEqual(r.text, 'HY');
  assert(Date.now() - t0 < 150, '不等慢的那个');
  await new Promise((ok) => setTimeout(ok, 5));
  assert(log.find((x) => x.host === 'open.bigmodel.cn').aborted, '慢的那个被取消');
  assert(!tr.busy, '不占用户翻译用的通道');
  // 先回来的是报错：等另一个
  plan['tokenhub.tencentmaas.com'] = { ms: 20, status: 500 };
  r = await tr.raceFree({ text: 'Hello', mode, target: '中文' });
  assert.strictEqual(r.text, 'ZP');
  // 都失败（服务器出错）：用付费的备用，一次一条
  plan['open.bigmodel.cn'] = { ms: 20, status: 500 };
  let paidCalls = 0;
  let gate = Promise.resolve();
  const paid = (args) => { paidCalls += 1; const run = gate.then(() => tr.translate(args)); gate = run.catch(() => {}); return run; };
  plan['api-free.deepl.com'] = { ms: 40 };
  paidMax = 0;
  const rs = await Promise.all([1, 2, 3].map(() => tr.raceFree({ text: 'Hello', mode, target: '中文' }, { paid })));
  assert.deepStrictEqual(rs.map((x) => x.text), ['DL', 'DL', 'DL']);
  assert(rs.every((x) => x.fallback));
  assert.strictEqual(paidCalls, 3);
  assert.strictEqual(paidMax, 1, '付费的不同时发');
  // 付费那条通道一直等不到：返回 busy，让调用方过一会儿重排，不报免费服务商的错
  r = await tr.raceFree({ text: 'Hello', mode, target: '中文' }, { paid: async () => ({ error: '上一段还在翻译', kind: 'busy' }) });
  assert.strictEqual(r.kind, 'busy');
  // 都失败、报错不是换备用的那种（密钥不对）：不用付费的，报默认服务商的错
  plan['open.bigmodel.cn'] = { ms: 20, status: 401 };
  plan['tokenhub.tencentmaas.com'] = { ms: 10, status: 401 };
  paidCalls = 0;
  r = await tr.raceFree({ text: 'Hello', mode, target: '中文' }, { paid });
  assert.strictEqual(r.kind, 'auth');
  assert.strictEqual(r.providerId, zp, '报默认服务商的错');
  assert.strictEqual(paidCalls, 0);
  // 后台补翻（不给 paid）：都失败也不换 DeepL；调用方取消（给新消息让位置）时各通道一起停
  plan['open.bigmodel.cn'] = { ms: 20, status: 500 };
  plan['tokenhub.tencentmaas.com'] = { ms: 20, status: 500 };
  log.length = 0;
  r = await tr.raceFree({ text: 'Hello', mode, target: '中文' });
  assert.strictEqual(r.kind, 'server');
  assert(!log.some((x) => /deepl/.test(x.host)), '后台补翻不用 DeepL');
  plan['open.bigmodel.cn'] = { ms: 300 };
  plan['tokenhub.tencentmaas.com'] = { ms: 300 };
  log.length = 0;
  const ac = new AbortController();
  t0 = Date.now();
  const pending = tr.raceFree({ text: 'Hello', mode, target: '中文' }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  r = await pending;
  assert.strictEqual(r.kind, 'cancel');
  assert(Date.now() - t0 < 200, '取消马上停');
  assert.strictEqual(log.length, 2);
  assert(log.every((x) => x.aborted), '两家的请求都停了');
  assert(!log.some((x) => /deepl/.test(x.host)));
  const done = new AbortController();
  done.abort();
  log.length = 0;
  assert.strictEqual((await tr.raceFree({ text: 'Hello', mode, target: '中文' }, { signal: done.signal })).kind, 'cancel');
  assert.strictEqual(log.length, 0, '已经取消的不发');
  // 默认是 DeepL（付费）：不一起发，调用方照旧一次一条
  tr.setRoles({ primaryId: dl, fallbackId: zp });
  assert.deepStrictEqual(tr.raceSet(), []);
  assert.strictEqual(await tr.raceFree({ text: 'Hello', mode, target: '中文' }), null);
  // 默认是混元：混元排第一
  tr.setRoles({ primaryId: hy, fallbackId: dl });
  assert.deepStrictEqual(tr.raceSet().map((p) => p.id), [hy, zp]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('免费服务商同时翻、先到先用自检通过');
})().catch((e) => { console.error(e); process.exit(1); });
