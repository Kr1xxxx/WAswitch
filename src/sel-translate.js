// 聊天里选中文字后，在选区下方显示一个小「翻译」按钮；点了按钮原地变成悬浮译文窗（shen 2026-10-28）。
// 外文翻成中文，中文翻成客户的语言（translate-ipc.js 的 selTranslate）。右键菜单的「翻译」直接弹译文窗。
//
// 不往 WhatsApp 页面里加任何东西：
//   - 什么时候去看：主进程的 input-event（鼠标左键松开）。页面里不挂监听
//   - 选了什么、在哪：隔离环境里只读 getSelection()（wa-page.js 的 readSelection）
//   - 按钮和译文窗：单独一个很小的视图，盖在账号页面上面，不在页面里（src/seltr/）
// 在账号页面上按鼠标、滚轮、按键（Ctrl/Cmd 组合键除外，好让 Ctrl+C 复制），换号、锁定、改窗口大小都会收起。
// 视图第一次用时才建，收起后 30 秒没再用就关掉省内存（按钮和译文窗是同一个视图）。
// 轻量号的聊天页本来就是软件自己的界面，按钮和译文窗直接画在 shell 里（lite.js，共用 seltr/card.js）。
const path = require('path');
const { WebContentsView, ipcMain } = require('electron');

const PAD = 6; // 视图四周留给阴影的透明边
const BTN = { width: 64 + PAD * 2, height: 28 + PAD * 2 };
const CARD_W = 320 + PAD * 2;
const CARD_MIN_H = 44 + PAD * 2;
const CARD_MAX_H = 260 + PAD * 2;
const GAP = 4; // 和选区之间
const IDLE_CLOSE_MS = 30 * 1000; // 视图是一个单独的渲染进程（约 100 MB）：收起 30 秒没再用就关掉
const CHECK_DELAY_MS = 40; // 松开鼠标后等页面把选区定下来（双击选词）

// 放哪：选区最后一行的下面，下面放不下就放到第一行上面；按钮右边和选区末尾对齐，译文窗左边和最后一行开头对齐。都在账号页面范围内
// sel 是页面 CSS 像素，view 是账号页面在窗口里的位置，zoom 是页面缩放，size 是视图大小（含透明边）
function placeBox(sel, view, zoom = 1, size = BTN, align = 'right') {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  let x = align === 'left' ? Math.round(view.x + sel.x * z - PAD) : Math.round(view.x + (sel.x + sel.w) * z - size.width + PAD);
  let y = Math.round(view.y + (sel.y + sel.h) * z + GAP - PAD);
  if (y + size.height > view.y + view.height) y = Math.round(view.y + sel.top * z - GAP - size.height + PAD);
  x = Math.max(view.x, Math.min(view.x + view.width - size.width, x));
  y = Math.max(view.y, Math.min(view.y + view.height - size.height, y));
  return { x, y, width: size.width, height: size.height };
}
const placeButton = (sel, view, zoom) => placeBox(sel, view, zoom, BTN);

// 不收起的按键：单按 Ctrl/Shift/Alt/Cmd，和 Ctrl/Cmd 组合键（Ctrl+C 复制选中的字）
function quietKey(ev) {
  const mods = Array.isArray(ev.modifiers) ? ev.modifiers : [];
  if (mods.some((m) => ['control', 'ctrl', 'meta', 'cmd', 'command'].includes(m))) return true;
  return ['Control', 'Shift', 'Alt', 'Meta', 'Ctrl', 'Command'].includes(ev.keyCode);
}

// deps：
//   win() -> 主窗口；lockLocalPage(wc)
//   canShow(id) -> 这个号现在是不是正显示着（当前号、账号页、没锁、没出问题）
//   viewOf(id) -> 账号页面的 WebContentsView
//   readSelection(wc) -> wa-page.js 的 readSelection
//   translate(text) -> Promise<{ text } | { error }>
//   copy(text)
//   focus() -> 键盘焦点还给当前账号页面
// 退出软件拆视图时 view.webContents 可能已经是 undefined：一律先看它还在不在
const wcOk = (v) => !!v && !!v.webContents && !v.webContents.isDestroyed();

