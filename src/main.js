// WAswitch 主进程。
// 窗口 = 一个本地界面视图（侧栏、顶栏、设置等，铺满整个窗口）+ 每个账号一个 WhatsApp 视图（盖在右侧卡片里）。
// 每个账号三层隔离：
//   1. 数据：独立的 session 分区（persist:wa-<id>），cookie、存储、缓存互不相通
//   2. 网络：独立代理（proxy.js），代理不通时不回落直连，并禁止 WebRTC 绕过代理
//   3. 环境：独立的浏览器标识、语言、时区（fingerprint.js），只用官方接口设置
const { app, BaseWindow, WebContentsView, ipcMain, session, shell, Menu, dialog, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('./log');
const fingerprint = require('./fingerprint');
const proxy = require('./proxy');
const { findByTimezone } = require('./regions');
const { Notifier } = require('./notify');
const memory = require('./memory');
const waPage = require('./wa-page');
const { setupMcp } = require('./mcp');

// ---------- 只允许运行一个 WAswitch ----------
// 开两个会让两个进程同时读写同一批账号数据。第二次打开时只把已有窗口显示出来。
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.exit(0);

// 出错时：记日志、提示、自动重启。为免反复崩溃：刚启动 60 秒内出错不重启；
// 10 分钟内已经自动重启过 3 次也不再重启。次数通过重启参数传给下一次运行。
const CRASH_WINDOW_MS = 10 * 60 * 1000;
function crashHistory() {
  const arg = process.argv.find((a) => a.startsWith('--crash-history='));
  const now = Date.now();
  return (arg ? arg.split('=')[1].split(',').map(Number) : []).filter((t) => Number.isFinite(t) && now - t < CRASH_WINDOW_MS);
}
log.init((e) => {
  try {
    if (app.isReady()) {
      const history = crashHistory();
      const relaunch = process.uptime() > 60 && history.length < 3;
      dialog.showMessageBoxSync({
        type: 'error',
        title: 'WAswitch 出错了',
        message: relaunch ? 'WAswitch 遇到错误，马上自动重启。' : 'WAswitch 启动时出错，已经退出。',
        detail: `${e && e.message ? e.message : e}\n\n详细情况已写入日志文件夹：${log.logDir()}`,
      });
      if (relaunch) {
        const args = process.argv.slice(1).filter((a) => !a.startsWith('--crash-history=') && a !== '--hidden');
        app.relaunch({ args: [...args, `--crash-history=${[...history, Date.now()].join(',')}`] });
      }
    }
  } finally {
    app.exit(1);
  }
});

// 省内存模式要在 app ready 之前生效
const settings = memory.loadSettings();
memory.applyStartupSwitches(settings);

const WA_URL = 'https://web.whatsapp.com/';
const SIDE_EXPANDED = 200;
const SIDE_COLLAPSED = 64;
const GAP = 8; // 右侧卡片和窗口边缘的间距
const TOPBAR = 44; // 卡片顶栏高度
const COLORS = ['#16A34A', '#7C3AED', '#EA580C', '#2563EB', '#DB2777', '#475569'];
const SOURCE_URL = 'https://github.com/Kr1xxxx/WAswitch';
const canLoginItem = process.platform === 'win32' || process.platform === 'darwin';
// 开机自启时是否直接缩在托盘（在 app ready 之后判断）。
// macOS 13 以后系统不告诉软件是不是开机启动的，所以 Mac 上开机自启会正常弹出窗口。
function shouldStartHidden() {
  if (process.argv.includes('--hidden')) return true;
  if (process.platform !== 'darwin') return false;
  try { return app.getLoginItemSettings().wasOpenedAtLogin === true; } catch { return false; }
}

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

// 本地界面不允许打开新窗口或跳走
function lockLocalPage(wc) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event) => event.preventDefault());
}

// ---------- 账号数据 ----------

const storeFile = () => path.join(app.getPath('userData'), 'accounts.json');
let accounts = [];
let accountsFileOk = false; // 账号文件读取正常时才清理残留的分区文件夹

