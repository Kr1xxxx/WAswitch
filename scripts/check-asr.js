// 语音转文字自检（不发真实请求）：
// 1) asr.js：切段（每段 ≤ 28 秒，切在安静处，最多 5 分钟）、wav 头、multipart
// 2) Translator.transcribe：用智谱密钥、分段请求拼起来；余额不足（1113）、没密钥、密钥错、太忙重试、没听出话
// 3) FloatCore：轻量号语音行显示、自动转写后翻译、按「voice:+消息编号」存（重开不再转）、没开自动只给按钮、失败可重试、
//    超过 5 分钟不自动转、更早的语音不在后台补、自己发的语音不显示
// 用法：node scripts/check-asr.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const asr = require('../src/asr');
const T = require('../src/translate');
const { FloatCore, fromLite, VOICE_MAX_S } = require('../src/floatcore');
const { TrStore, textKey } = require('../src/trstore');

const R = asr.RATE;
const tone = (sec, amp = 4000) => { const a = new Int16Array(Math.round(sec * R)); for (let i = 0; i < a.length; i += 1) a[i] = Math.round(amp * Math.sin(i / 7)); return a; };

function splitting() {
  assert.deepStrictEqual(asr.splitPcm(tone(10)).map((c) => c.length), [10 * R]);
  // 60 秒，在 24 秒处有 200 毫秒的安静：第一刀切在安静处
  const a = tone(60);
  a.fill(0, 24 * R, 24.2 * R);
  const parts = asr.splitPcm(a);
  assert(parts.every((c) => c.length <= asr.CHUNK_MAX_S * R), '每段不超过 28 秒');
  assert(Math.abs(parts[0].length / R - 24.1) < 0.11, `切在安静处：${parts[0].length / R}`);
  assert.strictEqual(parts.reduce((n, c) => n + c.length, 0), a.length, '切完一样长');
  // 28.5 秒：最后半秒并进去，不单独发一段
  assert.deepStrictEqual(asr.splitPcm(tone(28.5)).map((c) => c.length), [28.5 * R]);
  // 超过 5 分钟只转前 5 分钟
  const long = asr.splitPcm(tone(400, 100));
  assert.strictEqual(long.reduce((n, c) => n + c.length, 0), asr.MAX_SECONDS * R);
  assert(long.length <= Math.ceil(asr.MAX_SECONDS / 23), `最多 ${long.length} 段`); // 每段至少 23 秒
  const wav = asr.wavOf(new Int16Array([1, -1, 2]));
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.readUInt32LE(24), R);
  assert.strictEqual(wav.readUInt32LE(40), 6);
  assert.strictEqual(wav.length, 50);
  const f = asr.formOf(wav);
  const s = f.body.toString('latin1');
  assert(/^multipart\/form-data; boundary=/.test(f.type));
  assert(s.includes('name="model"\r\n\r\nglm-asr-2512') && s.includes('filename="voice.wav"') && s.includes('Content-Type: audio/wav'));
  assert.strictEqual(asr.clock(23), '0:23');
  assert.strictEqual(asr.clock(412), '6:52');
}

