// WAswitch 主进程：左侧账号栏 + 右侧 WhatsApp Web。
// 每个账号三层隔离：
//   1. 数据：独立的 session 分区（persist:wa-<id>），cookie、存储、缓存互不相通
//   2. 网络：独立代理（proxy.js），代理不通时不回落直连，并禁止 WebRTC 绕过代理
//   3. 环境：独立的浏览器标识、语言、时区（fingerprint.js），只用官方接口设置
const { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, session, shell, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fingerprint = require('./fingerprint');
const proxy = require('./proxy');
const { findByTimezone } = require('./regions');
const { Notifier } = require('./notify');
const memory = require('./memory');

// 省内存模式要在 app ready 之前生效
const settings = memory.loadSettings();
memory.applyStartupSwitches(settings);

const WA_URL = 'https://web.whatsapp.com/';
const SIDEBAR_WIDTH = 72;

// ---------- 安全：链接、跳转、权限 ----------

// 只有这些域名允许在软件里打开，其他链接一律交给系统浏览器。
const ALLOWED_HOSTS = ['whatsapp.com', 'whatsapp.net'];
function isWhatsAppUrl(raw) {
  try {
    const { protocol, hostname } = new URL(raw);
    if (protocol !== 'https:') return false;
    return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

// 只有 WhatsApp 页面能拿到这些权限（语音消息的麦克风、视频、剪贴板），其他一律拒绝。
// 网页通知也关掉：WhatsApp 自己的通知看不出是哪个号，改由 notify.js 按账号发。
const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
function setupPermissions(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl || wc.getURL();
    callback(ALLOWED_PERMISSIONS.has(permission) && isWhatsAppUrl(origin));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    ALLOWED_PERMISSIONS.has(permission) && isWhatsAppUrl(requestingOrigin));
}

// 外链（聊天里别人发的网址等）用系统浏览器打开；页面本身不允许跳转到 WhatsApp 以外的地方。
function setupNavigationGuards(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (isWhatsAppUrl(url)) return;
    event.preventDefault();
    if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
  });
  wc.on('will-redirect', (event, url) => {
    if (!isWhatsAppUrl(url)) event.preventDefault();
  });
}

// 本地页面（侧边栏、编辑窗口）不允许打开新窗口或跳走
function lockLocalPage(wc) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event) => event.preventDefault());
}

// ---------- 账号数据 ----------

const storeFile = () => path.join(app.getPath('userData'), 'accounts.json');
let accounts = [];

function saveAccounts() {
  const file = storeFile();
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(accounts, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function loadAccounts() {
  const file = storeFile();
  let list = null;
  if (fs.existsSync(file)) {
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(list)) throw new Error('not an array');
    } catch (e) {
      // 文件损坏时先备份，不直接覆盖
      const backup = `${file}.broken-${Date.now()}`;
      fs.copyFileSync(file, backup);
      console.warn(`accounts.json 无法读取（${e.message}），已备份到 ${backup}`);
      list = null;
    }
  }
  if (!list || !list.length) list = [{ id: String(Date.now()), name: '账号 1' }];
  // 老版本的账号没有代理和环境字段，补上
  for (const acc of list) {
    acc.id = String(acc.id);
    acc.name = acc.name || '未命名';
    acc.proxy = typeof acc.proxy === 'string' ? acc.proxy : '';
    acc.proxyPassword = typeof acc.proxyPassword === 'string' ? acc.proxyPassword : '';
    acc.fingerprint = fingerprint.normalize(acc.fingerprint);
    acc.muted = acc.muted === true;
  }
  return list;
}

function nextName() {
  const used = new Set(accounts.map((a) => a.name));
  let n = accounts.length + 1;
  while (used.has(`账号 ${n}`)) n += 1;
  return `账号 ${n}`;
}

// ---------- 窗口和账号视图 ----------