function saveAccounts() {
  const file = storeFile();
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(accounts, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function loadAccounts() {
  const file = storeFile();
  let list = [];
  // 只有文件存在并且读取成功，才允许清理残留分区。文件丢了不能当成“没有账号”去删数据
  accountsFileOk = false;
  if (fs.existsSync(file)) {
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(list)) throw new Error('not an array');
      accountsFileOk = true;
    } catch (e) {
      // 文件损坏时先备份，不直接覆盖，也不清理任何数据
      const backup = `${file}.broken-${Date.now()}`;
      fs.copyFileSync(file, backup);
      console.warn(`accounts.json 无法读取（${e.message}），已备份到 ${backup}`);
      list = [];
      accountsFileOk = false;
    }
  }
  // 去掉不是账号的条目，老版本的账号缺字段，补上
  list = list.filter((acc) => acc && typeof acc === 'object' && acc.id !== undefined && acc.id !== null);
  list.forEach((acc, i) => {
    acc.id = String(acc.id);
    acc.name = String(acc.name || '未命名').slice(0, 40);
    acc.color = COLORS.includes(acc.color) ? acc.color : COLORS[i % COLORS.length];
    acc.proxy = typeof acc.proxy === 'string' ? acc.proxy : '';
    acc.proxyPassword = typeof acc.proxyPassword === 'string' ? acc.proxyPassword : '';
    acc.exitLabel = typeof acc.exitLabel === 'string' ? acc.exitLabel : '';
    acc.fingerprint = fingerprint.normalize(acc.fingerprint);
    acc.muted = acc.muted === true;
  });
  return list;
}

function nextName() {
  const used = new Set(accounts.map((a) => a.name));
  let n = accounts.length + 1;
  while (used.has(`账号 ${n}`)) n += 1;
  return `账号 ${n}`;
}

function nextColor() {
  return COLORS.find((c) => !accounts.some((a) => a.color === c)) || COLORS[accounts.length % COLORS.length];
}

// 账号分区在磁盘上的文件夹。id 只能是数字，路径必须正好在 Partitions 下面，
// 防止 accounts.json 被改坏后删到别的地方。
function partitionDir(id) {
  if (!/^\d+$/.test(id)) return null;
  const base = path.join(app.getPath('userData'), 'Partitions');
  const dir = path.join(base, `wa-${id}`);
  return path.dirname(dir) === base ? dir : null;
}

// 启动时删掉已删除账号残留的分区文件夹（删除账号时文件可能还被占用，删不掉）
function cleanupPartitions() {
  if (!accountsFileOk) return;
  const base = path.join(app.getPath('userData'), 'Partitions');
  let names = [];
  try { names = fs.readdirSync(base); } catch { return; }
  const keep = new Set(accounts.map((a) => `wa-${a.id}`));
  for (const name of names) {
    const m = name.match(/^wa-(\d+)$/);
    if (!m || keep.has(name)) continue;
    const dir = partitionDir(m[1]);
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`已清理残留的账号数据 ${name}`);
    } catch (e) {
      console.warn(`清理 ${name} 失败：${e.message}`);
    }
  }
}

// ---------- 状态 ----------

let win, shellView;
const views = new Map(); // id -> WebContentsView
const problems = new Map(); // id -> { title, text, retrying, config }
const retries = new Map(); // id -> { attempt, timer }
const exitIps = new Map(); // id -> 最近一次测到的出口 IP
// id -> 'logged_in' | 'needs_qr'。以后 MCP 的账号状态也从这里读
const loginStates = new Map();
const LOGIN_CHECK_MS = 3 * 60 * 1000;
let lastTest = null; // 编辑页最近一次测试的结果，保存时记下出口所在地
let activeId = null;
let page = 'account'; // account | editor | settings | welcome
let editorId = null;
let editorNonce = 0;
let editorColor = null;
let quitting = false;

const memoryManager = new memory.MemoryManager(settings, {
  views,
  isBackground: (id) => id !== activeId || page !== 'account' || !win || !win.isVisible(),
  unreadOf: (id) => notifier.unread.get(id) || 0,
  onUpdate: () => { notifier.refresh(); pushState(); },
});

const notifier = new Notifier({
  getAccounts: () => accounts,
  getWindow: () => win,
  activate: (id) => { page = 'account'; activate(id); },
  quit: () => { quitting = true; app.quit(); },
  memoryOf: (id) => memoryManager.usageMB.get(id) || 0,
  totalMemory: () => memoryManager.totalMB(),
  settingsMenu: () => [
    {
      label: `后台账号超过 ${settings.recycleMB || memory.DEFAULTS.recycleMB} MB 时自动刷新回收内存`,
      type: 'checkbox',
      checked: settings.recycleMB > 0,
      click: () => setSetting('recycleMB', settings.recycleMB > 0 ? 0 : memory.DEFAULTS.recycleMB),
    },
    {
      label: '省内存模式（关闭显卡加速，重启后生效）',
      type: 'checkbox',
      checked: settings.lowMemoryMode,
      click: () => setSetting('lowMemoryMode', !settings.lowMemoryMode),
    },
    { label: '设置…', click: () => { notifier.showWindow(); showPage('settings'); } },
    ...(mcp ? [{ label: 'MCP 接口设置…', click: () => mcp.openSettings() }] : []),
  ],
});

