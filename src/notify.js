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
// - 同一条消息只弹一次：按 号 + 客户 + 这条消息（预览的指纹 + 未读条数）记下弹过的（popped），
//   刷新页面、重连、软件重启、标题里的数字掉了又回来，都不会把弹过的再弹一遍。只有点了“稍后”会按约定再提醒一次
// - 切网络、页面重新加载、轻量号重连时（hold），未读数掉了又回到原来的数不算新消息：
//   这期间不因为列表里角标暂时没了就忘掉弹过的，回来时列表读不出也不补“有 N 个未读对话”
const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { unreadBody, unreadNames, grownChats, chatKey, cleanPreview, popSig, clockOf } = require('./notify-text');

const READ_TIMEOUT_MS = 2000; // 读对话列表最多等这么久，超时就用“有 N 个未读对话”
const LATER_MS = 10 * 60 * 1000; // 点“稍后”：10 分钟后还没读再弹一次
// 托盘菜单是系统原生菜单，不能用样式：几段之间用一个全角宽的空格隔开，不用中点
const GAP = '\u2003';
const RECENT_POP_MS = 15 * 1000; // 这么久之内这个号刚弹过卡片，读不出新客户时就不再补一张号的卡
const MAX_POPPED = 200; // 每个号最多记多少个客户“弹过哪一条”
const HOLD_MS = 3 * 60 * 1000; // 重连（切网、页面重新加载）最后一次动静之后这么久内，未读数回到原来的数不算新消息

const asset = (name) => path.join(__dirname, '..', 'assets', name);

class Notifier {
  // hooks: { getAccounts(), isMuted(acc), getWindow(), activate(id), quit(), readChats(acc), popup, openChat(id, jid), isActive(id),
  //          loadPopped() -> { id: { 客户: { sig, unread } } }, savePopped(同样的结构) }
  constructor(hooks, { laterMs = LATER_MS, holdMs = HOLD_MS } = {}) {
    this.hooks = hooks;
    this.laterMs = laterMs;
    this.holdMs = holdMs;
    this.holds = new Map(); // id -> { count, until }：这个号正在重连，重连前有几个未读对话
    this.popSeq = new Map(); // id -> 最近一次读对话列表的编号，读的期间又有新消息就只用新的
    this.unread = new Map(); // id -> 未读对话数
    this.seen = new Map(); // id -> Map(客户 -> 已经弹过的未读条数)
    this.poppedMap = null; // id -> Map(客户 -> { sig, unread })：弹过（或用户看着时已经出现过）的那一条，存在磁盘上
    this.lastPop = new Map(); // id -> 最近一次弹卡片的时间
    this.laterTimers = new Map(); // 卡片 key -> “稍后”的定时器
    this.scanning = new Map(); // id -> 正在读对话列表的次数
    this.tray = null;
    this.lastNewAt = 0; // 最近一次有新消息的时间（含静音账号），自动装更新用
  }

  get popup() { return this.hooks.popup || null; }

  // 弹过的记录：第一次用时从磁盘读
  get popped() {
    if (!this.poppedMap) {
      this.poppedMap = new Map();
      let raw = null;
      try { raw = this.hooks.loadPopped ? this.hooks.loadPopped() : null; } catch { raw = null; }
      if (raw && typeof raw === 'object') {
        for (const [id, chats] of Object.entries(raw)) {
          if (!chats || typeof chats !== 'object') continue;
          const m = new Map();
          for (const [key, r] of Object.entries(chats)) {
            if (r && typeof r.sig === 'string' && Number.isInteger(r.unread)) m.set(key, { sig: r.sig, unread: r.unread, ...(typeof r.t === 'string' && r.t ? { t: r.t } : {}) });
          }
          if (m.size) this.poppedMap.set(id, m);
        }
      }
    }
    return this.poppedMap;
  }

  savePopped() {
    if (!this.hooks.savePopped) return;
    const out = {};
    for (const [id, m] of this.popped) if (m.size) out[id] = Object.fromEntries(m);
    try { this.hooks.savePopped(out); } catch { /* 存不上就算了，只是重启后可能多弹一次 */ }
  }

  // 记下这个客户现在这一条已经处理过（弹过，或用户正看着时出现的），以后同一条不再弹。
  // t：网页号列表里这条的钟点（见 clockOf），不存消息内容
  markPopped(id, key, sig, unread, t = '') {
    let m = this.popped.get(id);
    if (!m) { m = new Map(); this.popped.set(id, m); }
    m.delete(key); // 放到最后，超出上限时先删最久没动的
    m.set(key, t ? { sig, unread, t } : { sig, unread });
    if (m.size > MAX_POPPED) m.delete(m.keys().next().value);
  }

