// 聊天里选中文字后，在选区下方显示一个小「翻译」按钮（shen 2026-10-28）。点了就把选中的文字放进右侧工作台
// 翻译页的回复框并翻译（外文翻成中文，中文翻成客户的语言），工作台关着就打开。
//
// 不往 WhatsApp 页面里加任何东西：
//   - 什么时候去看：主进程的 input-event（鼠标左键松开）。页面里不挂监听
//   - 选了什么、在哪：隔离环境里只读 getSelection()（wa-page.js 的 readSelection）
//   - 按钮：单独一个很小的视图，盖在账号页面上面，不在页面里
// 鼠标按下、滚轮、键盘、换号、锁定、改窗口大小都会把按钮收起来。按钮的视图第一次用时才建，闲 3 分钟就关掉省内存。
// 右键菜单里的「翻译」走同一条路（main.js 的 setupPageMenu）。轻量号的聊天页本来就是软件自己的界面，按钮在 shell 里画（lite.js）。
const path = require('path');
const { WebContentsView, ipcMain } = require('electron');

const BTN = { width: 76, height: 40 }; // 视图大小：按钮 64×28，四周留 6px 给阴影
const PAD = 6;
const GAP = 4; // 按钮和选区之间
const IDLE_CLOSE_MS = 3 * 60 * 1000;
const CHECK_DELAY_MS = 40; // 松开鼠标后等页面把选区定下来（双击选词）

// 按钮放哪：选区最后一行的下面，右边和选区末尾对齐；下面放不下就放到第一行上面。都在账号页面范围内
// sel 是页面 CSS 像素，view 是账号页面在窗口里的位置，zoom 是页面缩放
function placeButton(sel, view, zoom = 1) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const right = view.x + (sel.x + sel.w) * z;
  let x = Math.round(right - BTN.width + PAD);
  let y = Math.round(view.y + (sel.y + sel.h) * z + GAP - PAD);
  if (y + BTN.height > view.y + view.height) y = Math.round(view.y + sel.top * z - GAP - BTN.height + PAD);
  x = Math.max(view.x, Math.min(view.x + view.width - BTN.width, x));
  y = Math.max(view.y, Math.min(view.y + view.height - BTN.height, y));
  return { x, y, width: BTN.width, height: BTN.height };
}

// deps：
//   win() -> 主窗口；lockLocalPage(wc)
//   canShow(id) -> 这个号现在是不是正显示着（当前号、账号页、没锁、没出问题）
//   viewOf(id) -> 账号页面的 WebContentsView
//   readSelection(wc) -> wa-page.js 的 readSelection
//   send(id, text) -> 打开工作台翻译页并翻译
function createSelTranslate(deps) {
  let view = null;
  let ready = false;
  let shown = null; // { id, text }
  let seq = 0; // 每次按下/滚动/新的松开 +1：读选区期间又动了就作废
  let idleTimer = null;

  function ensureView() {
    if (view && !view.webContents.isDestroyed()) return view;
    ready = false;
    view = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'seltr', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    deps.lockLocalPage(view.webContents);
    view.webContents.once('did-finish-load', () => { ready = true; });
    view.webContents.loadFile(path.join(__dirname, 'seltr', 'index.html'));
    deps.win().contentView.addChildView(view);
    return view;
  }
  function closeView() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!view) return;
    const v = view;
    view = null;
    ready = false;
    shown = null;
    try { deps.win().contentView.removeChildView(v); } catch {}
    if (!v.webContents.isDestroyed()) v.webContents.close();
  }
  function hide() {
    seq += 1;
    if (!shown) return;
    shown = null;
    if (view && !view.webContents.isDestroyed()) view.setVisible(false);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(closeView, IDLE_CLOSE_MS);
  }
  async function show(id, bounds, text, at) {
    const v = ensureView();
    clearTimeout(idleTimer);
    idleTimer = null;
    // 新建的视图等页面画好再显示，不闪一块空白
    for (let i = 0; i < 20 && !ready && !v.webContents.isDestroyed(); i += 1) await new Promise((r) => setTimeout(r, 25));
    if (v !== view || v.webContents.isDestroyed()) return false;
    shown = { id, text, at };
    v.setBounds(bounds);
    // 账号页面重建时会被加到最上面：保证按钮在最上层
    const kids = deps.win().contentView.children;
    if (kids[kids.length - 1] !== v) deps.win().contentView.addChildView(v);
    v.setVisible(true);
    return true;
  }

  async function check(id, wc) {
    const run = ++seq;
    await new Promise((r) => setTimeout(r, CHECK_DELAY_MS));
    if (run !== seq || !deps.canShow(id)) return;
    const sel = await deps.readSelection(wc);
    if (run !== seq || !deps.canShow(id)) return;
    if (!sel) { hide(); return; }
    const pageView = deps.viewOf(id);
    if (!pageView || pageView.webContents !== wc) return;
    const at = pageView.getBounds();
    const bounds = placeButton(sel, at, wc.getZoomFactor());
    const ok = await show(id, bounds, sel.text, JSON.stringify(at));
    if (ok && (run !== seq || !deps.canShow(id))) hide();
  }

  // 账号页面上的鼠标和键盘（主进程看得到，页面里不挂监听）
  function watch(id, wc) {
    wc.on('input-event', (_e, ev) => {
      const t = ev && ev.type;
      if (t === 'mouseUp') {
        if (ev.button && ev.button !== 'left') return;
        check(id, wc);
      } else if (t === 'mouseDown' || t === 'mouseWheel' || t === 'rawKeyDown' || t === 'keyDown' || t === 'contextMenu' || t === 'gestureScrollBegin') {
        hide();
      }
    });
    wc.on('destroyed', () => { if (shown && shown.id === id) hide(); });
  }

  // main.js 的 layout() 每次都调：换号、锁定、离开账号页、账号页面挪了位置或变了大小（开关工作台、改窗口大小）就收起
  function sync() {
    if (!shown) return;
    const pageView = deps.viewOf(shown.id);
    if (!deps.canShow(shown.id) || !pageView || JSON.stringify(pageView.getBounds()) !== shown.at) hide();
  }

  // 点了按钮（或右键菜单的「翻译」）
  function go(id, text) {
    hide();
    if (typeof text !== 'string' || !text.trim() || !deps.canShow(id)) return false;
    deps.send(id, text.trim().slice(0, 4000));
    return true;
  }

  // 只接受按钮自己发来的
  ipcMain.on('seltr:go', (e) => {
    if (!view || view.webContents.isDestroyed() || e.sender !== view.webContents || !shown) return;
    go(shown.id, shown.text);
  });
  ipcMain.on('seltr:hide', (e) => {
    if (!view || view.webContents.isDestroyed() || e.sender !== view.webContents) return;
    hide();
  });

  return { watch, hide, sync, go, close: closeView, get shown() { return shown ? { id: shown.id, text: shown.text } : null; } };
}

module.exports = { createSelTranslate, placeButton, BTN };