// MCP 接口（默认关闭）。在 app ready 之后创建。
let mcp = null;

function accountStatus(id) {
  const view = views.get(id);
  if (problems.has(id)) return 'error';
  if (!view) return 'not_loaded';
  return view.webContents.isLoading() ? 'loading' : 'ready';
}

const mcpHooks = {
  listAccounts: () => accounts.map((a) => ({
    id: a.id,
    name: a.name,
    active: a.id === activeId,
    unread: notifier.unread.get(a.id) || 0,
    muted: a.muted,
    status: accountStatus(a.id),
    // 只读掉线检测的结果：logged_in | needs_qr | unknown
    login: loginStates.get(a.id) || 'unknown',
    problem: problems.get(a.id)?.text || '',
  })),
  regions: () => Object.entries(fingerprint.regions).map(([key, v]) => ({ key, label: v.label })),
  activate: (id) => { notifier.showWindow(); page = 'account'; activate(id); },
  // 不直接创建：打开“添加账号”页面并预填，由人确认代理后保存，避免新号先用真实 IP 联网
  openAddAccount: ({ name, region }) => {
    notifier.showWindow();
    openEditor(null, { name, region });
  },
  renameAccount: (id, name) => {
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return false;
    acc.name = String(name).slice(0, 40);
    saveAccounts();
    pushState();
    notifier.refresh();
    return true;
  },
  removeAccount: (id, opts) => removeAccount(id, opts),

  // ---- 第二层：读对话列表 ----
  // 读之前现查一次是否已登录（只读检测），结果同步到掉线检测的状态里
  checkLogin: async (id) => {
    const view = views.get(id);
    if (!view || problems.has(id)) return 'unknown';
    const state = await waPage.loginState(view.webContents);
    if (state !== 'unknown' && state !== loginStates.get(id)) { loginStates.set(id, state); pushState(); }
    return state;
  },
  readChatList: async (id, opts) => {
    const view = views.get(id);
    if (!view) return { ok: false, reason: 'loading' };
    return waPage.readChatList(view.webContents, opts);
  },
  // 返回 'deny' | 'once' | 'ten' | 'busy'。timeoutMs 内没人点算拒绝
  confirmRead: async ({ client, account, includePreview, timeoutMs }) => {
    if (confirmDialogOpen) return 'busy';
    confirmDialogOpen = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    notifier.showWindow();
    try {
      const { response } = await dialog.showMessageBox(win, {
        signal: abort.signal,
        type: 'question',
        buttons: ['拒绝', '允许这一次', '10 分钟内允许'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'AI 想读取对话列表',
        message: `允许 AI 读取「${account}」的对话列表吗？`,
        detail: [
          `客户端自称：${client}（这个名字是客户端自己报的，不一定真实）`,
          includePreview
            ? '会读取：对话名称、未读数、时间，以及每个对话的最后一条消息预览（你在设置里打开了预览）。'
            : '会读取：对话名称、未读数、时间。不含消息内容。',
          '只读，不会点开对话，不会标为已读。读到的内容会发给这个 AI 客户端所用的 AI 服务商。',
          '“10 分钟内允许”只对这个连接、这个账号有效，可以在 MCP 接口设置里随时撤销。2 分钟内不选视为拒绝。',
        ].join('\n'),
      });
      if (abort.signal.aborted) return 'deny';
      return ['deny', 'once', 'ten'][response] || 'deny';
    } finally {
      clearTimeout(timer);
      confirmDialogOpen = false;
    }
  },
};

const regionName = (() => {
  let names = null;
  try { names = new Intl.DisplayNames(['zh-CN'], { type: 'region' }); } catch { /* 没有 ICU 时直接显示代码 */ }
  return (code) => (names && code ? names.of(code) : code || '');
})();

function proxyLabel(acc) {
  const p = proxy.parse(acc.proxy);
  if (!p) return '直连';
  if (p.error) return '代理设置有误';
  return acc.exitLabel ? `${acc.exitLabel} · ${p.port}` : `${p.scheme} · ${p.port}`;
}

function sideWidth() {
  return page !== 'settings' && settings.sidebarCollapsed ? SIDE_COLLAPSED : SIDE_EXPANDED;
}

// 所有账号视图大小相同，只显示当前账号。其他账号设为隐藏，
// Chromium 会把它们当作后台页面处理（降低优先级、节流、释放画面缓存），但消息照常接收。
function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  shellView.setBounds({ x: 0, y: 0, width, height });
  const side = sideWidth();
  const bounds = {
    x: side,
    y: GAP + TOPBAR,
    width: Math.max(0, width - side - GAP),
    height: Math.max(0, height - GAP * 2 - TOPBAR),
  };
  for (const [id, view] of views) {
    const current = page === 'account' && id === activeId;
    view.setBounds(bounds);
    view.setVisible(current && !problems.has(id));
    memoryManager.markBackground(id, !current || !win.isVisible());
  }
}

