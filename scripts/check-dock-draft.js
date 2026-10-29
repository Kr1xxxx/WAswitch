// 工作台回复框草稿自检（2026-10-28）：用真的 shell 页面 + 假的主进程。
// 1) 打字停手后、翻译后、改译文后都存草稿（按 号 + chatKey）；2) 换对话时马上把上一个对话的写下来，回复框换成新对话的（正在打字也换）；
// 3) 切回来、重启（重新加载页面）都从主进程给的 draft 恢复，包括“已手动修改”；4) 翻译途中换了对话，译文不落到新对话；
// 5) 还没认出对话时写的，认出来后归到那个对话；6) 清空回复框也发出去（主进程收到空的就删）。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-dock-draft.js
const path = require('path');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

const KA = 'aaaaaaaaaaaaaaaa';
const KB = 'bbbbbbbbbbbbbbbb';
const KC = 'cccccccccccccccc';

// 在页面里跑的公共小工具
const helpers = () => {
  window.__base = (over) => ({ accountId: 'a1', readable: 'ok', title: 'Emma Wilson', chatKey: 'aaaaaaaaaaaaaaaa', draft: null,
    items: [{ h: 'h1', text: 'Hi, is the 613 blonde wig still available?', t: '10:01', state: 'done', tr: '你好，613 金色假发还有货吗？' }],
    paused: '', auto: true, dailyCap: 500, hasProvider: true, needKey: null, primaryId: 'z', fallbackId: '',
    providers: [{ id: 'z', name: '智谱', model: 'glm-4-flash' }], modes: { out: [{ id: 'o', name: '标准' }], in: [{ id: 'i', name: '收到' }] }, inModeId: 'i',
    langs: ['英语', '德语'], target: '英语', targetSrc: 'default', autoTarget: '英语', canRemember: true, ...over });
  window.__push = (over) => { const d = window.__base(over); window.__dock = d; window.__cbs.dock(JSON.parse(JSON.stringify(d))); };
  window.__wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__type = (sel, str) => { const el = document.querySelector(sel); el.focus(); for (const c of str) { el.value += c; el.dispatchEvent(new Event('input', { bubbles: true })); } };
  window.__enter = () => document.querySelector('.dk-in').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  window.__last = (chat) => [...(window.__drafts || [])].reverse().find((x) => !chat || x.chat === chat) || null;
  window.__box = () => ({ text: document.querySelector('.dk-in').value, out: document.querySelector('.dk-out').value, edited: !document.querySelector('.dk-compose .dk-edited').hidden, focus: document.activeElement && document.activeElement.className });
};

const part1 = async () => {
  window.__cbs.state({ accounts: [{ id: 'a1', name: 'Shop', color: '#3b82f6' }], groups: [], activeId: 'a1', page: 'account', panelOpen: true, panelTab: 'translate', platform: 'linux', collapsed: false });
  window.__push({});
  await window.__wait(300);
  const out = {};
  window.__type('.dk-in', '您好，有货');
  out.beforeIdle = (window.__drafts || []).length;
  await window.__wait(450);
  out.typed = window.__last(window.__base({}).chatKey);
  // 回车翻译 → 存上译文
  window.__enter();
  await window.__wait(450);
  out.translated = window.__last('aaaaaaaaaaaaaaaa');
  // 改译文 → 存成“已手动修改”
  window.__type('.dk-out', '!');
  await window.__wait(450);
  out.edited = window.__last('aaaaaaaaaaaaaaaa');
  // 打完字去 WhatsApp 点开对话 B（焦点离开回复框）：马上存 A，回复框换成 B 的（空的）
  window.__type('.dk-in', '。');
  document.activeElement.blur();
  const n = window.__drafts.length;
  window.__push({ title: 'Lukas Becker', chatKey: 'bbbbbbbbbbbbbbbb', draft: null });
  out.flushNow = window.__drafts.slice(n);
  await window.__wait(50);
  out.boxB = window.__box();
  window.__type('.dk-in', 'Wann kommt die Perücke?');
  await window.__wait(450);
  out.typedB = window.__last('bbbbbbbbbbbbbbbb');
  document.activeElement.blur();
  // 切回 A：主进程给 A 存的草稿
  window.__push({ draft: out.flushNow[0] && out.flushNow[0].d });
  await window.__wait(50);
  out.boxA = window.__box();
  out.lastB = window.__last('bbbbbbbbbbbbbbbb');
  // 翻译途中换对话：译文不能落到 B
  let release;
  window.__trRun = (a) => new Promise((r) => { release = () => r({ text: `LATE:${a.text}`, warn: [] }); });
  const nA = window.__drafts.length;
  document.querySelector('.dk-in').value = '新的一句';
  document.querySelector('.dk-in').dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.dk-outhead .dk-btn')].find((b) => /翻译/.test(b.textContent)).click();
  await window.__wait(50);
  window.__push({ title: 'Lukas Becker', chatKey: 'bbbbbbbbbbbbbbbb', draft: out.typedB.d });
  release();
  await window.__wait(450);
  out.boxBafter = window.__box();
  out.lateLeak = window.__drafts.slice(nA).filter((x) => /LATE:/.test(x.d.out));
  window.__trRun = null;
  // 清空 B：发出空草稿（主进程收到就删）
  document.querySelector('.dk-in').value = '';
  document.querySelector('.dk-in').dispatchEvent(new Event('input', { bubbles: true }));
  await window.__wait(450);
  out.clearedB = window.__last('bbbbbbbbbbbbbbbb');
  return out;
};

