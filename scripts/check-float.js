// 悬浮翻译自检：自动翻译的取舍（只翻收到的、切对话只补最近 5 条、每分钟 20 条、每天上限、太长不自动翻）、
// 对外不出现 data-id、删号清缓存；再用 Electron 打开一个仿 WhatsApp 的页面，检查只读脚本读到的内容。
// 不连网络，不发真实请求。
const assert = require('assert');
const { FloatCore, hashOf } = require('../src/floatcore');

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
    const empty = await w.webContents.executeJavaScript('document.querySelector("#main").remove(); 1');
    assert(empty);
    const r2 = await waPage.readOpenChat(w.webContents);
    assert.strictEqual(r2.why, 'nochat');
    console.log('悬浮翻译只读脚本自检通过');
    app.exit(0);
  }).catch((e) => { console.error(e); app.exit(1); });
}).catch((e) => { console.error(e); process.exit(1); });

