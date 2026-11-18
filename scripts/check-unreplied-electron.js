// 「待回复」端到端自检：真实结构的 WhatsApp 对话列表 → 读出没回的对话 → 列在「待回复」页 → 点一下打开那个对话。
//   1) wa-page.js 的 readChatList（reply）在 scripts/fixtures/wa-chatlist-real.html 上认出谁最后说话、过了多久，只读不动页面；
//      不带 reply 时输出和以前一样（MCP 的 list_chats 不变）
//   2) 读两次后 unreplied.js 列出客户最后说话、超过 2 小时的私聊，不列自己回过的和群
//   3) 点开：createUnrepliedOpener + 真的 chat-open.js 让页面跳到 web.whatsapp.com/send?phone=号码（这里换成打开了这个对话的假页面），
//      确认打开的就是这个号码的对话
//   4) 真的 shell 页面 + 假的主进程：侧栏「待回复」带个数，页面列出对话，点一行带回号和对话，输入框有字时问一次，× 忽略；
//      900×600 和 1200×760 下文字不被裁。SHOT_DIR 设了就存截图
// 用法：xvfb-run -a -s "-screen 0 1920x1200x24" node scripts/run-check-electron.js scripts/check-unreplied-electron.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');
const waPage = require('../src/wa-page');
const { Unreplied, createUnrepliedOpener } = require('../src/unreplied');
const { createChatOpener } = require('../src/chat-open');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
// n 分钟前的钟点；跨过了半夜就用 00:00（这时只算到半夜的下限）
function clockAgo(min) {
  const now = new Date();
  const t = new Date(now.getTime() - min * 60000);
  const d = t.toDateString() === now.toDateString() ? t : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0);
  return { text: `${pad(d.getHours())}:${pad(d.getMinutes())}`, age: Math.round((now - d) / 60000) };
}
const OPEN_CHAT = (title, digits) => `<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp</title></head><body>
<div id="side"><div id="pane-side"></div></div>
<div id="main"><header><div><span dir="auto" title="${title}">${title}</span></div><div><span title="click here for contact info">click here for contact info</span></div></header>
<div role="application"><div role="row"><div tabindex="-1" data-id="false_${digits}@c.us_3EB0A1"><div class="m"><div class="copyable-text" data-pre-plain-text="[09:12, 18/11/2026] ${title}: "><span class="selectable-text copyable-text"><span>Hello</span></span></div></div></div></div></div>
<footer><div contenteditable="true" role="textbox" data-testid="conversation-compose-box-input"><p><br></p></div></footer></div></body></html>`;

