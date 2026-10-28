// 自带通知弹窗：屏幕右上角的一个透明小窗口，B 样式（WhatsApp 头像卡）。
// 不用系统通知（shen 2026-10-27：只要我们自己的弹窗）。
//
// - 只在有卡片时才建窗口；卡片都收走后先藏起来，空闲 1 分钟就关掉，平时不常驻（省内存）
// - 不抢焦点：窗口不能获得焦点，弹出时用 showInactive，别的软件里打字不会被打断
// - 窗口默认“点穿”：鼠标只有停在卡片上时才接收点击，其余透明的地方点下去落在下面的软件上
// - 倒计时只在用户在用电脑时走（shen 2026-10-27：没动鼠标、没按键就不要消失）：每半秒看一眼系统多久没输入，
//   刚有输入才扣时间；鼠标停在弹窗上、卡片藏在“还有 N 条”后面、窗口还没显示出来时也不扣
// - 离开电脑超过 5 分钟（shen 2026-10-27）：卡片不再自动消失，回来后要一张一张手动点；没有“全部收起”
// - 聊天锁打开时：不显示客户名字、头像和消息内容
// - 勿扰打开时：新消息不弹；退出登录、断线、新版本这类提醒照弹，只是不响（不然用户开着勿扰就永远不知道号掉了）
const { BrowserWindow, screen, powerMonitor } = require('electron');
const path = require('path');
const { PopupQueue } = require('./popup-queue');
const EMOJI = require('./emoji/list');
const RADIX = require('./colors/radix');

const CARD_W = 344;
const PAD = { top: 4, right: 8, bottom: 24, left: 24 }; // 卡片四周留给阴影的透明边
const WIN_W = CARD_W + PAD.left + PAD.right;
const WIN_H = 600; // 3 张卡 + “还有 N 条”，透明部分点穿
const IDLE_CLOSE_MS = 60 * 1000;
const SOUND_GAP_MS = 2000; // 两次提示音至少隔这么久，连着来很多条不会响成一片
const TICK_MS = 500; // 倒计时每多久走一步
const ACTIVE_WITHIN_S = 5; // 这么多秒内有过键盘鼠标输入才算“在用电脑”，倒计时才走
const AWAY_AFTER_S = 5 * 60; // 离开电脑超过这么久：现有的和期间来的卡片都不再自动消失，回来后要手动一张一张点掉
const HOVER_MAX_MS = 60 * 1000; // 悬停暂停最多这么久，之后当作鼠标已经不在上面（兜底）
const READY_TIMEOUT_MS = 10 * 1000; // 建窗后这么久页面还没就绪：销毁重建
const MAX_REBUILDS = 3; // 页面连续起不来最多重建几次，再多就等下一次 show()

const isMsg = (card) => card.kind === 'msg' || card.kind === 'sample';

class PopupWindow {
  // hooks: { getWindow(), account(id) -> { name, color }, locked(), settings() -> { popupSeconds, popupSound, popupDnd },
  //          onOpen(card), onLater(card), idleSeconds?() -> 系统多少秒没有键盘鼠标输入（默认用 powerMonitor） }
  constructor(hooks, { now = () => Date.now(), idleCloseMs = IDLE_CLOSE_MS } = {}) {
    this.hooks = hooks;
    this.now = now;
    this.idleCloseMs = idleCloseMs;
    this.queue = new PopupQueue({ now, durationMs: this.durationMs() });
    this.win = null;
    this.ready = false;
    this.ticker = null;
    this.lastTick = 0;
    this.idleTimer = null;
    this.readyTimer = null;
    this.rebuilds = 0;
    this.lastSound = 0;
    this.pendingSound = false;
    this.lastSig = ''; // 上次发给页面的内容，没变就不重发（页面不用重画，正按着的按钮不会丢）
  }

  durationMs() {
    const s = this.hooks.settings().popupSeconds;
    return Number.isInteger(s) && s >= 0 ? s * 1000 : 6000;
  }

  get dnd() { return !!this.hooks.settings().popupDnd; }