function pushState() {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  shellView.webContents.send('state', {
    platform: process.platform,
    page,
    activeId,
    editorId,
    editorNonce,
    editorColor,
    collapsed: settings.sidebarCollapsed,
    accounts: accounts.map((acc) => {
      const problem = problems.get(acc.id);
      return {
        id: acc.id,
        name: acc.name,
        color: acc.color,
        muted: acc.muted,
        unread: notifier.unread.get(acc.id) || 0,
        memMB: memoryManager.usageMB.get(acc.id) || 0,
        proxyLabel: proxyLabel(acc),
        regionLabel: (fingerprint.regions[acc.fingerprint.region] || fingerprint.regions.auto).label,
        problem: problem ? problem.text : '',
        problemTitle: problem ? problem.title : '',
        problemShort: problem ? problem.short : '',
        retrying: !!(problem && problem.retrying),
        needsQr: loginStates.get(acc.id) === 'needs_qr',
      };
    }),
    totalMB: memoryManager.totalMB(),
    settings,
    recycleChoices: memory.RECYCLE_CHOICES,
    canLoginItem,
    about: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      dataDir: app.getPath('userData'),
    },
  });
}

function refresh() {
  layout();
  pushState();
}

function setProblem(id, problem) {
  if (problem) problems.set(id, problem); else problems.delete(id);
  refresh();
}

// ---------- 连不上时自动重试 ----------
// 开机自启时 Clash 往往还没起来，所以代理错误不能只提示一次：10 秒后重试，之后逐步拉长到 60 秒。

function clearRetry(id) {
  const r = retries.get(id);
  if (r) clearTimeout(r.timer);
  retries.delete(id);
}

function reconnect(id) {
  const view = views.get(id);
  if (view && !view.webContents.isDestroyed()) view.webContents.loadURL(WA_URL).catch(() => {}); // 失败由 did-fail-load 处理
}

function scheduleRetry(id) {
  const r = retries.get(id) || { attempt: 0, timer: null };
  clearTimeout(r.timer);
  const delay = Math.min(10000 * 2 ** r.attempt, 60000);
  r.attempt += 1;
  r.timer = setTimeout(() => reconnect(id), delay);
  retries.set(id, r);
}

// 用户点“重新连接”
async function retryNow(id) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  clearRetry(id);
  const problem = problems.get(id);
  if (problem && problem.config) { openEditor(id); return; }
  if (!views.has(id)) { await createView(acc); refresh(); return; }
  reconnect(id);
}

// ---------- 掉线检测 ----------
// 每 3 分钟只读检查一次每个账号是否停在扫码页（在隔离环境里看页面结构，不读聊天内容）。
// 从“已登录”变成“要扫码”时，不管有没有关通知都提醒，因为掉线会漏掉所有消息。

async function checkLogins() {
  let changed = false;
  for (const acc of accounts) {
    const view = views.get(acc.id);
    if (!view || problems.has(acc.id)) continue;
    const state = await waPage.loginState(view.webContents);
    if (state === 'unknown') continue;
    const before = loginStates.get(acc.id);
    if (state === before) continue;
    if (state === 'needs_qr') mcp?.controller.gate.clearAccount(acc.id);
    if (state === 'needs_qr' && before === 'logged_in') {
      console.warn(`账号 ${acc.id} 已退出登录，需要重新扫码`);
      notifier.notify(acc, '已退出登录，需要重新扫码。点这里打开这个号。');
    }
    loginStates.set(acc.id, state);
    changed = true;
  }
  if (changed) pushState();
}

// 页面加载失败时，代理类错误要明确告诉用户，而不是一片空白
const PROXY_ERRORS = new Set([-111, -115, -120, -122, -125, -130, -336]);

