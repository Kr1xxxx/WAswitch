// 收到的消息自动翻译走来财（#209）：登录着团队时每条在自己的通道上翻，最多 3 条一起翻，不占用户翻译那条；
// 没登录时不走并行通道（调用方照旧一次一条，报「先登录团队」）；没有付费备用，也没有后台补翻（要花钱）。
// 用假的来财（scripts/fixtures/fake-cloud.js），不发任何真实请求。
const T = require('../src/translate.js');
const { FloatCore } = require('../src/floatcore');
const { fakeCloud } = require('./fixtures/fake-cloud');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-race-'));
const cloud = fakeCloud();
let now = 0;
let max = 0;
// 每个请求等 ms 毫秒才回答；包一层 fetch 记下同时有几个请求在路上
const slow = (ms) => ({ delay: ms, ok: true });
const realFetch = cloud.session.fetch;
cloud.session.fetch = async (url, opt) => { now += 1; max = Math.max(max, now); try { return await realFetch(url, opt); } finally { now -= 1; } };
const tr = new T.Translator({ dir, sessionFor: () => cloud.session, cloud: cloud.login, retryMs: 5 });
tr.setLashTerms(false);
tr.setWigTerms(false);
const mode = { prompt: '把用户的文字翻译成中文。', direction: 'in' };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

(async () => {
  // 登录着：并行通道只有来财
  assert.deepStrictEqual(tr.raceSet().map((p) => p.id), ['cloud']);
  let r = await tr.raceFree({ text: 'Hello', mode, target: '中文' });
  assert.deepStrictEqual([r.text, r.provider, r.model], ['Hola', '来财', 'DeepSeek'], '点译文时间显示「来财 DeepSeek」');
  assert(!tr.busy, '不占用户翻译用的通道');
  // 三条一起翻：三个请求同时在路上，总时间不是三倍
  cloud.reset(); max = 0;
  for (let i = 0; i < 3; i += 1) cloud.next(slow(60));
  let t0 = Date.now();
  const rs = await Promise.all([1, 2, 3].map((i) => tr.raceFree({ text: `Hello ${i}`, mode, target: '中文' })));
  assert.deepStrictEqual(rs.map((x) => x.text), ['Hola', 'Hola', 'Hola']);
  assert.strictEqual(max, 3, '三条同时发');
  assert(Date.now() - t0 < 150, `并行，不排队：${Date.now() - t0}ms`);
  // 用户自己翻的时候（本体 busy）并行通道照样翻
  cloud.reset(); cloud.next('hang');
  const user = tr.translate({ text: '你好', mode: { prompt: 'p' }, target: '英语' });
  assert(tr.busy);
  r = await tr.raceFree({ text: 'Hello', mode, target: '中文' });
  assert.strictEqual(r.text, 'Hola');
  tr.cancel();
  assert.strictEqual((await user).kind, 'cancel');
  // 报错：没有备用可换，原样返回（不带服务商）
  cloud.reset(); cloud.next({ status: 502, error: 'unreachable' });
  r = await tr.raceFree({ text: 'Hello', mode, target: '中文' }, { paid: () => { throw new Error('不该再有付费备用'); } });
  assert.deepStrictEqual([r.kind, r.error, cloud.calls.length], ['server', '来财连不上 DeepSeek，请稍后再试', 1]);
  assert(!('providerId' in r) && !r.fallback);
  // 调用方取消：这条通道马上停
  cloud.reset(); cloud.next('hang');
  const ac = new AbortController();
  t0 = Date.now();
  const pending = tr.raceFree({ text: 'Hello', mode, target: '中文' }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  r = await pending;
  assert.strictEqual(r.kind, 'cancel');
  assert(Date.now() - t0 < 200, '取消马上停');
  const done = new AbortController();
  done.abort();
  cloud.reset();
  assert.strictEqual((await tr.raceFree({ text: 'Hello', mode, target: '中文' }, { signal: done.signal })).kind, 'cancel');
  assert.strictEqual(cloud.calls.length, 0, '已经取消的不发');
  // 没登录：不走并行通道（返回 null，调用方照旧一次一条）
  cloud.logout();
  assert.deepStrictEqual(tr.raceSet(), []);
  assert.strictEqual(await tr.raceFree({ text: 'Hello', mode, target: '中文' }), null);
  cloud.loginAgain();

  // FloatCore 按 translate-ipc.js 的接法：登录着同时翻 3 条；后台补翻走的“免费的路”没有（nofree），更早的消息退回「翻译」按钮，不花钱
  const sent = [];
  let inFlight = 0;
  let peak = 0;
  const fc = new FloatCore({
    translate: async (text, o = {}) => {
      if (o.slow) return { error: '没有免费的翻译服务', kind: 'nofree' };
      sent.push(text);
      inFlight += 1; peak = Math.max(peak, inFlight);
      cloud.next({ delay: 30, ok: true });
      try { return await tr.raceFree({ text, mode, target: '中文' }); } finally { inFlight -= 1; }
    },
  });
  fc.deps.parallel = () => (tr.raceSet().length ? 3 : 1);
  fc.deps.hasFree = () => false;
  const msgs = Array.from({ length: 12 }, (_, i) => ({ id: `false_111@c.us_ID111N${i}`, out: false, text: `hola ${i}` }));
  cloud.reset();
  fc.ingest('A', { title: 'Carlos', msgs }, { auto: true, dailyCap: 500 });
  for (let i = 0; i < 100 && (fc.running || fc.queue.length || fc.active); i += 1) await sleep(10);
  assert.deepStrictEqual(sent.sort(), ['hola 10', 'hola 11', 'hola 7', 'hola 8', 'hola 9'], '只自动翻最近 5 条');
  assert.strictEqual(peak, 3, '同时翻 3 条');
  const v = fc.viewOf('A').items;
  assert(v.slice(0, 7).every((it) => it.state === 'manual'), `更早的留着「翻译」按钮：${v.map((it) => it.state)}`);
  assert.strictEqual(cloud.calls.length, 5, '更早的消息不在后台发给来财');
  // 自动翻译暂时失败：没有免费的路，不自动再翻，直接显示报错和「重试」
  const fc2 = new FloatCore({ translate: async () => ({ error: '来财那边出错了，请稍后再试', kind: 'server' }) });
  fc2.deps.hasFree = () => false;
  fc2.ingest('B', { title: 'Ana', msgs: [{ id: 'false_222@c.us_ID222N1', out: false, text: 'hola' }] }, { auto: true, dailyCap: 500 });
  await sleep(30);
  assert.deepStrictEqual([fc2.viewOf('B').items[0].state, fc2.viewOf('B').items[0].err], ['error', '来财那边出错了，请稍后再试']);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('收到的消息走来财、并行翻译自检通过');
})().catch((e) => { console.error(e); process.exit(1); });
