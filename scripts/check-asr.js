// 语音转文字自检（不发真实请求）：
// 1) asr.js：切段（15 秒以内整段，更长的每段 ≤ 14 秒，切在安静处，最多 5 分钟）、wav 头
// 2) Translator.transcribe：发给假的来财（照 #209 约定表），分段请求拼起来；没登录、额度、太忙重试、语音服务用不了、没听出话
// 3) FloatCore：轻量号语音行显示、自动转写后翻译、按「voice:+消息编号」存（重开不再转）、没开自动只给按钮、失败可重试、
//    超过 5 分钟不自动转、更早的语音不在后台补、自己发的语音不显示、没登录团队的登录后自动重转
// 4) FloatCore 网页号语音：按 data-id 去拿、时长回填、重开不再转、连续 3 条读不到就不再自动读（成功一次恢复）、
//    超过 5 分钟退回按钮并退额度、一条慢语音不挡后面的文字翻译
// 用法：node scripts/check-asr.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const asr = require('../src/asr');
const T = require('../src/translate');
const { FloatCore, fromLite, VOICE_MAX_S, VOICE_TRIP, msgKey } = require('../src/floatcore');
const { TrStore, textKey } = require('../src/trstore');
const { fakeCloud } = require('./fixtures/fake-cloud');

const R = asr.RATE;
const tone = (sec, amp = 4000) => { const a = new Int16Array(Math.round(sec * R)); for (let i = 0; i < a.length; i += 1) a[i] = Math.round(amp * Math.sin(i / 7)); return a; };

function splitting() {
  assert.deepStrictEqual(asr.splitPcm(tone(10)).map((c) => c.length), [10 * R]);
  // 15 秒以内整段发（来财的 Worker 每次 CPU 时间很少，一段别太大）
  assert.deepStrictEqual(asr.splitPcm(tone(15)).map((c) => c.length), [15 * R]);
  assert.strictEqual(asr.CHUNK_MAX_S, 14);
  // 40 秒，在 12 秒处有 200 毫秒的安静：第一刀切在安静处（每段最后 5 秒里找）
  const a = tone(40);
  a.fill(0, 12 * R, 12.2 * R);
  const parts = asr.splitPcm(a);
  assert(parts.every((c) => c.length <= asr.CHUNK_MAX_S * R), '每段不超过 14 秒');
  assert(Math.abs(parts[0].length / R - 12.1) < 0.11, `切在安静处：${parts[0].length / R}`);
  assert.strictEqual(parts.reduce((n, c) => n + c.length, 0), a.length, '切完一样长');
  // 剩下的不超过 15 秒就不再切：15.5 秒 = 14 + 1.5
  assert.strictEqual(asr.splitPcm(tone(15.5)).length, 2);
  assert.deepStrictEqual(asr.splitPcm(tone(25)).map((c) => c.length <= 15 * R), [true, true]);
  // 超过 5 分钟只转前 5 分钟
  const long = asr.splitPcm(tone(400, 100));
  assert.strictEqual(long.reduce((n, c) => n + c.length, 0), asr.MAX_SECONDS * R);
  assert(long.length <= Math.ceil(asr.MAX_SECONDS / 9), `最多 ${long.length} 段`); // 每段至少 9 秒
  // 一段的 base64 远低于来财的上限（1.4 MB）
  assert(asr.wavOf(tone(15)).toString('base64').length < 0.7 * 1024 * 1024);
  const wav = asr.wavOf(new Int16Array([1, -1, 2]));
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(24), R);
  assert.strictEqual(wav.readUInt32LE(40), 6);
  assert.strictEqual(wav.length, 50);
  assert.strictEqual(typeof asr.formOf, 'undefined', '不再拼智谱的 multipart');
  assert.strictEqual(asr.textOf('{"ok":true,"text":" Hallo "}'), 'Hallo');
  assert.strictEqual(asr.textOf('{"ok":true,"text":""}'), '');
  assert.strictEqual(asr.clock(23), '0:23');
  assert.strictEqual(asr.clock(412), '6:52');
}

