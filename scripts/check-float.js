// 悬浮翻译自检：自动翻译的取舍（只翻收到的、切对话只补最近 5 条、每分钟 20 条、每天上限、太长不自动翻）、
// 对外不出现 data-id、删号清缓存；再用 Electron 打开一个仿 WhatsApp 的页面，检查只读脚本读到的内容。
// 不连网络，不发真实请求。
const assert = require('assert');
const { FloatCore, fromLite, hashOf, msgHash } = require('../src/floatcore');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 消息编号带上对话（真 WhatsApp 的消息编号各不相同；按消息编号认消息，不同对话不能撞号）
const msg = (n, out = false, chat = '111@c.us', text = `hola ${n}`) => ({ id: `${out}_${chat}_ID${chat.replace(/\W/g, '')}N${n}`, out, text });

async function core() {
  let now = Date.parse('2026-10-24T10:00:00Z');
  const sent = [];
  // 没有免费服务商（智谱、混元都没填密钥）：更早的消息不在后台补翻
  const fc = new FloatCore({ now: () => now, slowGap: 0, translate: async (text, o = {}) => { if (o.slow) return { error: '没有免费的翻译服务', kind: 'nofree' }; sent.push(text); return { text: `译:${text}`, warn: [] }; } });
  // 第一次看到一个对话：12 条收到的，只自动翻最后 5 条
  const first = Array.from({ length: 12 }, (_, i) => msg(i));
  first.push(msg(99, true)); // 自己发的不翻
  fc.ingest('A', { title: 'Carlos', msgs: first }, { auto: true, dailyCap: 500 });
  await sleep(20);
  assert.deepStrictEqual(sent, ['hola 7', 'hola 8', 'hola 9', 'hola 10', 'hola 11']);
  const v = fc.viewOf('A');
  assert.strictEqual(v.items.length, 12);
  assert(!JSON.stringify(v).includes('c.us'), '悬浮窗拿到的数据里不能有 data-id');
  assert.strictEqual(v.items[0].state, 'manual');
  // 记客户语言用的对话 hash：固定、不含号码
  assert.match(v.chatKey, /^[0-9a-f]{16}$/);
  assert.strictEqual(fc.viewOf('A').chatKey, v.chatKey);
  // 上下文：这条之前的几条（双方都有）；手动改的译文保留，纠错结果只当建议
  const ctxMsgs = [msg(1, false, '333@c.us'), msg(2, true, '333@c.us'), msg(3, false, '333@c.us')];
  fc.ingest('C', { title: 'c', msgs: ctxMsgs }, { auto: false, dailyCap: 500 });
  assert.deepStrictEqual(fc.contextOf('C', msgHash('C', ctxMsgs[2].id)).map((m) => m.out), [false, true]);
  assert.strictEqual(fc.contextOf('C').length, 3);
  const hc = msgHash('C', ctxMsgs[2].id);
  assert(fc.edit('C', hc, '我改的'));
  assert(fc.manual('C', hc, true));
  await sleep(20);
  const ci = fc.viewOf('C').items.find((x) => x.h === hc);
  assert.strictEqual(ci.tr, '我改的');
  assert.strictEqual(ci.suggest, '译:hola 3');
  assert(fc.suggestion('C', hc, true));
  assert.strictEqual(fc.viewOf('C').items.find((x) => x.h === hc).tr, '译:hola 3');
  // 消息时间（页面上写的几点几分）
  fc.ingest('T', { title: 'x', msgs: [{ ...msg(1, false, '222@c.us'), t: { h: 9, mi: 5 } }] }, { auto: false, dailyCap: 500 });
  assert.strictEqual(fc.viewOf('T').items[0].t, '09:05');
  // 同一个对话来了新消息：自动翻
  fc.ingest('A', { title: 'Carlos', msgs: [...first.slice(1), msg(12)] }, { auto: true, dailyCap: 500 });
  await sleep(20);
  assert.strictEqual(sent[sent.length - 1], 'hola 12');
  // 手动翻一条旧的
  assert(fc.manual('A', msgHash('A', first[0].id)));
  await sleep(20);
  assert.strictEqual(sent[sent.length - 1], 'hola 0');
  // 每分钟最多 20 条（已经自动翻了 6 条）：一下来 30 条新消息，只再翻 14 条
  sent.length = 0;
  const burst = Array.from({ length: 20 }, (_, i) => msg(100 + i));
  fc.ingest('A', { title: 'Carlos', msgs: burst }, { auto: true, dailyCap: 500 });
  await sleep(50);
  // 换了对话编号相同（同一个对话），20 条全新：只翻 14 条
  assert.strictEqual(sent.length, 14, `minute cap: ${sent.length}`);
  assert.strictEqual(fc.viewOf('A').paused, 'minute');
  // 过一分钟，每天上限设成 25：今天已经 20 条，只能再翻 5 条
  now += 61000;
  sent.length = 0;
  const more = Array.from({ length: 10 }, (_, i) => msg(200 + i));
  fc.ingest('A', { title: 'Carlos', msgs: more }, { auto: true, dailyCap: 25 });
  await sleep(50);
  assert.strictEqual(sent.length, 5);
  assert.strictEqual(fc.viewOf('A').paused, 'day');
  // 太长的不自动翻
  now += 24 * 3600 * 1000;
  sent.length = 0;
  fc.ingest('A', { title: 'Carlos', msgs: [msg(300, false, '111@c.us', 'x'.repeat(1500))] }, { auto: true, dailyCap: 500 });
  await sleep(20);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(fc.viewOf('A').items[0].note, 'long');
  // 自动关着：什么都不翻
  fc.ingest('B', { title: 'X', msgs: [msg(1, false, '222@c.us')] }, { auto: false, dailyCap: 500 });
  await sleep(20);
  assert.strictEqual(sent.length, 0);
  // 打开自动后补翻
  fc.backfill('B', { dailyCap: 500 });
  await sleep(20);
  assert.strictEqual(sent.length, 1);
  // 群消息：发给大模型的只有文字
  sent.length = 0;
  fc.ingest('B', { title: 'X', msgs: [msg(1, false, '222@c.us'), { id: 'false_333@g.us_ID5_444@c.us', out: false, text: 'hello group' }] }, { auto: true, dailyCap: 500 });
  await sleep(20);
  assert.deepStrictEqual(sent, ['hello group']);
  // 删号清缓存
  fc.forget('A');
  assert.strictEqual(fc.viewOf('A').items.length, 0);
  console.log('悬浮翻译逻辑自检通过');
  await keyRetry();
  await persisted();
  await noWordsGist();
  await sendNoJump();
  scrollNoBottom();
  await reopenKeepsAll();
  await oldRecordsGetOriginals();
  await catchUpOlder();
  await parallelAuto();
  await lidSwitch();
}