  // 读到列表后：未读已经是 0 的客户（读过了）去掉记录，下次她再发同样的话（比如“ok”）照常弹。
  // 带钟点的记录不用去掉（新发来的那条钟点不一样，见 wasPopped）；正在重连时也不去掉：
  // 重连时列表里的角标会跟着标题一起暂时清零，不是真的读了，去掉的话回来时会把弹过的再弹一遍。
  // record：把现在有未读的客户都记成处理过（用户正看着、开着勿扰、第一次看列表时，这些不算新消息）
  notePopped(id, chats, { record = false } = {}) {
    if (!Array.isArray(chats)) return;
    const m = this.popped.get(id);
    const holding = this.heldCount(id) >= 0;
    let changed = false;
    for (const c of chats) {
      const key = chatKey(c);
      if (!key) continue;
      const n = Number.isInteger(c.unread) && c.unread > 0 ? c.unread : 0;
      if (!n) {
        const rec = m && m.get(key);
        if (rec && !rec.t && !holding) { m.delete(key); changed = true; }
        continue;
      }
      if (!record) continue;
      const sig = popSig(c);
      const t = clockOf(c);
      const rec = m && m.get(key);
      if (rec && rec.sig === sig && rec.unread === n && (rec.t || '') === t) continue;
      this.markPopped(id, key, sig, n, t);
      changed = true;
    }
    if (changed) this.savePopped();
  }

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

  // 勿扰开着：新消息不弹（号自己的提醒照弹，见 popup.js）
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

  // 这个号开始重连（切网络、页面重新加载 / 重试、轻量号断开重连）：记下现在的未读对话数，
  // 最后一次调用之后 holdMs 内，未读数掉了又回到这个数以内都当成同一批消息。count 不给就用现在的未读数
  hold(id, count) {
    const now = Date.now();
    const prev = this.heldCount(id);
    const n = Number.isInteger(count) ? count : (this.unread.get(id) || 0);
    this.holds.set(id, { count: Math.max(n, prev), until: now + this.holdMs });
  }

  // 正在重连时重连前的未读对话数；没在重连返回 -1
  heldCount(id) {
    const h = this.holds.get(id);
    if (!h) return -1;
    if (h.until <= Date.now()) { this.holds.delete(id); return -1; }
    return h.count;
  }

  // 未读数只是回到了重连前的数（重连回来了，不是新消息）
  restored(id, n) {
    const h = this.heldCount(id);
    return h >= 0 && n <= h;
  }

  // 页面标题变化时调用
  // baseline：页面刚刷新时，刷新前的未读数。涨回这个数之前不算新消息
  update(acc, count, { isActive, baseline = 0 }) {
    const prev = this.unread.get(acc.id) || 0;
    const before = Math.max(prev, baseline);
    this.unread.set(acc.id, count);
    // 有对话被读掉了：记下的“弹过几条”可能对不上了，下次重新对；看一眼列表，把读掉的客户从“弹过的”里去掉
    if (count < prev) {
      this.seen.delete(acc.id);
      // 几个未读对话一下子全没了：不是一个个读掉的，是页面在重连（WhatsApp 自己断线重连、换 Clash 节点也会这样）
      if (count === 0 && prev >= 2) this.hold(acc.id, prev);
      if (this.heldCount(acc.id) < 0) this.noteRead(acc);
    }
    // 全读完了：这个号的卡片收起来，“稍后”也不用再提醒
    if (count === 0) this.dropCards(acc.id);
    if (count > before) this.lastNewAt = Date.now();
    const popped = count > before && !this.muted(acc) && !this.looking(isActive) && !this.dnd;
    if (popped) this.scan(acc, { count, fresh: count - before });
    // 正看着这个号、或开着勿扰：不弹，但把每个客户现在的未读条数记下来，
    // 不然切走以后 / 关掉勿扰以后，定时看列表会把这些早看过的当新消息弹出来
    else if (count > before && !this.muted(acc)) this.scan(acc, { poll: true, silent: true });
    // 通知记录：只记哪个号、什么时候、几个未读，以及有没有弹出来；不记消息内容
    if (count > before && this.hooks.onNew) this.hooks.onNew({ id: acc.id, count, popped });
    this.refresh();
  }

  // 未读对话数没变，但某个客户又发了一条（同一个对话的未读条数变多）：网页号定时看一眼对话列表，轻量号由后台进程推过来
  // 正看着这个号、开着勿扰：不弹，只记下来，免得切走 / 关掉勿扰后把这期间看过的当新消息弹出来
  recheck(acc, { isActive }) {
    if (!(this.unread.get(acc.id) > 0) || this.muted(acc)) return;
    if (this.scanning.get(acc.id)) return; // 正在读（比如未读数刚变多），别打断它
    this.scan(acc, { poll: true, silent: this.looking(isActive) || this.dnd });
  }