async function translator() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-'));
  const cloud = fakeCloud();
  const tr = new T.Translator({ dir, sessionFor: () => cloud.session, cloud: cloud.login, retryMs: 1, random: () => 0 });
  const calls = () => cloud.calls.filter((c) => c.route === 'ai/transcribe');
  // 没登录团队：不发请求
  cloud.logout();
  let r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.kind, r.error, cloud.calls.length], ['auth', '先登录团队才能翻译', 0]);
  assert(!('providerId' in r));
  cloud.loginAgain();
  // 40 秒切成几段：分别请求，文字拼起来；每段带自己的真实时长
  const n40 = asr.splitPcm(tone(40)).length;
  assert(n40 >= 3, `40 秒至少 3 段：${n40}`);
  const words = Array.from({ length: n40 }, (_, i) => `w${i}`);
  cloud.next(...words.map((w) => ({ status: 200, body: { ok: true, text: ` ${w} ` } })));
  r = await tr.transcribe(tone(40));
  assert.deepStrictEqual(r, { text: words.join(' '), seconds: 40 });
  assert.strictEqual(calls().length, n40);
  const c0 = calls()[0];
  assert.strictEqual(c0.url, 'https://cloud.example/api/device/ai/transcribe');
  assert.strictEqual(c0.opt.headers.Authorization, 'Bearer device-token-123');
  assert.deepStrictEqual(Object.keys(c0.body).sort(), ['audio', 'seconds', 'v']);
  assert.strictEqual(Buffer.from(c0.body.audio, 'base64').toString('ascii', 0, 4), 'RIFF', '发的是 base64 的 wav');
  const secs = calls().map((c) => c.body.seconds);
  assert(secs.every((x) => x > 0 && x <= 15), JSON.stringify(secs));
  assert(Math.abs(secs.reduce((a, b) => a + b, 0) - 40) < 0.05, `各段时长加起来是 40 秒：${secs}`);
  cloud.reset();
  r = await tr.transcribe(tone(2.5));
  assert.strictEqual(calls()[0].body.seconds, 2.5, '时长可以带小数');
  // 额度用完：不重试
  cloud.reset(); cloud.next({ status: 402, error: 'over_budget' });
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.kind, r.error, calls().length], ['quota', '本月翻译额度用完了，请找管理员', 1]);
  // 太忙：重试，第二次成功
  cloud.reset(); cloud.next({ status: 429, error: 'rate_limited', extra: { retry_after_s: 0.01 } }, { status: 200, body: { ok: true, text: 'Danke' } });
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.text, calls().length], ['Danke', 2]);
  // 来财的语音服务今天用不了（503 no_ai）：不重试，说一句
  cloud.reset(); cloud.next({ status: 503, error: 'no_ai', extra: { retry_after_s: 60 } });
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.error, calls().length], ['语音转文字暂时用不了，请稍后再试', 1]);
  cloud.reset(); cloud.next({ status: 502, error: 'asr_failed' });
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.kind, r.error], ['server', '语音转文字失败，请稍后再试']);
  // 登录失效
  cloud.reset(); cloud.next({ status: 401, error: 'login_required' });
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.kind, r.error], ['auth', '团队登录失效，请重新登录']);
  assert(!JSON.stringify(r).includes('device-token'), '报错里不带令牌');
  // 网络断了：这一段就地重试一次，还断才算失败
  cloud.reset(); cloud.next('net', 'net');
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.kind, cloud.calls.length], ['network', 2]);
  cloud.reset(); cloud.next('net', { status: 200, body: { ok: true, text: 'Danke' } });
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.text, cloud.calls.length], ['Danke', 2], '断一次重试一次就好');
  // 长语音中间一段断了：只重发这一段，前面转好的不再用额度
  cloud.reset(); cloud.next({ status: 200, body: { ok: true, text: 'Hello, is the wig' } }, 'net', { status: 200, body: { ok: true, text: 'still available?' } });
  r = await tr.transcribe(tone(20));
  assert.deepStrictEqual([r.text, cloud.calls.length], ['Hello, is the wig still available?', 3]);
  // 每一段各有一次重试机会，不是整条语音只有一次
  cloud.reset(); cloud.next('net', { status: 200, body: { ok: true, text: 'Hello' } }, 'net', { status: 200, body: { ok: true, text: 'again' } });
  r = await tr.transcribe(tone(20));
  assert.deepStrictEqual([r.text, cloud.calls.length], ['Hello again', 4]);
  // 没听出话（来财回 text 空）
  cloud.reset(); cloud.next({ status: 200, body: { ok: true, text: '' } });
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.kind, r.error], ['empty', '没听出说的话']);
  r = await tr.transcribe(new Int16Array(0));
  assert.strictEqual(r.kind, 'input');
  // 不占翻译通道
  assert.strictEqual(tr.busy, null);
}