  // 系统多少秒没有键盘鼠标输入；拿不到就当作一直在用（倒计时照走）
  idleSeconds() {
    try {
      if (this.hooks.idleSeconds) return this.hooks.idleSeconds();
      return powerMonitor ? powerMonitor.getSystemIdleTime() : 0;
    } catch {
      return 0;
    }
  }

  get userActive() { return this.idleSeconds() < ACTIVE_WITHIN_S; }

  get userAway() { return this.idleSeconds() >= AWAY_AFTER_S; }

  // card: { key, kind: 'msg'|'notice'|'app'|'sample', accId?, chat?, text, count?, again?, sensitive?, onClick? }
  // 返回 true 表示弹出来了
  show(card) {
    const dnd = this.dnd;
    if (dnd && isMsg(card)) return false;
    this.queue.setDuration(this.durationMs());
    this.queue.push(card);
    if (this.userAway) this.queue.makeSticky(); // 人不在电脑前来的消息：留着等人回来点
    if (!dnd && this.hooks.settings().popupSound !== false && this.now() - this.lastSound >= SOUND_GAP_MS) {
      this.lastSound = this.now();
      this.pendingSound = true;
    }
    this.rebuilds = 0;
    this.ensureWindow();
    this.render();
    return true;
  }

  // 某个号的卡片都不要了（未读清零、号被删了、用户切过去看了）
  dropAccount(accId, keep) {
    if (this.queue.removeWhere((x) => x.accId === accId && (!keep || !keep(x)))) this.render();
  }

  // 收掉某个 key 的卡（比如读到客户列表后，把“有 N 个未读对话”那张号的卡收掉）
  dropKey(key) {
    if (this.queue.removeWhere((x) => x.key === key)) this.render();
  }

  // 设置或聊天锁变了：重新画（锁上后马上遮住名字和内容；开了勿扰就把新消息的卡收掉）
  refresh() {
    this.queue.setDuration(this.durationMs());
    if (this.dnd) this.queue.removeWhere(isMsg);
    this.render();
  }

