// 工作台自检：在消息列表里选中一段译文，列表重画（新消息、翻译完成）不能把选区弄没，Ctrl+C 才复制得到；
// 复制按钮只在真的复制上时才打对勾。用真的 shell 页面 + 假的主进程。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-dock-select.js
const path = require('path');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

const scenario = async () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ h: `h${i}`, text: `Hello ${i}, is the 613 blonde wig still available?`, t: `10:0${i}`, state: 'done', tr: `你好 ${i}，613 金色假发还有货吗？` }));
  const base = (items) => ({ accountId: 'a1', readable: 'ok', title: 'Emma Wilson', chatKey: 'aaaaaaaaaaaaaaaa', draft: null, items,
    paused: '', auto: true, dailyCap: 500, hasProvider: true, needKey: null, primaryId: 'z', fallbackId: '',
    providers: [{ id: 'z', name: '智谱', model: 'glm-4-flash' }], modes: { out: [{ id: 'o', name: '标准' }], in: [{ id: 'i', name: '收到' }] }, inModeId: 'i',
    langs: ['英语', '德语'], target: '英语', targetSrc: 'default', autoTarget: '英语', canRemember: true });
  const push = (items) => { const d = base(items); window.__dock = d; window.__cbs.dock(JSON.parse(JSON.stringify(d))); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  window.__cbs.state({ accounts: [{ id: 'a1', name: 'Shop', color: '#3b82f6' }], groups: [], activeId: 'a1', page: 'account', panelOpen: true, panelTab: 'translate', platform: 'linux', collapsed: false });
  push(mk(3));
  await wait(300);
  const texts = () => [...document.querySelectorAll('.dk-listbox .dk-item')].length;
  out.before = texts();
  // 选中第一条译文里的一段字
  const node = document.querySelector('.dk-listbox .dk-tr');
  const r = document.createRange(); r.setStart(node.firstChild, 0); r.setEnd(node.firstChild, 5);
  const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  const picked = sel.toString();
  out.picked = picked;
  // 新消息来了、翻译状态变了：连推几次，间隔 100ms
  for (let n = 4; n <= 6; n += 1) { push(mk(n)); await wait(100); }
  out.during = { items: texts(), sel: document.getSelection().toString() };
  // 选区没了：补画一次，新消息出现
  document.getSelection().removeAllRanges();
  await wait(200);
  out.after = { items: texts() };
  // 没选东西时照常重画
  push(mk(7)); await wait(100);
  out.plain = texts();
  // 选在回复框外面的别处（列表外）不压重画
  const hint = document.querySelector('.dk-in');
  hint.value = 'abc'; hint.setSelectionRange(0, 2);
  push(mk(8)); await wait(100);
  out.outside = texts();
  // 复制按钮：没复制上不打对勾，复制上了打对勾
  const copyBtn = () => document.querySelector('.dk-card .dk-tool[aria-label="复制"]');
  const box = document.querySelector('.dk-in'); box.value = '您好，有货'; box.dispatchEvent(new Event('input', { bubbles: true }));
  window.__copyOk = false; copyBtn().click(); await wait(300);
  out.failFlash = copyBtn().classList.contains('copy-ok');
  window.__copyOk = true; copyBtn().click(); await wait(300);
  out.okFlash = copyBtn().classList.contains('copy-ok');
  return out;
};

app.whenReady().then(async () => {
  const errs = [];
  const w = new BrowserWindow({ show: true, width: 1200, height: 760, webPreferences: { preload: path.join(__dirname, 'fixtures', 'dock-fake-preload.js'), contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  w.webContents.on('console-message', (e) => { const m = e.message || ''; if (e.level === 'error' || /Error/.test(m)) errs.push(m); });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const r = await w.webContents.executeJavaScript(`(${scenario})()`);
  assert.strictEqual(r.before, 3, `先画出 3 条 ${JSON.stringify(r)}`);
  assert(r.picked.length > 0, '选中了字');
  assert.deepStrictEqual([r.during.items, r.during.sel], [3, r.picked], `选着字时列表不重画，选区还在 ${JSON.stringify(r.during)}`);
  assert.strictEqual(r.after.items, 6, `选区没了以后补画，新消息出现 ${JSON.stringify(r.after)}`);
  assert.strictEqual(r.plain, 7, '没选字时照常重画');
  assert.strictEqual(r.outside, 8, '选的不是列表里的字，不压重画');
  assert.strictEqual(r.failFlash, false, '没复制上：复制按钮不打对勾');
  assert.strictEqual(r.okFlash, true, '复制上了：复制按钮打对勾');
  assert.deepStrictEqual(errs, [], '页面没有报错');
  console.log('工作台选字自检通过（选着译文时列表不重画、选区没了补画、没选字照常画、复制没成功不打对勾）');
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