const tick = () => new Promise((r) => setTimeout(r, 10));
async function settle(core) { for (let i = 0; i < 50 && (core.running || core.queue.length || core.vrunning || core.vq.length); i += 1) await tick(); }

function liteView(jid, messages) {
  return { jid, title: 'Sophie Martin', chats: [{ jid, name: 'Sophie Martin' }], messages };
}

async function floatFlow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-fc-'));
  const jid = '33612345678@s.whatsapp.net';
  const heard = [];
  const translated = [];
  let answer = (src) => ({ text: `Bonjour ${src.id}` });
  const mk = (store) => new FloatCore({
    store,
    transcribe: async (acc, src) => { heard.push(src.id); return answer(src); },
    translate: async (text) => { translated.push(text); return { text: `中:${text}`, warn: [] }; },
  });
  let store = new TrStore(dir);
  let core = mk(store);
  const now = Math.floor(Date.now() / 1000);
  const msgs = [
    { id: 'T1', me: false, ts: now - 50, text: 'Hi there' },
    { id: 'V1', me: false, ts: now - 40, text: '[语音]', voice: 23 },
    { id: 'V2', me: true, ts: now - 30, text: '[语音]', voice: 5 }, // 自己发的语音：不显示
    { id: 'V3', me: false, ts: now - 20, text: '[语音]', voice: VOICE_MAX_S + 1 }, // 太长：不自动转
  ];
  let read = fromLite(liteView(jid, msgs), jid);
  assert.strictEqual(read.ok, true);
  assert.deepStrictEqual(read.msgs.map((m) => [m.out, m.text, m.voice ?? null]), [[false, 'Hi there', null], [false, '', 23], [false, '', VOICE_MAX_S + 1]]);
  assert.deepStrictEqual(read.msgs[1].src, { jid, id: 'V1' });
  // 没开自动：语音只给「转文字」按钮，不转、不花钱
  core.ingest('a1', read, { auto: false, dailyCap: 100 });
  await settle(core);
  let v = core.viewOf('a1');
  assert.deepStrictEqual(v.items.map((it) => [it.state, it.voice]), [['manual', null], ['manual', 23], ['manual', VOICE_MAX_S + 1]]);
  assert(!JSON.stringify(v).includes('V1') && !JSON.stringify(v).includes(jid), '界面拿不到消息编号和号码');
  assert.strictEqual(heard.length, 0);
  // 点「转文字」：先转再翻，存起来
  const hV1 = v.items[1].h;
  assert.strictEqual(core.manual('a1', hV1), true);
  await settle(core);
  v = core.viewOf('a1');
  assert.deepStrictEqual([v.items[1].state, v.items[1].text, v.items[1].tr], ['done', 'Bonjour V1', '中:Bonjour V1']);
  assert.deepStrictEqual(heard, ['V1']);
  store.flush();
  // 重启后打开同一个对话：直接显示转好的文字和译文，不再转
  store = new TrStore(dir);
  core = mk(store);
  core.ingest('a1', read, { auto: true, dailyCap: 100 });
  await settle(core);
  v = core.viewOf('a1');
  assert.deepStrictEqual(heard, ['V1'], '转过的不再转');
  assert.deepStrictEqual([v.items[1].state, v.items[1].text, v.items[1].voice], ['done', 'Bonjour V1', 23]);
  assert.strictEqual(v.items[2].note, 'long', '超过 5 分钟不自动转');
  assert.strictEqual(v.items[2].state, 'manual');
  // 存的键是 voice:+方向和消息编号（不带对话编号）
  const ck = core.accs.get('a1').items.get(hV1).ck;
  assert(store.getKey('a1', ck, textKey(`voice:${msgKey(`false_${jid.replace(/_/g, '')}_V1`)}`)), '按 voice:+消息编号 存');
  // 开着自动：新来的语音自动转、翻，算一条自动翻译额度
  const before = core.accs.get('a1').day.n;
  msgs.push({ id: 'V4', me: false, ts: now - 5, text: '[语音]', voice: 7 });
  read = fromLite(liteView(jid, msgs), jid);
  core.ingest('a1', read, { auto: true, dailyCap: 100 });
  await settle(core);
  v = core.viewOf('a1');
  assert.deepStrictEqual(heard, ['V1', 'V4']);
  assert.strictEqual(v.items[3].tr, '中:Bonjour V4');
  assert.strictEqual(core.accs.get('a1').day.n, before + 1);
  // 转文字失败：报错，点重试再转
  answer = () => ({ error: '本月翻译额度用完了，请找管理员', kind: 'quota' });
  msgs.push({ id: 'V5', me: false, ts: now - 2, text: '[语音]', voice: 3 });
  core.ingest('a1', fromLite(liteView(jid, msgs), jid), { auto: true, dailyCap: 100 });
  await settle(core);
  v = core.viewOf('a1');
  const last = v.items[v.items.length - 1];
  assert.deepStrictEqual([last.state, last.err, last.text], ['error', '本月翻译额度用完了，请找管理员', '']);
  answer = () => ({ text: 'Merci' });
  assert.strictEqual(core.manual('a1', last.h), true);
  await settle(core);
  assert.strictEqual(core.viewOf('a1').items.find((it) => it.h === last.h).tr, '中:Merci');
  // 没登录团队：报错（没有「去填密钥」），登录后自动重转
  answer = () => ({ error: '先登录团队才能翻译', kind: 'auth' });
  msgs.push({ id: 'V6', me: false, ts: now - 1, text: '[语音]', voice: 3 });
  core.ingest('a1', fromLite(liteView(jid, msgs), jid), { auto: true, dailyCap: 100 });
  await settle(core);
  let v6 = core.viewOf('a1').items.find((it) => it.voice === 3 && it.state === 'error');
  assert.strictEqual(v6.err, '先登录团队才能翻译');
  assert(!('errPid' in v6), '没有服务商可填');
  answer = () => ({ text: 'Ciao' });
  assert.deepStrictEqual(core.retryKeyErrors({ dailyCap: 100, kinds: ['auth', 'config'], match: () => true }), ['a1']);
  await settle(core);
  v6 = core.viewOf('a1').items.find((it) => it.h === v6.h);
  assert.strictEqual(v6.tr, '中:Ciao');
  // 只听出数字、表情：不翻，转出来的当译文显示
  answer = () => ({ text: '123 456' });
  msgs.push({ id: 'V7', me: false, ts: now, text: '[语音]', voice: 2 });
  core.ingest('a1', fromLite(liteView(jid, msgs), jid), { auto: true, dailyCap: 100 });
  await settle(core);
  const v7 = core.viewOf('a1').items.slice(-1)[0];
  assert.deepStrictEqual([v7.state, v7.text], ['skip', '123 456']);
  return translated.length;
}

