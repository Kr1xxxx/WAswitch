// WAswitch 主进程：左侧账号栏 + 右侧 WhatsApp Web。
// 每个账号使用独立的 session 分区（persist:wa-<id>），cookie 和登录状态互不影响。
const { app, BaseWindow, WebContentsView, ipcMain, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const WA_URL = 'https://web.whatsapp.com/';

// WhatsApp Web 会拒绝带 "Electron" 字样的 UA。这里用 Electron 自带 Chromium 的真实版本号，
// 只去掉 Electron 和应用名标识，这样升级 Electron 后 UA 会自动跟着变新。
function buildUserAgent() {
  const major = process.versions.chrome.split('.')[0];
  const osPart = {
    win32: 'Windows NT 10.0; Win64; x64',
    darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  }[process.platform] || 'X11; Linux x86_64';
  return `Mozilla/5.0 (${osPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

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

// 只有 WhatsApp 页面能拿到这些权限（通知、语音消息的麦克风、视频、剪贴板），其他一律拒绝。
const ALLOWED_PERMISSIONS = new Set(['notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
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

const UA = buildUserAgent();
const SIDEBAR_WIDTH = 72;

const storeFile = () => path.join(app.getPath('userData'), 'accounts.json');
const loadAccounts = () => {
  try { return JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch { return [{ id: '1', name: '账号 1' }]; }
};
const saveAccounts = (list) => fs.writeFileSync(storeFile(), JSON.stringify(list, null, 2));

let win, sidebar;
let accounts = [];
const views = new Map(); // id -> WebContentsView
let activeId = null;

function layout() {
  const { width, height } = win.getContentBounds();
  sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR_WIDTH, height });
  for (const [id, view] of views) {
    view.setBounds(id === activeId
      ? { x: SIDEBAR_WIDTH, y: 0, width: width - SIDEBAR_WIDTH, height }
      : { x: 0, y: 0, width: 0, height: 0 });
  }
}

function createView(acc) {
  const ses = session.fromPartition(`persist:wa-${acc.id}`);
  ses.setUserAgent(UA);
  setupPermissions(ses);
  const view = new WebContentsView({
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  view.webContents.setUserAgent(UA);
  setupNavigationGuards(view.webContents);
  view.webContents.loadURL(WA_URL);
  // 从页面标题里读未读数，例如 "(3) WhatsApp"
  view.webContents.on('page-title-updated', (_e, title) => {
    const m = title.match(/^\((\d+)\)/);
    sidebar.webContents.send('unread', { id: acc.id, count: m ? Number(m[1]) : 0 });
  });
  win.contentView.addChildView(view);
  views.set(acc.id, view);
  return view;
}

function pushState() {
  sidebar.webContents.send('state', { accounts, activeId });
}

function activate(id) {
  activeId = id;
  layout();
  pushState();
}

app.whenReady().then(() => {
  // 侧边栏用的默认会话不需要任何权限
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  win = new BaseWindow({ width: 1280, height: 820, title: 'WAswitch' });
  sidebar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.contentView.addChildView(sidebar);
  sidebar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  sidebar.webContents.on('will-navigate', (event) => event.preventDefault());
  sidebar.webContents.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  accounts = loadAccounts();
  accounts.forEach(createView);
  activeId = accounts[0]?.id ?? null;

  win.on('resize', layout);
  sidebar.webContents.on('did-finish-load', pushState);
  layout();
});

ipcMain.on('switch', (_e, id) => activate(id));

ipcMain.on('add', () => {
  const id = String(Date.now());
  const acc = { id, name: `账号 ${accounts.length + 1}` };
  accounts.push(acc);
  saveAccounts(accounts);
  createView(acc);
  activate(id);
});

ipcMain.on('remove', async (_e, id) => {
  const view = views.get(id);
  if (!view) return;
  win.contentView.removeChildView(view);
  view.webContents.close();
  views.delete(id);
  await session.fromPartition(`persist:wa-${id}`).clearStorageData();
  accounts = accounts.filter((a) => a.id !== id);
  saveAccounts(accounts);
  activate(accounts[0]?.id ?? null);
});

ipcMain.on('rename', (_e, { id, name }) => {
  const acc = accounts.find((a) => a.id === id);
  if (acc) { acc.name = name; saveAccounts(accounts); pushState(); }
});

app.on('window-all-closed', () => app.quit());