let win, sidebar, editWin;
const views = new Map(); // id -> WebContentsView
const problems = new Map(); // id -> 错误说明（代理连不上等）
let activeId = null;
let quitting = false;

const memoryManager = new memory.MemoryManager(settings, {
  views,
  isBackground: (id) => id !== activeId || !win || !win.isVisible(),
  unreadOf: (id) => notifier.unread.get(id) || 0,
  onUpdate: () => notifier.refresh(),
});

const notifier = new Notifier({
  getAccounts: () => accounts,
  getWindow: () => win,
  activate: (id) => activate(id),
  quit: () => { quitting = true; app.quit(); },
  memoryOf: (id) => memoryManager.usageMB.get(id) || 0,
  totalMemory: () => memoryManager.totalMB(),
  settingsMenu: () => [
    {
      label: `后台账号超过 ${settings.recycleMB || memory.DEFAULTS.recycleMB} MB 时自动刷新回收内存`,
      type: 'checkbox',
      checked: settings.recycleMB > 0,
      click: () => {
        settings.recycleMB = settings.recycleMB > 0 ? 0 : memory.DEFAULTS.recycleMB;
        memory.saveSettings(settings);
        notifier.refresh();
      },
    },
    {
      label: '省内存模式（关闭显卡加速，重启后生效）',
      type: 'checkbox',
      checked: settings.lowMemoryMode,
      click: () => {
        settings.lowMemoryMode = !settings.lowMemoryMode;
        memory.saveSettings(settings);
        notifier.refresh();
      },
    },
  ],
});

// 所有账号视图大小相同，只显示当前账号。其他账号设为隐藏，
// Chromium 会把它们当作后台页面处理（降低优先级、节流、释放画面缓存），但消息照常接收。
function layout() {
  const { width, height } = win.getContentBounds();
  sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR_WIDTH, height });
  for (const [id, view] of views) {
    const active = id === activeId;
    view.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: width - SIDEBAR_WIDTH, height });
    view.setVisible(active);
    memoryManager.markBackground(id, !active || !win.isVisible());
  }
}

function pushState() {
  sidebar.webContents.send('state', {
    accounts: accounts.map(({ id, name }) => ({ id, name, problem: problems.get(id) || '' })),
    activeId,
  });
}

function setProblem(id, text) {
  if (text) problems.set(id, text); else problems.delete(id);
  pushState();
}

// 页面加载失败时，代理类错误要明确告诉用户，而不是一片空白
const PROXY_ERRORS = new Set([-111, -115, -120, -122, -125, -130, -336]);

async function createView(acc) {
  const ses = session.fromPartition(`persist:wa-${acc.id}`);
  const r = fingerprint.resolve(acc.fingerprint);
  // 网络请求层面的 UA 和语言（包括 Service Worker 发出的请求）
  ses.setUserAgent(r.userAgent, r.acceptLanguage);
  setupPermissions(ses);
  const applied = await proxy.apply(ses, acc.proxy);

  const view = new WebContentsView({
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const wc = view.webContents;
  // 禁止 WebRTC 走代理以外的 UDP，防止泄露真实 IP
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  setupNavigationGuards(wc);
  win.contentView.addChildView(view);
  views.set(acc.id, view);

  // 从页面标题里读未读数，例如 "(3) WhatsApp"
  wc.on('page-title-updated', (_e, title) => {
    const m = title.match(/^\((\d+)\)/);
    const count = m ? Number(m[1]) : 0;
    sidebar.webContents.send('unread', { id: acc.id, count });
    notifier.update(acc, count, { isActive: acc.id === activeId });
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (PROXY_ERRORS.has(code)) setProblem(acc.id, `代理连不上（${desc}），没有改用直连。请检查 Clash 是否开着，或右键编辑代理。`);
    else if (code !== -3) setProblem(acc.id, `页面打不开（${desc}）`);
  });
  wc.on('did-finish-load', () => { if (!applied.error) setProblem(acc.id, ''); });
  // 页面进程崩溃后调试连接会断开，直接重建这个账号的视图，保证环境设置重新生效
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    console.warn(`账号 ${acc.name} 的页面进程退出（${details.reason}），正在重建`);
    setTimeout(async () => {
      if (!accounts.includes(acc)) return;
      destroyView(acc.id);
      await createView(acc);
      layout();
    }, 1000);
  });

  if (applied.error) {
    setProblem(acc.id, `代理设置有误：${applied.error}。为避免暴露真实 IP，这个账号暂停联网。`);
    return view;
  }
  await fingerprint.attach(wc, acc.fingerprint);
  wc.loadURL(WA_URL);
  return view;
}