// 打开对话时：最近 5 条里的语音照常自动转；更早的语音不在后台补（要花钱），文字照常补
async function backfill() {
  const jid = '491701234567@s.whatsapp.net';
  const heard = [];
  const slow = [];
  const core = new FloatCore({
    transcribe: async (acc, src) => { heard.push(src.id); return { text: `Hallo ${src.id}` }; },
    translate: async (text, o) => { if (o.slow) slow.push(text); return { text: `中:${text}`, warn: [] }; },
  });
  const now = Math.floor(Date.now() / 1000);
  const msgs = [];
  for (let i = 0; i < 12; i += 1) msgs.push(i % 2 ? { id: `V${i}`, me: false, ts: now - 100 + i, text: '[语音]', voice: 4 } : { id: `T${i}`, me: false, ts: now - 100 + i, text: `Text ${i}` });
  core.ingest('a1', fromLite(liteView(jid, msgs), jid), { auto: true, dailyCap: 100 });
  await settle(core);
  assert.deepStrictEqual(heard.sort(), ['V11', 'V7', 'V9'], `只转最近 5 条里的语音：${heard}`);
  assert(slow.length > 0 && slow.every((t) => t.startsWith('Text')), '后台补的只有文字');
  const v = core.viewOf('a1');
  assert.strictEqual(v.items.find((it) => it.voice === 4 && it.state === 'manual') !== undefined, true, '更早的语音留着「转文字」按钮');
}

