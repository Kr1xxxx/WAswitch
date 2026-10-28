// 容器查询：卡片、翻译页按自己的大小排版，样式里不再看窗口宽高；顶栏自己宽度一变就重排。
// 1) shell.css 里不能再有按窗口宽高写的 @media（分辨率、减少动态效果这类可以）
// 2) 侧栏展开时，编辑页两栏间距在窗口 1060 / 1061 宽时切换，和以前的 @media (max-width: 1060px) 一样；侧栏收起时卡片更宽，不挤
// 3) 翻译页记录区在窗口 760 / 761 高时切换三行 / 五行，和以前的 @media (max-height: 760px) 一样
// 4) 只改侧栏宽度、不重画也不动窗口：顶栏变宽，藏起的备注自己回来
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-container-layout.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell', 'shell.css'), 'utf8');
const viewport = css.match(/@media[^{]*\b(min-|max-)?(width|height)\b[^{]*\{/g) || [];

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const acc = { id: 'a1', name: '德国客户号', note: 'Emma 负责，主要做德国 B2B 大客户', color: '#3b82f6', proxyLabel: 'Clash 7891', exitIp: '203.0.113.7', mode: 'web', groupId: '', memMB: 110, zoom: 0.9 };
const base = { accounts: [acc], groups: [], activeId: 'a1', page: 'account', platform: 'linux', collapsed: false, settings: {}, panelOpen: false };
const done = (code, msg) => { fs.writeSync(2, `${msg}\n`); app.exit(code); };

app.whenReady().then(async () => {
  assert.deepStrictEqual(viewport, [], `shell.css 里还有按窗口宽高写的 @media，改成 @container：${viewport.join(' | ')}`);

  const w = new BrowserWindow({ show: true, width: 1400, height: 800, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'fixtures', 'add-menu-fake-preload.js'), contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sizeTo = async (width, height = 800) => { w.setContentSize(width, height); await wait(300); };
  const state = async (s) => { await js((x) => window.__cbs.state(x), s); await wait(300); };

  // 2) 编辑页（.page 两栏）
  const pageGap = () => js(() => { const p = document.querySelector('#content .page:not(.narrow)'); return p ? getComputedStyle(p).columnGap : null; });
  await state({ ...base, page: 'editor', editorId: null, editorNonce: 1 });
  await sizeTo(1061);
  assert.strictEqual(await pageGap(), '40px', '侧栏展开、窗口 1061 宽：两栏间距该是 40');
  await sizeTo(1060);
  assert.strictEqual(await pageGap(), '24px', '侧栏展开、窗口 1060 宽：两栏间距该是 24');
  await state({ ...base, page: 'editor', editorId: null, editorNonce: 1, collapsed: true });
  assert.strictEqual(await pageGap(), '40px', '侧栏收起后卡片宽 988，两栏不用挤');
  await sizeTo(924);
  assert.strictEqual(await pageGap(), '24px', '侧栏收起、窗口 924 宽（卡片 852）：两栏间距该是 24');

  // 3) 翻译页记录区
  const histH = () => js(() => { const l = document.querySelector('.tp-hist-list'); return l ? l.getBoundingClientRect().height : null; });
  await state({ ...base, page: 'translate' });
  await sizeTo(1200, 761);
  assert.strictEqual(await histH(), 200, '窗口 761 高：记录区五行（200）');
  await sizeTo(1200, 760);
  assert.strictEqual(await histH(), 120, '窗口 760 高：记录区三行（120）');

  // 4) 顶栏：只收侧栏不动窗口，备注回来
  const noteSeen = () => js(() => { const n = document.querySelector('#topbar .who-note'); return !!(n && n.getClientRects().length); });
  await sizeTo(1400);
  await state(base);
  let width = 1400;
  while (width > 600 && await noteSeen()) { width -= 20; await sizeTo(width); }
  assert(!(await noteSeen()), '窗口变窄时备注该先藏起来');
  await js(() => { document.body.style.setProperty('--side', '64px'); });
  await wait(300);
  assert(await noteSeen(), `窗口 ${width} 宽、只收起侧栏：顶栏变宽了，备注该回来`);
  await js(() => { document.body.style.setProperty('--side', '200px'); });
  await wait(300);
  assert(!(await noteSeen()), '侧栏展开回去：备注又该藏起来');
  assert(await js(() => { const b = document.querySelector('#topbar'); return b.scrollWidth <= b.clientWidth; }), '顶栏不该溢出');

  done(0, 'check-container-layout OK');
}).catch((e) => done(1, `check-container-layout FAIL: ${e.stack || e}`));