async function createView(acc, loadDelay = 0) {
  const ses = session.fromPartition(`persist:wa-${acc.id}`);
  const r = fingerprint.resolve(acc.fingerprint);
  // 网络请求层面的 UA 和语言（包括 Service Worker 发出的请求）
  ses.setUserAgent(r.userAgent, r.acceptLanguage);
  // 不用拼写检查，也就不会去下载词典
  ses.setSpellCheckerEnabled(false);
  setupPermissions(ses);
  const applied = await proxy.apply(ses, acc.proxy);

  const view = new WebContentsView({
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  if (typeof view.setBorderRadius === 'function') view.setBorderRadius(14);
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
    notifier.update(acc, count, { isActive: acc.id === activeId && page === 'account' });
    pushState();
  });

  let failed = false;
  wc.on('did-start-loading', () => { failed = false; });
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 是被新的加载打断，不算错误
    failed = true;
    console.warn(`账号 ${acc.id} 页面加载失败：${code} ${desc}`);
    if (PROXY_ERRORS.has(code)) {
      setProblem(acc.id, {
        title: '代理连不上，这个账号已暂停联网',
        short: '代理连不上',
        text: `${acc.name} 设置的线路 ${acc.proxy} 没有响应（${desc}）。为了不暴露真实 IP，不会改用直连。请检查 Clash 是否在运行、端口是否正确。`,
        retrying: true,
      });
    } else {
      setProblem(acc.id, { title: 'WhatsApp 页面打不开', short: '连不上', text: `页面加载失败（${desc}），可能是网络不通。`, retrying: true });
    }
    scheduleRetry(acc.id);
  });
  wc.on('did-finish-load', () => {
    if (failed || applied.error) return;
    clearRetry(acc.id);
    if (problems.has(acc.id)) setProblem(acc.id, null);
  });
  // 页面进程崩溃后调试连接会断开，直接重建这个账号的视图，保证环境设置重新生效
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    console.warn(`账号 ${acc.id} 的页面进程退出（${details.reason}），正在重建`);
    setTimeout(async () => {
      if (!accounts.includes(acc)) return;
      destroyView(acc.id);
      await createView(acc);
      refresh();
    }, 1000);
  });

  if (applied.error) {
    setProblem(acc.id, {
      title: '代理设置有误，这个账号已暂停联网',
      short: '代理设置有误',
      text: `${applied.error}。为避免暴露真实 IP，这个账号暂时不联网，请修改代理。`,
      config: true,
    });
    return view;
  }
  await fingerprint.attach(wc, acc.fingerprint);
  if (loadDelay) setTimeout(() => { if (!wc.isDestroyed()) wc.loadURL(WA_URL).catch(() => {}); }, loadDelay);
  else wc.loadURL(WA_URL).catch(() => {}); // 失败由 did-fail-load 处理
  return view;
}

function destroyView(id) {
  clearRetry(id);
  const view = views.get(id);
  if (!view) return;
  win.contentView.removeChildView(view);
  if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach();
  view.webContents.close();
  views.delete(id);
}

function activate(id) {
  activeId = id;
  if (!accounts.length) page = 'welcome';
  refresh();
}

function showPage(next) {
  page = next === 'account' && !accounts.length ? 'welcome' : next;
  refresh();
}

// prefill：新建账号时预填的名称和地区（MCP 的 add_account 用）
let editorPrefill = null;
function openEditor(id, prefill = null) {
  const acc = accounts.find((a) => a.id === id);
  editorPrefill = acc ? null : prefill;
  editorId = acc ? acc.id : null;
  editorColor = acc ? acc.color : nextColor();
  editorNonce += 1;
  lastTest = null;
  page = 'editor';
  refresh();
}

// 返回 'removed' | 'cancelled' | 'busy' | 'not_found'。timeoutMs：超时没人点就当取消（MCP 调用用）
// MCP 引起的确认框同一时间只弹一个（删除账号、读对话列表共用）
let confirmDialogOpen = false;
async function removeAccount(id, { timeoutMs } = {}) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return 'not_found';
  // 已经有一个确认框在等用户时，不再叠第二个
  if (confirmDialogOpen) return 'busy';
  confirmDialogOpen = true;
  const abort = new AbortController();
  const timer = timeoutMs ? setTimeout(() => abort.abort(), timeoutMs) : null;
  if (timeoutMs) notifier.showWindow();
  let response;
  try {
    ({ response } = await dialog.showMessageBox(win, {
      signal: abort.signal,
      type: 'warning',
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
      title: '删除账号',
      message: `删除「${acc.name}」？`,
      detail: `会清除这个号在本机的全部数据（登录状态、聊天缓存、代理设置），之后要重新扫码才能登录。手机上的聊天记录不受影响。手机的“已关联的设备”里还会显示这台电脑，可以在手机上手动退出。${timeoutMs ? '\n\n这个请求来自 MCP 客户端（AI 助手）。' : ''}`,
    }));
  } finally {
    clearTimeout(timer);
    confirmDialogOpen = false;
  }
  if (response !== 1 || abort.signal.aborted) return 'cancelled';
  destroyView(id);
  problems.delete(id);
  exitIps.delete(id);
  loginStates.delete(id);
  mcp?.controller.gate.clearAccount(id);
  notifier.forget(id);
  memoryManager.forget(id);
  await session.fromPartition(`persist:wa-${id}`).clearStorageData();
  accounts = accounts.filter((a) => a.id !== id);
  saveAccounts();
  // 删掉磁盘上的分区文件夹；文件还被占用时删不掉，下次启动会再清理
  const dir = partitionDir(id);
  if (dir) fs.rm(dir, { recursive: true, force: true }, (e) => { if (e) console.warn(`暂时删不掉 wa-${id}，下次启动再清理`); });
  if (page === 'editor' && editorId === id) page = 'account';
  activate(accounts[0]?.id ?? null);
  return 'removed';
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