function destroyView(id) {
  const view = views.get(id);
  if (!view) return;
  win.contentView.removeChildView(view);
  if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach();
  view.webContents.close();
  views.delete(id);
}

function activate(id) {
  activeId = id;
  layout();
  pushState();
}

async function removeAccount(id) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['取消', '删除'],
    defaultId: 0,
    cancelId: 0,
    title: '删除账号',
    message: `删除「${acc.name}」？`,
    detail: '会清除这个账号在本机的登录数据，之后要重新扫码才能再登录。手机上的聊天记录不受影响。',
  });
  if (response !== 1) return;
  destroyView(id);
  problems.delete(id);
  notifier.forget(id);
  memoryManager.forget(id);
  await session.fromPartition(`persist:wa-${id}`).clearStorageData();
  accounts = accounts.filter((a) => a.id !== id);
  saveAccounts();
  activate(accounts[0]?.id ?? null);
}

// 带用户名密码的 http 代理：按代理的地址和端口找到对应账号，取它的密码。
// 不按页面匹配，因为 Service Worker 发出的请求没有对应页面。
app.on('login', (event, _webContents, _details, authInfo, callback) => {
  if (!authInfo.isProxy) return;
  for (const acc of accounts) {
    const p = proxy.parse(acc.proxy);
    if (p && !p.error && p.username && p.host === authInfo.host && p.port === authInfo.port) {
      event.preventDefault();
      callback(p.username, proxy.decryptPassword(acc.proxyPassword));
      return;
    }
  }
});

app.whenReady().then(async () => {
  // 侧边栏和编辑窗口用的默认会话不需要任何权限
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  win = new BaseWindow({ width: 1280, height: 820, title: 'WAswitch', icon: path.join(__dirname, '..', 'assets', 'icon.png') });
  notifier.init();
  // 窗口隐藏到托盘时，当前账号也算后台
  win.on('hide', layout);
  win.on('show', layout);
  // 关闭窗口时缩到托盘，后台继续收消息；从托盘菜单“退出”才真正退出
  let hintShown = false;
  // Windows 关机或注销时不要拦着
  win.on('session-end', () => { quitting = true; });
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (!hintShown && process.platform !== 'darwin') {
      hintShown = true;
      notifier.tray.displayBalloon?.({ title: 'WAswitch 还在运行', content: '已缩到托盘，继续接收消息。右键托盘图标可以退出。' });
    }
  });
  sidebar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.contentView.addChildView(sidebar);
  lockLocalPage(sidebar.webContents);
  sidebar.webContents.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  sidebar.webContents.on('did-finish-load', pushState);
  win.on('resize', layout);

  accounts = loadAccounts();
  saveAccounts();
  activeId = accounts[0]?.id ?? null;
  for (const acc of accounts) await createView(acc);
  layout();
  pushState();
  memoryManager.start();
});

// ---------- 侧边栏操作 ----------

ipcMain.on('switch', (_e, id) => activate(id));
ipcMain.on('add', () => openEditor(null));

