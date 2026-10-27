// 未读汇总、托盘图标、任务栏角标、新消息弹窗。
//
// 未读数来自每个账号页面的标题（WhatsApp 会把标题改成 "(3) WhatsApp"），
// 这个数字是“有未读消息的对话数”。
//
// 不用系统通知，也不用 WhatsApp 自己的网页通知（看不出是哪个号），改由这里弹 WAswitch 自带的弹窗（popup.js）：
// - 某个号的未读对话数变多，或者对话列表里某个客户的未读条数变多：每个客户一张卡，
//   写客户名字、哪个号收到的、对话列表里的最后一条预览；同一个客户再来就合并成一张
// - 对话列表来自 hooks.readChats（网页号在隔离环境里只读对话列表，不往页面注入；轻量号来自后台进程）
// - 读不到对话列表（页面在加载、聊天锁着）时：一张号的卡，写“有 N 个未读对话”
// - 用户正看着这个号（WAswitch 在前台、正开着这个号）不弹；看着别的号或 WAswitch 在后台照常弹
const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { unreadBody, unreadNames, grownChats, chatKey } = require('./notify-text');

const READ_TIMEOUT_MS = 2000; // 读对话列表最多等这么久，超时就用“有 N 个未读对话”
const LATER_MS = 10 * 60 * 1000; // 点“稍后”：10 分钟后还没读再弹一次
const RECENT_POP_MS = 15 * 1000; // 这么久之内这个号刚弹过卡片，读不出新客户时就不再补一张号的卡

const asset = (name) => path.join(__dirname, '..', 'assets', name);

class Notifier {
  // hooks: { getAccounts(), isMuted(acc), getWindow(), activate(id), quit(), readChats(acc), popup, openChat(id, jid) }
  constructor(hooks, { laterMs = LATER_MS } = {}) {
    this.hooks = hooks;
    this.laterMs = laterMs;
    this.popSeq = new Map(); // id -> 最近一次读对话列表的编号，读的期间又有新消息就只用新的
    this.unread = new Map(); // id -> 未读对话数
    this.seen = new Map(); // id -> Map(客户 -> 已经弹过的未读条数)
    this.lastPop = new Map(); // id -> 最近一次弹卡片的时间
    this.laterTimers = new Map(); // 卡片 key -> “稍后”的定时器
    this.scanning = new Map(); // id -> 正在读对话列表的次数
    this.tray = null;
    this.lastNewAt = 0; // 最近一次有新消息的时间（含静音账号），自动装更新用
  }

  get popup() { return this.hooks.popup || null; }

  init() {
    if (process.platform === 'win32') app.setAppUserModelId('com.waswitch.app');
    this.tray = new Tray(this.trayImage(false));
    this.trayState = 'plain';
    this.tray.on('click', () => this.showWindow());
    this.refresh();
  }