// ---------- 设置 ----------

function applyLoginItem() {
  if (!canLoginItem) return;
  // 开机启动时带 --hidden，直接缩在托盘
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: ['--hidden'] });
}

function setSetting(key, value) {
  if (key === 'recycleMB') {
    if (value !== 0 && !memory.RECYCLE_CHOICES.includes(value)) return;
  } else if (['lowMemoryMode', 'closeToTray', 'openAtLogin', 'sidebarCollapsed'].includes(key)) {
    if (typeof value !== 'boolean') return;
  } else {
    return;
  }
  settings[key] = value;
  memory.saveSettings(settings);
  if (key === 'openAtLogin') applyLoginItem();
  notifier.refresh();
  refresh();
}

// ---------- 快捷键和菜单 ----------

// Ctrl/Cmd + 1–9 切换账号。只在 WAswitch 窗口有焦点时生效，不抢其他软件的快捷键。
app.on('web-contents-created', (_e, wc) => {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt || input.shift) return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (!mod || !/^[1-9]$/.test(input.key)) return;
    const acc = accounts[Number(input.key) - 1];
    if (!acc) return;
    event.preventDefault();
    page = 'account';
    activate(acc.id);
  });
});

function setupMenu() {
  if (process.platform === 'darwin') {
    // macOS 需要“编辑”菜单，Cmd+C / Cmd+V 才能用
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  } else {
    // Windows / Linux 不显示菜单栏（默认菜单里有开发者工具），复制粘贴照常可用
    Menu.setApplicationMenu(null);
  }
}

// ---------- 启动 ----------

app.on('second-instance', () => notifier.showWindow());

app.whenReady().then(async () => {
  if (!isPrimary) return;
  setupMenu();
  // 本地界面用的默认会话不需要任何权限
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setSpellCheckerEnabled(false);

  const mac = process.platform === 'darwin';
  win = new BaseWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600, show: false,
    title: 'WAswitch', backgroundColor: '#E6E9ED',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    ...(mac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } } : {}),
  });
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
    if (!settings.closeToTray) { quitting = true; app.quit(); return; }
    event.preventDefault();
    win.hide();
    if (!hintShown && !mac) {
      hintShown = true;
      notifier.tray.displayBalloon?.({ title: 'WAswitch 还在运行', content: '已缩到托盘，继续接收消息。右键托盘图标可以退出。' });
    }
  });

  shellView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'shell', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.contentView.addChildView(shellView);
  lockLocalPage(shellView.webContents);
  shellView.webContents.loadFile(path.join(__dirname, 'shell', 'index.html'));
  shellView.webContents.on('did-finish-load', pushState);
  win.on('resize', layout);

  accounts = loadAccounts();
  if (accountsFileOk) saveAccounts();
  cleanupPartitions();
  applyLoginItem();
  activeId = accounts[0]?.id ?? null;
  page = accounts.length ? 'account' : 'welcome';
  refresh();
  if (!shouldStartHidden()) win.show();

  // 电脑睡眠醒来后，网络和 Clash 需要几秒恢复，之后重连所有连不上的账号
  powerMonitor.on('resume', () => {
    setTimeout(() => {
      for (const [id, p] of problems) if (!p.config) { clearRetry(id); reconnect(id); }
    }, 5000);
  });

  // 分批启动：先打开当前账号，其他账号每隔 2.5 秒打开一个，避免同时加载卡顿
  for (const [i, acc] of accounts.entries()) {
    await createView(acc, i * 2500);
    refresh();
  }
  memoryManager.start();
  setInterval(checkLogins, LOGIN_CHECK_MS);
  setTimeout(checkLogins, 60 * 1000);

  mcp = setupMcp({ hooks: mcpHooks, lockLocalPage });
  await mcp.init();
  notifier.refresh();
});

// ---------- 本地界面发来的操作 ----------

// 只接受本地界面发来的消息，WhatsApp 页面没有这些接口
const fromShell = (e) => shellView && e.sender === shellView.webContents;
const onShell = (channel, fn) => ipcMain.on(channel, (e, ...args) => { if (fromShell(e)) fn(...args); });
const handleShell = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
  if (!fromShell(e)) throw new Error('not allowed');
  return fn(...args);
});
const findAcc = (id) => accounts.find((a) => a.id === id);