// 转写付过钱就存：翻译失败、没听出话，重启后都不再转（Fable 审计 #254 建议 1、2）
async function heardKept() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-heard-'));
  const jid = '34612345678@s.whatsapp.net';
  const heard = [];
  let trOk = false;
  const mk = (store) => new FloatCore({
    store,
    retryMs: [], // 翻译失败不自动重翻，直接看报错
    transcribe: async (acc, src) => { heard.push(src.id); return src.id === 'E1' ? { error: '没听出说的话', kind: 'empty' } : { text: 'Hola, ¿tienen pelucas rubias?' }; },
    translate: async (text) => (trOk ? { text: `中:${text}`, warn: [] } : { error: '网络不通', kind: 'network' }),
  });
  const now = Math.floor(Date.now() / 1000);
  const msgs = [{ id: 'S1', me: false, ts: now - 2, text: '[语音]', voice: 6 }, { id: 'E1', me: false, ts: now - 1, text: '[语音]', voice: 2 }];
  const read = fromLite(liteView(jid, msgs), jid);
  let store = new TrStore(dir);
  let core = mk(store);
  core.ingest('a1', read, { auto: true, dailyCap: 100 });
  await settle(core);
  let v = core.viewOf('a1');
  assert.deepStrictEqual(v.items.map((it) => [it.state, it.text]), [['error', 'Hola, ¿tienen pelucas rubias?'], ['error', '']]);
  assert.deepStrictEqual(heard.sort(), ['E1', 'S1']);
  store.flush();
  // 重启：转过的直接拿文字去翻，没听出话的显示原因，都不再转
  trOk = true;
  store = new TrStore(dir);
  core = mk(store);
  core.ingest('a1', read, { auto: true, dailyCap: 100 });
  await settle(core);
  v = core.viewOf('a1');
  assert.deepStrictEqual(heard.sort(), ['E1', 'S1'], '重启后不再转');
  assert.deepStrictEqual(v.items.map((it) => [it.state, it.tr, it.err]), [['done', '中:Hola, ¿tienen pelucas rubias?', ''], ['error', '', '没听出说的话']]);
  // 翻好后记录换成正常译文
  const it = core.accs.get('a1').items.get(v.items[0].h);
  assert.strictEqual(store.getKey('a1', it.ck, it.k).tr, '中:Hola, ¿tienen pelucas rubias?');
  // 用户点「重试」才再转
  assert.strictEqual(core.manual('a1', v.items[1].h), true);
  await settle(core);
  assert.strictEqual(heard.length, 3);
}