// WhatsApp 把同一个对话的编号从手机号（@c.us）换成隐私编号（@lid）：data-id 中间那段变，消息编号不变。
// 切回、重启都不重翻；草稿和客户语言跟着对话走；老版本按整条 data-id 存的语音、_view 照样用（客户反馈 2026-10-29「切回来怎么又在重新翻译」）
async function lidSwitch() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { TrStore, textKey } = require('../src/trstore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trstore-lid-'));
  const calls = [];
  const heard = [];
  const logs = [];
  const make = () => {
    const store = new TrStore(dir);
    const fc = new FloatCore({ store, slowGap: 30, parallel: () => 3, log: (x) => logs.push(x),
      transcribe: async () => { heard.push(1); return { text: 'Voice words' }; },
      translate: async (text, o = {}) => { calls.push((o.slow ? '慢:' : '') + text); await sleep(5); return { text: `译:${text}` }; } });
    return { store, fc };
  };
  const idle = async (fc) => { for (let i = 0; i < 300 && (fc.running || fc.queue.length || fc.vrunning); i += 1) await sleep(10); };
  const IN = [0, 2, 5, 8, 11, 14, 17, 19];
  const win = (jid) => Array.from({ length: 20 }, (_, i) => { const inc = IN.includes(i); return { id: `${!inc}_${jid}_3EB0${i}`, out: !inc, text: inc ? `Customer ${i}` : `Me ${i}`, t: { h: 10, mi: i, at: 1e12 + i * 60000 } }; });
  const other = [{ id: 'false_999@lid_3EB0X', out: false, text: 'Other chat', t: { h: 11, mi: 0, at: 2e12 } }];
  const opts = { auto: true, dailyCap: 500 };
  const phone = '4915112345678@c.us';
  const lid = '123456789012345@lid';
  const unique = (items) => { assert.strictEqual(new Set(items.map((x) => x.h)).size, items.length, '没有重复的行'); assert.strictEqual(new Set(items.map((x) => x.text)).size, items.length, '没有重复的行'); };
  let { store, fc } = make();
  // 后台慢慢补的还没轮到：显示「翻译」，不显示「翻译中…」
  fc.ingest('W', { title: 'Mia', msgs: win(phone), bottom: true }, opts);
  await sleep(1);
  const st0 = fc.viewOf('W').items.map((x) => x.state);
  assert.deepStrictEqual(st0.slice(0, 3), ['manual', 'manual', 'manual'], '后台排队的看起来没开始');
  assert(st0.slice(3).every((x) => x === 'queued' || x === 'running' || x === 'done'), '最新 5 条照常');
  assert(fc.manual('W', fc.viewOf('W').items[0].h), '点了马上翻');
  await idle(fc);
  assert.strictEqual(calls.length, 8);
  assert(calls.includes('Customer 0') && !calls.includes('慢:Customer 0'), '点的那条不走后台');
  const key0 = fc.viewOf('W').chatKey;
  // 1. 换编号切回：0 次，都是已翻译，没有重复的行
  fc.ingest('W', { title: 'Other', msgs: other, bottom: true }, opts);
  await idle(fc);
  calls.length = 0;
  fc.ingest('W', { title: 'Mia', msgs: win(lid), bottom: true }, opts);
  await idle(fc);
  assert.deepStrictEqual(calls, [], '换编号切回不重翻');
  let items = fc.viewOf('W').items;
  assert.strictEqual(items.length, 8);
  assert(items.every((x) => x.state === 'done'));
  unique(items);
  assert.strictEqual(fc.viewOf('W').chatKey, key0, '草稿、客户语言跟着对话走');
  assert.strictEqual(logs.length, 1, '认出别名时记一行日志');
  assert(!logs[0].includes('@'), '日志里没有编号');
  // 2. 换编号 + 重启（新的 FloatCore 和 TrStore，同一个文件夹）
  store.flush();
  ({ store, fc } = make());
  fc.ingest('W', { title: 'Mia', msgs: win('987654321098765@lid'), bottom: true }, opts);
  await idle(fc);
  assert.deepStrictEqual(calls, [], '重启后换编号也不重翻');
  assert.strictEqual(fc.viewOf('W').items.length, 8);
  assert.strictEqual(fc.viewOf('W').chatKey, key0);
  // 3. 一屏两种编号：客户的 @c.us，自己刚发的 @lid 是最后一条：不算换对话
  ({ store, fc } = make());
  const mixed = win('31612345678@c.us');
  fc.ingest('X', { title: 'Sanne', msgs: mixed, bottom: true }, opts);
  await idle(fc);
  calls.length = 0;
  const keyX = fc.viewOf('X').chatKey;
  const n = fc.viewOf('X').items.length;
  const mine = { id: 'true_99988877766655@lid_3EB0Z', out: true, text: 'Sure', t: { h: 10, mi: 30, at: 1e12 + 30 * 60000 } };
  fc.ingest('X', { title: 'Sanne', msgs: [...mixed.slice(1), mine], bottom: true }, opts);
  assert.strictEqual(fc.viewOf('X').chatKey, keyX);
  assert.strictEqual(fc.viewOf('X').items.length, n, '翻译栏条数不变');
  await idle(fc);
  assert.deepStrictEqual(calls, []);
  // 6. 群：群成员编号变了也是同一条
  fc.ingest('X', { title: 'Team', msgs: [{ id: 'false_120363@g.us_3EBG1_4915112345678@c.us', out: false, text: 'Group hello' }], bottom: true }, opts);
  await idle(fc);
  calls.length = 0;
  fc.ingest('X', { title: 'Team', msgs: [{ id: 'false_120363@g.us_3EBG1_123456789012345@lid', out: false, text: 'Group hello' }], bottom: true }, opts);
  await idle(fc);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(fc.viewOf('X').items.length, 1);
  // 4. 网页号语音：老版本按整条 data-id 存的转写和译文照用，不再转；之后换了编号也认得出
  const vid = 'false_447700900123@c.us_3EBV1';
  const vck = hashOf('V', 'chat|447700900123@c.us');
  store.putKey('V', vck, textKey(`voice:${vid}`), { tr: '语音译文', text: 'Voice words' });
  fc.ingest('V', { title: 'Oliver', msgs: [{ id: vid, out: false, text: '', voice: 12 }], bottom: true }, opts);
  await idle(fc);
  assert.strictEqual(heard.length, 0, '老键的转写照用');
  assert.deepStrictEqual(fc.viewOf('V').items.map((x) => [x.state, x.tr]), [['done', '语音译文']]);
  store.flush();
  ({ store, fc } = make());
  fc.ingest('V', { title: 'Oliver', msgs: [{ id: 'false_555666777888999@lid_3EBV1', out: false, text: '', voice: 12 }], bottom: true }, opts);
  await idle(fc);
  assert.strictEqual(heard.length, 0, '换了编号也不再转');
  assert.deepStrictEqual(fc.viewOf('V').items.map((x) => x.tr), ['语音译文']);
  // 5. 老版本写的 _view（消息 hash 按整条 data-id 算）：升级后打开不出现重复的行
  const ock = hashOf('O', 'chat|33612345678@c.us');
  const old = Array.from({ length: 4 }, (_, i) => ({ id: `false_33612345678@c.us_3EBO${i}`, out: false, text: `Bonjour ${i}` }));
  for (const m of old) store.put('O', ock, m.text, { tr: `存:${m.text}`, text: m.text });
  store.putView('O', ock, old.map((m) => ({ h: hashOf('O', m.id), k: textKey(m.text), t: '' })));
  calls.length = 0;
  fc.ingest('O', { title: 'Camille', msgs: old.slice(2), bottom: true }, opts);
  await idle(fc);
  items = fc.viewOf('O').items;
  assert.deepStrictEqual(items.map((x) => x.text), ['Bonjour 0', 'Bonjour 1', 'Bonjour 2', 'Bonjour 3']);
  assert.deepStrictEqual(calls, []);
  // 8. 别名表和索引只有 hash；索引超过上限删最旧的
  store.flush();
  for (const acc of ['W', 'X', 'V', 'O']) {
    const raw = fs.readFileSync(path.join(dir, acc, '_chats.json'), 'utf8');
    assert(!/@|Customer|Bonjour|Voice|\d{9}/.test(raw), '别名表里没有号码和原文');
  }
  // 先见到的那边还没有译文文件、另一边有：正式的用有文件的（草稿、记住的客户语言在它下面）
  const cOld = hashOf('Y', 'chat|4477@c.us');
  const cNew = hashOf('Y', 'chat|4477@lid');
  store.put('Y', cOld, 'Hi', { tr: '你好' });
  assert(store.link('Y', cNew, cOld));
  assert.strictEqual(store.canon('Y', cNew), cOld);
  for (let i = 0; i < 2100; i += 1) store.markSeen('Z', hashOf('Z', `m${i}`), hashOf('Z', 'chat|x'));
  assert.strictEqual(Object.keys(store.meta('Z').data.seen).length, 2000);
  assert.strictEqual(store.seenChat('Z', hashOf('Z', 'm0')), null, '最旧的先删');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('同一个对话换编号不重翻自检通过');
}

// 2026-10-29 之前存的译文记录没有原文（shen「英文的可以也存吗」）：重启后补回来的旧消息先只有译文；
// 网页号那条消息又读到时补上原文；轻量号按本机聊天缓存在后台补（trfill.js）。只补进已有的记录，翻译栏不多出一条
async function oldRecordsGetOriginals() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { TrStore } = require('../src/trstore');
  const { fillLite } = require('../src/trfill');
  const { textKey } = require('../src/trstore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trstore-orig-'));
  const sent = [];
  let clock = Date.parse('2026-10-29T09:00:00Z');
  const make = () => {
    const store = new TrStore(dir);
    return { store, fc: new FloatCore({ store, now: () => clock, translate: async (text) => { sent.push(text); return { text: `译:${text}`, warn: [] }; } }) };
  };
  // 把记录改成旧格式：去掉原文
  const strip = (acc) => {
    for (const f of fs.readdirSync(path.join(dir, acc))) {
      const file = path.join(dir, acc, f);
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const r of Object.values(data)) if (r && r.tr) delete r.text;
      fs.writeFileSync(file, JSON.stringify(data));
    }
  };
  const opts = { auto: true, dailyCap: 500 };
  const unique = (items) => {
    assert.strictEqual(new Set(items.map((x) => x.h)).size, items.length, '没有重复的消息');
    const texts = items.map((x) => x.text).filter(Boolean);
    assert.strictEqual(new Set(texts).size, texts.length, '同一条原文只出现一次');
  };

  // 网页号：30 条客户消息，读页面只读最后 20 条
  const chat = '447700900456@c.us';
  const conv = Array.from({ length: 30 }, (_, i) => ({ id: `false_${chat}_3EA${i}`, out: false, text: `Hello ${i}`, t: { h: 11, mi: i, at: 1700000000000 + i * 60000 } }));
  const read = (from, to) => ({ title: 'Olivia', bottom: true, msgs: conv.slice(from, to) });
  let { store, fc } = make();
  for (let n = 1; n <= 30; n += 1) { clock += 10000; fc.ingest('W', read(Math.max(0, n - 20), n), opts); await sleep(2); }
  await sleep(30);
  store.flush();
  strip('W');
  sent.length = 0;
  ({ store, fc } = make());
  fc.ingest('W', read(10, 30), opts);
  let items = fc.viewOf('W').items;
  assert.strictEqual(items.length, 30);
  assert.deepStrictEqual(items.slice(0, 10).map((x) => x.text), Array(10).fill(''), '旧记录补回来时只有译文');
  assert.strictEqual(fc.manual('W', items[0].h, true), false, '没有原文的不能纠错');
  assert.deepStrictEqual(sent, [], '旧记录不重翻');
  // 读到的 20 条在磁盘上有译文没原文：读到时就补进记录
  const ck = fc.viewOf('W').chatKey;
  assert.strictEqual(store.missingText('W', ck).size, 10, '读到的 20 条已经补上，更早的 10 条还缺');
  // 用户往下滚回去（或客户的旧消息又出现在最后 20 条里）：补回来的那条补上原文，还是同一条
  fc.ingest('W', { title: 'Olivia', bottom: true, msgs: [...conv.slice(2, 10), ...conv.slice(18, 30)] }, opts);
  items = fc.viewOf('W').items;
  unique(items);
  assert.deepStrictEqual(items.slice(0, 2).map((x) => x.text), ['', ''], '没读到的还缺');
  assert.deepStrictEqual(items.slice(2, 10).map((x) => x.text), conv.slice(2, 10).map((m) => m.text), '读到的补上了原文');
  assert(fc.manual('W', items[2].h, true), '补上原文后能纠错');
  await sleep(20);
  assert.deepStrictEqual(sent, ['Hello 2']);
  assert.strictEqual(store.missingText('W', ck).size, 2);
  assert.strictEqual(store.getKey('W', ck, textKey('Hello 2')).text, 'Hello 2');

  // 轻量号：记录里缺原文的，按聊天缓存（带 [图片] 这种标签的去掉标签再认）在后台补
  const jid = '4915123456789@s.whatsapp.net';
  const lite = [...Array.from({ length: 30 }, (_, i) => (i === 3 ? `[图片] Look at this ${i}` : `Guten Tag ${i}`))];
  const liteView = (n) => ({ jid, title: 'Lukas', messages: lite.slice(0, n).slice(-20).map((text, i, a) => ({ id: `3EB0L${n - a.length + i}`, me: false, ts: 1700000000 + (n - a.length + i) * 60, text })) });
  for (let n = 1; n <= 30; n += 1) { clock += 10000; fc.ingest('L', fromLite(liteView(n), jid), opts); await sleep(2); }
  await sleep(30);
  store.flush();
  strip('L');
  ({ store, fc } = make());
  fc.ingest('L', fromLite(liteView(30), jid), { auto: false, dailyCap: 500 });
  const lck = fc.viewOf('L').chatKey;
  assert.strictEqual(fc.viewOf('L').items.length, 30);
  assert.strictEqual(store.missingText('L', lck).size, 10, '轻量号旧记录：更早的 10 条缺原文');
  const before = fc.viewOf('L').items.map((x) => x.h);
  // 还有一条旧记录，那条消息已经不在缓存里了：补不上
  store.putKey('L', lck, textKey('Gone from cache'), { tr: '已经不在缓存里' });
  const filled = [];
  const asked = [];
  const cache = ['Guten Tag 0', ...lite]; // 同一句出现两次也只补一次
  const runFill = () => fillLite({
    store, accId: 'L', gap: 0, alive: () => true,
    jids: async () => [['111111111@s.whatsapp.net', 1], [jid, cache.length]],
    incoming: async (j) => { asked.push(j); return j === jid ? cache : ['Hi']; },
    onFill: (c, k, text) => { filled.push(text); fc.fillText('L', c, k, text); },
  });
  const n = await runFill();
  assert.strictEqual(n, 10);
  assert.strictEqual(filled.length, 10);
  assert(filled.includes('Look at this 3'), '去掉 [图片] 标签再认');
  assert.deepStrictEqual([...store.missingText('L', lck)], [textKey('Gone from cache')]);
  assert.deepStrictEqual(asked, [jid], '没有译文记录的对话不去要缓存');
  assert.strictEqual(await runFill(), 0);
  assert.deepStrictEqual(asked, [jid], '缓存条数没变：下次启动不再去要');
  cache.push('Gute Nacht');
  assert.strictEqual(await runFill(), 0);
  assert.deepStrictEqual(asked, [jid, jid], '缓存变多了（历史同步晚到）：再补一次');
  items = fc.viewOf('L').items;
  assert.deepStrictEqual(items.map((x) => x.h), before, '补原文不多出、不挪动翻译栏上的消息');
  assert(items.every((x) => x.text), '翻译栏上的也补上了原文');
  unique(items);
  assert.strictEqual(fs.existsSync(path.join(dir, 'L')) && fs.readdirSync(path.join(dir, 'L')).filter((f) => f !== '_chats.json').length, 1, '没有译文的对话不建文件');
  assert.strictEqual(await fillLite({ store, accId: 'L', gap: 0, alive: () => true, jids: async () => [[jid, 99]], incoming: async () => lite }), 0, '再跑一次没有要补的');
  // 重启后：补回来的直接带原文
  store.flush();
  ({ store, fc } = make());
  fc.ingest('L', fromLite(liteView(30), jid), { auto: false, dailyCap: 500 });
  items = fc.viewOf('L').items;
  assert.strictEqual(items.length, 30);
  assert(items.every((x) => x.text));
  unique(items);
  // 超过 4000 字的原文不截断（截了 hash 对不上，补回来时认不出）
  const long = 'Lorem ipsum dolor sit amet. '.repeat(150);
  store.putKey('L', lck, textKey(long), { tr: '长', text: long });
  assert.strictEqual(store.getKey('L', lck, textKey(long)).text, long);
  store.putKey('L', lck, textKey(long + '!'), { tr: '长' });
  assert(store.fillText('L', lck, textKey(long + '!'), long + '!'), '长原文也能补');
  // 原文对不上（hash 不一样）的不补
  assert.strictEqual(store.fillText('L', lck, textKey('x'), 'y'), false);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('旧译文记录补原文自检通过');
}