async function translator() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-'));
  const ss = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(`E${t}`), decryptString: (b) => b.toString().slice(1) };
  const calls = [];
  let behave = [];
  const fake = { fetch: async (url, opt) => {
    calls.push({ url, opt });
    const b = behave.shift() || {};
    if (b === 'net') throw new Error('net::ERR_CONNECTION_RESET');
    const st = b.status || 200;
    return { ok: st < 300, status: st, body: null, headers: { get: () => null }, text: async () => (b.body !== undefined ? b.body : JSON.stringify({ text: 'Hello' })) };
  } };
  const tr = new T.Translator({ seed: false, dir, safeStorage: ss, sessionFor: () => fake, retryMs: 1, random: () => 0 });
  let r = await tr.transcribe(tone(2));
  assert.strictEqual(r.kind, 'config', '没有智谱：提示先添加');
  const zp = tr.saveProvider({ preset: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' });
  assert(zp.ok);
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.kind, r.providerId, r.error], ['auth', zp.id, '智谱还没填密钥']);
  assert.strictEqual(calls.length, 0, '没密钥不发请求');
  tr.saveProvider({ id: zp.id, preset: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', key: 'zp-key-123456' });
  // 两段：分别请求，文字拼起来
  behave = [{ body: JSON.stringify({ text: 'Hello, is the wig' }) }, { body: JSON.stringify({ text: ' still available?' }) }];
  r = await tr.transcribe(tone(40));
  assert.deepStrictEqual(r, { text: 'Hello, is the wig still available?', seconds: 40 });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions');
  assert.strictEqual(calls[0].opt.headers.Authorization, 'Bearer zp-key-123456');
  assert(calls[0].opt.body instanceof Uint8Array && /boundary=/.test(calls[0].opt.headers['Content-Type']), '发的是 multipart');
  // 余额不足：智谱 1113 是 HTTP 429，不重试
  calls.length = 0;
  behave = [{ status: 429, body: '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}' }];
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.kind, r.error, calls.length], ['quota', '智谱余额不足，语音转文字要先充值', 1]);
  // 太忙：重试，第二次成功
  calls.length = 0;
  behave = [{ status: 429, body: '{"error":{"code":"1302","message":"rate limit"}}' }, { body: '{"text":"Danke"}' }];
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.text, calls.length], ['Danke', 2]);
  // 密钥错：带上服务商，界面给「去填密钥」
  behave = [{ status: 401, body: '{"error":{"message":"invalid key zp-key-123456"}}' }];
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.kind, r.providerId], ['auth', zp.id]);
  assert(!JSON.stringify(r).includes('zp-key-123456'), '报错里不带密钥');
  // 网络断了
  behave = ['net'];
  r = await tr.transcribe(tone(2));
  assert.strictEqual(r.kind, 'network');
  // 没听出话
  behave = [{ body: '{"text":"  "}' }];
  r = await tr.transcribe(tone(2));
  assert.deepStrictEqual([r.kind, r.error], ['empty', '没听出说的话']);
  r = await tr.transcribe(new Int16Array(0));
  assert.strictEqual(r.kind, 'input');
  // 不占翻译通道
  assert.strictEqual(tr.busy, null);
}

const tick = () => new Promise((r) => setTimeout(r, 10));
async function settle(core) { for (let i = 0; i < 50 && (core.running || core.queue.length); i += 1) await tick(); }

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
    slowGap: 1,
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
  // 存的键是 voice:+消息编号
  const ck = core.accs.get('a1').items.get(hV1).ck;
  assert(store.getKey('a1', ck, textKey(`voice:false_${jid.replace(/_/g, '')}_V1`)), '按 voice:+消息编号 存');
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
  answer = () => ({ error: '智谱余额不足，语音转文字要先充值', kind: 'quota' });
  msgs.push({ id: 'V5', me: false, ts: now - 2, text: '[语音]', voice: 3 });
  core.ingest('a1', fromLite(liteView(jid, msgs), jid), { auto: true, dailyCap: 100 });
  await settle(core);
  v = core.viewOf('a1');
  const last = v.items[v.items.length - 1];
  assert.deepStrictEqual([last.state, last.err, last.text], ['error', '智谱余额不足，语音转文字要先充值', '']);
  answer = () => ({ text: 'Merci' });
  assert.strictEqual(core.manual('a1', last.h), true);
  await settle(core);
  assert.strictEqual(core.viewOf('a1').items.find((it) => it.h === last.h).tr, '中:Merci');
  // 没填智谱密钥：报错带服务商，填好密钥后自动重转
  answer = () => ({ error: '智谱还没填密钥', kind: 'auth', providerId: 'zp' });
  msgs.push({ id: 'V6', me: false, ts: now - 1, text: '[语音]', voice: 3 });
  core.ingest('a1', fromLite(liteView(jid, msgs), jid), { auto: true, dailyCap: 100 });
  await settle(core);
  let v6 = core.viewOf('a1').items.find((it) => it.voice === 3 && it.state === 'error');
  assert.strictEqual(v6.errPid, 'zp');
  answer = () => ({ text: 'Ciao' });
  assert.deepStrictEqual(core.retryKeyErrors({ dailyCap: 100 }), ['a1']);
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
    slowGap: 1,
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

(async () => {
  splitting();
  await translator();
  const n = await floatFlow();
  await backfill();
  await heardKept();
  console.log(`语音转文字自检通过（切段、wav、智谱请求和报错、转写后翻译 ${n} 次、存记录不重转、转了没翻成也不重转、额度、重试、补翻）`);
})().catch((e) => { console.error(e); process.exit(1); });
