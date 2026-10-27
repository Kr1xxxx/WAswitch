// 自带通知弹窗：屏幕右上角的一个透明小窗口，B 样式（WhatsApp 头像卡）。
// 不用系统通知（shen 2026-10-27：只要我们自己的弹窗）。
//
// - 只在有卡片时才建窗口；卡片都收走后先藏起来，空闲 1 分钟就关掉，平时不常驻（省内存）
// - 不抢焦点：窗口不能获得焦点，弹出时用 showInactive，别的软件里打字不会被打断
// - 窗口默认“点穿”：鼠标只有停在卡片上时才接收点击，其余透明的地方点下去落在下面的软件上
// - 聊天锁打开时：不显示客户名字、头像和消息内容
// - 勿扰打开时：一张都不弹（调用方照常记通知记录）
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { PopupQueue } = require('./popup-queue');

const CARD_W = 344;
const PAD = { top: 4, right: 8, bottom: 24, left: 24 }; // 卡片四周留给阴影的透明边
const WIN_W = CARD_W + PAD.left + PAD.right;
const WIN_H = 600; // 3 张卡 + “还有 N 条”，透明部分点穿
const IDLE_CLOSE_MS = 60 * 1000;
const SOUND_GAP_MS = 2000; // 两次提示音至少隔这么久，连着来很多条不会响成一片

class PopupWindow {
  // hooks: { getWindow(), account(id) -> { name, color }, locked(), settings() -> { popupSeconds, popupSound, popupDnd },
  //          onOpen(card), onLater(card) }
  constructor(hooks, { now = () => Date.now(), idleCloseMs = IDLE_CLOSE_MS } = {}) {
    this.hooks = hooks;
    this.now = now;
    this.idleCloseMs = idleCloseMs;
    this.queue = new PopupQueue({ now, durationMs: this.durationMs() });
    this.win = null;
    this.ready = false;
    this.timer = null;
    this.idleTimer = null;
    this.lastSound = 0;
    this.pendingSound = false;
  }

  durationMs() {
    const s = this.hooks.settings().popupSeconds;
    return Number.isInteger(s) && s >= 0 ? s * 1000 : 6000;
  }

  get dnd() { return !!this.hooks.settings().popupDnd; }

  // card: { key, kind: 'msg'|'notice'|'app'|'sample', accId?, chat?, text, count?, again?, sensitive?, onClick? }
  // 返回 true 表示弹出来了
  show(card) {
    if (this.dnd) return false;
    this.queue.durationMs = this.durationMs();
    this.queue.push(card);
    if (this.hooks.settings().popupSound !== false && this.now() - this.lastSound >= SOUND_GAP_MS) {
      this.lastSound = this.now();
      this.pendingSound = true;
    }
    this.ensureWindow();
    this.render();
    return true;
  }

  // 某个号的卡片都不要了（未读清零、号被删了、用户切过去看了）
  dropAccount(accId, keep) {
    if (this.queue.removeWhere((x) => x.accId === accId && (!keep || !keep(x)))) this.render();
  }

  // 设置或聊天锁变了：重新画（锁上后马上遮住名字和内容）
  refresh() {
    this.queue.setDuration(this.durationMs());
    if (this.dnd && this.queue.size) this.queue.clear();
    this.render();
  }