// 网页号：readOpenChat 读出来的样子（语音没有文字，voice 是 0）
async function webFlow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-web-'));
  const chat = '4930111222@c.us';
  const id = (k) => `false_${chat}_${k}`;
  const at = Date.now();
  const m = (k, x = {}) => ({ id: id(k), out: false, text: '', voice: 0, t: { h: 10, mi: 1, at: at + Number(String(k).replace(/\D/g, '')) }, ...x });
  const text = (k, t) => ({ id: id(k), out: false, text: t, t: { h: 10, mi: 2, at: at + Number(String(k).replace(/\D/g, '')) } });
  const calls = [];
  const translated = [];
  let answer = () => ({ text: 'Guten Tag, ist die Perücke noch da?', seconds: 23 });
  let gate = null;
  const mk = (store) => new FloatCore({
    store,
    transcribe: async (acc, src, sec, opts) => { calls.push({ src, opts }); if (gate) await gate; return answer(src, opts); },
    translate: async (t) => { translated.push(t); return { text: `中:${t}`, warn: [] }; },
  });
  let store = new TrStore(dir);
  let core = mk(store);
  const msgs = [text('T1', 'Hello'), m('V2')];
  core.ingest('w', { title: 'Emma Schmidt', msgs }, { auto: true, dailyCap: 100 });
  await settle(core);
  let v = core.viewOf('w');
  assert.deepStrictEqual(calls.map((c) => [c.src.dataId, c.opts.auto]), [[id('V2'), true]], '按 data-id 自动去拿');
  assert.deepStrictEqual([v.items[1].state, v.items[1].voice, v.items[1].text, v.items[1].tr], ['done', 23, 'Guten Tag, ist die Perücke noch da?', '中:Guten Tag, ist die Perücke noch da?'], '时长回填、转写后翻译');
  assert(!JSON.stringify(v).includes(chat), '界面拿不到 data-id 和号码');
  const ck = core.accs.get('w').items.get(v.items[1].h).ck;
  assert(store.getKey('w', ck, textKey(`voice:${msgKey(id('V2'))}`)), '按 voice:+方向和消息编号 存');
  core.ingest('w', { title: 'Emma Schmidt', msgs }, { auto: true, dailyCap: 100 }); // 再读一次：记下时长
  store.flush();
  // 重启再打开：不再转，时长用存下的
  store = new TrStore(dir);
  core = mk(store);
  core.ingest('w', { title: 'Emma Schmidt', msgs }, { auto: true, dailyCap: 100 });
  await settle(core);
  v = core.viewOf('w');
  assert.strictEqual(calls.length, 1, '重开不再转');
  assert.deepStrictEqual([v.items[1].state, v.items[1].voice], ['done', 23]);
  // 自动翻译关着：只给「转文字」按钮
  const off = mk(new TrStore(fs.mkdtempSync(path.join(os.tmpdir(), 'asr-web-off-'))));
  off.ingest('w', { title: 'Emma Schmidt', msgs: [m('V3')] }, { auto: false, dailyCap: 100 });
  await settle(off);
  assert.deepStrictEqual([off.viewOf('w').items[0].state, off.viewOf('w').items[0].voice, calls.length], ['manual', 0, 1]);
  // 连续 3 条读不到：报原因和代码，之后新来的不再自动读
  answer = () => ({ error: '读不到这条语音，请在 WhatsApp 里听', kind: 'nomedia', code: 'W2 no_media_fields' });
  for (let i = 0; i < VOICE_TRIP; i += 1) {
    msgs.push(m(`V${10 + i}`));
    core.ingest('w', { title: 'Emma Schmidt', msgs }, { auto: true, dailyCap: 100 });
    await settle(core);
  }
  v = core.viewOf('w');
  const bad = v.items.filter((it) => it.state === 'error');
  assert.strictEqual(bad.length, VOICE_TRIP);
  assert(bad.every((it) => it.err.includes('读不到') && it.code === 'W2 no_media_fields'), JSON.stringify(bad));
  const before = calls.length;
  msgs.push(m('V20'));
  core.ingest('w', { title: 'Emma Schmidt', msgs }, { auto: true, dailyCap: 100 });
  await settle(core);
  v = core.viewOf('w');
  assert.strictEqual(calls.length, before, '熔断后不再自动去读');
  const v20 = v.items[v.items.length - 1];
  assert.strictEqual(v20.state, 'manual');
  // 用户点「转文字」照常去读；读成功一次就恢复自动
  answer = () => ({ text: 'Merci', seconds: 4 });
  assert.strictEqual(core.manual('w', v20.h), true);
  await settle(core);
  assert.strictEqual(calls[calls.length - 1].opts.auto, false);
  assert.strictEqual(core.viewOf('w').items.find((it) => it.h === v20.h).state, 'done');
  msgs.push(m('V21'));
  core.ingest('w', { title: 'Emma Schmidt', msgs }, { auto: true, dailyCap: 100 });
  await settle(core);
  assert.strictEqual(calls.length, before + 2, '恢复自动');
  // 单条文件不对（钥匙、格式）不算存储改版：不熔断
  answer = () => ({ error: '读不到这条语音，请在 WhatsApp 里听', kind: 'badfile', code: 'W2 not_ogg' });
  for (let i = 0; i < VOICE_TRIP; i += 1) {
    msgs.push(m(`V${30 + i}`));
    core.ingest('w', { title: 'Emma Schmidt', msgs }, { auto: true, dailyCap: 100 });
    await settle(core);
  }
  assert.strictEqual(core.accs.get('w').voiceFails, 0, '单条文件不对不计入熔断');
  // 页面正在加载：退回按钮，不报错，退额度
  answer = () => ({ kind: 'later' });
  const n1 = core.accs.get('w').day.n;
  msgs.push(m('V40'));
  core.ingest('w', { title: 'Emma Schmidt', msgs }, { auto: true, dailyCap: 100 });
  await settle(core);
  const v40 = core.viewOf('w').items.at(-1);
  assert.deepStrictEqual([v40.state, v40.err, core.accs.get('w').day.n], ['manual', '', n1]);
  // 页面重新加载也恢复
  core.accs.get('w').voiceFails = VOICE_TRIP;
  core.voiceReset('w');
  assert.strictEqual(core.accs.get('w').voiceFails, 0);
  // 自动转时才知道超过 5 分钟：不下载，退回按钮，退回额度
  answer = () => ({ kind: 'long', seconds: VOICE_MAX_S + 100 });
  const n0 = core.accs.get('w').day.n;
  msgs.push(m('V22'));
  core.ingest('w', { title: 'Emma Schmidt', msgs }, { auto: true, dailyCap: 100 });
  await settle(core);
  const v22 = core.viewOf('w').items.at(-1);
  assert.deepStrictEqual([v22.state, v22.note, v22.voice], ['manual', 'long', VOICE_MAX_S + 100]);
  assert.strictEqual(core.accs.get('w').day.n, n0, '退回额度');
  // 一条慢语音：转的时候新来的文字照常翻
  answer = () => ({ text: 'Danke', seconds: 180 });
  let open;
  gate = new Promise((r) => { open = r; });
  msgs.push(m('V23'));
  core.ingest('w', { title: 'Emma Schmidt', msgs }, { auto: true, dailyCap: 100 });
  for (let i = 0; i < 5; i += 1) await tick();
  msgs.push(text('T24', 'Do you ship to Berlin?'));
  core.ingest('w', { title: 'Emma Schmidt', msgs }, { auto: true, dailyCap: 100 });
  for (let i = 0; i < 20 && !translated.includes('Do you ship to Berlin?'); i += 1) await tick();
  assert(translated.includes('Do you ship to Berlin?'), '文字没被语音挡住');
  assert.strictEqual(core.viewOf('w').items.find((it) => it.voice === 0 && it.state === 'running') !== undefined, true, '语音还在转');
  gate = null;
  open();
  await settle(core);
  assert(translated.includes('Danke'));
}