function createSelTranslate(deps) {
  let view = null;
  let ready = false;
  // 正显示着的：{ id, text, at（账号页面位置，变了就收起）, sel, zoom, mode: 'button' | 'card', st（译文窗状态）, h }
  let shown = null;
  let seq = 0; // 每次按下/滚动/新的松开 +1：读选区、翻译期间又动了就作废
  let idleTimer = null;
  let stopped = false; // 软件在退出：不再建视图

  function ensureView() {
    if (wcOk(view)) return view;
    ready = false;
    view = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'seltr', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    deps.lockLocalPage(view.webContents);
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
    if (wcOk(v)) v.webContents.close();
  }
  function hide() {
    seq += 1;
    if (!shown) return;
    shown = null;
    if (wcOk(view)) {
      // 焦点在按钮/译文窗上（点过它）：还给聊天页，不然收起后打字没反应
      const hadFocus = view.webContents.isFocused();
      view.setVisible(false);
      if (hadFocus) deps.focus();
    }
    armIdle();
  }
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(closeView, IDLE_CLOSE_MS);
  }
  const alive = () => wcOk(view);
  function push() {
    if (!alive() || !ready || !shown) return;
    view.webContents.send('seltr:state', shown.mode === 'card' ? { mode: 'card', ...shown.st } : { mode: 'button' });
  }
  function place() {
    if (!alive() || !shown) return;
    const card = shown.mode === 'card';
    const size = card ? { width: CARD_W, height: Math.max(CARD_MIN_H, Math.min(CARD_MAX_H, shown.h || CARD_MIN_H)) } : BTN;
    view.setBounds(placeBox(shown.sel, JSON.parse(shown.at), shown.zoom, size, card ? 'left' : 'right'));
  }
  // 新建的视图页面画好（seltr:ready）才显示，不闪一块空白；3 秒还没好（或期间又动了鼠标键盘）就这次不显示
  async function waitReady(v) {
    for (let i = 0; i < 120 && !ready && v === view && wcOk(v); i += 1) await new Promise((r) => setTimeout(r, 25));
    return ready && v === view && wcOk(v);
  }
  async function show(next) {
    if (stopped) return false;
    const run = seq;
    const v = ensureView();
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!(await waitReady(v)) || run !== seq || !deps.canShow(next.id)) {
      if (!shown) armIdle();
      return false;
    }
    shown = next;
    push();
    place();
    // 账号页面重建时会被加到最上面：保证按钮在最上层
    const kids = deps.win().contentView.children;
    if (kids[kids.length - 1] !== v) deps.win().contentView.addChildView(v);
    v.setVisible(true);
    return true;
  }
  // 读当前选区，准备好要显示的东西（位置按账号页面现在的位置和缩放算）
  async function locate(id, wc) {
    const sel = await deps.readSelection(wc);
    const pageView = deps.viewOf(id);
    if (!sel || stopped || wc.isDestroyed() || !pageView || pageView.webContents !== wc) return null;
    return { id, text: sel.text, at: JSON.stringify(pageView.getBounds()), sel, zoom: wc.getZoomFactor() };
  }

  async function check(id, wc) {
    const run = ++seq;
    await new Promise((r) => setTimeout(r, CHECK_DELAY_MS));
    if (run !== seq || !deps.canShow(id)) return;
    const found = await locate(id, wc);
    if (run !== seq || !deps.canShow(id)) return;
    if (!found) { hide(); return; }
    await show({ ...found, mode: 'button' });
  }

  // 翻译正显示着的文字，按钮变成译文窗
  async function translate() {
    if (!shown) return;
    const cur = shown;
    const run = seq;
    cur.mode = 'card';
    cur.st = { busy: true };
    cur.h = 0;
    push();
    place();
    let r;
    try { r = await deps.translate(cur.text); } catch { r = { error: '翻译失败' }; }
    if (run !== seq || shown !== cur) return; // 期间收起了或换了别的选区
    cur.st = r && typeof r.text === 'string' && r.text.trim() ? { text: r.text } : { error: (r && r.error) || '翻译失败' };
    push();
  }

  // 账号页面上的鼠标和键盘（主进程看得到，页面里不挂监听）
  function watch(id, wc) {
    wc.on('input-event', (_e, ev) => {
      if (stopped || wc.isDestroyed()) return;
      const t = ev && ev.type;
      if (t === 'mouseUp') {
        if (ev.button && ev.button !== 'left') return;
        check(id, wc);
      } else if (t === 'rawKeyDown' || t === 'keyDown') {
        if (!quietKey(ev)) hide();
      } else if (t === 'mouseDown' || t === 'mouseWheel' || t === 'contextMenu' || t === 'gestureScrollBegin') {
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

  // 右键菜单的「翻译」：直接弹译文窗。读不到选区的位置（比如选在对话列表里）就放在点右键的地方附近
  async function fromMenu(id, wc, text, point) {
    hide();
    if (typeof text !== 'string' || !text.trim() || !deps.canShow(id)) return;
    const run = seq;
    let found = await locate(id, wc);
    if (run !== seq || !deps.canShow(id)) return;
    const pageView = deps.viewOf(id);
    if (!pageView) return;
    if (!found) {
      const p = point && Number.isFinite(point.x) ? point : { x: 0, y: 0 };
      found = { id, text: '', at: JSON.stringify(pageView.getBounds()), sel: { x: p.x, y: p.y, w: 0, h: 0, top: p.y }, zoom: wc.getZoomFactor() };
    }
    // 读到了选区就用读到的（只有消息正文，不带时间）；读不到用右键菜单给的文字
    if (!found.text) found.text = text.trim().slice(0, 4000);
    if (await show({ ...found, mode: 'card', st: { busy: true }, h: 0 })) translate();
  }

  // 只接受这个小视图自己发来的
  const fromView = (e) => alive() && e.sender === view.webContents;
  ipcMain.on('seltr:ready', (e) => { if (fromView(e)) { ready = true; push(); } });
  ipcMain.on('seltr:go', (e) => { if (fromView(e) && shown && shown.mode === 'button') translate(); });
  ipcMain.on('seltr:retry', (e) => { if (fromView(e) && shown && shown.mode === 'card' && shown.st && shown.st.error) translate(); });
  ipcMain.on('seltr:copy', (e, text) => {
    if (!fromView(e) || !shown || !shown.st || typeof text !== 'string' || text !== shown.st.text) return;
    deps.copy(text);
  });
  ipcMain.on('seltr:size', (e, h) => {
    if (!fromView(e) || !shown || shown.mode !== 'card' || !Number.isFinite(h)) return;
    shown.h = Math.ceil(h) + PAD * 2;
    place();
  });
  ipcMain.on('seltr:hide', (e) => { if (fromView(e)) hide(); });

  // 退出软件时调（main.js 的 before-quit）：拆掉视图，之后不再响应
  function shutdown() {
    stopped = true;
    seq += 1;
    closeView();
  }

  return { watch, hide, sync, fromMenu, close: closeView, shutdown, get shown() { return shown ? { id: shown.id, text: shown.text, mode: shown.mode } : null; } };
}

module.exports = { createSelTranslate, placeBox, placeButton, quietKey, BTN, CARD_W, PAD };
