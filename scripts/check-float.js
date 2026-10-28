// 悬浮翻译自检：自动翻译的取舍（只翻收到的、切对话只补最近 5 条、每分钟 20 条、每天上限、太长不自动翻）、
// 对外不出现 data-id、删号清缓存；再用 Electron 打开一个仿 WhatsApp 的页面，检查只读脚本读到的内容。
// 不连网络，不发真实请求。
const assert = require('assert');
const { FloatCore, fromLite, hashOf } = require('../src/floatcore');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (n, out = false, chat = '111@c.us', text = `hola ${n}`) => ({ id: `${out}_${chat}_ID${n}`, out, text });

async function core() {
  let now = Date.parse('2026-10-24T10:00:00Z');
  const sent = [];
  const fc = new FloatCore({ now: () => now, translate: async (text) => { sent.push(text); return { text: `译:${text}`, warn: [] }; } });
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
  assert.deepStrictEqual(fc.contextOf('C', hashOf('C', ctxMsgs[2].id)).map((m) => m.out), [false, true]);
  assert.strictEqual(fc.contextOf('C').length, 3);
  const hc = hashOf('C', ctxMsgs[2].id);
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
  assert(fc.manual('A', hashOf('A', first[0].id)));
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
  await sendNoJump();
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
    fc2.manual('R', hashOf('R', b.id)); // b 排在 a 后面；先让 a 跑着
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
  assert(fc.edit('P', hashOf('P', msgs[1].id), '再见（我改的）'));
  store.flush();
  const files = fs.readdirSync(path.join(dir, 'P'));
  assert.strictEqual(files.length, 1);
  const raw = fs.readFileSync(path.join(dir, 'P', files[0]), 'utf8');
  // 只查号码本身（555@），时间戳里碰巧有 555 不算
  assert(!raw.includes('"hello"') && !raw.includes('555@'), '磁盘上不存原文和号码');
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
  assert.strictEqual(fs.readdirSync(path.join(dir, 'P')).length, 2, '删号不删存的译文');
  fs.rmSync(dir, { recursive: true, force: true });
  // 存哪：Windows 上 D 盘是本机固定硬盘才放 D 盘，U 盘/移动硬盘/网络盘/查不出来/写不进去都回到 C（userData）；Mac 不变；
  // 旧文件搬过去一次，不覆盖新位置已有的
  const { pickDir, migrate, parseDriveProbe, isLocalFixed, dirInfo } = require('../src/trstore');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trdir-'));
  const oldDir = path.join(base, 'old');
  const dDir = path.join(base, 'D', 'WAswitch', 'translations');
  const fixed = async () => ({ type: 'Fixed', bus: 'NVMe' });
  assert.strictEqual(await pickDir(oldDir, { platform: 'darwin', preferred: dDir, probe: fixed }), oldDir);
  for (const [out, want] of [['Removable|USB', oldDir], ['Fixed|USB', oldDir], ['Fixed|SD', oldDir], ['Network|', oldDir], ['CDRom|', oldDir], ['NoRootDirectory|', oldDir], ['', oldDir], ['Fixed|SATA', dDir], ['Fixed|', dDir]]) {
    assert.strictEqual(await pickDir(oldDir, { platform: 'win32', preferred: dDir, probe: async () => parseDriveProbe(out) }), want, `D 盘是 ${out || '查不出来'}`);
  }
  assert.strictEqual(await pickDir(oldDir, { platform: 'win32', preferred: dDir, probe: async () => { throw new Error('x'); } }), oldDir, '查盘出错就用 C');
  assert.deepStrictEqual(parseDriveProbe('Fixed|NVMe\r\n'), { type: 'Fixed', bus: 'NVMe' });
  assert(!isLocalFixed(parseDriveProbe('Fixed|7')), 'BusType 是数字 7 也是 USB');
  fs.writeFileSync(path.join(base, 'file'), '');
  assert.strictEqual(await pickDir(oldDir, { platform: 'win32', preferred: path.join(base, 'file', 'x'), probe: fixed }), oldDir, '写不进去就用 C');
  fs.mkdirSync(path.join(oldDir, 'A'), { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'A', 'c1.json'), '{"k":1}');
  fs.writeFileSync(path.join(oldDir, 'A', 'c2.json'), '{"k":"old"}');
  fs.mkdirSync(path.join(dDir, 'A'), { recursive: true });
  fs.writeFileSync(path.join(dDir, 'A', 'c2.json'), '{"k":"new"}');
  assert.strictEqual(migrate(oldDir, dDir), 1);
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