// 重启：重新加载页面，主进程推来带 draft 的状态
const part2 = async (draft) => {
  window.__cbs.state({ accounts: [{ id: 'a1', name: 'Shop', color: '#3b82f6' }], groups: [], activeId: 'a1', page: 'account', panelOpen: true, panelTab: 'translate', platform: 'linux', collapsed: false });
  window.__push({ draft });
  await window.__wait(300);
  const out = { restored: window.__box(), sentOnLoad: (window.__drafts || []).length };
  // 刚加的号：还没认出对话（chatKey 空）时写的，认出对话后归到那个对话
  // 真的主进程里 dockGet 拿到的总是当前状态：先把假的当前状态换成新号的，再切号
  window.__dock = window.__base({ accountId: 'a2', readable: 'loading', title: '', chatKey: '', items: [] });
  window.__cbs.state({ accounts: [{ id: 'a1', name: 'Shop', color: '#3b82f6' }, { id: 'a2', name: 'New', color: '#10b981' }], groups: [], activeId: 'a2', page: 'account', panelOpen: true, panelTab: 'translate', platform: 'linux', collapsed: false });
  window.__push({ accountId: 'a2', readable: 'loading', title: '', chatKey: '', items: [] });
  await window.__wait(100);
  window.__type('.dk-in', 'Thanks!');
  await window.__wait(450);
  out.noKeySent = (window.__drafts || []).filter((x) => x.acc === 'a2').length;
  window.__push({ accountId: 'a2', title: 'Sophie Martin', chatKey: 'cccccccccccccccc', draft: { text: '旧的', out: '' } });
  await window.__wait(450);
  out.carried = window.__last('cccccccccccccccc');
  out.carriedBox = window.__box();
  return out;
};