// 右键账号：编辑 / 重新加载 / 删除
ipcMain.on('context', (_e, id) => {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  Menu.buildFromTemplate([
    { label: '编辑（名称、代理、地区）', click: () => openEditor(id) },
    { label: '重新加载', click: () => views.get(id)?.webContents.reload() },
    {
      label: '静音通知', type: 'checkbox', checked: acc.muted,
      click: () => { acc.muted = !acc.muted; saveAccounts(); notifier.refresh(); },
    },
    { type: 'separator' },
    { label: `删除「${acc.name}」并退出登录`, click: () => removeAccount(id) },
  ]).popup();
});

// ---------- 编辑窗口：新建账号和修改账号共用 ----------

function openEditor(id) {
  if (editWin && !editWin.isDestroyed()) editWin.close();
  editWin = new BrowserWindow({
    width: 480, height: 640, resizable: false, minimizable: false, maximizable: false,
    title: id ? '编辑账号' : '添加账号',
    webPreferences: { preload: path.join(__dirname, 'edit', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  editWin.setMenu(null);
  lockLocalPage(editWin.webContents);
  editWin.loadFile(path.join(__dirname, 'edit', 'edit.html'), { query: { id: id || '' } });
}

ipcMain.handle('editor:load', (_e, id) => {
  const acc = accounts.find((a) => a.id === id);
  return {
    isNew: !acc,
    name: acc ? acc.name : nextName(),
    proxy: acc ? acc.proxy : '',
    hasPassword: !!(acc && acc.proxyPassword),
    region: acc ? acc.fingerprint.region : 'auto',
    regions: Object.entries(fingerprint.regions).map(([key, v]) => ({ key, label: v.label })),
  };
});

// 测试代理：返回出口 IP、国家、时区，并给出匹配的地区
ipcMain.handle('editor:test', async (_e, { id, proxy: proxyText, password }) => {
  const acc = accounts.find((a) => a.id === id);
  const pass = password || (acc ? proxy.decryptPassword(acc.proxyPassword) : '');
  const res = await proxy.test(proxyText, pass);
  if (res.ok) res.region = findByTimezone(res.timezone);
  return res;
});

ipcMain.handle('editor:save', async (_e, { id, name, proxy: proxyText, password, region }) => {
  const parsed = proxy.parse(proxyText);
  if (parsed && parsed.error) return { error: parsed.error };
  if (!fingerprint.regions[region]) region = 'auto';
  const proxyStored = parsed ? parsed.display : '';
  let acc = accounts.find((a) => a.id === id);

  // 密码：新填的优先；地址里带的其次；都没有则保留原来的（地址变了用户名也变了就清掉）
  let encPassword = acc ? acc.proxyPassword : '';
  try {
    const newPass = password || (parsed && parsed.password) || '';
    if (newPass) encPassword = proxy.encryptPassword(newPass);
    if (!parsed || !parsed.username) encPassword = '';
  } catch (e) {
    return { error: e.message };
  }

  if (!acc) {
    acc = { id: String(Date.now()), name, proxy: proxyStored, proxyPassword: encPassword, fingerprint: fingerprint.generate(region) };
    accounts.push(acc);
    saveAccounts();
    await createView(acc);
    activate(acc.id);
  } else {
    const changed = acc.proxy !== proxyStored || acc.proxyPassword !== encPassword || acc.fingerprint.region !== region;
    acc.name = name;
    acc.proxy = proxyStored;
    acc.proxyPassword = encPassword;
    // 只改地区（时区、语言），浏览器标识保持不变
    acc.fingerprint.region = region;
    saveAccounts();
    if (changed) {
      destroyView(acc.id);
      await createView(acc);
    }
    activate(activeId);
  }
  if (editWin && !editWin.isDestroyed()) editWin.close();
  return { ok: true };
});

app.on('before-quit', () => { quitting = true; });
// 窗口只是隐藏，不因为“没有可见窗口”而退出
app.on('window-all-closed', () => {});
// macOS 点 Dock 图标时重新显示窗口
app.on('activate', () => { if (win) { win.show(); win.focus(); } });
