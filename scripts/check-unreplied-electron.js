// 「待回复」端到端自检：真实结构的 WhatsApp 对话列表 → 读出没回的对话 → 列在「待回复」页 → 点一下打开那个对话。
//   1) wa-page.js 的 readChatList（reply）在 scripts/fixtures/wa-chatlist-real.html 上认出谁最后说话、过了多久，只读不动页面；
//      不带 reply 时输出和以前一样（MCP 的 list_chats 不变）
//   2) 读两次后 unreplied.js 列出客户最后说话、超过 30 分钟的私聊（存了名字、没查号码的也列），不列自己回过的和群（照片头像的群看预览前的发送人）
//   3) 点开：createUnrepliedOpener + 真的 chat-open.js 让页面跳到 web.whatsapp.com/send?phone=号码（这里换成打开了这个对话的假页面），
//      确认打开的就是这个号码的对话；在打开的对话里我们说完话，交给 followup.js（假的 AI 回答），待跟进和列表上的同一行合起来
//   4) 真的 shell 页面 + 假的主进程：侧栏「待回复」带个数，页面分待回复、待跟进、已完成三段（已完成默认收起，每次进来都收起），
//      点一行带回号和对话，输入框有字时问一次，点左边的圆圈算办完，已完成里点绿勾放回；
//      900×600 和 1200×760 下文字不被裁。SHOT_DIR 设了就存截图
// 用法：xvfb-run -a -s "-screen 0 1920x1200x24" node scripts/run-check-electron.js scripts/check-unreplied-electron.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');
const waPage = require('../src/wa-page');
const { Unreplied, createUnrepliedOpener, todoKey } = require('../src/unreplied');
const { Followup, chatOf } = require('../src/followup');
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
    assert.strictEqual(by['Sophie Martin'].last, 'Do you ship to Lyon? And what is the price for 20 trays?', '预览文字（客户最后一句）读得出');
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
    assert.strictEqual(by['Team Lyon'].sender, true, '头像是照片的群：预览前面有发送人');
    // 中文界面（fingerprint.js 让 WhatsApp 用 zh-CN）：发送人后面可能是全角「：」，冒号单独一段或者跟着名字
    const zh = await wc.executeJavaScript(`(() => { try {
      const src = [...document.querySelectorAll('#pane-side [role=row]')].find((r) => r.querySelector('[title="Team Lyon"]'));
      const add = (name, html) => {
        const c = src.cloneNode(true);
        const t = c.querySelector('[title="Team Lyon"]');
        t.setAttribute('title', name);
        t.textContent = name;
        c.querySelector('[title^="Paul"]').outerHTML = html;
        src.parentNode.appendChild(c);
      };
      add('里昂团队', '<span title="安娜：好的" class="x78zum5 x1cy8zhl"><span dir="auto" class="_ao3e">安娜</span><span>： </span><span dir="ltr" class="_ao3e">好的</span></span>');
      add('巴黎团队', '<span title="安娜：好" class="x78zum5 x1cy8zhl"><span dir="auto" class="_ao3e">安娜：</span><span dir="ltr" class="_ao3e">好</span></span>');
      add('Nina Koch', '<span title="Preis：20 EUR" class="x78zum5 x1cy8zhl"><span dir="ltr" class="_ao3e">Preis：20 EUR</span></span>');
      return true;
    } catch (e) { return String(e); } })()`);
    assert.strictEqual(zh, true);
    const rz = await waPage.readChatList(wc, { reply: true });
    const bz = Object.fromEntries(rz.chats.map((c) => [c.name, c]));
    assert.strictEqual(bz['里昂团队'].sender, true, '全角「：」单独一段认出是群');
    assert.strictEqual(bz['巴黎团队'].sender, true, '全角「：」跟着名字也认出是群');
    assert.strictEqual(bz['Nina Koch'].sender, false, '私聊消息里带全角冒号不算');
    await wc.executeJavaScript("[...document.querySelectorAll('#pane-side [role=row]')].slice(-3).forEach((r) => r.remove())");
    assert.strictEqual(by['Sophie Martin'].sender, false, '私聊没有发送人');
    assert.strictEqual(by['+44 7700 900123'].sender, false, '语音时长 0:23 不当成发送人');
    assert(Array.isArray(r.icons) && r.icons.includes('status-dblcheck') && r.icons.includes('msg-dblcheck'), `图标名带出来写日志 ${JSON.stringify(r.icons)}`);
    assert.strictEqual(store.get('w1', 'Team Lyon'), null, '头像是照片的群不记');
    assert.strictEqual(store.get('w1', 'Sophie Martin').digits, undefined, '存了名字的不先查号码');
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

    // ---- 3b) 待跟进：我们在打开的对话里说完话 → 读出来交给 followup.js → AI 说还欠一件事 → 和列表上同一个对话合成一行 ----
    const sentAgo = clockAgo(60); // 我们一小时前说的（过了半夜就是 00:00）
    const today = new Date();
    const pre = `[${sentAgo.text}, ${today.getDate()}/${today.getMonth() + 1}/${today.getFullYear()}] Me: `;
    await wc.executeJavaScript(`(() => {
      const src = document.querySelector('#main [role=row]');
      const row = src.cloneNode(true);
      const d = row.querySelector('[data-id]');
      d.setAttribute('data-id', 'true_447700900123@c.us_3EB0B2');
      row.querySelector('[data-pre-plain-text]').setAttribute('data-pre-plain-text', ${JSON.stringify(pre)});
      row.querySelector('.selectable-text span').textContent = 'Sure, I will send the catalogue later today.';
      src.parentNode.appendChild(row);
    })()`);
    const oc = await waPage.readOpenChat(wc);
    assert(oc.ok && oc.msgs.length === 2 && oc.msgs[1].out === true && oc.msgs[0].out === false, `打开的对话读得出谁说的 ${JSON.stringify(oc.msgs)}`);
    const seen = chatOf(oc, null, todoKey);
    assert(seen && seen.info.digits === '447700900123', `网页号：号码从对话编号认出来 ${JSON.stringify(seen)}`);
    assert.strictEqual(chatOf({ ...oc, group: true }, null, todoKey), null, '群不看');
    assert.strictEqual(chatOf({ ...oc, bottom: false }, null, todoKey), null, '往上翻着看旧消息时不看');
    let fnow = Date.now();
    const asked = [];
    const fu = new Followup({
      now: () => fnow,
      analyzed: (id, key) => store.analyzed(id, key),
      supported: () => true,
      send: async (m) => { asked.push(m); return '{"todo": true, "what": "发产品目录", "when": "soon"}'; },
      onResult: (id, key, info, res, meta) => store.setTodo(id, key, info, res, meta),
    });
    fu.observe('w1', seen.key, seen.info, oc.msgs);
    fnow += 46000;
    assert.strictEqual(await fu.tick(), true);
    assert(asked[0][1].content.includes('我：Sure, I will send the catalogue later today.'), asked[0][1].content);
    assert.strictEqual(store.getTodo('w1', target.key).what, '发产品目录', '列表上的名字和对话顶上的标题对得上');
    if (sentAgo.age >= 31) { // 刚过半夜跑时还没到期，只看上面那条
      const merged = store.list().filter((e) => e.name.includes('7700'));
      assert.strictEqual(merged.length, 1, `和列表上同一个对话只列一行 ${JSON.stringify(merged)}`);
      assert.strictEqual(merged[0].what, '发产品目录');
    }
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
      { accountId: 'a2', key: 'Emma Wilson', name: 'Emma Wilson', since: now - 26 * 3600e3, last: 'Hi, do you have the 0.07 C curl trays in stock? We need about 500 boxes before the end of the month for our salons in Manchester.' },
      { accountId: 'a1', key: '‪+44 7700 900123‬', name: '‪+44 7700 900123‬', since: now - 4 * 3600e3 - 60e3 },
      { accountId: 'a3', key: '14155550134@s.whatsapp.net', kind: 'todo', name: 'Olivia Johnson', since: now - 3 * 3600e3, what: '发样品照片和批发价目表' },
      { accountId: 'a1', key: 'Sophie Martin', kind: 'reply', name: 'Sophie Martin-Lefèvre (Lyon Beauty Supplies)', since: now - 45 * 60e3 - 20e3, what: '确认交期后回复客户并发送新的价目表和合同' },
    ];
    const doneItems = [
      { accountId: 'a2', key: 'James Wilson', kind: 'reply', name: 'James Wilson', doneAt: now - 5 * 60e3 },
      { accountId: 'a1', key: '‪+34 612 345 678‬', kind: 'reply', name: '‪+34 612 345 678‬', doneAt: now - 26 * 3600e3 },
    ];
    const preload = path.join(app.getPath('temp'), `ur-fake-preload-${process.pid}.js`);
    fs.writeFileSync(preload, `window.__cbs = {}; window.__calls = []; window.__next = null;
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'onUndoOffer') return (cb) => { window.__cbs.undo = cb; };
  if (k === 'showPage') return (p) => { window.__calls.push(['showPage', p]); };
  if (k === 'unrepliedOpen') return async (a, key, force) => { window.__calls.push(['open', a, key, force]); const r = window.__next || { result: 'opened' }; window.__next = null; return r; };
  if (k === 'unrepliedDismiss') return async (a, key) => { window.__calls.push(['dismiss', a, key]); return true; };
  if (k === 'unrepliedRestore') return async (a, key, kind) => { window.__calls.push(['restore', a, key, kind]); return true; };
  if (k === 'panelData') return async () => ({ replies: [], customers: [] });
  if (k === 'notifLog') return async () => [];
  return async () => null;
} });`);
    const w = new BrowserWindow({ show: true, width: 1200, height: 760, webPreferences: { preload, contextIsolation: false, sandbox: false } });
    w.webContents.on('console-message', (e) => { if (e.level === 'error' || /Error/.test(e.message || '')) errs.push(e.message); });
    await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
    const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
    const shot = async (name) => { if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
    const base = { accounts, groups: [], activeId: 'a1', platform: 'linux', collapsed: false, settings: {}, page: 'account', unreplied: { count: items.length, list: items, done: doneItems } };
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

    // 看文字有没有被裁：nowrap 的行要么放得下，要么是允许省略号的名字和第二行
    const clipped = () => js(() => {
      const bad = [];
      for (const el of document.querySelectorAll('.ur-wait, .ur-acc, .ur-sh, #side .tool-row .name, .ur-ask .btn, .ur-ask span, h1')) {
        if (el.scrollWidth > el.clientWidth + 1) bad.push(el.className + ':' + el.textContent);
      }
      const rows = [...document.querySelectorAll('.ur-row')].map((r) => ({ h: r.getBoundingClientRect().height, two: !!r.querySelector('.ur-what'), done: r.classList.contains('done') }));
      // 第二行：一行，放不下截掉（省略号），不换行
      const what = [...document.querySelectorAll('.ur-what')].map((el) => ({ text: el.textContent, h: el.getBoundingClientRect().height, ellipsis: getComputedStyle(el).textOverflow, size: getComputedStyle(el).fontSize }));
      return { bad, rows, what };
    });
    const heads = () => js(() => [...document.querySelectorAll('.ur-sh')].map((x) => x.textContent));
    for (const [wd, ht, label] of [[1200, 760, 'wide'], [900, 600, 'min']]) {
      w.setSize(wd, ht);
      await push({ page: 'unreplied' });
      await wait(300);
      assert.deepStrictEqual(await heads(), ['待回复3', '待跟进1', '已完成2'], '三段标题带个数');
      assert.strictEqual(await js(() => document.querySelectorAll('.ur-row.done').length), 0, '已完成默认收起');
      const rows = await js(() => [...document.querySelectorAll('.ur-row')].map((r) => ({ text: r.textContent, x: !!r.querySelector('.ur-done .ur-circle'), first: r.firstElementChild.className })));
      assert.strictEqual(rows.length, 4, `页面列出 4 个对话 ${JSON.stringify(rows)}`);
      assert(rows[0].text.includes('Emma Wilson') && rows[0].text.includes('Sales FR') && rows[0].text.includes('1 天') && rows[0].text.includes('curl trays'), `第一行：名字、号、客户最后一句、等了多久 ${rows[0].text}`);
      assert(rows[1].text.includes('4 小时'), rows[1].text);
      assert(rows[2].text.includes('45 分钟'), `不到 1 小时写分钟 ${rows[2].text}`);
      assert(rows[3].text.includes('Olivia Johnson'), `待跟进在第二段 ${rows[3].text}`);
      assert(rows.every((x) => x.x && x.first === 'ur-done'), '每行最左边是圆圈');
      const circle = await js(() => { const b = document.querySelector('.ur-circle').getBoundingClientRect(); const o = document.querySelector('.ur-open').getBoundingClientRect(); return { w: b.width, h: b.height, left: b.right <= o.left, mid: Math.abs((b.top + b.bottom) / 2 - (o.top + o.bottom) / 2) }; });
      assert(circle.w === 18 && circle.h === 18 && circle.left && circle.mid <= 0.5, `圆圈 18px、在行左边、上下居中 ${JSON.stringify(circle)}`);
      let c = await clipped();
      assert.deepStrictEqual(c.bad, [], `${label}：文字没被裁 ${JSON.stringify(c.bad)}`);
      assert(c.rows.every((r) => r.h >= 52 && r.h <= 56), `${label}：每行一样高 ${JSON.stringify(c.rows)}`);
      assert.deepStrictEqual(c.rows.map((r) => r.two), [true, false, true, true], '有客户最后一句或 what 的行多一行');
      assert(c.what.length === 3 && c.what.every((x) => x.h <= 18 && x.ellipsis === 'ellipsis' && x.size === '12px'), `${label}：第二行一行、12px、放不下截掉 ${JSON.stringify(c.what)}`);
      assert.strictEqual(c.what[1].text, '确认交期后回复客户并发送新的价目表和合同', '待回复里没有客户最后一句时写 what');
      assert.strictEqual(c.what[2].text, '发样品照片和批发价目表');
      await shot(`unreplied-${label}`);
      // 点「已完成」展开：矮一些、一行、绿勾、钟点
      await js(() => document.querySelector('.ur-fold').click());
      await wait(300);
      const done = await js(() => [...document.querySelectorAll('.ur-row.done')].map((r) => ({ text: r.textContent, label: r.querySelector('.ur-done').getAttribute('aria-label'), bg: getComputedStyle(r.querySelector('.ur-circle')).backgroundColor })));
      assert.strictEqual(done.length, 2, `展开后两行 ${JSON.stringify(done)}`);
      assert.strictEqual(await js(() => document.querySelector('.ur-fold').getAttribute('aria-expanded')), 'true');
      assert(done[0].text.includes('James Wilson') && /\d\d:\d\d/.test(done[0].text) && done[1].text.includes('昨天'), `今天写钟点，昨天写「昨天」 ${JSON.stringify(done)}`);
      assert.strictEqual(done[0].label, '放回待回复「James Wilson」');
      assert.strictEqual(done[0].bg, 'rgb(48, 164, 108)', `绿勾 ${done[0].bg}`);
      c = await clipped();
      assert.deepStrictEqual(c.bad, [], `${label}：展开后文字没被裁 ${JSON.stringify(c.bad)}`);
      assert(c.rows.filter((r) => r.done).every((r) => r.h <= 40 && !r.two), `${label}：已完成一行、矮一些 ${JSON.stringify(c.rows)}`);
      await shot(`unreplied-${label}-done`);
      // 换一页再回来：又是收起的
      await push({ page: 'account' });
      await wait(100);
    }
    await push({ page: 'unreplied' });
    await wait(150);
    assert.strictEqual(await js(() => document.querySelector('.ur-fold').getAttribute('aria-expanded')), 'false', '再进来已完成是收起的');
    await js(() => document.querySelector('.ur-fold').click());
    await wait(100);
    await js(() => document.querySelector('.ur-row.done .ur-done').click());
    await wait(100);
    assert.deepStrictEqual((await js(() => window.__calls)).pop(), ['restore', 'a2', 'James Wilson', 'reply'], '点绿勾放回');
    // 状态推过来（主进程每分钟一次）不把展开的已完成收起来
    await push({ page: 'unreplied', unreplied: { count: items.length, list: items, done: doneItems.slice(1) } });
    await wait(100);
    assert.strictEqual(await js(() => document.querySelectorAll('.ur-row.done').length), 1, '推过来新的状态，已完成还开着');
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
    await js(() => { window.__next = { result: 'not_empty' }; document.querySelectorAll('.ur-open')[2].click(); });
    await wait(200);
    const ask = await js(() => document.querySelector('.ur-ask')?.textContent || '');
    assert(ask.includes('输入框里有没发的字') && ask.includes('仍然打开'), `输入框有字时问一次 ${ask}`);
    await shot('unreplied-ask');
    assert.deepStrictEqual((await clipped()).bad, [], '提问那行没被裁');
    await js(() => [...document.querySelectorAll('.ur-ask .btn')].find((b) => b.textContent === '仍然打开').click());
    await wait(100);
    assert.deepStrictEqual((await js(() => window.__calls)).pop(), ['open', 'a1', 'Sophie Martin', true], '仍然打开带 force');
    assert.strictEqual(await js(() => !!document.querySelector('.ur-ask')), false, '打开后提问收起');
    // 点圆圈：办完
    assert.strictEqual(await js(() => document.querySelectorAll('.ur-done')[0].getAttribute('aria-label')), '完成「Emma Wilson」');
    await js(() => document.querySelectorAll('.ur-done')[0].click());
    await wait(100);
    assert.deepStrictEqual((await js(() => window.__calls)).pop(), ['dismiss', 'a2', 'Emma Wilson'], '点圆圈办完这一个');
    // 只有已完成：写一句，下面是已完成
    await push({ page: 'unreplied', unreplied: { count: 0, list: [], done: doneItems } });
    await wait(150);
    assert.strictEqual(await js(() => document.querySelector('#side [aria-label="待回复"] .pill')), null, '侧栏个数不算已完成');
    assert(/没有要回复或跟进的对话/.test(await js(() => document.querySelector('#content').textContent)), '上面两段空的时候写一句');
    assert.deepStrictEqual(await heads(), ['已完成2'], '空的段不显示');
    // 都空
    await push({ page: 'unreplied', unreplied: { count: 0, list: [], done: [] } });
    await wait(150);
    assert.deepStrictEqual(await heads(), [], '三段都空没有标题');
    assert(/没有要回复或跟进的对话/.test(await js(() => document.querySelector('#content').textContent)), '空的时候写一句');
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