  // Mac 菜单栏用黑白模板图（系统按深浅色自动变色），有未读或有号断线时换成带圆点的那张；
  // Windows 托盘平时不变，有号断线时换成带红点的那张
  trayImage(unread, offline = false) {
    if (process.platform !== 'darwin') return nativeImage.createFromPath(asset(offline ? 'trayOffline.png' : 'tray.png'));
    const img = nativeImage.createFromPath(asset(unread || offline ? 'trayUnreadTemplate.png' : 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }

  total() {
    let sum = 0;
    for (const n of this.unread.values()) sum += n;
    return sum;
  }

  // 这个号是否不弹通知：账号自己关了，或者所在分组整组关了
  muted(acc) {
    return this.hooks.isMuted ? this.hooks.isMuted(acc) : !!acc.muted;
  }

  // 勿扰开着：一张都不弹
  get dnd() { return !!(this.popup && this.popup.dnd); }

  // 用户正看着这个号：WAswitch 在前台，正开着这个号
  looking(isActive) {
    const win = this.hooks.getWindow();
    return !!(isActive && win && win.isVisible() && win.isFocused());
  }

  showWindow() {
    const win = this.hooks.getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    // Mac：从弹窗（不抢焦点的小窗口）点“打开”时，软件本身不在前台，要先把软件叫到前台
    if (process.platform === 'darwin') app.focus({ steal: true });
    win.focus();
  }

  // 页面标题变化时调用
  // baseline：页面刚刷新时，刷新前的未读数。涨回这个数之前不算新消息
  update(acc, count, { isActive, baseline = 0 }) {
    const prev = this.unread.get(acc.id) || 0;
    const before = Math.max(prev, baseline);
    this.unread.set(acc.id, count);
    // 有对话被读掉了：记下的“弹过几条”可能对不上了，下次重新对
    if (count < prev) this.seen.delete(acc.id);
    // 全读完了：这个号的卡片收起来，“稍后”也不用再提醒
    if (count === 0) this.dropCards(acc.id);
    if (count > before) this.lastNewAt = Date.now();
    const popped = count > before && !this.muted(acc) && !this.looking(isActive) && !this.dnd;
    if (popped) this.scan(acc, { count, fresh: count - before });
    // 通知记录：只记哪个号、什么时候、几个未读，以及有没有弹出来；不记消息内容
    if (count > before && this.hooks.onNew) this.hooks.onNew({ id: acc.id, count, popped });
    this.refresh();
  }

  // 未读对话数没变，但某个客户又发了一条（同一个对话的未读条数变多）：网页号定时看一眼对话列表，轻量号由后台进程推过来
  recheck(acc, { isActive }) {
    if (!(this.unread.get(acc.id) > 0) || this.muted(acc) || this.looking(isActive) || this.dnd) return;
    if (this.scanning.get(acc.id)) return; // 正在读（比如未读数刚变多），别打断它
    this.scan(acc, { poll: true });
  }

  async readChats(acc) {
    if (!this.hooks.readChats) return null;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.hooks.readChats(acc)),
        new Promise((r) => { timer = setTimeout(() => r(null), READ_TIMEOUT_MS); }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // 读对话列表，给未读变多的客户弹卡片；读不到就弹一张号的卡
  async scan(acc, { count = 0, fresh = 1, poll = false } = {}) {
    const seq = (this.popSeq.get(acc.id) || 0) + 1;
    this.popSeq.set(acc.id, seq);
    this.scanning.set(acc.id, (this.scanning.get(acc.id) || 0) + 1);
    let chats;
    try {
      chats = await this.readChats(acc);
    } finally {
      const left = (this.scanning.get(acc.id) || 1) - 1;
      if (left > 0) this.scanning.set(acc.id, left); else this.scanning.delete(acc.id);
    }
    // 读的期间这个号又来了新消息（会另读一次），或者未读已经清零、号被删了，这次就算了
    if (this.popSeq.get(acc.id) !== seq) return;
    const n = this.unread.get(acc.id) || 0;
    if (!(n > 0)) return;
    if (!Array.isArray(chats)) {
      if (!poll) this.popAccount(acc, n, null);
      return;
    }
    const prevSeen = this.seen.get(acc.id) || null;
    const { fresh: list, seen } = grownChats(prevSeen, chats, fresh);
    this.seen.set(acc.id, seen);
    if (poll && !prevSeen) return; // 第一次看这个号的列表：只记下来，不弹以前的未读
    if (!list.length) {
      // 列表里找不到新客户（被搜索筛掉了、还没排好）：刚弹过就算了，没弹过补一张号的卡
      if (!poll && Date.now() - (this.lastPop.get(acc.id) || 0) > RECENT_POP_MS) this.popAccount(acc, count || n, unreadNames(chats));
      return;
    }
    // 倒着放，列表里最近的那个客户最后放、在最上面
    for (const c of list.slice().reverse()) {
      this.show({ key: `m:${acc.id}:${c.key}`, kind: 'msg', accId: acc.id, chat: c.name, chatKey: c.key, jid: c.jid, text: c.preview || '发来新消息', count: c.unread });
    }
  }

  popAccount(acc, count, names) {
    this.show({ key: `m:${acc.id}:*`, kind: 'msg', accId: acc.id, chat: '', text: unreadBody(count, names), count: 0 });
  }

  show(card) {
    if (!this.popup) return false;
    if (card.accId) this.lastPop.set(card.accId, Date.now());
    return this.popup.show(card);
  }

  // 弹窗上点了“打开”
  open(card) {
    if (card.kind === 'app' || card.kind === 'sample') {
      if (card.onClick) card.onClick(); else this.showWindow();
      return;
    }
    this.showWindow();
    if (!card.accId) return;
    this.hooks.activate(card.accId);
    if (card.jid && this.hooks.openChat) this.hooks.openChat(card.accId, card.jid);
  }

  // 弹窗上点了“稍后”：10 分钟后这个客户（读不到列表就看这个号）还有未读，再弹一次
  later(card) {
    if (card.kind !== 'msg' || !card.accId) return;
    clearTimeout(this.laterTimers.get(card.key));
    const t = setTimeout(async () => {
      this.laterTimers.delete(card.key);
      const acc = (this.hooks.getAccounts() || []).find((a) => a.id === card.accId);
      if (!acc || !(this.unread.get(acc.id) > 0) || this.muted(acc)) return;
      let still = true;
      if (card.chatKey) {
        const chats = await this.readChats(acc);
        if (Array.isArray(chats)) {
          const c = chats.find((x) => chatKey(x) === card.chatKey);
          still = !!(c && c.unread > 0);
        }
      }
      if (still && this.unread.get(acc.id) > 0) this.show({ ...card, again: true });
    }, this.laterMs);
    this.laterTimers.set(card.key, t);
  }

  dropCards(id) {
    for (const [key, t] of this.laterTimers) if (key.startsWith(`m:${id}:`)) { clearTimeout(t); this.laterTimers.delete(key); }
    if (this.popup) this.popup.dropAccount(id, (c) => c.kind !== 'msg');
  }

  forget(id) {
    this.unread.delete(id);
    this.popSeq.delete(id);
    this.seen.delete(id);
    this.lastPop.delete(id);
    this.dropCards(id);
    if (this.popup) this.popup.dropAccount(id);
    this.refresh();
  }

  // 号自己的提醒（退出登录、被封、连接出错）：标题是账号名
  notify(acc, body) {
    return this.show({ key: `n:${acc.id}:${body}`, kind: 'notice', accId: acc.id, text: body });
  }

  // 软件自己的提醒（新版本已下载、断线、跟进提醒）。sensitive：带客户名字，聊天锁着时不显示
  notifyApp(title, body, onClick, { sensitive = false } = {}) {
    return this.show({ key: `app:${title}:${body}`, kind: 'app', title, text: body, onClick, sensitive });
  }

  // 刷新任务栏角标、托盘提示和托盘菜单
  refresh() {
    const total = this.total();
    const win = this.hooks.getWindow();

    // macOS Dock 显示数字
    if (process.platform !== 'win32') app.setBadgeCount(total);
    // Windows 任务栏：图标右下角加红点
    if (process.platform === 'win32' && win) {
      win.setOverlayIcon(total ? nativeImage.createFromPath(asset('badge.png')) : null, total ? `${total} 个未读对话` : '');
    }
    if (win) win.setTitle(total ? `(${total}) WAswitch` : 'WAswitch');

    if (!this.tray) return;
    const accounts = this.hooks.getAccounts();
    // 断线满 2 分钟的号（offline-watch.js 判断）
    const isOffline = (id) => (this.hooks.isOffline ? this.hooks.isOffline(id) : false);
    const down = accounts.filter((a) => isOffline(a.id)).length;
    // 托盘图标：Mac 有未读或断线时带圆点，Windows 有号断线时带红点
    const state = `${total ? 'u' : ''}${down ? 'd' : ''}` || 'plain';
    if (state !== this.trayState) {
      this.trayState = state;
      this.tray.setImage(this.trayImage(!!total, !!down));
    }
    // Mac 菜单栏：图标旁边显示未读数，有号断线时加“断线”
    if (process.platform === 'darwin') {
      const title = [total ? String(total) : '', down ? '断线' : ''].filter(Boolean).join(' ');
      this.tray.setTitle(title, { fontType: 'monospacedDigit' });
    }
    const mem = this.hooks.totalMemory ? this.hooks.totalMemory() : 0;
    const memText = mem ? ` · 共占用 ${mem} MB` : '';
    const upd = this.hooks.trayText ? this.hooks.trayText() : '';
    const downText = down ? `\n${down} 个号断线，客户消息收不到` : '';
    const dndText = this.dnd ? '\n勿扰中，新消息不弹窗' : '';
    this.tray.setToolTip(`${total ? `WAswitch · ${total} 个未读对话` : 'WAswitch'}${memText}${downText}${dndText}${upd ? `\n${upd}` : ''}`);
    const items = accounts.map((acc) => {
      const n = this.unread.get(acc.id) || 0;
      const mb = this.hooks.memoryOf ? this.hooks.memoryOf(acc.id) : 0;
      return {
        label: `${isOffline(acc.id) ? '⚠ ' : ''}${acc.name}${n ? `（${n}）` : ''}${isOffline(acc.id) ? ' · 断线' : ''}${this.muted(acc) ? ' · 不弹通知' : ''}${mb ? ` · ${mb} MB` : ''}`,
        click: () => { this.showWindow(); this.hooks.activate(acc.id); },
      };
    });
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示窗口', click: () => this.showWindow() },
      ...(this.hooks.updateMenu ? this.hooks.updateMenu() : []),
      { type: 'separator' },
      ...items,
      { type: 'separator' },
      ...(this.hooks.setDnd ? [{ label: '勿扰（新消息不弹窗）', type: 'checkbox', checked: this.dnd, click: () => this.hooks.setDnd(!this.dnd) }] : []),
      ...(this.hooks.settingsMenu ? [...this.hooks.settingsMenu(), { type: 'separator' }] : []),
      { label: '退出 WAswitch', click: () => this.hooks.quit() },
    ]));
  }
}

module.exports = { Notifier };