// Fable 审计 2026-10-28：空对话、刚换对话就打字、放进输入框后、换目标语言
const part3 = async () => {
  const A = 'aaaaaaaaaaaaaaaa'; const C = 'cccccccccccccccc'; const D = 'dddddddddddddddd';
  window.__cbs.state({ accounts: [{ id: 'a1', name: 'Shop', color: '#3b82f6' }], groups: [], activeId: 'a1', page: 'account', panelOpen: true, panelTab: 'translate', platform: 'linux', collapsed: false });
  window.__push({ draft: { text: '给 Emma 的', out: '' } });
  await window.__wait(300);
  const out = {};
  // 1) 打开还没有消息的新对话（chatKey 空）：回复框清空，这里写的不存到 Emma 名下；新客户发来消息、认出对话后归到它
  window.__push({ title: 'New Lead', chatKey: '', items: [] });
  await window.__wait(50);
  out.emptyBox = window.__box();
  window.__type('.dk-in', '给新客户的');
  await window.__wait(450);
  out.emptySent = (window.__drafts || []).filter((x) => x.chat === A && x.d && /新客户/.test(x.d.text)).length;
  document.activeElement.blur();
  window.__push({ title: 'New Lead', chatKey: C, draft: null });
  await window.__wait(450);
  out.emptyCarried = window.__last(C);
  out.emptyCarriedBox = window.__box();
  // 2) 刚点开对话 D、还没读到就点进回复框接着打字：这一阵打的字归到 D，C 留打字之前的那份
  await window.__wait(2700); // 上一阵打字已经过去
  window.__type('.dk-in', ' 补一句');
  const n = window.__drafts.length;
  out.hasFocus = document.hasFocus();
  window.__push({ title: 'Sophie Martin', chatKey: D, draft: null });
  await window.__wait(450);
  out.typingOld = window.__drafts.slice(n).filter((x) => x.chat === C);
  out.typingNew = window.__last(D);
  out.typingBox = window.__box();
  // 2b) 给 D 连着写一段（字和字之间不到 2.5 秒）→ 去 WhatsApp 点开 E → 1 秒内点回回复框接着打：D 还是整段，E 只拿新打的
  const E = 'eeeeeeeeeeeeeeee';
  window.__type('.dk-in', '，明天发货');
  await window.__wait(400);
  document.activeElement.blur();
  await window.__wait(300);
  const nb = window.__drafts.length;
  window.__type('.dk-in', 'Hi Lukas'); // __type 先 focus 再打
  window.__push({ title: 'Lukas Becker', chatKey: E, draft: null });
  await window.__wait(450);
  out.burstOld = window.__drafts.slice(nb).filter((x) => x.chat === D);
  out.burstOldLast = window.__last(D);
  out.burstNew = window.__last(E);
  // 回到 D 接着测
  document.activeElement.blur();
  window.__push({ title: 'Sophie Martin', chatKey: D, draft: out.burstOldLast.d });
  await window.__wait(100);
  // 3) 放进输入框以后：草稿删掉（框里这次还在）；再改就又存
  window.__enter();
  await window.__wait(300);
  window.__insertResult = 'ok';
  document.querySelector('.dk-insert').click();
  await window.__wait(450);
  out.used = window.__last(D);
  out.usedBox = window.__box();
  window.__type('.dk-in', '!');
  await window.__wait(450);
  out.editedAfter = window.__last(D);
  // 4) 换目标语言（dock:lang 返回的状态也走 dockAdopt）：回复框不变
  window.__dock = window.__base({ title: 'Sophie Martin', chatKey: D, draft: null, target: '德语', targetSrc: 'manual' });
  const before = window.__box().text;
  const sel = document.querySelectorAll('.dk-bar-sel')[1];
  sel.value = '德语'; sel.dispatchEvent(new Event('change', { bubbles: true }));
  await window.__wait(100);
  out.langKept = window.__box().text === before;
  return out;
};

// 工作台回到“翻译”（shen 2026-10-29）：换号、从一个认得出的对话换到另一个，并且停在客户资料或话术时，调 panelTab('translate')；
// 同一个对话不跳；还没认出对话不跳；正在填表单（pn.edit）不跳
const part4 = async () => {
  const A = 'aaaaaaaaaaaaaaaa'; const B = 'bbbbbbbbbbbbbbbb';
  const accounts = [{ id: 'a1', name: 'Shop', color: '#3b82f6' }, { id: 'a2', name: 'New', color: '#10b981' }];
  const state = (tab, activeId = 'a1') => window.__cbs.state({ accounts, groups: [], activeId, page: 'account', panelOpen: true, panelTab: tab, platform: 'linux', collapsed: false });
  const calls = () => (window.__panelTabs || []).splice(0);
  const out = {};
  state('translate');
  window.__push({ chatKey: A });
  await window.__wait(100);
  out.first = calls(); // 第一次推送（刚启动）
  state('customers');
  window.__push({ chatKey: A }); // 同一个对话再推一次（来了新消息等）
  window.__push({ chatKey: A, items: [] });
  await window.__wait(50);
  out.same = calls();
  window.__push({ chatKey: '', title: '', items: [] }); // 还没认出对话
  await window.__wait(50);
  out.unknown = calls();
  window.__push({ chatKey: A });
  await window.__wait(50);
  out.recognized = calls(); // 认出来的还是刚才那个对话
  window.__push({ title: 'Lukas Becker', chatKey: B });
  await window.__wait(50);
  out.chat = calls();
  // 换对话中间有一阵读不出对话（刚点开、还没读到）：B → 读不出 → A 照样算换了对话
  state('customers');
  window.__push({ chatKey: '', title: '', items: [] });
  await window.__wait(50);
  window.__push({ chatKey: A });
  await window.__wait(50);
  out.viaUnknown = calls();
  state('translate');
  window.__push({ chatKey: A });
  await window.__wait(50);
  out.alreadyTr = calls(); // 已经在翻译页：不用再切
  state('replies');
  window.__push({ accountId: 'a2', chatKey: '', title: '', items: [], readable: 'loading' });
  await window.__wait(50);
  out.acc = calls();
  // 填着表单：换对话、换号都不跳
  state('customers', 'a2');
  pn.edit = { accountId: 'a2', tags: [] };
  window.__push({ accountId: 'a2', title: 'Sophie Martin', chatKey: A });
  window.__push({ accountId: 'a2', title: 'Lukas Becker', chatKey: B });
  window.__push({ accountId: 'a1', title: 'Emma Wilson', chatKey: A });
  await window.__wait(50);
  out.editing = calls();
  pn.edit = null;
  window.__push({ accountId: 'a2', title: 'Sophie Martin', chatKey: A });
  await window.__wait(50);
  out.afterEdit = calls();
  return out;
};

