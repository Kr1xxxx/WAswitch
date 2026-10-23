// WAswitch 主进程：左侧账号栏 + 右侧 WhatsApp Web。
// 每个账号使用独立的 session 分区（persist:wa-<id>），cookie 和登录状态互不影响。
const { app, BaseWindow, WebContentsView, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

const WA_URL = 'https://web.whatsapp.com/';
// WhatsApp Web 会拒绝 "Electron" UA，这里伪装成普通 Chrome。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
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
  const view = new WebContentsView({ webPreferences: { session: ses } });
  view.webContents.setUserAgent(UA);
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
  win = new BaseWindow({ width: 1280, height: 820, title: 'WAswitch' });
  sidebar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.contentView.addChildView(sidebar);
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
