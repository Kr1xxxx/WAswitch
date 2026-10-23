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
  // hooks: { getAccounts(), getWindow(), activate(id), quit() }
  constructor(hooks) {
    this.hooks = hooks;
    this.unread = new Map(); // id -> 未读对话数
    this.tray = null;
    this.active = new Set(); // 正在显示的通知，防止被回收后点击失效
  }

  init() {
    if (process.platform === 'win32') app.setAppUserModelId('com.waswitch.app');
    const trayIcon = nativeImage.createFromPath(asset(process.platform === 'darwin' ? 'tray16.png' : 'tray.png'));
    this.tray = new Tray(trayIcon);
    this.tray.on('click', () => this.showWindow());
    this.refresh();
  }

  total() {
    let sum = 0;
    for (const n of this.unread.values()) sum += n;
    return sum;
  }

  showWindow() {
    const win = this.hooks.getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  // 页面标题变化时调用
  update(acc, count, { isActive }) {
    const before = this.unread.get(acc.id) || 0;
    this.unread.set(acc.id, count);
    const win = this.hooks.getWindow();
    const userIsLooking = isActive && win && win.isVisible() && win.isFocused();
    if (count > before && !acc.muted && !userIsLooking) this.notify(acc, `有 ${count} 个未读对话`);
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

  // 刷新任务栏角标、托盘提示和托盘菜单
  refresh() {
    const total = this.total();
    const win = this.hooks.getWindow();

    // macOS Dock 和 Linux（Unity 等）显示数字
    if (process.platform !== 'win32') app.setBadgeCount(total);
    // Windows 任务栏：图标右下角加红点
    if (process.platform === 'win32' && win) {
      win.setOverlayIcon(total ? nativeImage.createFromPath(asset('badge.png')) : null, total ? `${total} 个未读对话` : '');
    }
    if (win) win.setTitle(total ? `(${total}) WAswitch` : 'WAswitch');

    if (!this.tray) return;
    const mem = this.hooks.totalMemory ? this.hooks.totalMemory() : 0;
    const memText = mem ? ` · 共占用 ${mem} MB` : '';
    this.tray.setToolTip(`${total ? `WAswitch · ${total} 个未读对话` : 'WAswitch'}${memText}`);
    const accounts = this.hooks.getAccounts();
    const items = accounts.map((acc) => {
      const n = this.unread.get(acc.id) || 0;
      const mb = this.hooks.memoryOf ? this.hooks.memoryOf(acc.id) : 0;
      return {
        label: `${acc.name}${n ? `（${n}）` : ''}${acc.muted ? ' · 已静音（仍计入总数）' : ''}${mb ? ` · ${mb} MB` : ''}`,
        click: () => { this.showWindow(); this.hooks.activate(acc.id); },
      };
    });
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示窗口', click: () => this.showWindow() },
      { type: 'separator' },
      ...items,
      { type: 'separator' },
      ...(this.hooks.settingsMenu ? [...this.hooks.settingsMenu(), { type: 'separator' }] : []),
      { label: '退出 WAswitch', click: () => this.hooks.quit() },
    ]));
  }
}

module.exports = { Notifier };