// 切到一个对话时没翻的旧消息（shen 2026-10-29 截图：后面 4 条存着译文，前面 3 条只剩「翻译」按钮）：
// 最后 5 条没翻的照常自动翻，存着的不占名额；更早的用免费的智谱或混元在后台慢慢补（slow），最新的先翻，不算额度；
// 没有免费服务商就留着「翻译」按钮；同一次运行里切走再切回也补；补的时候来了新消息先翻新的；用户点了马上翻
// 用免费服务商时收到的消息最多同时翻 3 条（shen 2026-10-29「提速做,同时做的仅限于免费 API」），付费的一次一条；
// 每条只算一次额度；说忙的那条过一会儿再来，不卡住别的
async function parallelAuto() {
  let par = 3;
  let now = 0;
  let max = 0;
  const order = [];
  let busyOnce = new Set();
  const fc = new FloatCore({ parallel: () => par, translate: async (text) => {
    if (busyOnce.has(text)) { busyOnce.delete(text); return { error: '让用户先翻', kind: 'busy' }; }
    now += 1; max = Math.max(max, now);
    await sleep(30);
    now -= 1;
    order.push(text);
    return { text: `译:${text}`, warn: [] };
  } });
  const idle = async () => { for (let i = 0; i < 300 && (fc.running || fc.queue.length); i += 1) await sleep(10); assert(!fc.running && !fc.queue.length); };
  const chat = '4915112345678@c.us';
  const opts = { auto: true, dailyCap: 500 };
  fc.ingest('P', { title: 'Lukas', bottom: true, msgs: [msg(0, false, chat)] }, opts);
  await idle();
  max = 0;
  const burst = [1, 2, 3, 4].map((i) => msg(i, false, chat));
  const t0 = Date.now();
  fc.ingest('P', { title: 'Lukas', bottom: true, msgs: [msg(0, false, chat), ...burst] }, opts);
  await idle();
  assert.strictEqual(max, 3, '最多同时 3 条');
  assert(Date.now() - t0 < 300, '4 条两轮翻完（不是一条一条）');
  assert.strictEqual(fc.viewOf('P').today, 5, '每条只算一次');
  // 付费的：一次一条
  par = 1;
  max = 0;
  fc.ingest('P', { title: 'Lukas', bottom: true, msgs: [msg(0, false, chat), ...burst, ...[5, 6, 7].map((i) => msg(i, false, chat))] }, opts);
  await idle();
  assert.strictEqual(max, 1);
  assert.deepStrictEqual(order.slice(-3), ['hola 5', 'hola 6', 'hola 7'], '按顺序');
  // 说忙的那条：别的先翻，它过一会儿再来
  par = 3;
  busyOnce = new Set(['hola 8']);
  const more = [8, 9].map((i) => msg(i, false, chat));
  fc.ingest('P', { title: 'Lukas', bottom: true, msgs: [msg(0, false, chat), ...burst, ...[5, 6, 7].map((i) => msg(i, false, chat)), ...more] }, opts);
  await idle();
  assert.deepStrictEqual(order.slice(-2), ['hola 9', 'hola 8']);
  assert(fc.viewOf('P').items.every((x) => x.state === 'done'));
  assert.strictEqual(fc.viewOf('P').today, 10);
  // 刚读到时文字还没显示全，下次读到的变了：还没开始翻的用新的
  {
    const got = [];
    let release;
    const fc2 = new FloatCore({ translate: (text) => { got.push(text); return new Promise((res) => { release = () => res({ text: `译:${text}`, warn: [] }); }); } });
    const a = msg(1, false, chat, 'Hallo');
    const b = msg(2, false, chat, 'Wart');
    fc2.ingest('Q', { title: 'Lukas', bottom: true, msgs: [] }, opts);
    fc2.ingest('Q', { title: 'Lukas', bottom: true, msgs: [a, b] }, opts);
    assert(fc2.ingest('Q', { title: 'Lukas', bottom: true, msgs: [{ ...a, text: 'Hallo, wie geht es?' }, { ...b, text: 'Warten Sie bitte' }] }, opts));
    release(); await sleep(5); release(); await sleep(5);
    assert.deepStrictEqual(got, ['Hallo', 'Warten Sie bitte'], '已经在翻的不改，排着的用新的');
  }
  console.log('同时翻几条自检通过');
}

async function catchUpOlder() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { TrStore } = require('../src/trstore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trstore-catchup-'));
  const store = new TrStore(dir);
  const sent = [];
  let free = true;
  let slowErr = '';
  const fc = new FloatCore({ store, slowGap: 100, translate: async (text, o = {}) => {
    if (o.slow && !free) return { error: '没有免费的翻译服务', kind: 'nofree' };
    if (o.slow && slowErr) { sent.push(`错:${text}`); return { error: '网络不通', kind: slowErr }; }
    sent.push(o.slow ? `慢:${text}` : text);
    return { text: `译:${text}`, warn: [] };
  } });
  const idle = async () => { for (let i = 0; i < 300 && (fc.running || fc.queue.length); i += 1) await sleep(10); assert(!fc.running && !fc.queue.length, '排着的都翻完了'); };
  const chat = '31612345678@c.us';
  const texts = ['Hi', 'Hello', 'Thank you', 'Then I have to wait till December', 'Did you get my message on Tuesday?', 'Oh, I see', 'OK, next order then', 'Can you send it to my husband?', 'Oohhh'];
  const msgs = texts.map((text, i) => ({ id: `false_${chat}_3EB${i}`, out: false, text }));
  const ck = hashOf('N', `chat|${chat}`);
  for (const t of texts.slice(5, 8)) store.put('N', ck, t, { tr: `存:${t}` });
  const opts = { auto: true, dailyCap: 500 };
  fc.ingest('N', { title: 'Sanne', bottom: true, msgs }, opts);
  await sleep(20); // 最近 5 条翻完，更早的那条还在等（隔 100ms）
  assert.deepStrictEqual(sent, ['Hello', 'Thank you', 'Then I have to wait till December', 'Did you get my message on Tuesday?', 'Oohhh'], '存着的不占最近 5 条');
  assert.strictEqual(fc.viewOf('N').today, 5);
  // 补翻的时候客户又发来一条：先翻新的，不等
  const late = { id: `false_${chat}_3EB9`, out: false, text: 'Are you there?' };
  fc.ingest('N', { title: 'Sanne', bottom: true, msgs: [...msgs, late] }, opts);
  await sleep(20);
  assert.strictEqual(sent[5], 'Are you there?');
  await idle();
  assert.deepStrictEqual(sent.slice(6), ['慢:Hi'], '更早的用免费服务商在后台补');
  assert(fc.viewOf('N').items.every((x) => x.state === 'done'));
  assert.strictEqual(fc.viewOf('N').today, 6, '后台补翻不算额度');
  // 没有免费服务商：留着「翻译」按钮，不报错；之后填了密钥，切走再切回就补上
  free = false;
  sent.length = 0;
  const chat2 = '4915112345678@c.us';
  const m2 = Array.from({ length: 8 }, (_, i) => ({ id: `false_${chat2}_3EC${i}`, out: false, text: `Hallo ${i}` }));
  fc.ingest('N', { title: 'Lukas', bottom: true, msgs: m2 }, opts);
  await idle();
  assert.deepStrictEqual(fc.viewOf('N').items.map((x) => [x.state, x.err]).slice(0, 4), [['manual', ''], ['manual', ''], ['manual', ''], ['done', '']]);
  free = true;
  sent.length = 0;
  fc.ingest('N', { title: 'Sanne', bottom: true, msgs: [...msgs, late] }, opts);
  fc.ingest('N', { title: 'Lukas', bottom: true, msgs: m2 }, opts);
  await idle();
  assert.deepStrictEqual(sent, ['Hallo 0', 'Hallo 1', 'Hallo 2'], '切回对话也补（没翻的不到 5 条，照常自动翻）');
  // 用户等不及点了排着的那条：马上翻
  sent.length = 0;
  const chat3 = '447700900123@c.us';
  const m3 = Array.from({ length: 9 }, (_, i) => ({ id: `false_${chat3}_3ED${i}`, out: false, text: `Hey ${i}` }));
  fc.ingest('N', { title: 'Oliver', bottom: true, msgs: m3 }, opts);
  assert(fc.manual('N', msgHash('N', m3[0].id)));
  await idle();
  assert.deepStrictEqual(sent.slice(0, 2), ['Hey 4', 'Hey 0'], '点了的插到最前面（正在翻的那条翻完就轮到它）');
  assert.deepStrictEqual(sent.slice(-3), ['慢:Hey 3', '慢:Hey 2', '慢:Hey 1']);
  // 免费服务商出错（网络不通）：只试一条，排着的都退回「翻译」按钮，不一条条去试
  slowErr = 'network';
  sent.length = 0;
  const chat5 = '12125550123@c.us';
  const m5 = Array.from({ length: 12 }, (_, i) => ({ id: `false_${chat5}_3EF${i}`, out: false, text: `Hello ${i}` }));
  fc.ingest('N', { title: 'Emily', bottom: true, msgs: m5 }, opts);
  await idle();
  assert.deepStrictEqual(sent.filter((x) => x.startsWith('错:')), ['错:Hello 6'], '出错只试一条');
  assert.deepStrictEqual(fc.viewOf('N').items.slice(0, 7).map((x) => [x.state, x.err]), Array(7).fill(['manual', '']));
  slowErr = '';
  // 自动关着打开对话，再打开自动：一样，存着的不占名额，更早的后台补
  sent.length = 0;
  const chat4 = '33612345678@c.us';
  const m4 = Array.from({ length: 8 }, (_, i) => ({ id: `false_${chat4}_3EE${i}`, out: false, text: `Bonjour ${i}` }));
  store.put('M', hashOf('M', `chat|${chat4}`), 'Bonjour 7', { tr: '存' });
  fc.ingest('M', { title: 'Camille', bottom: true, msgs: m4 }, { auto: false, dailyCap: 500 });
  fc.backfill('M', { dailyCap: 500 });
  await idle();
  assert.deepStrictEqual(sent, ['Bonjour 2', 'Bonjour 3', 'Bonjour 4', 'Bonjour 5', 'Bonjour 6', '慢:Bonjour 1', '慢:Bonjour 0']);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('切到对话补翻更早的消息自检通过');
}