onShell('switch', (id) => { if (findAcc(id)) { page = 'account'; activate(id); } });
onShell('add', () => openEditor(null));
onShell('edit', (id) => { if (findAcc(id)) openEditor(id); });
onShell('page', (p) => { if (['account', 'settings'].includes(p)) showPage(p); });
onShell('collapse', () => setSetting('sidebarCollapsed', !settings.sidebarCollapsed));
onShell('setting', ({ key, value } = {}) => setSetting(key, value));
onShell('reload', (id) => {
  if (!findAcc(id)) return;
  if (problems.has(id)) retryNow(id);
  else views.get(id)?.webContents.reload();
});
onShell('retry', (id) => retryNow(id));
onShell('mute', ({ id, muted } = {}) => {
  const acc = findAcc(id);
  if (!acc || typeof muted !== 'boolean') return;
  acc.muted = muted;
  saveAccounts();
  notifier.refresh();
  pushState();
});
onShell('open-logs', () => { const dir = log.logDir(); if (dir) shell.openPath(dir); });
onShell('open-source', () => shell.openExternal(SOURCE_URL));

// 右键账号或点顶栏“⋯”：编辑 / 刷新 / 通知 / 删除
onShell('context', (id) => {
  const acc = findAcc(id);
  if (!acc) return;
  Menu.buildFromTemplate([
    { label: '编辑名称、颜色和代理…', click: () => openEditor(id) },
    { label: '刷新', click: () => (problems.has(id) ? retryNow(id) : views.get(id)?.webContents.reload()) },
    {
      label: '不弹通知', type: 'checkbox', checked: acc.muted,
      click: () => { acc.muted = !acc.muted; saveAccounts(); notifier.refresh(); pushState(); },
    },
    { type: 'separator' },
    { label: `删除「${acc.name}」并退出登录…`, click: () => removeAccount(id) },
  ]).popup({ window: win });
});

// ---------- 编辑账号（新建和修改共用） ----------

handleShell('editor:load', (id) => {
  const acc = findAcc(id);
  return {
    id: acc ? acc.id : null,
    isNew: !acc,
    name: acc ? acc.name : String(editorPrefill?.name || nextName()).slice(0, 40),
    color: acc ? acc.color : editorColor || nextColor(),
    proxy: acc ? acc.proxy : '',
    hasPassword: !!(acc && acc.proxyPassword),
    region: acc ? acc.fingerprint.region : (fingerprint.regions[editorPrefill?.region] ? editorPrefill.region : 'auto'),
    regions: Object.entries(fingerprint.regions).map(([key, v]) => ({ key, label: v.label })),
  };
});

// 测试代理：返回出口 IP、所在地、时区，给出匹配的地区，并提示和别的账号出口相同
handleShell('editor:test', async ({ id, proxy: proxyText, password } = {}) => {
  const acc = findAcc(id);
  const pass = String(password || '') || (acc ? proxy.decryptPassword(acc.proxyPassword) : '');
  const res = await proxy.test(String(proxyText || ''), pass);
  if (!res.ok) return res;
  res.region = findByTimezone(res.timezone);
  res.country = regionName(res.country);
  const same = accounts.find((a) => a.id !== id && exitIps.get(a.id) === res.ip);
  if (same) res.sameAs = same.name;
  lastTest = { proxy: proxy.parse(proxyText)?.rules, ip: res.ip, label: res.country };
  return res;
});