let w = null;
const errs = [];
app.whenReady().then(async () => {
  w = new BrowserWindow({ show: true, width: 1200, height: 760, webPreferences: { preload: path.join(__dirname, 'fixtures', 'dock-fake-preload.js'), contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  w.webContents.on('console-message', (e) => { const m = e.message || ''; if (e.level === 'error' || /Error/.test(m)) errs.push(m); });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  await w.webContents.executeJavaScript(`(${helpers})()`);
  const r = await w.webContents.executeJavaScript(`(${part1})()`);
  assert.strictEqual(r.beforeIdle, 0, '打字时不是每个字都存');
  assert(r.typed && r.typed.acc === 'a1' && r.typed.chat === KA && r.typed.d.text === '您好，有货', `停手后存草稿 ${JSON.stringify(r.typed)}`);
  assert.strictEqual(r.translated.d.out, 'EN:您好，有货', '翻译后存上译文');
  assert.strictEqual(r.translated.d.src, '您好，有货');
  assert(r.edited.d.edited && r.edited.d.out === 'EN:您好，有货!', `改过的译文存成已手动修改 ${JSON.stringify(r.edited)}`);
  assert.strictEqual(r.flushNow.length, 1, '换对话时马上存上一个对话（不等 300ms）');
  assert.strictEqual(r.flushNow[0].chat, KA);
  assert.strictEqual(r.flushNow[0].d.text, '您好，有货。', '换对话前刚打的字也在');
  assert.deepStrictEqual([r.boxB.text, r.boxB.out], ['', ''], `换到 B 后回复框是 B 的（空的）${JSON.stringify(r.boxB)}`);
  assert.strictEqual(r.typedB.d.text, 'Wann kommt die Perücke?');
  assert.deepStrictEqual([r.boxA.text, r.boxA.out, r.boxA.edited], ['您好，有货。', 'EN:您好，有货!', true], `切回 A 恢复草稿 ${JSON.stringify(r.boxA)}`);
  assert.strictEqual(r.lastB.d.text, 'Wann kommt die Perücke?', '切走时 B 的草稿存了');
  assert.deepStrictEqual(r.lateLeak, [], '翻译途中换了对话，译文不能存进别的对话');
  assert.strictEqual(r.boxBafter.text, 'Wann kommt die Perücke?');
  assert(!/LATE:/.test(r.boxBafter.out), 'B 的回复框没有 A 的译文');
  assert.strictEqual(r.clearedB.d.text, '', '清空也发出去（主进程删掉）');

  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  await w.webContents.executeJavaScript(`(${helpers})()`);
  const r2 = await w.webContents.executeJavaScript(`(${part2})(${JSON.stringify(r.edited.d)})`);
  assert.deepStrictEqual([r2.restored.text, r2.restored.out, r2.restored.edited], ['您好，有货', 'EN:您好，有货!', true], `重启后恢复 ${JSON.stringify(r2.restored)}`);
  assert.strictEqual(r2.sentOnLoad, 0, '恢复时不重复存');
  assert.strictEqual(r2.noKeySent, 0, '还没认出对话时不存');
  assert(r2.carried && r2.carried.acc === 'a2', `认出对话后归到那个对话 ${JSON.stringify(r2.carried)}`);
  assert.strictEqual(r2.carried.d.text, '旧的\nThanks!', '认出的对话原来有草稿：原来的在前，没认出时写的接在后面');
  assert.strictEqual(r2.carriedBox.text, '旧的\nThanks!', '没认出对话时写的字不被旧草稿盖掉');

  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  await w.webContents.executeJavaScript(`(${helpers})()`);
  w.focus();
  const r3 = await w.webContents.executeJavaScript(`(${part3})()`);
  assert.deepStrictEqual([r3.emptyBox.text, r3.emptyBox.out], ['', ''], `打开没有消息的新对话，回复框清空 ${JSON.stringify(r3.emptyBox)}`);
  assert.strictEqual(r3.emptySent, 0, '空对话里写的不能存到上一个客户名下');
  assert(r3.emptyCarried && r3.emptyCarried.d.text === '给新客户的', `认出对话后归到新客户 ${JSON.stringify(r3.emptyCarried)}`);
  assert.strictEqual(r3.emptyCarriedBox.text, '给新客户的');
  assert(r3.hasFocus, '窗口要有焦点才测得了“刚换对话就打字”');
  assert.deepStrictEqual(r3.typingOld.map((x) => x.d && x.d.text), ['给新客户的'], `上一个对话留打字之前的那份 ${JSON.stringify(r3.typingOld)}`);
  assert(r3.typingNew && r3.typingNew.d.text === '补一句', `刚换对话就打的字归到新对话 ${JSON.stringify(r3.typingNew)}`);
  assert.strictEqual(r3.typingBox.text, '补一句');
  assert(r3.burstOld.every((x) => x.d), `连着打的那段不能被删 ${JSON.stringify(r3.burstOld)}`);
  assert.strictEqual(r3.burstOldLast.d.text, '补一句，明天发货', '上一个对话还是整段');
  assert(r3.burstNew && r3.burstNew.d.text === 'Hi Lukas', `新对话只拿点回来以后打的 ${JSON.stringify(r3.burstNew)}`);
  assert.strictEqual(r3.used.d, null, `放进输入框后草稿删掉 ${JSON.stringify(r3.used)}`);
  assert.strictEqual(r3.usedBox.text, '补一句，明天发货', '这次框里还在');
  assert(r3.editedAfter.d && r3.editedAfter.d.text === '补一句，明天发货!', '放进去以后再改就又存');
  assert(r3.langKept, '换目标语言不换回复框');

  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  await w.webContents.executeJavaScript(`(${helpers})()`);
  const r4 = await w.webContents.executeJavaScript(`(${part4})()`);
  assert.deepStrictEqual(r4.first, [], '刚启动第一次推送不用切');
  assert.deepStrictEqual(r4.same, [], '同一个对话不切页');
  assert.deepStrictEqual(r4.unknown, [], '还没认出对话不切页');
  assert.deepStrictEqual(r4.recognized, [], '认出来还是刚才那个对话不切页');
  assert.deepStrictEqual(r4.chat, ['translate'], `换了客户对话，客户资料页回到翻译 ${JSON.stringify(r4.chat)}`);
  assert.deepStrictEqual(r4.viaUnknown, ['translate'], `换对话中间读不出对话也要回到翻译 ${JSON.stringify(r4.viaUnknown)}`);
  assert.deepStrictEqual(r4.alreadyTr, [], '已经在翻译页不用再切');
  assert.deepStrictEqual(r4.acc, ['translate'], `换号，话术页回到翻译 ${JSON.stringify(r4.acc)}`);
  assert.deepStrictEqual(r4.editing, [], `填着表单时换对话、换号都不切 ${JSON.stringify(r4.editing)}`);
  assert.deepStrictEqual(r4.afterEdit, ['translate'], `表单关了以后换对话照样切 ${JSON.stringify(r4.afterEdit)}`);
  assert.deepStrictEqual(errs, [], '页面没有报错');
  console.log('回复草稿自检通过（停手存、翻译存、换对话先存再换、切回和重启恢复、翻译途中换对话不串、未认出对话时归位、清空删、空对话、刚换对话就打字、放进输入框后不留、换号换对话回翻译页）');
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