// 网页号、新版页面（2026-10 起）：页面上的编号只有消息自己的编号（raw，一串十六进制），读页面时补成 false_chat:<标题>_<编号>。
// 去 WhatsApp 存储里找语音要用 raw，不能用补出来的那条（存储里没有这种编号，一定找不到，连着 3 条还会停掉自动转写）
async function webNewIds() {
  const KEY = '3A5F0C2B9D8E7F6A1B2C3D4E5F6A7B8C';
  const calls = [];
  const core = new FloatCore({
    store: new TrStore(fs.mkdtempSync(path.join(os.tmpdir(), 'asr-web-raw-'))),
    transcribe: async (acc, src) => { calls.push(src); return { text: 'Hallo, ist die Farbe C noch da?', seconds: 11 }; },
    translate: async (t) => ({ text: `中:${t}`, warn: [] }),
  });
  const msgs = [
    { id: 'false_chat:Emma Schneider_0123456789ABCDEF0123456789ABCDEF', out: false, text: 'Guten Morgen!', t: null, raw: '0123456789ABCDEF0123456789ABCDEF' },
    { id: `false_chat:Emma Schneider_${KEY}`, out: false, text: '', voice: 0, t: null, raw: KEY },
  ];
  core.ingest('w', { title: 'Emma Schneider', msgs }, { auto: true, dailyCap: 100 });
  await settle(core);
  assert.deepStrictEqual(calls.map((c) => c.dataId), [KEY], '按页面上的编号去找语音');
  const v = core.viewOf('w');
  assert.deepStrictEqual([v.items[1].state, v.items[1].voice, v.items[1].tr], ['done', 11, '中:Hallo, ist die Farbe C noch da?'], '转写后翻译');
}

(async () => {
  splitting();
  await translator();
  const n = await floatFlow();
  await backfill();
  await heardKept();
  await webFlow();
  await webNewIds();
  console.log(`语音转文字自检通过（切段、wav、来财请求和报错、转写后翻译 ${n} 次、存记录不重转、转了没翻成也不重转、额度、重试、补翻、网页号语音）`);
})().catch((e) => { console.error(e); process.exit(1); });