  ensureWindow() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.win && !this.win.isDestroyed()) return;
    const mac = process.platform === 'darwin';
    this.ready = false;
    this.win = new BrowserWindow({
      width: WIN_W, height: WIN_H, ...this.position(),
      show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, closable: true,
      skipTaskbar: true, focusable: false, alwaysOnTop: true, title: 'WAswitch 通知',
      ...(mac ? { type: 'panel' } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'popup', 'preload.js'),
        sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false,
        autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false,
      },
    });
    const w = this.win;
    w.setAlwaysOnTop(true, 'screen-saver');
    if (mac) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    w.setIgnoreMouseEvents(true, { forward: true });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.on('closed', () => { if (this.win === w) { this.win = null; this.ready = false; } });
    w.loadFile(path.join(__dirname, 'popup', 'index.html')).catch(() => {});
  }

  // 放在 WAswitch 主窗口所在那块屏幕的右上角（Mac 在菜单栏下面）
  position() {
    const main = this.hooks.getWindow();
    let display;
    try {
      display = main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
    } catch {
      display = screen.getPrimaryDisplay();
    }
    const wa = display.workArea;
    const gap = process.platform === 'darwin' ? 10 : 12; // 卡片离屏幕边的距离
    return {
      x: Math.round(wa.x + wa.width - gap - CARD_W - PAD.left),
      y: Math.round(wa.y + gap - PAD.top),
    };
  }

  // 主进程发给弹窗页面的内容：聊天锁开着时名字、头像、内容都不发过去
  model() {
    const locked = !!this.hooks.locked();
    const { shown, more } = this.queue.view();
    const cards = shown.map((c) => {
      const acc = c.accId ? this.hooks.account(c.accId) : null;
      const accChip = acc ? { name: acc.name, color: acc.color } : null;
      if (c.kind === 'msg' || c.kind === 'sample') {
        const hide = locked && c.kind === 'msg';
        return {
          uid: c.uid, kind: 'msg', at: c.at, again: !!c.again, acc: accChip,
          who: hide ? '新消息' : (c.chat || (acc ? acc.name : '新消息')),
          avatar: hide ? { lock: true } : (c.chat ? { text: initials(c.chat), color: colorFor(c.chat) } : { logo: true }),
          text: hide ? (acc ? '有新消息，聊天已锁定，解锁后查看' : '有新消息，解锁后查看') : c.text,
          count: hide ? 0 : (c.count > 1 ? c.count : 0),
          actions: ['later', 'open'],
        };
      }
      const hide = locked && c.sensitive;
      return {
        uid: c.uid, kind: c.kind, at: c.at, again: !!c.again, acc: accChip,
        who: c.kind === 'notice' && acc ? acc.name : (c.title || 'WAswitch'),
        avatar: { logo: true },
        text: hide ? '有一条提醒，解锁后查看' : c.text,
        count: 0,
        actions: ['open'],
      };
    });
    return { cards, more, platform: process.platform };
  }

  render() {
    clearTimeout(this.timer);
    this.timer = null;
    const w = this.win;
    if (!this.queue.size) {
      if (w && !w.isDestroyed()) {
        if (this.ready) w.webContents.send('popup:state', { cards: [], more: 0, platform: process.platform });
        this.queue.setHover(false);
        w.setIgnoreMouseEvents(true, { forward: true });
        w.hide();
        // 空闲 1 分钟就关掉窗口，不常驻
        if (!this.idleTimer) this.idleTimer = setTimeout(() => this.closeWindow(), this.idleCloseMs);
      }
      return;
    }
    if (!w || w.isDestroyed()) return;
    if (this.ready) {
      const state = this.model();
      if (this.pendingSound) { state.sound = true; this.pendingSound = false; }
      w.webContents.send('popup:state', state);
      w.setBounds({ ...this.position(), width: WIN_W, height: WIN_H });
      if (!w.isVisible()) w.showInactive();
    }
    const next = this.queue.nextExpiry();
    if (next && !this.queue.hoverSince) this.timer = setTimeout(() => { this.queue.tick(); this.render(); }, Math.max(50, next - this.now() + 20));
  }

  closeWindow() {
    this.idleTimer = null;
    if (this.queue.size) return;
    const w = this.win;
    this.win = null;
    this.ready = false;
    if (w && !w.isDestroyed()) w.destroy();
  }

  // 弹窗页面发来的事件
  onReady(sender) {
    if (!this.win || this.win.isDestroyed() || sender !== this.win.webContents) return;
    this.ready = true;
    this.render();
  }

  onHover(sender, on) {
    if (!this.win || this.win.isDestroyed() || sender !== this.win.webContents) return;
    // 鼠标在卡片上：接收点击，暂停倒计时；离开：恢复点穿，接着倒计时
    this.win.setIgnoreMouseEvents(!on, { forward: true });
    this.queue.setHover(!!on);
    if (!on) this.render();
  }

  onAction(sender, uid, action) {
    if (!this.win || this.win.isDestroyed() || sender !== this.win.webContents) return;
    if (action === 'clear') { this.queue.clear(); this.render(); return; }
    const card = this.queue.get(uid);
    if (!card) return;
    this.queue.remove(uid);
    this.render();
    if (action === 'open') this.hooks.onOpen(card);
    else if (action === 'later') this.hooks.onLater(card);
    // 'close'：只是收起这一张
  }
}

// 头像：名字首字母，颜色按名字固定（不加载客户真实头像：那要从 WhatsApp 的服务器下载，会绕开账号的代理）
function initials(name) {
  const words = String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '#';
  const first = [...words[0]][0] || '';
  if (/[㐀-鿿]/.test(first)) return first; // 中文名只写第一个字
  const second = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return (first + second).toUpperCase();
}

const AVATAR_COLORS = ['#8B6F5A', '#4F7A8C', '#6B7F4E', '#A0566B', '#5A5F8C', '#7A6A3A', '#3F7D74', '#8C5A86'];
function colorFor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

module.exports = { PopupWindow, initials, colorFor, IDLE_CLOSE_MS };