app.whenReady().then(async () => {
  const errs = [];
  try {
    // ---- 1) 读对话列表 ----
    const t0 = clockAgo(180);
    const t2 = clockAgo(240);
    const hash = encodeURIComponent(JSON.stringify({ t0: t0.text, t1: clockAgo(170).text, t2: t2.text, t3: clockAgo(300).text, t4: clockAgo(310).text, t5: clockAgo(185).text }));
    const wa = new BrowserWindow({ show: true, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true } });
    await wa.loadURL(`file://${path.join(__dirname, 'fixtures', 'wa-chatlist-real.html')}#${hash}`);
    await wa.webContents.executeJavaScript('window.__idb');
    await wait(100);
    const wc = wa.webContents;
    await wc.executeJavaScript('Object.assign(window.__events, { clicks: 0, scrolls: 0, mutations: 0, focus: 0 })');
    const plain = await waPage.readChatList(wc, { includePreview: false });
    assert(plain.ok && plain.chats.length === 8, `读到 8 个对话 ${JSON.stringify(plain)}`);
    assert(plain.chats.every((c) => !('out' in c) && !('age' in c)), '不带 reply 时不多给字段（MCP 的 list_chats 不变）');
    const r = await waPage.readChatList(wc, { reply: true });
    assert(r.ok, JSON.stringify(r));
    const by = Object.fromEntries(r.chats.map((c) => [c.name.replace(/[‪-‮]/g, ''), c]));
    assert.strictEqual(r.atTop, true, '列表在最上面');
    assert.strictEqual(by['Sophie Martin'].out, false, '客户发的文字：没有勾');
    assert(Math.abs(by['Sophie Martin'].age - t0.age) <= 1, `过了多久按列表时间算 ${by['Sophie Martin'].age} vs ${t0.age}`);
    assert.strictEqual(by['Lukas Weber'].out, true, '老版勾 status-dblcheck 认成自己发的');
    assert.strictEqual(by['Marie Dubois'].out, true, '新版勾 msg-dblcheck 认成自己发的');
    assert.strictEqual(by['Carlos García'].out, true, '发送中的钟 msg-time 认成自己发的');
    assert.strictEqual(by['+44 7700 900123'].out, false, '收到的语音图标 status-ptt 不是勾');
    assert.strictEqual(by['+44 7700 900123'].unread, 2);
    assert.strictEqual(by['Lash Supply EU'].is_group, true, '群认得出');
    const nowD = new Date();
    assert.strictEqual(by['Emma Wilson'].age, nowD.getHours() * 60 + nowD.getMinutes(), '昨天：至少过了今天这么久');
    assert(by['Carlos García'].age >= 0, '星期几也算得出下限');
    assert.deepStrictEqual(await wc.executeJavaScript('window.__events'), { clicks: 0, scrolls: 0, mutations: 0, focus: 0 }, '读的时候没动页面');

    // 往下翻过对话列表：atTop 是 false（这时不拿画出来的行判断谁不在列表上了）
    await wc.executeJavaScript("(() => { const p = document.getElementById('pane-side'); p.style.height = '120px'; p.style.overflow = 'auto'; p.scrollTop = 200; return p.scrollTop; })()");
    assert.strictEqual((await waPage.readChatList(wc, { reply: true })).atTop, false, '往下翻过时 atTop 是 false');
    await wc.executeJavaScript("(() => { const p = document.getElementById('pane-side'); p.scrollTop = 0; p.style.height = ''; p.style.overflow = ''; })()");
    assert.strictEqual((await waPage.readChatList(wc, { reply: true })).atTop, true, '翻回最上面 atTop 是 true');
    // 滚动的是里面别的元素时：画出来的行里没有第一行（list-item-0）也算往下翻过
    await wc.executeJavaScript("document.querySelector('[data-testid=list-item-0]').setAttribute('data-testid', 'list-item-12')");
    assert.strictEqual((await waPage.readChatList(wc, { reply: true })).atTop, false, '没有第一行时 atTop 是 false');
    await wc.executeJavaScript("document.querySelector('[data-testid=list-item-12]').setAttribute('data-testid', 'list-item-0')");

    // ---- 2) 列出没回的 ----
    const store = new Unreplied();
    store.ingestWeb('w1', r.chats, { atTop: r.atTop });
    await wait(50);
    const r2 = await waPage.readChatList(wc, { reply: true });
    store.ingestWeb('w1', r2.chats, { atTop: r2.atTop });
    // 和 main.js 一样：新记下的对话去 WhatsApp 本地联系人里按名字查号码
    for (const { key, name } of store.needsNumber('w1', 99)) {
      const found = await waPage.lookupPeerPhone(wc, { title: name });
      store.setNumber('w1', key, found.digits, /^(notfound|samename|nodb|noidb)$/.test(found.why || ''));
    }
    assert.strictEqual(store.get('w1', 'Sophie Martin').digits, '33611111111', '存了名字的联系人查到号码');
    assert.strictEqual(store.get('w1', 'Team Lyon').noNum, true, '头像是照片的群查不到号码');
    const list = store.list();
    const names = list.map((e) => e.name.replace(/[‪-‮]/g, ''));
    assert(names.includes('Sophie Martin') && names.includes('+44 7700 900123'), `没回的列出来 ${JSON.stringify(names)}`);
    for (const n of ['Lukas Weber', 'Marie Dubois', 'Carlos García', 'Lash Supply EU', 'Team Lyon']) assert(!names.includes(n), `${n} 不该列`);
    assert(list.every((e, k) => !k || list[k - 1].since <= e.since), '等得久的在前');

    // ---- 3) 点开 ----
    const target = list.find((e) => e.name.includes('7700'));
    const navigated = [];
    const acc = { id: 'w1', mode: 'web' };
    const chatOpener = createChatOpener({
      findAcc: (id) => (id === 'w1' ? acc : null),
      isLite: () => false,
      userBusy: () => false,
      problem: () => false,
      activate: () => {},
      activateForUser: async () => {},
      webContents: () => wc,
      waPage,
      navigate: (_id, url) => { navigated.push(url); wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OPEN_CHAT(target.name, '447700900123'))}`); return true; },
      liteChats: () => [],
      liteOpen: () => {},
      request: () => null,
      setRequest: () => {},
      clearRequest: () => {},
      wait,
    });
    const activated = [];
    const opener = createUnrepliedOpener({
      store: () => store,
      findAcc: (id) => (id === 'w1' ? acc : null),
      isLite: () => false,
      locked: () => false,
      webContents: () => (wc.isLoading() ? null : wc),
      waPage,
      activate: async (id) => { activated.push(id); },
      liteOpen: () => {},
      // main.js 接的是 chat-open.js 的 openForUser；它和 MCP 的 open 走同一段网页版打开（openWeb），这里用 open（不看用户忙不忙）
      openNumber: (id, digits) => (chatOpener.openForUser ? chatOpener.openForUser({ accountId: id, phone: digits, force: true }) : chatOpener.open({ accountId: id, phone: digits })),
    });
    const res = await opener.open(target.accountId, target.key);
    assert.deepStrictEqual(res, { result: 'opened' }, `打开结果 ${JSON.stringify(res)}`);
    assert.deepStrictEqual(navigated, ['https://web.whatsapp.com/send?phone=447700900123'], '用 WhatsApp 自己的链接打开这个号码');
    assert.deepStrictEqual(activated, ['w1'], '切到了那个号');
    const peer = await waPage.readChatPeer(wc);
    assert(peer && peer.chat === '447700900123@c.us' && peer.title === target.name, `打开的就是这个对话 ${JSON.stringify(peer)}`);
    // 再点一次：已经开着，不再刷新
    assert.deepStrictEqual(await opener.open(target.accountId, target.key), { result: 'already' });
    assert.strictEqual(navigated.length, 1, '已经开着不再跳转');
    wa.destroy();

    // ---- 4) 界面 ----
    const calls = [];
    const now = Date.now();
    const accounts = [
      { id: 'a1', name: 'Sales DE', color: '#3b82f6', proxyLabel: '直连', mode: 'web', unread: 1 },
      { id: 'a2', name: 'Sales FR', color: '#16a34a', proxyLabel: '直连', mode: 'web' },
      { id: 'a3', name: 'Lite US', color: '#ea580c', proxyLabel: '直连', mode: 'lite' },
    ];
    const items = [
      { accountId: 'a2', key: 'Emma Wilson', name: 'Emma Wilson', since: now - 26 * 3600e3 },
      { accountId: 'a1', key: '‪+44 7700 900123‬', name: '‪+44 7700 900123‬', since: now - 4 * 3600e3 - 60e3 },
      { accountId: 'a3', key: '14155550134@s.whatsapp.net', name: 'Olivia Johnson', since: now - 3 * 3600e3 },
      { accountId: 'a1', key: 'Sophie Martin', name: 'Sophie Martin-Lefèvre (Lyon Beauty Supplies)', since: now - 2 * 3600e3 - 120e3 },
    ];
    const preload = path.join(app.getPath('temp'), `ur-fake-preload-${process.pid}.js`);
    fs.writeFileSync(preload, `window.__cbs = {}; window.__calls = []; window.__next = null;
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'onUndoOffer') return (cb) => { window.__cbs.undo = cb; };
  if (k === 'showPage') return (p) => { window.__calls.push(['showPage', p]); };
  if (k === 'unrepliedOpen') return async (a, key, force) => { window.__calls.push(['open', a, key, force]); const r = window.__next || { result: 'opened' }; window.__next = null; return r; };
  if (k === 'unrepliedDismiss') return async (a, key) => { window.__calls.push(['dismiss', a, key]); return true; };
  if (k === 'panelData') return async () => ({ replies: [], customers: [] });
  if (k === 'notifLog') return async () => [];
  return async () => null;
} });`);
    const w = new BrowserWindow({ show: true, width: 1200, height: 760, webPreferences: { preload, contextIsolation: false, sandbox: false } });
    w.webContents.on('console-message', (e) => { if (e.level === 'error' || /Error/.test(e.message || '')) errs.push(e.message); });
    await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
    const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
    const shot = async (name) => { if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
    const base = { accounts, groups: [], activeId: 'a1', platform: 'linux', collapsed: false, settings: {}, page: 'account', unreplied: { count: items.length, list: items } };
    const push = (extra) => js((st) => window.__cbs.state(st), { ...base, ...extra });
    await push({});
    await wait(200);
    const side = await js(() => {
      const b = document.querySelector('#side [aria-label="待回复"]');
      return b ? { text: b.textContent, pill: b.querySelector('.pill')?.textContent } : null;
    });
    assert.deepStrictEqual(side, { text: '待回复4', pill: '4' }, `侧栏有「待回复」和个数 ${JSON.stringify(side)}`);
    await js(() => document.querySelector('#side [aria-label="待回复"]').click());
    assert.deepStrictEqual((await js(() => window.__calls)).pop(), ['showPage', 'unreplied'], '点侧栏打开待回复页');

    // 看文字有没有被裁：nowrap 的行要么放得下，要么是允许省略号的名字
    const clipped = () => js(() => {
      const bad = [];
      for (const el of document.querySelectorAll('.ur-wait, #side .tool-row .name, .ur-list .hint, .ur-ask .btn, h1')) {
        if (el.scrollWidth > el.clientWidth + 1 && !el.closest('.ov-name')) bad.push(el.className + ':' + el.textContent);
      }
      const rows = [...document.querySelectorAll('.ur-open')].map((b) => b.getBoundingClientRect().height);
      return { bad, rows };
    });
    for (const [wd, ht, label] of [[1200, 760, 'wide'], [900, 600, 'min']]) {
      w.setSize(wd, ht);
      await push({ page: 'unreplied' });
      await wait(300);
      const rows = await js(() => [...document.querySelectorAll('.ur-row')].map((r) => ({ text: r.textContent, x: !!r.querySelector('.ur-x') })));
      assert.strictEqual(rows.length, 4, `页面列出 4 个对话 ${JSON.stringify(rows)}`);
      assert(rows[0].text.includes('Emma Wilson') && rows[0].text.includes('Sales FR') && rows[0].text.includes('1 天'), `第一行：名字、号、等了多久 ${rows[0].text}`);
      assert(rows[1].text.includes('4 小时'), rows[1].text);
      assert(rows.every((x) => x.x), '每行有忽略');
      const c = await clipped();
      assert.deepStrictEqual(c.bad, [], `${label}：文字没被裁 ${JSON.stringify(c.bad)}`);
      assert(c.rows.every((hh) => hh <= 40), `${label}：每行一行高 ${JSON.stringify(c.rows)}`);
      await shot(`unreplied-${label}`);
    }
    // 收起侧栏：图标上带个数
    await push({ page: 'unreplied', collapsed: true });
    await wait(150);
    assert.strictEqual(await js(() => document.querySelector('#side [aria-label="待回复"] .dot')?.textContent), '4', '收起侧栏时图标上有个数');
    await shot('unreplied-collapsed');
    await push({ page: 'unreplied', collapsed: false });
    await wait(150);

    // 点一行：带回号和对话
    await js(() => document.querySelectorAll('.ur-open')[1].click());
    await wait(100);
    assert.deepStrictEqual((await js(() => window.__calls)).pop(), ['open', 'a1', '‪+44 7700 900123‬', false], '点一行打开这个对话');
    // 输入框有字：问一次，点「仍然打开」带 force
    await js(() => { window.__next = { result: 'not_empty' }; document.querySelectorAll('.ur-open')[3].click(); });
    await wait(200);
    const ask = await js(() => document.querySelector('.ur-ask')?.textContent || '');
    assert(ask.includes('输入框里有没发的字') && ask.includes('仍然打开'), `输入框有字时问一次 ${ask}`);
    await shot('unreplied-ask');
    assert.deepStrictEqual((await clipped()).bad, [], '提问那行没被裁');
    await js(() => [...document.querySelectorAll('.ur-ask .btn')].find((b) => b.textContent === '仍然打开').click());
    await wait(100);
    assert.deepStrictEqual((await js(() => window.__calls)).pop(), ['open', 'a1', 'Sophie Martin', true], '仍然打开带 force');
    assert.strictEqual(await js(() => !!document.querySelector('.ur-ask')), false, '打开后提问收起');
    // × 忽略
    await js(() => document.querySelectorAll('.ur-x')[0].click());
    await wait(100);
    assert.deepStrictEqual((await js(() => window.__calls)).pop(), ['dismiss', 'a2', 'Emma Wilson'], '× 忽略这一个');
    // 空的时候
    await push({ page: 'unreplied', unreplied: { count: 0, list: [] } });
    await wait(150);
    assert.strictEqual(await js(() => document.querySelector('#side [aria-label="待回复"] .pill')), null, '没有时不显示个数');
    assert(/没有超过 2 小时没回的对话/.test(await js(() => document.querySelector('#content').textContent)), '空的时候写一句');
    await shot('unreplied-empty');
    assert.deepStrictEqual(errs, [], `页面没有报错 ${JSON.stringify(errs)}`);
    fs.rmSync(preload, { force: true });
    console.error('check-unreplied-electron: ok');
    app.exit(0);
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    app.exit(1);
  }
});
