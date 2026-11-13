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
  assert.deepStrictEqual([r.text, r.provider, r.model], ['Hola', '来财', ''], '来财没说用的哪家：点译文时间显示「来财」');
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
  cloud.reset(); cloud.next({ status: 502, error: 'unreachable', extra: { provider: '智谱' } });
  r = await tr.raceFree({ text: 'Hello', mode, target: '中文' }, { paid: () => { throw new Error('不该再有付费备用'); } });
  assert.deepStrictEqual([r.kind, r.error, cloud.calls.length], ['server', '来财连不上智谱，请稍后再试', 1]);
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
  // 经过真的 translate-ipc.js 接法（FloatCore → Translator → 来财）：语音转出来的文字标 purpose voice，
  // 新消息自动翻译带 queued_ms（语音从转文字前算起）；用户点的不带；纠错是 fix、不带
  {
    const Module = require('module');
    const R = require('../src/records');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-race-ipc-'));
    const fakeElectron = { app: { getPath: () => userData }, session: { fromPartition: () => ({ setProxy: async () => {} }) }, ipcMain: { handle() {}, on() {} }, clipboard: {}, shell: {}, WebContentsView: function () {} };
    const origLoad = Module._load;
    Module._load = function (request, ...rest) { return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest); };
    // 译文存在临时的 userData 里：Windows 上装着软件时 pickDir 会选 D:\WAswitch\translations（真的译文记录），自检不能写进去
    const trstore = require('../src/trstore');
    const origPick = trstore.pickDir;
    trstore.pickDir = (fallback) => fallback;
    const { setupTranslateIpc } = require('../src/translate-ipc');
    trstore.pickDir = origPick;
    Module._load = origLoad;
    const modeStore = new R.Records(userData, 'tmodes');
    modeStore.upsert({ name: 'In', direction: 'in', prompt: '翻译成中文' });
    const real = { handleShell: () => {}, onShell: () => {}, modeStore, translator: tr, activeId: '' };
    const ipc = setupTranslateIpc(new Proxy(real, { get: (t, k) => (k in t ? t[k] : () => {}) }));
    ipc.setupFloatCore();
    const core = ipc.floatCore;
    assert.strictEqual(path.dirname(core.deps.store.dir), userData, '译文只写进临时目录');
    let clock = Date.parse('2026-11-13T09:00:00Z');
    core.deps.now = () => clock;
    core.deps.transcribe = async () => { clock += 3000; return { text: 'Bonjour, vous avez du stock ?', seconds: 4 }; };
    const settle = async () => { for (let i = 0; i < 100 && (core.running || core.queue.length || core.vrunning || core.vq.length); i += 1) await sleep(10); };
    const chats = () => cloud.calls.filter((c) => c.route === 'ai/chat').map((c) => c.body);
    // 先打开对话（只有自己发的一条）：之后来的才是新消息，带 queued_ms。一次只翻一条，每个请求在路上 0.8 秒：第二条等了第一条的 0.8 秒
    core.deps.parallel = () => 1;
    const fetch0 = cloud.session.fetch;
    cloud.session.fetch = async (url, opt) => { clock += 800; return fetch0(url, opt); };
    const t1 = { id: 'false_333@c.us_ID333T1', out: false, text: 'Bonjour' };
    const t2 = { id: 'false_333@c.us_ID333T2', out: false, text: 'Vous livrez en France ?' };
    const mine = { id: 'true_333@c.us_ID333M1', out: true, text: 'Bonjour Claire' };
    core.ingest('W', { title: 'Claire', bottom: true, msgs: [mine] }, { auto: true, dailyCap: 500 });
    cloud.reset();
    core.ingest('W', { title: 'Claire', bottom: true, msgs: [mine, t1, t2] }, { auto: true, dailyCap: 500 });
    await settle();
    core.ingest('W', { title: 'Claire', bottom: true, msgs: [mine, t1, t2, { id: 'false_333@c.us_ID333V1', out: false, text: '', voice: 0, raw: 'ID333V1' }] }, { auto: true, dailyCap: 500 });
    await settle();
    let b = chats();
    assert.deepStrictEqual(b.map((x) => [x.purpose, x.queued_ms]), [['translate', 0], ['translate', 800], ['voice', 3000]], JSON.stringify(b.map((x) => [x.purpose, x.queued_ms])));
    const items = core.viewOf('W').items;
    cloud.reset();
    assert(core.manual('W', items[0].h));
    await settle();
    const voiceItem = items.find((it) => typeof it.voice === 'number');
    assert(voiceItem, JSON.stringify(items));
    assert(core.manual('W', voiceItem.h, true)); // 对语音转出来的文字纠错
    await settle();
    b = chats();
    assert.deepStrictEqual(b.map((x) => [x.purpose, 'queued_ms' in x]), [['translate', false], ['fix', false]], '用户点的、纠错（语音也是）都不带');
    cloud.session.fetch = fetch0;
    fs.rmSync(userData, { recursive: true, force: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('收到的消息走来财、并行翻译自检通过');
})().catch((e) => { console.error(e); process.exit(1); });
