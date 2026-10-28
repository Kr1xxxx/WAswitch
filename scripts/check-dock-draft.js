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
  // 正在打字时换到对话 B：马上存 A，回复框换成 B 的（空的）
  window.__type('.dk-in', '。');
  const n = window.__drafts.length;
  window.__push({ title: 'Lukas Becker', chatKey: 'bbbbbbbbbbbbbbbb', draft: null });
  out.flushNow = window.__drafts.slice(n);
  await window.__wait(50);
  out.boxB = window.__box();
  window.__type('.dk-in', 'Wann kommt die Perücke?');
  await window.__wait(450);
  out.typedB = window.__last('bbbbbbbbbbbbbbbb');
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
  assert(r2.carried && r2.carried.acc === 'a2' && r2.carried.d.text === 'Thanks!', `认出对话后归到那个对话 ${JSON.stringify(r2.carried)}`);
  assert.strictEqual(r2.carriedBox.text, 'Thanks!', '没认出对话时写的字不被旧草稿盖掉');
  assert.deepStrictEqual(errs, [], '页面没有报错');
  console.log('回复草稿自检通过（停手存、翻译存、换对话先存再换、切回和重启恢复、翻译途中换对话不串、未认出对话时归位、清空删）');
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