  // 有对话被读掉了：读一下列表，把未读变成 0 的客户从“弹过的”里去掉（不弹、不影响正在读的那次）
  async noteRead(acc) {
    if (!this.popped.get(acc.id)) return;
    const chats = await this.readChats(acc);
    if (!(this.hooks.getAccounts() || []).some((a) => a.id === acc.id)) return;
    this.notePopped(acc.id, chats);
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
  // poll：定时看的（读不到不弹号的卡）；silent：只记下每个客户的未读条数，不弹
  async scan(acc, { count = 0, fresh = 1, poll = false, silent = false } = {}) {
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
      // 读不到列表：重连回来、未读数没超过重连前的数，就不补号的卡（分不出是不是弹过的那几条）
      if (!poll && !this.restored(acc.id, n)) this.popAccount(acc, n, null);
      return;
    }
    const prevSeen = this.seen.get(acc.id) || null;
    // 正看着 / 勿扰 / 第一次看这个号的列表：只记下来，不弹以前的未读
    const quiet = silent || (poll && !prevSeen);
    this.notePopped(acc.id, chats, { record: quiet });
    const { fresh: list, seen, dup } = grownChats(prevSeen, chats, fresh, 3, this.popped.get(acc.id));
    this.seen.set(acc.id, seen);
    if (quiet) return;
    if (!list.length) {
      // 变多的客户都是弹过的那一条（页面刷新、重连后数字掉了又回来）：不弹，也不补号的卡
      if (dup) return;
      // 列表里找不到新客户（被搜索筛掉了、还没排好）：刚弹过就算了，没弹过补一张号的卡
      if (!poll && !this.restored(acc.id, n) && Date.now() - (this.lastPop.get(acc.id) || 0) > RECENT_POP_MS) this.popAccount(acc, count || n, unreadNames(chats));
      return;
    }
    // 读到客户了：之前读不到时弹的那张“有 N 个未读对话”号的卡收掉，不和客户卡并存
    if (this.popup && this.popup.dropKey) this.popup.dropKey(`m:${acc.id}:*`);
    // 倒着放，列表里最近的那个客户最后放、在最上面
    for (const c of list.slice().reverse()) {
      this.show({ key: `m:${acc.id}:${c.key}`, kind: 'msg', accId: acc.id, chat: c.name, chatKey: c.key, jid: c.jid, text: c.preview || '发来新消息', count: c.unread });
      this.markPopped(acc.id, c.key, c.sig, c.unread, c.t);
    }
    this.savePopped();
    // 定时看列表弹出来的（同一个客户又发一条）也记进通知记录；未读对话数变多那条在 update() 里已经记过
    if (poll && this.hooks.onNew) this.hooks.onNew({ id: acc.id, count: n, popped: true });
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

  // 弹窗上点了“稍后”：10 分钟后这个客户还有未读，再弹一次（内容用现在列表里的，不用 10 分钟前的旧预览）。
  // 客户卡：列表读不到（锁着、页面在加载）就不确定读没读，宁可不弹；号的卡：这个号还有未读就弹。
  // 到时候正看着这个号也不弹
  later(card) {
    if (card.kind !== 'msg' || !card.accId) return;
    clearTimeout(this.laterTimers.get(card.key));
    const t = setTimeout(async () => {
      this.laterTimers.delete(card.key);
      const acc = (this.hooks.getAccounts() || []).find((a) => a.id === card.accId);
      if (!acc || !(this.unread.get(acc.id) > 0) || this.muted(acc)) return;
      const chats = await this.readChats(acc);
      const n = this.unread.get(acc.id) || 0;
      const isActive = this.hooks.isActive ? this.hooks.isActive(acc.id) : false;
      if (!(n > 0) || !(this.hooks.getAccounts() || []).some((a) => a.id === acc.id) || this.looking(isActive)) return;
      if (card.chatKey) {
        if (!Array.isArray(chats)) return;
        const c = chats.find((x) => chatKey(x) === card.chatKey);
        if (!(c && c.unread > 0)) return;
        this.show({ ...card, again: true, text: cleanPreview(c.preview) || card.text, count: c.unread });
        return;
      }
      this.show({ ...card, again: true, text: unreadBody(n, unreadNames(chats)), count: 0 });
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
    this.holds.delete(id);
    if (this.popped.delete(id)) this.savePopped();
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
    const memText = mem ? `\n共占用 ${mem} MB` : '';
    const upd = this.hooks.trayText ? this.hooks.trayText() : '';
    const downText = down ? `\n${down} 个号断线，客户消息收不到` : '';
    const dndText = this.dnd ? '\n勿扰中，新消息不弹窗' : '';
    this.tray.setToolTip(`${total ? `WAswitch\n${total} 个未读对话` : 'WAswitch'}${memText}${downText}${dndText}${upd ? `\n${upd}` : ''}`);
    const items = accounts.map((acc) => {
      const n = this.unread.get(acc.id) || 0;
      const mb = this.hooks.memoryOf ? this.hooks.memoryOf(acc.id) : 0;
      return {
        label: `${isOffline(acc.id) ? '⚠ ' : ''}${acc.name}${n ? `（${n}）` : ''}${[isOffline(acc.id) ? '断线' : '', this.muted(acc) ? '不弹通知' : '', mb ? `${mb} MB` : ''].filter(Boolean).map((t) => `${GAP}${t}`).join('')}`,
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