// 重新打开对话、重启软件后，翻译栏上以前的译文一条不少（shen 2026-10-28「后续打开页面，翻译的文本都一直在这」）：
// 页面只读最后 20 条（双方），聊着聊着翻译栏攒到 20 条译文；切走再切回、重启后，读不到的更早的译文按存的记录补回来，
// 不调模型；补回来的带着原文，能展开、能纠错；客户再发来照常接在后面
async function reopenKeepsAll() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { TrStore } = require('../src/trstore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trstore-reopen-'));
  const sent = [];
  const make = () => {
    const store = new TrStore(dir);
    return { store, fc: new FloatCore({ store, translate: async (text) => { sent.push(text); return { text: `译:${text}`, warn: [] }; } }) };
  };
  const chat = '123456789012345@lid';
  const conv = [];
  for (let i = 0; i < 46; i += 1) conv.push({ id: `${i % 2 === 1}_${chat}_3EB${i}`, out: i % 2 === 1, text: `Message ${i}`, t: { h: 9, mi: i, at: 1700000000000 + i * 60000 } });
  const read = (n) => ({ title: 'Emma', bottom: true, msgs: conv.slice(0, n).slice(-20) });
  const opts = { auto: true, dailyCap: 500 };
  let { store, fc } = make();
  for (let n = 1; n <= 40; n += 1) { fc.ingest('R', read(n), opts); await sleep(2); }
  await sleep(20);
  const live = fc.viewOf('R').items.map((x) => [x.state, x.tr]);
  assert.strictEqual(live.length, 20, '聊着聊着翻译栏攒到 20 条');
  assert(live.every(([st]) => st === 'done'));
  // 切到别的对话再切回：20 条都在，不调模型
  fc.ingest('R', { title: 'Megan', bottom: true, msgs: [msg(1, false, '999@lid', 'Hi there')] }, opts);
  await sleep(20);
  sent.length = 0;
  fc.ingest('R', read(40), opts);
  await sleep(20);
  assert.deepStrictEqual(fc.viewOf('R').items.map((x) => [x.state, x.tr]), live, '切回对话：以前的译文一条不少');
  assert.deepStrictEqual(sent, [], '切回对话不调模型');
  // 重启：同样 20 条，按原来的顺序，不调模型
  store.flush();
  ({ store, fc } = make());
  fc.ingest('R', read(40), opts);
  await sleep(20);
  let items = fc.viewOf('R').items;
  assert.deepStrictEqual(items.map((x) => [x.state, x.tr]), live, '重启后：以前的译文一条不少、顺序不变');
  assert.deepStrictEqual(sent, [], '重启后不调模型');
  assert.deepStrictEqual(items.slice(0, 10).map((x) => x.text), Array.from({ length: 10 }, (_, i) => `Message ${i * 2}`), '补回来的带着原文（能展开）');
  assert.strictEqual(new Set(items.map((x) => x.h)).size, items.length, '重启后没有重复');
  assert.strictEqual(new Set(items.map((x) => x.text)).size, items.length, '读到的 20 条里的和记录里的同一条只出现一次');
  assert.strictEqual(items[0].t, '09:00', '补回来的带着时间');
  assert(fc.manual('R', items[0].h, true), '补回来的有原文，能纠错');
  await sleep(20);
  assert.deepStrictEqual(sent, ['Message 0'], '纠错按原文重翻');
  sent.length = 0;
  // 补回来的也能手动改，改了存住，再重启还在
  assert(fc.edit('R', items[0].h, '我改的'));
  store.flush();
  const raw = fs.readFileSync(path.join(dir, 'R', fs.readdirSync(path.join(dir, 'R'))[0]), 'utf8');
  assert(raw.includes('"text":"Message 0"'), '磁盘上存着原文');
  assert(!raw.includes('123456789012345'), '磁盘上不存号码');
  ({ store, fc } = make());
  fc.ingest('R', read(40), opts);
  assert.deepStrictEqual(fc.viewOf('R').items[0].tr, '我改的');
  // 客户接着发：接在后面，补回来的留在上面，最多 40 条
  for (let n = 41; n <= 46; n += 1) { fc.ingest('R', read(n), opts); await sleep(2); }
  await sleep(20);
  items = fc.viewOf('R').items;
  assert.strictEqual(items.length, 23);
  assert.deepStrictEqual(items.slice(-3).map((x) => x.tr), ['译:Message 40', '译:Message 42', '译:Message 44']);
  assert.strictEqual(new Set(items.map((x) => x.h)).size, items.length, '没有重复');
  assert.deepStrictEqual(sent, ['Message 40', 'Message 42', 'Message 44']);
  // 以前存的译文带【要点】那行（#240 之前的默认模式）：补回来时也去掉
  {
    const e = store.load('R', items[1].h && fc.viewOf('R').chatKey);
    const k = store.getView('R', fc.viewOf('R').chatKey)[1].k;
    e.data[k].tr = '译:Message 2\n【要点】客户问货';
    e.dirty = true;
    store.flush();
    const again = make();
    again.fc.ingest('R', read(46), opts);
    assert.strictEqual(again.fc.viewOf('R').items[1].tr, '译:Message 2', '补回来的译文也去掉【要点】');
  }
  // 不在的时候来了很多（接不上）：存的整张单子都比这次读到的早，照样补在上面
  store.flush();
  const more = [];
  for (let i = 46; i < 70; i += 1) more.push({ id: `false_${chat}_3EB${i}`, out: false, text: `Late ${i}`, t: { h: 10, mi: i - 10, at: 1700000000000 + i * 60000 } });
  ({ store, fc } = make());
  fc.ingest('R', { title: 'Emma', bottom: true, msgs: more.slice(-20) }, { auto: false, dailyCap: 500 });
  items = fc.viewOf('R').items;
  assert.strictEqual(items.length, 40);
  assert.deepStrictEqual(items.slice(19, 21).map((x) => [x.tr, x.text]), [['译:Message 44', 'Message 44'], ['', 'Late 50']]);
  assert.strictEqual(new Set(items.map((x) => x.h)).size, items.length, '接不上时也没有重复');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('重新打开对话、重启后译文一条不少自检通过');
}

// 自己发消息时翻译栏不动（shen 2026-10-28）：页面只读最后 20 条，自己每发一条，最老的客户消息就被挤出读的范围。
// 同一个对话里被挤出去的照样留着，列表不变、不推送、不重画；客户再发来才加在最后
async function sendNoJump() {
  const fc = new FloatCore({ translate: async (text) => ({ text: `译:${text}`, warn: [] }) });
  const opts = { auto: false, dailyCap: 500 };
  // 20 条：客户 6 条，自己 14 条，客户的在前面
  let page = Array.from({ length: 20 }, (_, i) => msg(i, ![0, 1, 4, 8, 12, 15].includes(i)));
  const texts = () => fc.viewOf('S').items.map((x) => x.text);
  assert(fc.ingest('S', { title: 'Emma', msgs: page }, opts));
  const start = texts();
  assert.strictEqual(start.length, 6);
  let pushes = 0;
  for (let i = 0; i < 16; i++) {
    page = [...page.slice(1), msg(100 + i, true)]; // 发一条：最老的一条被挤出读的范围
    if (fc.ingest('S', { title: 'Emma', msgs: page }, opts)) pushes += 1;
    assert.deepStrictEqual(texts(), start, `发第 ${i + 1} 条后翻译栏的消息变了`);
  }
  assert.strictEqual(pushes, 0, '自己发消息不该让翻译栏重画');
  assert(page.every((m) => m.out), '这时读到的 20 条全是自己发的');
  // 客户回了一条：加在最后，前面的都还在
  page = [...page.slice(1), msg(200)];
  assert(fc.ingest('S', { title: 'Emma', msgs: page }, opts));
  assert.deepStrictEqual(texts(), [...start, 'hola 200']);
  // 换到别的对话再回来（和上次读到的接不上）：只显示这次读到的
  fc.ingest('S', { title: 'Max', msgs: [msg(1, false, '999@c.us')] }, opts);
  fc.ingest('S', { title: 'Emma', msgs: page }, opts);
  assert.deepStrictEqual(texts(), ['hola 200']);
  // 上次当成收到的、这次认出是自己发的（还在翻译中删不掉）：不留在列表上
  {
    let release;
    const fc2 = new FloatCore({ translate: () => new Promise((res) => { release = () => res({ text: '译', warn: [] }); }) });
    const a = { id: 'false_777@c.us_A', out: false, text: 'Hallo' };
    const b = { id: 'false_777@c.us_B', out: false, text: 'Bis morgen' };
    fc2.ingest('R', { title: 'Anna', msgs: [a, b] }, { auto: true, dailyCap: 500 });
    await sleep(5);
    fc2.manual('R', msgHash('R', b.id)); // b 排在 a 后面；先让 a 跑着
    fc2.ingest('R', { title: 'Anna', msgs: [a, { ...b, id: 'true_777@c.us_B', out: true }] }, { auto: true, dailyCap: 500 });
    assert.deepStrictEqual(fc2.viewOf('R').items.map((x) => x.text), ['Hallo']);
    fc2.ingest('R', { title: 'Anna', msgs: [{ ...b, id: 'true_777@c.us_B', out: true }, msg(1, true, '777@c.us')] }, { auto: true, dailyCap: 500 });
    assert.deepStrictEqual(fc2.viewOf('R').items.map((x) => x.text), ['Hallo'], '认出是自己发的那条不能被当成旧消息留下');
    release();
  }
  // 轻量号一次读到的超过 40 条：一条不少，发消息也不变
  const many = Array.from({ length: 60 }, (_, i) => msg(i, false, '555@c.us'));
  fc.ingest('M', { title: 'Big', msgs: many }, opts);
  assert(!fc.ingest('M', { title: 'Big', msgs: [...many.slice(1), msg(60, true, '555@c.us')] }, opts), '轻量号发消息也不重画');
  assert.strictEqual(fc.viewOf('M').items.length, 60);
  // 客户撤回了中间一条（没被挤出去，是不见了）：不留，也不会挪到前面
  const rv = [msg(1, false, '666@c.us'), msg(2, false, '666@c.us'), msg(3, false, '666@c.us'), msg(4, true, '666@c.us')];
  fc.ingest('V', { title: 'Rev', msgs: rv }, opts);
  fc.ingest('V', { title: 'Rev', msgs: [rv[0], rv[2], rv[3]] }, opts);
  assert.deepStrictEqual(fc.viewOf('V').items.map((x) => x.text), ['hola 1', 'hola 3']);
  console.log('发消息时翻译栏不动自检通过');
}