  ensureWindow() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.win && !this.win.isDestroyed()) return;
    const mac = process.platform === 'darwin';
    this.ready = false;
    this.lastSig = '';
    this.win = new BrowserWindow({
      width: WIN_W, height: WIN_H, ...this.position(),
      show: false, frame: false, transparent: true, backgroundColor: RADIX.TRANSPARENT, hasShadow: false,
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
    // 页面起不来（加载失败、渲染进程没了、迟迟不就绪）：销毁重建，不然卡片进了队列却永远不显示
    w.webContents.on('did-fail-load', (_e, code, desc) => { if (code !== -3) this.dropWindow(w, `加载失败 ${code} ${desc || ''}`); });
    w.webContents.on('render-process-gone', (_e, d) => this.dropWindow(w, `渲染进程退出 ${d && d.reason}`));
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => { if (this.win === w && !this.ready) this.dropWindow(w, '页面一直没就绪'); }, READY_TIMEOUT_MS);
    w.on('closed', () => { if (this.win === w) { this.win = null; this.ready = false; } });
    w.loadFile(path.join(__dirname, 'popup', 'index.html')).catch(() => {});
  }

  dropWindow(w, why) {
    if (this.win !== w) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    console.warn(`通知弹窗窗口${why}，重建`);
    this.win = null;
    this.ready = false;
    if (!w.isDestroyed()) w.destroy();
    if (!this.queue.size) return;
    this.rebuilds += 1;
    if (this.rebuilds <= MAX_REBUILDS) { this.ensureWindow(); this.render(); } else console.warn('通知弹窗页面连续起不来，先不再重建');
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

  // 鼠标现在是否真的在弹窗窗口里（页面说“鼠标停在卡上”时核对一下，窗口藏过再显示时页面记的旧位置不可信）
  cursorInside() {
    const w = this.win;
    if (!w || w.isDestroyed()) return false;
    try {
      const p = screen.getCursorScreenPoint();
      const b = w.getBounds();
      return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    } catch {
      return true;
    }
  }

  // 主进程发给弹窗页面的内容：聊天锁开着时名字、头像、内容都不发过去
  model() {
    const locked = !!this.hooks.locked();
    const { shown, more } = this.queue.view();
    const cards = shown.map((c) => {
      const acc = c.accId ? this.hooks.account(c.accId) : null;
      const accChip = acc ? { name: acc.name, color: acc.color, emoji: EMOJI.valid(acc.emoji) ? acc.emoji : '' } : null;
      if (isMsg(c)) {
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

  send(state) {
    const w = this.win;
    if (!w || w.isDestroyed() || !this.ready) return;
    w.webContents.send('popup:state', state);
  }

  render() {
    const w = this.win;
    if (!this.queue.size) {
      this.stopTicker();
      if (w && !w.isDestroyed()) {
        this.lastSig = '';
        this.send({ cards: [], more: 0, platform: process.platform });
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
      const sig = JSON.stringify(state);
      if (sig !== this.lastSig || this.pendingSound) {
        this.lastSig = sig;
        if (this.pendingSound) { state.sound = true; this.pendingSound = false; }
        this.send(state);
      }
      w.setBounds({ ...this.position(), width: WIN_W, height: WIN_H });
      if (!w.isVisible()) w.showInactive();
    }
    this.startTicker();
  }

  startTicker() {
    if (this.ticker || !this.queue.hasExpiring) return;
    this.lastTick = this.now();
    this.ticker = setInterval(() => this.tick(), TICK_MS);
  }

  stopTicker() {
    clearInterval(this.ticker);
    this.ticker = null;
  }

  // 每半秒：决定这一步要不要扣倒计时
  tick() {
    const now = this.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    const w = this.win;
    if (!this.queue.size || !this.queue.hasExpiring) { this.stopTicker(); return; }
    if (!w || w.isDestroyed() || !this.ready || !w.isVisible()) return; // 还没显示出来：不算
    if (this.queue.hoverSince) {
      // 页面说鼠标停在上面，但鼠标其实不在窗口里（窗口藏过再显示时页面记的是旧位置），或者停得太久：当作移开
      if (!this.cursorInside() || now - this.queue.hoverSince > HOVER_MAX_MS) this.resetHover();
      else return;
    }
    if (this.userAway) { this.queue.makeSticky(); return; } // 离开超过 5 分钟：这些卡都留着，回来手动点
    if (!this.userActive) return; // 没动鼠标、没按键：不消失
    if (this.queue.advance(dt)) this.render();
  }

  // 悬停状态作废：恢复点穿、接着倒计时，并让页面忘掉记住的鼠标位置
  resetHover() {
    this.queue.setHover(false);
    const w = this.win;
    if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(true, { forward: true });
    this.send({ ...this.model(), resetHover: true });
  }

  closeWindow() {
    this.idleTimer = null;
    if (this.queue.size) return;
    const w = this.win;
    this.win = null;
    this.ready = false;
    this.stopTicker();
    if (w && !w.isDestroyed()) w.destroy();
  }

  // 弹窗页面发来的事件
  onReady(sender) {
    if (!this.win || this.win.isDestroyed() || sender !== this.win.webContents) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.ready = true;
    this.rebuilds = 0;
    this.render();
  }

  onHover(sender, on) {
    if (!this.win || this.win.isDestroyed() || sender !== this.win.webContents) return;
    // 鼠标在卡片上：接收点击，暂停倒计时；离开：恢复点穿，接着倒计时
    if (on && !this.cursorInside()) return; // 鼠标根本不在窗口里：页面记的是旧位置，不信
    this.win.setIgnoreMouseEvents(!on, { forward: true });
    this.queue.setHover(!!on);
  }

  onAction(sender, uid, action) {
    if (!this.win || this.win.isDestroyed() || sender !== this.win.webContents) return;
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

const AVATAR_COLORS = RADIX.AVATAR_COLORS;
function colorFor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

module.exports = { PopupWindow, initials, colorFor, IDLE_CLOSE_MS, ACTIVE_WITHIN_S, AWAY_AFTER_S, TICK_MS };
