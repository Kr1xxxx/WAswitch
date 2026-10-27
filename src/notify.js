// 未读汇总、托盘图标、任务栏角标、按账号区分的桌面通知。
//
// 未读数来自每个账号页面的标题（WhatsApp 会把标题改成 "(3) WhatsApp"），
// 这个数字是“有未读消息的对话数”。不读取页面内容，也不往页面注入脚本。
//
// WhatsApp 自己的网页通知被关掉（看不出是哪个号），改由这里发：
// 某个账号的未读数增加时，弹出“账号名：有 N 个未读对话”，点一下就切到这个账号。
const { app, Tray, Menu, Notification, nativeImage } = require('electron');
const path = require('path');

const asset = (name) => path.join(__dirname, '..', 'assets', name);

class Notifier {
  // hooks: { getAccounts(), isMuted(acc), getWindow(), activate(id), quit() }
  constructor(hooks) {
    this.hooks = hooks;
    this.unread = new Map(); // id -> 未读对话数
    this.tray = null;
    this.active = new Set(); // 正在显示的通知，防止被回收后点击失效
    this.lastNewAt = 0; // 最近一次有新消息的时间（含静音账号），自动装更新用
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

  showWindow() {
    const win = this.hooks.getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  // 页面标题变化时调用
  // baseline：页面刚刷新时，刷新前的未读数。涨回这个数之前不算新消息
  update(acc, count, { isActive, baseline = 0 }) {
    const before = Math.max(this.unread.get(acc.id) || 0, baseline);
    this.unread.set(acc.id, count);
    if (count > before) this.lastNewAt = Date.now();
    const win = this.hooks.getWindow();
    const userIsLooking = isActive && win && win.isVisible() && win.isFocused();
    const popped = count > before && !this.muted(acc) && !userIsLooking;
    if (popped) this.notify(acc, `有 ${count} 个未读对话`);
    // 通知记录：只记哪个号、什么时候、几个未读，以及有没有弹出来；不记消息内容
    if (count > before && this.hooks.onNew) this.hooks.onNew({ id: acc.id, count, popped });
    this.refresh();
  }

  forget(id) {
    this.unread.delete(id);
    this.refresh();
  }

  // 标题是账号名，正文不含消息内容
  notify(acc, body) {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: acc.name,
      body,
      icon: asset('icon.png'),
      silent: false,
    });
    this.active.add(n);
    const done = () => this.active.delete(n);
    n.on('click', () => {
      this.showWindow();
      this.hooks.activate(acc.id);
      done();
    });
    n.on('close', done);
    n.show();
  }

  // 软件自己的通知（比如新版本已下载）
  notifyApp(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: asset('icon.png') });
    this.active.add(n);
    const done = () => this.active.delete(n);
    n.on('click', () => { if (onClick) onClick(); done(); });
    n.on('close', done);
    n.show();
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
    this.tray.setToolTip(`${total ? `WAswitch · ${total} 个未读对话` : 'WAswitch'}${memText}${downText}${upd ? `\n${upd}` : ''}`);
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
      ...(this.hooks.settingsMenu ? [...this.hooks.settingsMenu(), { type: 'separator' }] : []),
      { label: '退出 WAswitch', click: () => this.hooks.quit() },
    ]));
  }
}

module.exports = { Notifier };