// 页面说不清停在哪（bottom 是 null）：靠消息时间、和上次读到的接不接得上，认出是往上翻了（@lid 对话）
function scrollNoBottom() {
  const opts = { auto: false, dailyCap: 500 };
  const lid = '98765432101234@lid';
  const at = (i) => Date.parse('2026-03-02T08:00:00Z') + i * 60000;
  const all = (timed) => Array.from({ length: 120 }, (_, i) => ({ ...msg(i, i % 3 !== 0, lid), ...(timed ? { t: { h: 8, mi: i % 60, at: at(i) } } : {}) }));
  for (const timed of [true, false]) {
    const fc = new FloatCore({ translate: async (text) => ({ text: `译:${text}`, warn: [] }) });
    const list = all(timed);
    const read = (end) => ({ title: 'Amanda Hardy', msgs: list.slice(end - 20, end), bottom: null });
    const texts = () => fc.viewOf('N').items.map((x) => x.text);
    fc.ingest('N', read(120), opts);
    const start = texts();
    // 有时间的：一直翻到最早也认得出；没时间的：只认得出和上次读到的接得上的那一段
    const ends = timed ? [115, 100, 80, 60, 40, 20, 60, 100, 119] : [115, 110, 105, 101];
    for (const e of ends) {
      assert(!fc.ingest('N', read(e), opts), `${timed ? '有' : '没'}时间，翻到 ${e} 时翻译栏不该重画`);
      assert.deepStrictEqual(texts(), start, `${timed ? '有' : '没'}时间，翻到 ${e} 时翻译栏变了`);
    }
    assert(!fc.ingest('N', read(120), opts));
    assert.deepStrictEqual(texts(), start);
  }
  // 最新一条被删了（页面上不见了）：停在最下面就照常用；说不清在哪时，客户再发来一条也照常加上，不会卡住
  {
    const fc = new FloatCore({ translate: async (text) => ({ text: `译:${text}`, warn: [] }) });
    const list = all(true);
    const texts = () => fc.viewOf('D').items.map((x) => x.text);
    fc.ingest('D', { title: 'A', msgs: list.slice(100, 120), bottom: true }, opts);
    // 最后一条（自己发的 119）删了，页面往前多露出一条客户的 99：停在最下面，这次读到的照常用
    assert(fc.ingest('D', { title: 'A', msgs: list.slice(99, 119), bottom: true }, opts));
    assert.strictEqual(texts()[0], 'hola 99');
    const fc2 = new FloatCore({ translate: async (text) => ({ text: `译:${text}`, warn: [] }) });
    fc2.ingest('E', { title: 'A', msgs: list.slice(100, 120), bottom: null }, opts);
    const next = { ...msg(500, false, lid), t: { h: 10, mi: 0, at: at(200) } };
    assert(fc2.ingest('E', { title: 'A', msgs: [...list.slice(100, 118), list[119], next].slice(-20), bottom: null }, opts));
    assert.strictEqual(fc2.viewOf('E').items.slice(-1)[0].text, 'hola 500');
    // 页面把位置认错了（说不在最下面），但读到了更新的消息：照常加上，不冻住
    const later = { ...msg(501, false, lid), t: { h: 10, mi: 1, at: at(201) } };
    assert(fc2.ingest('E', { title: 'A', msgs: [...list.slice(102, 118), list[119], later], bottom: false }, opts));
    assert.strictEqual(fc2.viewOf('E').items.slice(-1)[0].text, 'hola 501');
    // 换了对话：照常显示新对话的
    fc2.ingest('E', { title: 'B', msgs: [msg(1, false, '111222333444555@lid')], bottom: false }, opts);
    assert.deepStrictEqual(fc2.viewOf('E').items.map((x) => x.text), ['hola 1']);
  }
  console.log('说不清停在哪时翻译栏也不变自检通过');
}

// 填好密钥后：“没填密钥 / 密钥不对”失败的自动重翻；别的原因失败的不动；照每天上限；别的对话里的忘掉；纠错失败的恢复原译文
async function keyRetry() {
  const now = Date.parse('2026-10-24T10:00:00Z');
  let mode = 'nokey';
  const sent = [];
  const fc = new FloatCore({ now: () => now, translate: async (text) => {
    sent.push(text);
    if (mode === 'nokey') return text.includes('quota') ? { error: '智谱账户没余额了', kind: 'quota' } : { error: '智谱还没填密钥', kind: 'auth', providerId: 'zp' };
    return { text: `译:${text}`, warn: [] };
  } });
  // 另一个对话先失败一条，然后切走
  fc.ingest('K', { title: 'old', msgs: [msg(1, false, '900@c.us', 'old chat')] }, { auto: true, dailyCap: 500 });
  await sleep(20);
  const msgs = [msg(1, false, '901@c.us', 'a'), msg(2, false, '901@c.us', 'b quota'), msg(3, false, '901@c.us', 'c')];
  fc.ingest('K', { title: 'Emma', msgs }, { auto: true, dailyCap: 500 });
  await sleep(20);
  let items = fc.viewOf('K').items;
  assert.deepStrictEqual(items.map((x) => x.state), ['error', 'error', 'error']);
  assert.strictEqual(items[0].errPid, 'zp');
  // 别的服务商的密钥：不重翻
  mode = 'ok';
  sent.length = 0;
  assert.deepStrictEqual(fc.retryKeyErrors({ dailyCap: 500, match: (pid) => pid === 'dl' }), []);
  // 智谱的密钥填好了：只重翻缺密钥的两条，没余额那条不动
  assert.deepStrictEqual(fc.retryKeyErrors({ dailyCap: 500, match: (pid) => pid === 'zp' }), ['K']);
  await sleep(20);
  assert.deepStrictEqual(sent.sort(), ['a', 'c']);
  items = fc.viewOf('K').items;
  assert.deepStrictEqual(items.map((x) => x.state), ['done', 'error', 'done']);
  assert.strictEqual(items[0].tr, '译:a');
  assert.strictEqual(items[1].err, '智谱账户没余额了');
  // 切回之前的对话：失败的那条按新消息补翻
  sent.length = 0;
  fc.ingest('K', { title: 'old', msgs: [msg(1, false, '900@c.us', 'old chat')] }, { auto: true, dailyCap: 500 });
  await sleep(20);
  assert.deepStrictEqual(sent, ['old chat']);
  assert.strictEqual(fc.viewOf('K').items[0].tr, '译:old chat');
  // 每天上限到了：不重翻，旧报错也不再显示，退回“翻译”按钮
  const fc2 = new FloatCore({ now: () => now, translate: async () => ({ error: '智谱还没填密钥', kind: 'auth', providerId: 'zp' }) });
  fc2.ingest('L', { title: 'x', msgs: [msg(1, false, '902@c.us'), msg(2, false, '902@c.us')] }, { auto: true, dailyCap: 3 });
  await sleep(20);
  let n = 0;
  fc2.deps.translate = async (text) => { n += 1; return { text: `译:${text}`, warn: [] }; };
  fc2.retryKeyErrors({ dailyCap: 3, match: () => true });
  await sleep(20);
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(fc2.viewOf('L').items.map((x) => [x.state, x.err]), [['done', ''], ['manual', '']]);
  assert.strictEqual(fc2.viewOf('L').paused, 'day');
  // 纠错失败（密钥问题）：原译文恢复，不再请求
  const fc3 = new FloatCore({ now: () => now, translate: async (text, o) => (o.fix ? { error: '智谱的密钥不对或没有权限', kind: 'auth', providerId: 'zp' } : { text: `译:${text}`, warn: [] }) });
  fc3.ingest('M', { title: 'x', msgs: [msg(1, false, '903@c.us')] }, { auto: true, dailyCap: 500 });
  await sleep(20);
  const hm = fc3.viewOf('M').items[0].h;
  fc3.manual('M', hm, true);
  await sleep(20);
  assert.strictEqual(fc3.viewOf('M').items[0].state, 'error');
  fc3.deps.translate = async () => { throw new Error('不该再请求'); };
  fc3.retryKeyErrors({ dailyCap: 500, match: () => true });
  assert.deepStrictEqual([fc3.viewOf('M').items[0].state, fc3.viewOf('M').items[0].tr], ['done', '译:hola 1']);
  console.log('填好密钥自动重翻自检通过');
}

// 译文存盘：切走再切回、重启后直接显示，不再调模型；手动改的也存；删号也保留
// 时间、数字、表情这类没有文字的消息不翻；存着的旧译文显示时去掉以前默认模式加的【要点】那行（shen 2026-10-28）
async function noWordsGist() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { TrStore } = require('../src/trstore');
  const { noWords, dropGist } = require('../src/floatcore');
  for (const t of ['08:02', '28-1', '+1 (555) 010-2233', '👍👍', '12/03/2026', '...', '$120']) assert(noWords(t), t);
  for (const t of ['ok', 'And ok…', '谢谢', 'Größe M', '2 wigs']) assert(!noWords(t), t);
  assert.strictEqual(dropGist('谢谢，请发送发票\n\n【要点】客户要求发送发票'), '谢谢，请发送发票');
  assert.strictEqual(dropGist('第一行\n第二行\n【要点】客户确认'), '第一行\n第二行');
  assert.strictEqual(dropGist('【要点】只有这一行'), '【要点】只有这一行');
  assert.strictEqual(dropGist('普通译文'), '普通译文');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trstore-'));
  const store = new TrStore(dir);
  const sent = [];
  const fc = new FloatCore({ store, translate: async (text) => { sent.push(text); return { text: `译:${text}`, warn: [] }; } });
  const chat = '777@c.us';
  const ck = hashOf('G', `chat|${chat}`);
  store.put('G', ck, 'Thanks, please send the invoice', { tr: '谢谢，请发送发票\n\n【要点】客户要求发送发票' });
  store.put('G', ck, 'Paid', { tr: '已付\n【要点】我自己写的', edited: true });
  const msgs = [msg(1, false, chat, 'Thanks, please send the invoice'), msg(2, false, chat, 'Paid'), msg(3, false, chat, '08:02'),
    msg(4, false, chat, '28-1'), msg(5, false, chat, 'And ok…')];
  fc.ingest('G', { title: 'g', msgs }, { auto: true, dailyCap: 500 });
  await sleep(20);
  assert.deepStrictEqual(sent, ['And ok…'], '时间、编号不翻，存过的不再翻');
  const items = fc.viewOf('G').items;
  assert.deepStrictEqual(items.map((x) => [x.state, x.tr]), [['done', '谢谢，请发送发票'], ['done', '已付\n【要点】我自己写的'], ['skip', ''], ['skip', ''], ['done', '译:And ok…']]);
  // 不翻的：点不了翻译、改不了
  assert(!fc.manual('G', items[2].h));
  assert(!fc.edit('G', items[2].h, 'x'));
  // 用户自己的「收到」模式要要点：存着的要点不删；客户原文里本来就有【要点】也不删
  let keep = true;
  const fc2 = new FloatCore({ store, keepGist: () => keep, translate: async (text) => ({ text: `译:${text}`, warn: [] }) });
  store.put('G', ck, '客户写的【要点】', { tr: '客户\n【要点】原文就有' });
  fc2.ingest('G', { title: 'g', msgs: [msg(1, false, chat, 'Thanks, please send the invoice')] }, { auto: false, dailyCap: 500 });
  assert.strictEqual(fc2.viewOf('G').items[0].tr, '谢谢，请发送发票\n\n【要点】客户要求发送发票');
  keep = false;
  const fc3 = new FloatCore({ store, keepGist: () => keep, translate: async (text) => ({ text: `译:${text}`, warn: [] }) });
  fc3.ingest('G', { title: 'g', msgs: [msg(9, false, chat, '客户写的【要点】')] }, { auto: false, dailyCap: 500 });
  assert.strictEqual(fc3.viewOf('G').items.at(-1).tr, '客户\n【要点】原文就有');
  fs.rmSync(dir, { recursive: true, force: true });
}

