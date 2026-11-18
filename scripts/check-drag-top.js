// 自检：没有顶栏的页面（待回复、翻译、总览、设置……）顶上按住能拖动窗口，下面的按钮、下拉框照常点。
// 做法：无边框窗口里 -webkit-app-region: drag 的地方由系统接管，页面收不到 mousedown。
// 用 XTest（python ctypes 调 libXtst）在 xvfb 里发真实点击，看页面收没收到：
//   1. 待回复页：顶上空白、大标题拖窗口；第一行、× 照常点
//   2. 列表往下滚以后，拖动区跟着标题滚走，顶上露出来的行照常点
//   3. 翻译页：标题那一条拖窗口；语言下拉框照常点
//   4. 总览页：顶上空白拖窗口
// 运行：xvfb-run -a -s "-screen 0 1920x1200x24" npx electron --no-sandbox scripts/check-drag-top.js
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const XTEST = `
import ctypes, sys, time
x = ctypes.cdll.LoadLibrary('libX11.so.6'); t = ctypes.cdll.LoadLibrary('libXtst.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
d = ctypes.c_void_p(x.XOpenDisplay(None))
px, py = int(sys.argv[1]), int(sys.argv[2])
t.XTestFakeMotionEvent(d, -1, px, py, 0); x.XFlush(d); time.sleep(0.05)
t.XTestFakeButtonEvent(d, 1, 1, 0); x.XFlush(d); time.sleep(0.05)
t.XTestFakeButtonEvent(d, 1, 0, 0); x.XFlush(d); time.sleep(0.05)
`;

app.whenReady().then(async () => {
  const preload = path.join(app.getPath('temp'), `drag-top-preload-${process.pid}.js`);
  fs.writeFileSync(preload, `window.__cbs = {};
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'onUndoOffer') return (cb) => { window.__cbs.undo = cb; };
  if (k === 'panelData') return async () => ({ replies: [], customers: [] });
  if (k === 'notifLog') return async () => [];
  return async () => null;
} });`);
  let failures = 0;
  const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
  try {
    const w = new BrowserWindow({ show: true, frame: false, x: 0, y: 0, width: 1200, height: 600, webPreferences: { preload, contextIsolation: false, sandbox: false } });
    await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
    const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
    const now = Date.now();
    const accounts = [{ id: 'a1', name: 'Sales DE', color: '#3b82f6', proxyLabel: '直连', mode: 'web' }];
    const list = Array.from({ length: 20 }, (_, i) => ({ accountId: 'a1', key: `k${i}`, name: `Emma Wilson ${i}`, since: now - (3 + i) * 3600e3 }));
    const base = { accounts, groups: [], activeId: 'a1', platform: 'darwin', collapsed: false, settings: {}, page: 'unreplied', unreplied: { count: list.length, list } };
    const push = async (extra) => { await js((st) => window.__cbs.state(st), { ...base, ...extra }); await wait(400); };
    await push({});
    await js(() => { window.__md = 0; document.addEventListener('mousedown', () => { window.__md += 1; }, true); });
    const b = w.getContentBounds();
    // 在 sel 那个元素上点一下（dy 不给就点竖直中间），返回页面有没有收到 mousedown
    const pageGets = async (sel, dy) => {
      const r = await js((s) => { const q = document.querySelector(s).getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; }, sel);
      await js(() => { window.__md = 0; });
      execFileSync('python3', ['-c', XTEST, String(Math.round(b.x + r.x + Math.min(40, r.w / 2))), String(Math.round(b.y + r.y + (dy == null ? r.h / 2 : dy)))]);
      await wait(150);
      return (await js(() => window.__md)) > 0;
    };
    // 先确认这个办法分得出来：账号页的顶栏本来就能拖
    await push({ page: 'account' });
    check(!(await pageGets('#topbar', 10)), '账号页顶栏能拖（对照）');
    check(await pageGets('#topbar .top-acts .icon-btn'), '账号页顶栏的按钮照常点（对照）');

    await push({ page: 'unreplied' });
    check(!(await pageGets('#content', 10)), '待回复：顶上空白能拖');
    check(!(await pageGets('.page > h1')), '待回复：标题能拖');
    check(await pageGets('.ur-open'), '待回复：第一行照常点');
    check(await pageGets('.ur-x'), '待回复：× 照常点');
    await js(() => { document.querySelector('#content').scrollTop = 200; });
    await wait(300);
    check(await pageGets('#content', 10), '待回复往下滚以后：顶上露出来的行照常点');
    check(await pageGets('#content', 50), '待回复往下滚以后：原来标题的位置照常点');

    await push({ page: 'translate' });
    check(!(await pageGets('.tp-head', 8)), '翻译页：顶上能拖');
    check(!(await pageGets('.tp-head h1')), '翻译页：标题能拖');
    check(await pageGets('.tp select.tp-lang'), '翻译页：语言下拉框照常点');

    await push({ page: 'overview' });
    check(!(await pageGets('#content', 10)), '总览：顶上空白能拖');

    await push({ page: 'opennum' });
    check(!(await pageGets('#content', 10)), '开聊：顶上空白能拖');
    check(!(await pageGets('.page > h1')), '开聊：标题能拖');
    check(await pageGets('.op-form input'), '开聊：号码框照常点');
    check(await pageGets('.op-form select'), '开聊：账号下拉框照常点'); // 放最后：点开的下拉框会吃掉下一下点击
  } catch (e) {
    console.log(`失败：${e && e.stack}`);
    failures += 1;
  }
  fs.rmSync(preload, { force: true });
  if (!failures) console.error('check-drag-top: ok');
  app.exit(failures ? 1 : 0);
});