handleShell('editor:save', async ({ id, name, color, proxy: proxyText, password, region } = {}) => {
  name = String(name || '').trim().slice(0, 40);
  if (!name) return { error: '请填写名称' };
  if (!COLORS.includes(color)) color = nextColor();
  const parsed = proxy.parse(String(proxyText || ''));
  if (parsed && parsed.error) return { error: parsed.error };
  if (!fingerprint.regions[region]) region = 'auto';
  const proxyStored = parsed ? parsed.display : '';
  let acc = findAcc(id);

  // 密码：新填的优先；地址里带的其次；都没有则保留原来的（地址变了用户名也变了就清掉）
  let encPassword = acc ? acc.proxyPassword : '';
  try {
    const newPass = String(password || '') || (parsed && parsed.password) || '';
    if (newPass) encPassword = proxy.encryptPassword(newPass);
    if (!parsed || !parsed.username) encPassword = '';
  } catch (e) {
    return { error: e.message };
  }
  // 测试过的出口所在地显示在侧栏
  const tested = lastTest && parsed && lastTest.proxy === parsed.rules ? lastTest : null;

  if (!acc) {
    acc = { id: String(Date.now()), name, color, proxy: proxyStored, proxyPassword: encPassword, exitLabel: tested ? tested.label : '', fingerprint: fingerprint.generate(region), muted: false };
    accounts.push(acc);
    if (tested) exitIps.set(acc.id, tested.ip);
    saveAccounts();
    page = 'account';
    activeId = acc.id;
    await createView(acc);
    refresh();
  } else {
    const changed = acc.proxy !== proxyStored || acc.proxyPassword !== encPassword || acc.fingerprint.region !== region;
    if (acc.proxy !== proxyStored) acc.exitLabel = '';
    if (tested) { acc.exitLabel = tested.label; exitIps.set(acc.id, tested.ip); }
    acc.name = name;
    acc.color = color;
    acc.proxy = proxyStored;
    acc.proxyPassword = encPassword;
    // 只改地区（时区、语言），浏览器标识保持不变
    acc.fingerprint.region = region;
    saveAccounts();
    page = 'account';
    activeId = acc.id;
    if (changed) {
      destroyView(acc.id);
      problems.delete(acc.id);
      await createView(acc);
    }
    refresh();
  }
  notifier.refresh();
  return { ok: true };
});

// ---------- 隔离自检 ----------
// 逐个测试每个账号的代理出口，找出走真实 IP 的号、共用出口的号、时区和出口对不上的号。

handleShell('check:run', async () => {
  const items = [];
  const byPort = new Map();
  const byIp = new Map();
  for (const acc of accounts) {
    const p = proxy.parse(acc.proxy);
    if (!p) { items.push({ level: 'warn', title: `${acc.name}：直连`, detail: '没有设代理，用的是这台电脑的真实 IP。' }); continue; }
    if (p.error) { items.push({ level: 'bad', title: `${acc.name}：代理设置有误`, detail: p.error }); continue; }
    const key = `${p.host}:${p.port}`;
    byPort.set(key, [...(byPort.get(key) || []), acc.name]);
    // 会话里的代理规则不能带“直连”兜底
    const rule = await session.fromPartition(`persist:wa-${acc.id}`).resolveProxy(WA_URL);
    if (/DIRECT/i.test(rule)) items.push({ level: 'bad', title: `${acc.name}：代理规则里有直连兜底`, detail: rule });
    const res = await proxy.test(acc.proxy, proxy.decryptPassword(acc.proxyPassword));
    if (!res.ok) { items.push({ level: 'bad', title: `${acc.name}：代理连不上`, detail: res.error }); continue; }
    exitIps.set(acc.id, res.ip);
    acc.exitLabel = regionName(res.country);
    byIp.set(res.ip, [...(byIp.get(res.ip) || []), acc.name]);
    const tz = fingerprint.resolve(acc.fingerprint).timezone;
    const place = [acc.exitLabel, res.city].filter(Boolean).join(' · ');
    items.push(tz && tz !== res.timezone
      ? { level: 'warn', title: `${acc.name}：出口 ${res.ip}（${place}）`, detail: `出口时区是 ${res.timezone}，账号设置的是 ${tz}，建议在编辑里改成一致。` }
      : { level: 'ok', title: `${acc.name}：出口 ${res.ip}（${place}）`, detail: tz ? `时区 ${tz}，和出口一致。` : '时区跟随本机，建议在编辑里选和出口一致的地区。' });
  }
  for (const [key, names] of byPort) {
    if (names.length > 1) items.push({ level: 'bad', title: `${names.join('、')} 共用同一个代理端口`, detail: `${key}。这几个号会从同一个 IP 上网，建议每个号一个端口。` });
  }
  for (const [ip, names] of byIp) {
    if (names.length > 1) items.push({ level: 'bad', title: `${names.join('、')} 的出口 IP 相同`, detail: `${ip}。在 WhatsApp 看来这几个号在同一个地方。` });
  }
  const webrtcOk = [...views.values()].every((v) => v.webContents.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp');
  items.push({ level: webrtcOk ? 'ok' : 'bad', title: 'WebRTC 只走代理，不泄露本机 IP' });
  const uaOk = accounts.every((a) => !/Electron|waswitch/i.test(fingerprint.resolve(a.fingerprint).userAgent));
  items.push({ level: uaOk ? 'ok' : 'bad', title: '浏览器标识里没有 Electron 或软件名' });
  saveAccounts();
  pushState();
  return { items, time: new Date().toLocaleString('zh-CN') };
});

app.on('before-quit', () => { quitting = true; });
// 窗口只是隐藏，不因为“没有可见窗口”而退出
app.on('window-all-closed', () => {});
// macOS 点 Dock 图标时重新显示窗口
app.on('activate', () => notifier.showWindow());