async function persisted() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { TrStore } = require('../src/trstore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trstore-'));
  const sent = [];
  const make = () => {
    const store = new TrStore(dir);
    return { store, fc: new FloatCore({ store, translate: async (text) => { sent.push(text); return { text: `译:${text}`, warn: [] }; } }) };
  };
  let { store, fc } = make();
  const msgs = [msg(1, false, '555@c.us', 'hello'), msg(2, false, '555@c.us', 'bye')];
  fc.ingest('P', { title: 'p', msgs }, { auto: true, dailyCap: 500 });
  await sleep(20);
  assert.deepStrictEqual(sent, ['hello', 'bye']);
  assert(fc.edit('P', msgHash('P', msgs[1].id), '再见（我改的）'));
  store.flush();
  const files = fs.readdirSync(path.join(dir, 'P')).filter((f) => f !== '_chats.json'); // _chats：别名表和最近消息索引
  assert.strictEqual(files.length, 1);
  const meta = fs.readFileSync(path.join(dir, 'P', '_chats.json'), 'utf8');
  assert(!meta.includes('555') && !meta.includes('hello'), '别名表和索引里只有 hash');
  const raw = fs.readFileSync(path.join(dir, 'P', files[0]), 'utf8');
  // 只查号码本身（555@），时间戳里碰巧有 555 不算
  assert(raw.includes('"text":"hello"') && !raw.includes('555@'), '磁盘上存原文，不存号码');
  // 重启：同样的消息（编号变了也认得出）直接显示，不调模型
  ({ store, fc } = make());
  sent.length = 0;
  const again = [{ ...msg(7, false, '555@c.us', 'hello') }, msg(2, false, '555@c.us', 'bye'), msg(3, false, '555@c.us', 'new one')];
  fc.ingest('P', { title: 'p', msgs: again }, { auto: true, dailyCap: 500 });
  await sleep(20);
  assert.deepStrictEqual(sent, ['new one']);
  const items = fc.viewOf('P').items;
  assert.deepStrictEqual(items.map((x) => [x.state, x.tr, x.edited]), [['done', '译:hello', false], ['done', '再见（我改的）', true], ['done', '译:new one', false]]);
  // 别的对话里同样的话不串
  fc.ingest('P', { title: 'q', msgs: [msg(1, false, '666@c.us', 'hello')] }, { auto: true, dailyCap: 500 });
  await sleep(20);
  assert.deepStrictEqual(sent, ['new one', 'hello']);
  fc.forget('P');
  assert.strictEqual(fs.readdirSync(path.join(dir, 'P')).filter((f) => f !== '_chats.json').length, 2, '删号不删存的译文');
  fs.rmSync(dir, { recursive: true, force: true });
  // 存哪（同步判断，不调 PowerShell）：Windows 上 D:\WAswitch 已经存在（安装包确认 D 盘是本机硬盘后才建）并且写得进去才放 D 盘，
  // 否则回到 C（userData）；软件自己不建 D:\WAswitch；Mac 不变。旧文件只从 C 搬到 D，选了 C 时 D 盘的一个都不动
  const { pickDir, migrate, dirInfo } = require('../src/trstore');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trdir-'));
  const oldDir = path.join(base, 'old');
  const dRoot = path.join(base, 'D', 'WAswitch');
  const dDir = path.join(dRoot, 'translations');
  assert.strictEqual(pickDir(oldDir, { platform: 'darwin', root: dRoot }), oldDir, 'Mac 不变');
  assert.strictEqual(pickDir(oldDir, { platform: 'win32', root: dRoot }), oldDir, 'D:\\WAswitch 不存在就用 C');
  assert(!fs.existsSync(dRoot), '软件自己不建 D:\\WAswitch（没有它就可能是 U 盘）');
  fs.mkdirSync(dRoot, { recursive: true });
  assert.strictEqual(pickDir(oldDir, { platform: 'win32', root: dRoot }), dDir, '根目录在、写得进去就放 D');
  assert(fs.statSync(dDir).isDirectory());
  assert.deepStrictEqual(fs.readdirSync(dDir), [], '探测用的临时文件删干净');
  fs.writeFileSync(path.join(base, 'file'), '');
  assert.strictEqual(pickDir(oldDir, { platform: 'win32', root: path.join(base, 'file') }), oldDir, '根目录是个文件，写不进去就用 C');
  fs.mkdirSync(path.join(base, 'ro'));
  fs.writeFileSync(path.join(base, 'ro', 'translations'), '');
  assert.strictEqual(pickDir(oldDir, { platform: 'win32', root: path.join(base, 'ro') }), oldDir, 'translations 建不了就用 C');
  fs.rmSync(dRoot, { recursive: true, force: true });
  // 选了 C 时（D 盘暂时打不开）：D 盘的译文一个都不动，也不往 C 搬（审计第 3 条的回归）
  fs.mkdirSync(path.join(dDir, 'A'), { recursive: true });
  fs.writeFileSync(path.join(dDir, 'A', 'c0.json'), '{"k":0}');
  fs.mkdirSync(path.join(oldDir, 'A'), { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'A', 'c9.json'), '{"k":9}');
  const gone = path.join(base, 'D-gone');
  assert.strictEqual(pickDir(oldDir, { platform: 'win32', root: path.join(gone, 'WAswitch') }), oldDir);
  assert.strictEqual(fs.readFileSync(path.join(dDir, 'A', 'c0.json'), 'utf8'), '{"k":0}', '选了 C，D 盘的不动');
  assert.strictEqual(fs.readFileSync(path.join(oldDir, 'A', 'c9.json'), 'utf8'), '{"k":9}', '选了 C，C 盘新存的留着');
  fs.rmSync(path.join(base, 'D'), { recursive: true, force: true });
  fs.rmSync(oldDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(oldDir, 'A'), { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'A', 'c1.json'), '{"k":1}');
  fs.writeFileSync(path.join(oldDir, 'A', 'c2.json'), '{"k":"old"}');
  fs.mkdirSync(path.join(dDir, 'A'), { recursive: true });
  fs.writeFileSync(path.join(dDir, 'A', 'c2.json'), '{"k":"new"}');
  assert.strictEqual(migrate(oldDir, dDir), 2);
  assert.strictEqual(fs.readFileSync(path.join(dDir, 'A', 'c1.json'), 'utf8'), '{"k":1}');
  assert.strictEqual(fs.readFileSync(path.join(dDir, 'A', 'c2.json'), 'utf8'), '{"k":"new"}');
  assert(!fs.existsSync(oldDir), '搬完删掉旧的');
  assert.strictEqual(migrate(oldDir, dDir), 0);
  assert.strictEqual(migrate(dDir, dDir), 0);
  // 关于页显示的大小：只算每个号文件夹里的 .json
  fs.writeFileSync(path.join(dDir, 'A', 'note.txt'), 'xxxxxxxx');
  assert.deepStrictEqual(await dirInfo(dDir), { bytes: 7 + 11, files: 2 });
  assert.deepStrictEqual(await dirInfo(path.join(base, 'nope')), { bytes: 0, files: 0 });
  // 换位置：没写盘的先写到旧位置，之后读写新位置
  const st = new TrStore(oldDir);
  st.put('A', 'c9', 'hi', { tr: '你好' });
  st.setDir(dDir);
  assert(fs.existsSync(path.join(oldDir, 'A', 'c9.json')), '换位置前写盘');
  assert.strictEqual(st.get('A', 'c9', 'hi'), null, '新位置没有这条');
  assert.strictEqual(st.get('A', 'c1', 'x'), null);
  assert(st.load('A', 'c1').data.k === 1, '新位置读得到');
  fs.rmSync(base, { recursive: true, force: true });
  console.log('译文存盘自检通过');

  // 轻量号：不读网页，直接用后台进程推来的当前对话；图片、语音的类型标签不翻，带说明文字的只翻说明
  const jid = '4915112345678@s.whatsapp.net';
  assert.strictEqual(fromLite(null, null).why, 'nochat');
  assert.strictEqual(fromLite({ jid: 'other@s.whatsapp.net', messages: [] }, jid).why, 'wait', '刚点开、还没推过来');
  const lv = { jid, title: '', chats: [{ jid, name: '' }], messages: [
    { id: 'A1', me: false, ts: 1761559200, text: 'Hallo, ist das noch verfügbar?' },
    { id: 'A2', me: true, ts: 1761559260, text: 'Ja' },
    { id: 'A3', me: false, ts: 1761559320, text: '[图片]' },
    { id: 'A4', me: false, ts: 1761559380, text: '[图片] Wie dieses hier' },
    { id: 'A_5', me: false, ts: 1761559440, text: '[ok] danke' },
  ] };
  const lr = fromLite(lv, jid);
  assert(lr.ok);
  assert.strictEqual(lr.title, '+4915112345678', '没名字用号码，客户名单能对上');
  assert.deepStrictEqual(lr.msgs.map((m) => [m.out, m.text]), [[false, 'Hallo, ist das noch verfügbar?'], [true, 'Ja'], [false, 'Wie dieses hier'], [false, '[ok] danke']]);
  assert(lr.msgs.every((m) => m.id.split('_').length === 3 && m.id.split('_')[1] === jid), '编号能认出是哪个对话');
  assert(Number.isInteger(lr.msgs[0].t.h) && Number.isInteger(lr.msgs[0].t.mi));
  assert.strictEqual(fromLite({ ...lv, title: 'Lukas' }, jid).title, 'Lukas');
  // 和网页号走同一套：自动翻、存盘、重启后直接显示
  const ldir = fs.mkdtempSync(path.join(os.tmpdir(), 'trlite-'));
  const lsent = [];
  const lmake = () => {
    const store = new TrStore(ldir);
    return { store, fc: new FloatCore({ store, translate: async (text) => { lsent.push(text); return { text: `译:${text}`, warn: [] }; } }) };
  };
  let l = lmake();
  l.fc.ingest('L', lr, { auto: true, dailyCap: 500 });
  await sleep(20);
  assert.deepStrictEqual(lsent, ['Hallo, ist das noch verfügbar?', 'Wie dieses hier', '[ok] danke']);
  l.store.flush();
  l = lmake();
  lsent.length = 0;
  l.fc.ingest('L', fromLite(lv, jid), { auto: true, dailyCap: 500 });
  await sleep(20);
  assert.deepStrictEqual(lsent, [], '重启后不再调模型');
  assert.deepStrictEqual(l.fc.viewOf('L').items.map((x) => x.tr), ['译:Hallo, ist das noch verfügbar?', '译:Wie dieses hier', '译:[ok] danke']);
  fs.rmSync(ldir, { recursive: true, force: true });
  assert(!lsent.includes('Ja'), '轻量号自己发的（fromMe）不调模型');
  assert(!l.fc.viewOf('L').items.some((x) => x.text === 'Ja'), '轻量号自己发的不在翻译列表里');
  assert.strictEqual(l.fc.accs.get('L').day.n, 0, '重启后读到存盘的译文，自己发的也不算额度');
  // 自己发的消息上一次被当成收到的（刚发出去还认不出方向）：认出来后撤掉排队、退回额度
  {
    let release;
    const got = [];
    const fc2 = new FloatCore({ translate: (text) => { got.push(text); return new Promise((res) => { release = () => res({ text: `译:${text}`, warn: [] }); }); } });
    const one = { id: 'false_chat:Anna_3EB1', out: false, text: 'Hallo' };
    const mine = { id: 'false_chat:Anna_3EB2', out: false, text: 'Bis morgen' };
    fc2.ingest('W', { title: 'Anna', msgs: [one, mine] }, { auto: true, dailyCap: 500 });
    await sleep(5);
    assert.strictEqual(fc2.accs.get('W').day.n, 2);
    fc2.ingest('W', { title: 'Anna', msgs: [one, { ...mine, id: 'true_chat:Anna_3EB2', out: true }] }, { auto: true, dailyCap: 500 });
    assert.strictEqual(fc2.accs.get('W').day.n, 1, '退回自己那条占的额度');
    assert.deepStrictEqual(fc2.viewOf('W').items.map((x) => x.text), ['Hallo']);
    release();
    await sleep(5);
    assert.deepStrictEqual(got, ['Hallo'], '自己发的不调模型');
  }
  console.log('轻量号翻译自检通过');
}

// 上下滑聊天记录时翻译栏不变（shen 2026-10-28「上下滑客户聊天记录为什么右侧聊天记录会一直变」）：
// WhatsApp 往上翻时会把最下面的新消息从页面上拿掉，只读最后 20 条就读到了更早的消息。
// 仿一个这样的页面（@lid 对话，一次只留 40 条），往上翻、再翻回来，翻译栏一直是对话里最新的那些
async function scrollStable(w, waPage) {
  const N = 120;
  await w.webContents.executeJavaScript(`(() => {
    const lid = '98765432101234@lid';
    const pad = (n) => String(n).padStart(2, '0');
    window.__msgs = Array.from({ length: ${N} + 5 }, (_, i) => {
      const out = i % 3 !== 0;
      const pre = '[' + pad(8 + Math.floor(i / 60)) + ':' + pad(i % 60) + ', 2026/3/2] ' + (out ? 'Ich' : 'Amanda') + ': ';
      return '<div role="row"><div data-id="' + out + '_' + lid + '_3EB0' + i + '" class="' + (out ? 'message-out' : 'message-in') + '"><div class="copyable-text" data-pre-plain-text="' + pre + '"><span class="selectable-text copyable-text"><span>' + (out ? 'reply ' : 'msg ') + i + '</span></span></div></div></div>';
    });
    document.querySelector('#main') && document.querySelector('#main').remove();
    document.body.insertAdjacentHTML('beforeend', '<div id="main" style="width:600px"><header><span title="Amanda Hardy">Amanda Hardy</span></header>'
      + '<div id="sc" style="height:300px;overflow-y:auto"><div role="application"></div></div><footer></footer></div>');
    // end：页面上留着的最后一条（不含）；往上翻时 WhatsApp 只留 40 条，最下面的新消息被拿掉
    window.__show = (end, bottom) => {
      const app = document.querySelector('[role=application]');
      app.innerHTML = window.__msgs.slice(Math.max(0, end - 40), end).join('');
      const sc = document.getElementById('sc');
      sc.scrollTop = bottom ? sc.scrollHeight : Math.floor(sc.scrollHeight / 3);
      return sc.scrollHeight - sc.clientHeight - sc.scrollTop;
    };
    return 1; })()`);
  const fc = new FloatCore({ translate: async (text) => ({ text: `译:${text}`, warn: [] }) });
  const opts = { auto: false, dailyCap: 500 };
  const show = (end, bottom) => w.webContents.executeJavaScript(`window.__show(${end}, ${bottom})`);
  const texts = () => fc.viewOf('L').items.map((x) => x.text);
  await show(N, true);
  const r0 = await waPage.readOpenChat(w.webContents);
  assert(r0.ok && r0.msgs.length === 20, JSON.stringify(r0));
  assert.strictEqual(r0.bottom, true, '停在最下面');
  fc.ingest('L', r0, opts);
  const start = texts();
  assert.strictEqual(start[start.length - 1], 'msg 117');
  // 往上翻到最早，再翻回来：翻译栏一直不变、不重画
  const ends = [];
  for (let e = N - 5; e >= 40; e -= 5) ends.push(e);
  for (let e = 45; e < N; e += 5) ends.push(e);
  for (const e of ends) {
    await show(e, false);
    const r = await waPage.readOpenChat(w.webContents);
    assert(r.ok, JSON.stringify(r));
    assert.strictEqual(r.bottom, false, `翻到 ${e} 时认出不在最下面`);
    assert(!fc.ingest('L', r, opts), `翻到 ${e} 时翻译栏不该重画`);
    assert.deepStrictEqual(texts(), start, `翻到 ${e} 时翻译栏变了`);
  }
  // 回到最下面：还是原样
  await show(N, true);
  assert(!fc.ingest('L', await waPage.readOpenChat(w.webContents), opts));
  assert.deepStrictEqual(texts(), start);
  // 往上翻着的时候客户又发来一条：页面上没有，先不变；回到最下面就加在最后
  await show(N - 30, false);
  fc.ingest('L', await waPage.readOpenChat(w.webContents), opts);
  assert.deepStrictEqual(texts(), start);
  await show(N + 1, true);
  assert(fc.ingest('L', await waPage.readOpenChat(w.webContents), opts));
  assert.deepStrictEqual(texts(), [...start, 'msg 120']);
  console.log('上下滑聊天记录时翻译栏不变自检通过');
}

core().then(() => {
  // 只读脚本：在 Electron 里跑（由 xvfb-run electron 调用时才跑）
  if (!process.versions.electron) return;
  const { app, BrowserWindow } = require('electron');
  const waPage = require('../src/wa-page');
  app.whenReady().then(async () => {
    const w = new BrowserWindow({ show: false });
    await w.loadFile(require('path').join(__dirname, 'fixtures', 'wa-chat.html'));
    const before = await w.webContents.executeJavaScript('document.body.innerHTML.length');
    const r = await waPage.readOpenChat(w.webContents);
    const after = await w.webContents.executeJavaScript('document.body.innerHTML.length + "|" + Object.keys(window).filter(k => k.startsWith("__")).length');
    assert(r.ok, JSON.stringify(r));
    assert.strictEqual(r.title, 'Carlos García');
    const incoming = r.msgs.filter((m) => !m.out).map((m) => m.text);
    assert.deepStrictEqual(incoming, ['¿Tienen la talla M en negro?', '¿Cuánto cuesta el envío?', '', 'Hola grupo']);
    assert(!JSON.stringify(r).includes('18:40'), '不读时间');
    assert(!JSON.stringify(r).includes('Pedro'), '不读群发送人');
    // CRM 同步要时间：只在隔离环境里解析成数字，名字不带出来
    assert.deepStrictEqual(r.msgs[0].t, { y: 2026, mo: 10, d: 24, h: 18, mi: 40, ambig: false, at: new Date(2026, 9, 24, 18, 40).getTime(), altAt: null });
    assert(!JSON.stringify(r).includes('Carlos:'), '不带出发送人名字');
    assert(!JSON.stringify(r).includes('quoted text'), '不读引用');
    assert.strictEqual(after.split('|')[0], String(before), '页面没有被改');
    // 等页面变化（MutationObserver，只在隔离环境里看着，不改页面）：来了新消息马上返回，没变化等到时间；输入框里打字不算
    {
      const wc = w.webContents;
      const html0 = await wc.executeJavaScript('document.body.innerHTML');
      await waPage.waitChatChange(wc, 50); // 第一次：开始看着
      let t = Date.now();
      assert.strictEqual(await waPage.waitChatChange(wc, 300), false, '没变化');
      assert(Date.now() - t >= 250);
      assert.strictEqual(await wc.executeJavaScript('document.body.innerHTML'), html0, '看着不改页面');
      assert.strictEqual(await wc.executeJavaScript('Object.keys(window).filter((k) => k.startsWith("__ws")).length'), 0, '页面自己的环境里看不到');
      t = Date.now();
      setTimeout(() => wc.executeJavaScript(`document.querySelector('[role=application]').insertAdjacentHTML('beforeend', '<div role="row"><div data-id="false_111@c.us_W1" class="message-in"><span class="selectable-text"><span>Neu</span></span></div></div>'); 1`), 60);
      assert.strictEqual(await waPage.waitChatChange(wc, 2000), true, '来了新消息');
      assert(Date.now() - t < 400, `新消息要马上返回，用了 ${Date.now() - t} ms`);
      await wc.executeJavaScript(`(() => { const m = document.querySelector('#main'); if (!m.querySelector('footer')) m.insertAdjacentHTML('beforeend', '<footer><div contenteditable="true"></div></footer>'); return 1; })()`);
      await waPage.waitChatChange(wc, 50);
      setTimeout(() => wc.executeJavaScript(`document.querySelector('#main footer [contenteditable]').textContent = 'Hallo'; 1`), 30);
      assert.strictEqual(await waPage.waitChatChange(wc, 300), false, '输入框里打字不算');
      // 两次等之间来的消息也算
      await wc.executeJavaScript(`document.querySelector('[role=application]').insertAdjacentHTML('beforeend', '<div role="row"><div data-id="false_111@c.us_W2" class="message-in"><span class="selectable-text"><span>Neu 2</span></span></div></div>'); 1`);
      await sleep(80);
      assert.strictEqual(await waPage.waitChatChange(wc, 300), true, '两次等之间来的消息');
      // 换了对话（#main 整个换掉）
      setTimeout(() => wc.executeJavaScript(`(() => { const m = document.querySelector('#main'); const n = m.cloneNode(true); m.replaceWith(n); return 1; })()`), 30);
      assert.strictEqual(await waPage.waitChatChange(wc, 1000), true, '换了对话');
      await wc.executeJavaScript(`document.querySelectorAll('[data-id$="_W1"], [data-id$="_W2"]').forEach((n) => n.closest('[role=row]').remove()); document.querySelector('#main footer')?.remove(); 1`);
    }
    // 字数超了要丢掉旧的长消息，留下最新的
    await w.webContents.executeJavaScript(`(() => {
      const app = document.querySelector('[role=application]');
      const add = (id, t) => { const r = document.createElement('div'); r.setAttribute('role', 'row'); r.innerHTML = '<div data-id="' + id + '"><div class="copyable-text" data-pre-plain-text="x"><span class="selectable-text"><span></span></span></div></div>'; r.querySelector('span span').textContent = t; app.append(r); };
      for (let i = 0; i < 6; i++) add('false_111@c.us_L' + i, 'x'.repeat(4000));
      add('false_111@c.us_NEW', 'newest');
      return 1; })()`);
    const r3 = await waPage.readOpenChat(w.webContents);
    assert.strictEqual(r3.msgs[r3.msgs.length - 1].text, 'newest', '最新消息不能被字数上限挤掉');
    assert(r3.msgs.reduce((n, m) => n + m.text.length, 0) <= 20000);
    // 新版页面：编号没有 true_/false_ 前缀、标题不带 title 属性，靠气泡 class 认方向
    await w.webContents.executeJavaScript(`(() => {
      document.querySelector('#main').innerHTML = '<header><span dir="auto">Anna Müller</span></header><div role="application">'
        + '<div role="row"><div data-id="3EB0AA" class="message-in"><div data-pre-plain-text="[09:10, 26/10/2026] Anna: "><span dir="ltr"><span>Guten Morgen, ist das Paket schon unterwegs?</span></span></div></div></div>'
        + '<div role="row"><div data-id="3EB0BB" class="message-out"><div data-pre-plain-text="[09:11, 26/10/2026] Ich: "><span class="selectable-text"><span>Ja, heute verschickt.</span></span></div></div></div></div>';
      return 1; })()`);
    const r4 = await waPage.readOpenChat(w.webContents);
    assert(r4.ok, JSON.stringify(r4));
    assert.strictEqual(r4.title, 'Anna Müller');
    assert.deepStrictEqual(r4.msgs.map((m) => [m.out, m.text]), [[false, 'Guten Morgen, ist das Paket schon unterwegs?'], [true, 'Ja, heute verschickt.']]);
    assert(r4.msgs.every((m) => /^(true|false)_chat:Anna Müller_/.test(m.id)), '补出的编号要能认出是哪个对话');
    // 刚点开、还没有消息的对话：算读到了，只是没有消息
    await w.webContents.executeJavaScript(`document.querySelector('#main').innerHTML = '<header><span title="Lucas">Lucas</span></header><div role="application"></div>'; 1`);
    const r5 = await waPage.readOpenChat(w.webContents);
    assert(r5.ok && r5.msgs.length === 0, JSON.stringify(r5));
    // 右边空白（没点开聊天）：提示先点开一个聊天
    await w.webContents.executeJavaScript(`document.querySelector('#main').innerHTML = '<div>WhatsApp</div>'; 1`);
    assert.strictEqual((await waPage.readOpenChat(w.webContents)).why, 'nochat');
    // 没有 data-id 也没有 class，只剩正文块：照样读，当成收到的
    await w.webContents.executeJavaScript(`document.querySelector('#main').innerHTML = '<header><span title="Marie">Marie</span></header><div role="row"><div><div data-pre-plain-text="[10:00, 26/10/2026] Marie: ">Bonjour, <b>merci</b></div></div></div><div role="row"><div><div data-pre-plain-text="[10:01, 26/10/2026] Marie: ">Bonjour, <b>merci</b></div></div></div>'; 1`);
    const r6 = await waPage.readOpenChat(w.webContents);
    assert(r6.ok, JSON.stringify(r6));
    assert.deepStrictEqual(r6.msgs.map((m) => [m.out, m.text]), [[false, 'Bonjour, merci'], [false, 'Bonjour, merci']]);
    assert.notStrictEqual(r6.msgs[0].id, r6.msgs[1].id, '同样的话两次要有不同编号');
    // 没有 class，但带发送状态的勾：认成自己发的，翻译列表里不显示
    await w.webContents.executeJavaScript(`document.querySelector('#main').innerHTML = '<header><span title="Marie">Marie</span></header>'
      + '<div role="row"><div data-id="3EB0CC"><div data-pre-plain-text="[10:00, 26/10/2026] Marie: "><span dir="ltr">Bonjour</span></div></div></div>'
      + '<div role="row"><div data-id="3EB0DD"><div data-pre-plain-text="[10:01, 26/10/2026] Moi: "><span dir="ltr">Merci à vous</span></div><span data-icon="msg-dblcheck"></span></div></div>'
      + '<div role="row"><div data-id="3EB0EE"><div role="button"><span data-icon="msg-dblcheck"></span>quoted</div><div data-pre-plain-text="[10:03, 26/10/2026] Marie: "><span dir="ltr">Super</span></div></div></div>'; 1`);
    const r7 = await waPage.readOpenChat(w.webContents);
    assert(r7.ok, JSON.stringify(r7));
    assert.deepStrictEqual(r7.msgs.map((m) => [m.out, m.text]), [[false, 'Bonjour'], [true, 'Merci à vous'], [false, 'Super']]);
    // 没有 data-id 只剩正文块时也一样
    await w.webContents.executeJavaScript(`document.querySelector('#main').innerHTML = '<header><span title="Marie">Marie</span></header>'
      + '<div role="row"><div><div data-pre-plain-text="[10:01, 26/10/2026] Marie: ">Salut</div></div></div>'
      + '<div role="row"><div><div data-pre-plain-text="[10:02, 26/10/2026] Moi: ">Bonne journée</div><span data-icon="msg-check"></span></div></div>'; 1`);
    const r8 = await waPage.readOpenChat(w.webContents);
    assert.deepStrictEqual(r8.msgs.map((m) => [m.out, m.text]), [[false, 'Salut'], [true, 'Bonne journée']]);
    // 页面改版、方向标记全没了（没有前缀、没有 class、没有勾）：看气泡靠哪边
    const row = (side, name, t) => '<div role="row" style="display:flex;justify-content:flex-' + (side === 'r' ? 'end' : 'start') + '"><div data-id="3EB' + Math.random().toString(36).slice(2, 8) + '"><div data-pre-plain-text="[10:00, 26/10/2026] ' + name + ': " style="width:220px"><span dir="ltr">' + t + '</span></div></div></div>';
    await w.webContents.executeJavaScript(`document.querySelector('#main').innerHTML = '<header><span title="Kunde Berlin">Kunde Berlin</span></header>'
      + ${JSON.stringify(row('l', 'Anna', 'Ist das noch da?') + row('r', 'Ich', 'Ja, noch da.') + row('l', 'Anna', 'Super, danke'))}; 1`);
    const r9 = await waPage.readOpenChat(w.webContents);
    assert.deepStrictEqual(r9.msgs.map((m) => [m.out, m.text]), [[false, 'Ist das noch da?'], [true, 'Ja, noch da.'], [false, 'Super, danke']]);
    // 读不出位置时看名字：私聊里对方名字就是对话标题，别的名字只能是自己
    const flat = (id, name, t, extra = '') => '<div role="row"><div data-id="' + id + '"><div data-pre-plain-text="[10:00, 26/10/2026] ' + name + ': "><span dir="ltr">' + t + '</span></div>' + extra + '</div></div>';
    await w.webContents.executeJavaScript(`document.querySelector('#main').innerHTML = '<header><span title="Anna Müller">Anna Müller</span></header>'
      + ${JSON.stringify(flat('3EC1', 'Anna Müller', 'Hallo') + flat('3EC2', 'Max', 'Gern geschehen') + flat('3EC3', 'Anna Müller', 'Tschüss'))}; 1`);
    const r10 = await waPage.readOpenChat(w.webContents);
    assert.deepStrictEqual(r10.msgs.map((m) => [m.out, m.text]), [[false, 'Hallo'], [true, 'Gern geschehen'], [false, 'Tschüss']]);
    // 群里：认得出的自己那条（带勾）的名字，同名的也是自己；别人的名字照样当收到的，客户消息不漏
    await w.webContents.executeJavaScript(`document.querySelector('#main').innerHTML = '<header><span title="Team Lyon">Team Lyon</span></header>'
      + ${JSON.stringify(flat('3ED1', 'Pierre', 'On commande ?') + flat('3ED2', 'Moi', 'Oui', '<span data-icon="msg-dblcheck"></span>') + flat('3ED3', 'Moi', 'Demain matin') + flat('3ED4', 'Lucie', 'Parfait'))}; 1`);
    const r11 = await waPage.readOpenChat(w.webContents);
    assert.deepStrictEqual(r11.msgs.map((m) => [m.out, m.text]), [[false, 'On commande ?'], [true, 'Oui'], [true, 'Demain matin'], [false, 'Parfait']]);
    assert(!JSON.stringify([r9, r10, r11]).includes('Moi') && !JSON.stringify([r9, r10, r11]).includes('Max'), '发送人名字不带出隔离环境');
    // 读到的结果交给翻译：自己发的不显示、不调模型、不算每天的额度
    {
      const called = [];
      const fcw = new FloatCore({ translate: async (text) => { called.push(text); return { text: '译', warn: [] }; } });
      for (const rr of [r9, r10, r11]) { fcw.ingest('W', rr, { auto: true, dailyCap: 500 }); await new Promise((res) => setTimeout(res, 10)); }
      assert.deepStrictEqual(called, ['Ist das noch da?', 'Super, danke', 'Hallo', 'Tschüss', 'On commande ?', 'Parfait']);
      assert.strictEqual(fcw.accs.get('W').day.n, 6, '只有收到的算额度');
      assert.deepStrictEqual(fcw.viewOf('W').items.map((x) => x.text), ['On commande ?', 'Parfait'], '翻译列表只有客户的');
    }
    await scrollStable(w, waPage);
    // 有消息行但一条都认不出：才算读不到
    await w.webContents.executeJavaScript(`document.querySelector('#main').innerHTML = '<header><span title="X">X</span></header><div role="row"><div>hi</div></div>'; 1`);
    assert.strictEqual((await waPage.readOpenChat(w.webContents)).why, 'nomatch');
    const empty = await w.webContents.executeJavaScript('document.querySelector("#main").remove(); 1');
    assert(empty);
    const r2 = await waPage.readOpenChat(w.webContents);
    assert.strictEqual(r2.why, 'nochat');
    // 还在二维码页（没登录）：单独说 qr，翻译页提示“扫码登录后可用”
    await w.webContents.executeJavaScript(`document.body.innerHTML = '<div data-ref="2@abc"><canvas aria-label="Scan this QR code"></canvas></div>'; 1`);
    assert.strictEqual((await waPage.readOpenChat(w.webContents)).why, 'qr');
    console.log('悬浮翻译只读脚本自检通过');
    app.exit(0);
  }).catch((e) => { console.error(e); app.exit(1); });
}).catch((e) => { console.error(e); process.exit(1); });

