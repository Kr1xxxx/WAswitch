// WAswitch 主进程。
// 窗口 = 一个本地界面视图（侧栏、顶栏、设置等，铺满整个窗口）+ 每个账号一个 WhatsApp 视图（盖在右侧卡片里）。
// 每个账号三层隔离：
//   1. 数据：独立的 session 分区（persist:wa-<id>），cookie、存储、缓存互不相通
//   2. 网络：独立代理（proxy.js），代理不通时不回落直连，并禁止 WebRTC 绕过代理
//   3. 环境：独立的浏览器标识、语言、时区（fingerprint.js），只用官方接口设置
// 小号可以用“轻量模式”（src/lite）：不开网页，在一个共用的后台进程里直接连 WhatsApp，省内存。
// 主号只能用网页版。轻量模式必须走代理，后台进程里有网络护栏，任何直连都会被拦下。
const { app, BaseWindow, WebContentsView, ipcMain, session, shell, Menu, dialog, powerMonitor, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const log = require('./log');
const fingerprint = require('./fingerprint');
const proxy = require('./proxy');
const { isValidRegion, regionForTimezone, regionLabel } = require('./regions');
const { Notifier } = require('./notify');
const memory = require('./memory');
const waPage = require('./wa-page');
const { setupMcp } = require('./mcp');
const { LiteHost } = require('./lite/host');
const { isSafeLink } = require('./links');
const { clearSessionCache } = require('./cache');
const { Updater } = require('./updater');

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
    // 先让轻量模式后台进程存好密钥再退出（它自己保存、退出；下面的提示框给它留出时间）
    try { liteHost?.shutdown(); } catch { /* 后台进程可能已经不在了 */ }
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
const startupLowMemory = settings.lowMemoryMode; // 省内存模式要重启才生效，记下启动时的值

const WA_URL = 'https://web.whatsapp.com/';
const SIDE_EXPANDED = 200;
const SIDE_COLLAPSED = 64;
const GAP = 8; // 右侧卡片和窗口边缘的间距
const TOPBAR = 44; // 卡片顶栏高度
const AIBAR = 44; // “AI 想切换账号”横幅的高度
const TYPING_MS = 30 * 1000; // 这么久内按过键，算用户正在用
const NOTE_MAX = 200;
const COLORS = ['#16A34A', '#7C3AED', '#EA580C', '#2563EB', '#DB2777', '#475569'];
const SOURCE_URL = 'https://github.com/Kr1xxxx/WAswitch';
const canLoginItem = process.platform === 'win32' || process.platform === 'darwin';
// 开机自启时是否直接缩在托盘（在 app ready 之后判断）。
// macOS 13 以后系统不告诉软件是不是开机启动的，所以 Mac 上开机自启会正常弹出窗口。
function shouldStartHidden() {
  if (process.argv.includes('--hidden')) return true;
  if (takeUpdateMarker()) return true;
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

// ---------- 分组 ----------
// 分组单独存在 groups.json（accounts.json 仍是账号数组，老版本照样能读）。账号上记 groupId。
// 分组只影响侧栏怎么显示：折叠只是不显示这几行，页面照常运行；整组静音和账号自己的静音是“或”的关系。
const groupsFile = () => path.join(app.getPath('userData'), 'groups.json');
const GROUP_MAX = 30;
let groups = [];
function loadGroups() {
  const file = groupsFile();
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('not an array');
    const seen = new Set();
    return raw.filter((g) => g && typeof g.id === 'string' && g.id && !seen.has(g.id) && seen.add(g.id)).slice(0, GROUP_MAX).map((g) => ({
      ...g,
      name: String(g.name || '分组').replace(/\s+/g, ' ').trim().slice(0, 20) || '分组',
      collapsed: g.collapsed === true,
      muted: g.muted === true,
    }));
  } catch (e) {
    // 和 accounts.json 一样：坏了先备份，不覆盖。分组丢了只是账号都回到“未分组”，账号本身不受影响
    const backup = `${file}.broken-${Date.now()}`;
    try { fs.copyFileSync(file, backup); } catch {}
    console.warn(`groups.json 无法读取（${e.message}），已备份到 ${backup}`);
    return [];
  }
}
function saveGroups() {
  const file = groupsFile();
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(groups, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}
const groupOf = (acc) => (acc.groupId ? groups.find((g) => g.id === acc.groupId) : null);
// 是否不弹通知：账号自己关了，或者所在分组整组关了
const isMuted = (acc) => acc.muted || !!groupOf(acc)?.muted;
// 侧栏的显示顺序：先是没分组的号，再按分组顺序；同一段里按 accounts.json 的顺序。Ctrl+数字、托盘也按这个顺序
function displayOrder() {
  return [...accounts.filter((a) => !groupOf(a)), ...groups.flatMap((g) => accounts.filter((a) => a.groupId === g.id))];
}
// 把账号挪到某个分组（'' 表示未分组）里，放在 beforeId 那个号前面；beforeId 为空就放到这一段的最后
function moveAccount(id, groupId, beforeId) {
  const acc = findAcc(id);
  if (!acc) return false;
  if (groupId && !groups.some((g) => g.id === groupId)) return false;
  const target = groupId || '';
  const before = beforeId ? findAcc(beforeId) : null;
  accounts.splice(accounts.indexOf(acc), 1);
  acc.groupId = target;
  if (before && before.id !== id && (before.groupId || '') === target) {
    accounts.splice(accounts.indexOf(before), 0, acc);
  } else {
    // 放到同一段最后一个号后面；这一段还没有号就放到最后
    const last = [...accounts].reverse().find((a) => (groupOf(a) ? a.groupId : '') === target);
    accounts.splice(last ? accounts.indexOf(last) + 1 : accounts.length, 0, acc);
  }
  saveAccounts();
  notifier.refresh();
  refresh();
  return true;
}
// 上移、下移：只在同一段里挪
function stepAccount(id, dir) {
  const acc = findAcc(id);
  if (!acc) return;
  const key = groupOf(acc) ? acc.groupId : '';
  const section = displayOrder().filter((a) => (groupOf(a) ? a.groupId : '') === key);
  const i = section.indexOf(acc);
  const j = i + dir;
  if (j < 0 || j >= section.length) return;
  const other = section[j];
  const ai = accounts.indexOf(acc);
  const oi = accounts.indexOf(other);
  accounts[ai] = other;
  accounts[oi] = acc;
  saveAccounts();
  notifier.refresh();
  refresh();
}
let editGroupId = ''; // 新建的分组：侧栏直接进入改名
function createGroup(moveId) {
  if (groups.length >= GROUP_MAX) return null;
  const used = new Set(groups.map((g) => g.name));
  let n = groups.length + 1;
  while (used.has(`分组 ${n}`)) n += 1;
  const g = { id: `g${Date.now().toString(36)}`, name: `分组 ${n}`, collapsed: false, muted: false };
  groups.push(g);
  saveGroups();
  editGroupId = g.id;
  if (moveId) moveAccount(moveId, g.id, null);
  else refresh();
  return g.id;
}

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
    // 备注：手机号、用途、负责人之类，只在本机显示，不给 MCP
    acc.note = typeof acc.note === 'string' ? cleanNote(acc.note) : '';
    acc.color = COLORS.includes(acc.color) ? acc.color : COLORS[i % COLORS.length];
    acc.proxy = typeof acc.proxy === 'string' ? acc.proxy : '';
    acc.proxyPassword = typeof acc.proxyPassword === 'string' ? acc.proxyPassword : '';
    acc.exitLabel = typeof acc.exitLabel === 'string' ? acc.exitLabel : '';
    acc.fingerprint = fingerprint.normalize(acc.fingerprint);
    acc.muted = acc.muted === true;
    // 分组：指向不存在的分组时显示成未分组，但不清掉（groups.json 坏了、从备份恢复后还能回到原来的组）
    acc.groupId = typeof acc.groupId === 'string' ? acc.groupId.slice(0, 40) : '';
    acc.mode = acc.mode === 'lite' ? 'lite' : 'web';
    acc.liteKey = typeof acc.liteKey === 'string' ? acc.liteKey : '';
    // 老版本没有这个字段：当作登录过（之前已经在用的号），掉线照样标红
    acc.loggedIn = acc.loggedIn === undefined ? true : acc.loggedIn === true;
    // 直连号是否允许网页版通话（WebRTC 走 UDP），默认不允许
    acc.allowCalls = acc.allowCalls === true;
    acc.lastExit = acc.lastExit && typeof acc.lastExit.ip === 'string' && Number.isFinite(acc.lastExit.at) ? { ip: acc.lastExit.ip, at: acc.lastExit.at } : null;
    // 主号只能用网页版
    acc.primary = acc.primary === true && acc.mode === 'web';
  });
  // 只能有一个主号；没有时把第一个网页版账号设为主号
  const primaries = list.filter((a) => a.primary);
  primaries.slice(1).forEach((a) => { a.primary = false; });
  if (!primaries.length) {
    const first = list.find((a) => a.mode === 'web');
    if (first) first.primary = true;
  }
  return list;
}

function cleanNote(note) {
  return String(note || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
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

// 轻量模式账号的数据文件夹，规则同上
function liteDir(id) {
  if (!/^\d+$/.test(id)) return null;
  const base = path.join(app.getPath('userData'), 'lite');
  const dir = path.join(base, id);
  return path.dirname(dir) === base ? dir : null;
}

// 启动时删掉已删除账号残留的分区文件夹（删除账号时文件可能还被占用，删不掉）
function cleanupPartitions() {
  if (!accountsFileOk) return;
  let liteNames = [];
  try { liteNames = fs.readdirSync(path.join(app.getPath('userData'), 'lite')); } catch { /* 没有轻量模式账号 */ }
  const keepLite = new Set(accounts.filter((a) => a.mode === 'lite').map((a) => a.id));
  for (const name of liteNames) {
    const dir = liteDir(name);
    if (!dir || keepLite.has(name)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); console.log(`已清理残留的轻量模式数据 ${name}`); } catch (e) { console.warn(`清理轻量模式数据 ${name} 失败：${e.message}`); }
  }
  const base = path.join(app.getPath('userData'), 'Partitions');
  let names = [];
  try { names = fs.readdirSync(base); } catch { return; }
  // 轻量模式账号没有网页分区，残留的也一起清掉
  const keep = new Set(accounts.filter((a) => a.mode === 'web').map((a) => `wa-${a.id}`));
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
const exitIps = new Map(); // id -> 这次打开软件后测到的出口 IP（当作当前值用）
// 测到出口时同时存进 accounts.json（带时间）。重启后只用来提醒“上次测到相同”，不当作当前值
function recordExit(acc, ip) {
  exitIps.set(acc.id, ip);
  acc.lastExit = { ip, at: Date.now() };
  // 用户自己测到了新 IP，就不再提醒“变了”
  if (exitChanges.has(acc.id) && exitChanges.get(acc.id).to !== ip) exitChanges.delete(acc.id);
}

// 出口 IP 巡检：每 30 分钟按顺序测一遍走代理的号，IP 和上次不一样就在顶栏和侧栏标黄。
// 机场节点会悄悄换 IP，号在 WhatsApp 看来会忽东忽西。只访问 ipinfo.io，一次一个，不占多少资源。
const EXIT_WATCH_MS = 30 * 60 * 1000;
const exitChanges = new Map(); // id -> { from, to, fromLabel, toLabel, at }
let exitWatchRunning = false;
async function watchExits() {
  if (exitWatchRunning || quitting) return;
  exitWatchRunning = true;
  try {
    for (const acc of [...accounts]) {
      if (!acc.proxy || quitting || !findAcc(acc.id)) continue;
      const prev = exitIps.get(acc.id) || (acc.lastExit ? acc.lastExit.ip : '');
      const prevLabel = acc.exitLabel;
      const proxyAtStart = acc.proxy;
      const res = await proxy.test(acc.proxy, proxy.decryptPassword(acc.proxyPassword));
      // 测的时候代理被改了或者号被删了：结果作废
      if (!res.ok || !findAcc(acc.id) || acc.proxy !== proxyAtStart) continue;
      const label = regionName(res.country);
      if (prev && prev !== res.ip) {
        exitChanges.set(acc.id, { from: prev, to: res.ip, fromLabel: prevLabel, toLabel: label, at: Date.now() });
        console.warn(`[出口巡检] ${acc.name}：${prev} -> ${res.ip}`);
      }
      exitIps.set(acc.id, res.ip);
      acc.lastExit = { ip: res.ip, at: Date.now() };
      acc.exitLabel = label;
    }
    saveAccounts();
    refresh();
  } finally {
    exitWatchRunning = false;
  }
}
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
// MCP 想切号或打开添加页、但用户正在打字时，先挂起，在窗口顶部问用户
let aiRequest = null; // { kind: 'switch' | 'add', id?, name?, region? }
let lastTypedAt = 0;

// 轻量模式（在 app ready 之后创建）
let liteHost = null;
const liteStates = new Map(); // id -> { status, qr }
const liteViews = new Map(); // id -> 后台进程推来的对话列表和当前对话
const liteOpen = new Map(); // id -> 正在看的对话
let liteGuardHits = 0; // 网络护栏拦下的次数（隔离自检里显示）
const isLite = (acc) => acc && acc.mode === 'lite';

const memoryManager = new memory.MemoryManager(settings, {
  views,
  // 轻量模式账号共用一个后台进程，占用平均分给每个轻量账号（近似值）
  extraUsage: (byPid) => {
    const lite = accounts.filter(isLite);
    const pid = liteHost && liteHost.pid();
    if (!lite.length) return [];
    const each = Math.round((pid ? byPid.get(pid) || 0 : 0) / lite.length);
    return lite.map((a) => [a.id, each]);
  },
  isBackground: (id) => id !== activeId || page !== 'account' || !win || !win.isVisible(),
  unreadOf: (id) => notifier.unread.get(id) || 0,
  onUpdate: () => { notifier.refresh(); pushState(); },
});

const notifier = new Notifier({
  getAccounts: () => displayOrder(),
  isMuted: (acc) => isMuted(acc),
  getWindow: () => win,
  activate: (id) => { userActivate(id); },
  quit: () => { quitting = true; app.quit(); },
  memoryOf: (id) => memoryManager.usageMB.get(id) || 0,
  totalMemory: () => memoryManager.totalMB(),
  settingsMenu: () => [
    {
      label: `后台账号超过 ${settings.recycleMB || settings.recycleLastMB} MB 时自动刷新回收内存`,
      type: 'checkbox',
      checked: settings.recycleMB > 0,
      click: () => setSetting('recycleMB', settings.recycleMB > 0 ? 0 : settings.recycleLastMB),
    },
    {
      label: '省内存模式（关闭显卡加速，重启后生效）',
      type: 'checkbox',
      checked: settings.lowMemoryMode,
      click: () => { setSetting('lowMemoryMode', !settings.lowMemoryMode); askRestart(); },
    },
    ...(accounts.length ? [{ label: locked ? '聊天已锁定' : '立即锁定聊天', enabled: !locked, click: () => setLocked(true) }] : []),
    { label: '设置…', click: () => { notifier.showWindow(); showPage('settings'); } },
    ...(mcp ? [{ label: 'MCP 接口设置…', click: () => mcp.openSettings() }] : []),
  ],
  trayText: () => (updater ? updater.trayText() : ''),
  updateMenu: () => {
    const u = updater?.state;
    if (!u || u.status !== 'downloaded') return [];
    return u.mac
      ? [{ label: `打开新版本 ${u.version} 的安装包`, click: () => updater.openMacInstaller() }]
      : [{ label: `重启以更新到 ${u.version}`, click: () => updater.install() }];
  },
});

// MCP 接口（默认关闭）。在 app ready 之后创建。
let mcp = null;

// 分批启动时还没开始加载的账号（页面停在 about:blank，不能算 ready）
const pendingLoad = new Set();

function accountStatus(id) {
  const view = views.get(id);
  if (problems.has(id)) return 'error';
  if (isLite(accounts.find((a) => a.id === id))) {
    const st = liteStates.get(id)?.status;
    return st === 'open' || st === 'qr' ? 'ready' : 'loading';
  }
  if (!view) return 'not_loaded';
  return pendingLoad.has(id) || view.webContents.isLoading() ? 'loading' : 'ready';
}

const mcpHooks = {
  listAccounts: () => accounts.map((a) => ({
    id: a.id,
    name: a.name,
    active: a.id === activeId,
    unread: notifier.unread.get(a.id) || 0,
    muted: a.muted,
    mode: a.mode, // web | lite
    status: accountStatus(a.id),
    // 只读掉线检测的结果：logged_in | needs_qr | unknown
    login: loginStates.get(a.id) || 'unknown',
    problem: problems.get(a.id)?.text || '',
  })),
  regions: () => Object.entries(fingerprint.regions).map(([key, v]) => ({ key, label: v.label })),
  // MCP 引起的切换不抢键盘焦点；用户正在打字时不切，改为在窗口顶部问用户。返回 'done' | 'pending' | 'hidden'（添加页开在托盘里的窗口）
  activate: (id) => aiAsk({ kind: 'switch', id }),
  // 不直接创建：打开“添加账号”页面并预填，由人确认代理后保存，避免新号先用真实 IP 联网
  openAddAccount: ({ name, region }) => aiAsk({ kind: 'add', name, region }),
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
    // 轻量模式没有网页，登录状态来自后台进程
    if (isLite(findAcc(id))) return problems.has(id) ? 'unknown' : (loginStates.get(id) || 'unknown');
    const view = views.get(id);
    if (!view || problems.has(id)) return 'unknown';
    const state = await waPage.loginState(view.webContents);
    if (state !== 'unknown' && state !== loginStates.get(id)) { loginStates.set(id, state); noteLoggedIn(id, state); pushState(); }
    return state;
  },
  readChatList: async (id, opts) => {
    if (isLite(findAcc(id))) return { ok: false, reason: 'lite' };
    const view = views.get(id);
    if (!view || pendingLoad.has(id)) return { ok: false, reason: 'loading' };
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

// ---------- 聊天锁 ----------
// 电脑一段时间没有键盘鼠标操作，就把聊天区遮住（藏起账号页面，界面上显示锁屏卡片），右滑解锁，不设密码。
// 只是防路过的人看到聊天内容：页面照常在后台运行，消息、未读数、通知都不受影响。不往 WhatsApp 页面注入任何东西。
let locked = false;
const LOCK_POLL_MS = 10 * 1000;
function setLocked(on) {
  on = !!on;
  if (locked === on) return;
  if (on && !accounts.length) return;
  locked = on;
  // 先把键盘焦点从账号页面挪走，锁住后打字不会进到聊天里
  if (on && shellView && !shellView.webContents.isDestroyed()) shellView.webContents.focus();
  layout();
  refresh();
  if (!on) {
    focusActive();
    // 解锁后正在看的轻量号聊天马上标已读（锁着时不标）
    const jid = liteOpen.get(activeId);
    if (jid && page === 'account' && isLite(findAcc(activeId)) && win && win.isFocused()) liteHost.read(activeId, jid);
  }
}
// 空闲时间：窗口在前台时用系统空闲时间（键盘和鼠标都算，包括在 WhatsApp 页面里滚动、点击）；
// 窗口不在前台、最小化或缩到托盘时，从失去焦点那一刻起算空闲（用户在别的软件里忙也算没看这里）
let unfocusedSince = 0;
function idleSeconds() {
  const sys = powerMonitor.getSystemIdleTime();
  if (win && win.isVisible() && !win.isMinimized() && win.isFocused()) { unfocusedSince = 0; return sys; }
  if (!unfocusedSince) unfocusedSince = Date.now();
  return Math.max(sys, (Date.now() - unfocusedSince) / 1000);
}
function checkIdleLock() {
  const mins = settings.lockMinutes;
  if (!mins || locked || !accounts.length) return;
  if (idleSeconds() >= mins * 60) setLocked(true);
}

// 所有账号视图大小相同，只显示当前账号。其他账号设为隐藏，
// Chromium 会把它们当作后台页面处理（降低优先级、节流、释放画面缓存），但消息照常接收。
function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  shellView.setBounds({ x: 0, y: 0, width, height });
  const side = sideWidth();
  const top = TOPBAR + (aiRequest ? AIBAR : 0);
  const bounds = {
    x: side,
    y: GAP + top,
    width: Math.max(0, width - side - GAP),
    height: Math.max(0, height - GAP * 2 - top),
  };
  for (const [id, view] of views) {
    const current = page === 'account' && id === activeId;
    view.setBounds(bounds);
    view.setVisible(current && !problems.has(id) && !locked);
    memoryManager.markBackground(id, !current || !win.isVisible());
  }
  syncLiteWatch();
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
    aiRequest: aiRequestForShell(),
    update: updater ? updater.snapshot() : null,
    collapsed: settings.sidebarCollapsed,
    locked,
    lockChoices: memory.LOCK_CHOICES,
    // 分组：每组带上未读总数，折叠后组头上也能看到
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      collapsed: g.collapsed,
      muted: g.muted,
      count: accounts.filter((a) => a.groupId === g.id).length,
      unread: accounts.filter((a) => a.groupId === g.id).reduce((n, a) => n + (notifier.unread.get(a.id) || 0), 0),
    })),
    editGroupId,
    accounts: displayOrder().map((acc) => {
      const problem = problems.get(acc.id);
      return {
        id: acc.id,
        name: acc.name,
        note: acc.note,
        color: acc.color,
        muted: acc.muted,
        groupId: groupOf(acc) ? acc.groupId : '',
        groupMuted: !!groupOf(acc)?.muted,
        unread: notifier.unread.get(acc.id) || 0,
        memMB: memoryManager.usageMB.get(acc.id) || 0,
        proxyLabel: proxyLabel(acc),
        regionLabel: regionLabel(acc.fingerprint.region),
        // 顶栏的“当地时间”：账号的时区；跟随本机时为 null
        timezone: fingerprint.resolve(acc.fingerprint).timezone || null,
        exitIp: exitIps.get(acc.id) || (acc.lastExit ? acc.lastExit.ip : ''),
        exitAt: acc.lastExit ? acc.lastExit.at : 0,
        exitChange: exitChanges.get(acc.id) || null,
        problem: problem ? problem.text : '',
        problemTitle: problem ? problem.title : '',
        problemShort: problem ? problem.short : '',
        problemKind: problem ? problem.kind || '' : '',
        direct: !acc.proxy,
        allowCalls: !!acc.allowCalls,
        // 从没登录成功过的号停在二维码页是正常的第一步，不算故障
        everLoggedIn: !!acc.loggedIn,
        retrying: !!(problem && problem.retrying),
        needsQr: loginStates.get(acc.id) === 'needs_qr',
        mode: acc.mode,
        primary: acc.primary,
        liteStatus: isLite(acc) ? (liteStates.get(acc.id)?.status || 'connecting') : '',
      };
    }),
    lite: liteStateForShell(),
    totalMB: memoryManager.totalMB(),
    settings,
    restartNeeded: settings.lowMemoryMode !== startupLowMemory,
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

// 第一次登录成功时记下来（存进 accounts.json）：之后再要扫码才算掉线，标红
function noteLoggedIn(id, state) {
  const acc = findAcc(id);
  if (state !== 'logged_in' || !acc || acc.loggedIn) return;
  acc.loggedIn = true;
  saveAccounts();
}

// WebRTC：默认禁止走代理以外的 UDP，防止泄露真实 IP。
// 直连号可以在编辑里打开“允许通话”：只用默认网卡（不暴露内网 IP），允许 UDP，网页版才能打电话。
// 注意“直连”实际走系统代理设置：Clash 开着系统代理时网页走 Clash，而通话的 UDP 走真实 IP，所以默认关。
function webrtcPolicy(acc) {
  return !acc.proxy && acc.allowCalls ? 'default_public_interface_only' : 'disable_non_proxied_udp';
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
  if (isLite(acc)) { problems.delete(id); startLite(acc); refresh(); return; }
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
    noteLoggedIn(acc.id, state);
    changed = true;
  }
  if (changed) pushState();
}

// 页面加载失败时，代理类错误要明确告诉用户，而不是一片空白
const RELOAD_QUIET_MS = 15 * 1000;
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
  wc.setWebRTCIPHandlingPolicy(webrtcPolicy(acc));
  setupNavigationGuards(wc);
  win.contentView.addChildView(view);
  views.set(acc.id, view);

  // 从页面标题里读未读数，例如 "(3) WhatsApp"
  // 页面刚开始加载的 15 秒里标题会从 0 涨回刷新前的数：涨回原数不弹，超过原数（真有新消息）照常弹
  let quietUntil = 0;
  let baseline = 0;
  wc.on('page-title-updated', (_e, title) => {
    const m = title.match(/^\((\d+)\)/);
    const count = m ? Number(m[1]) : 0;
    notifier.update(acc, count, { isActive: acc.id === activeId && page === 'account', baseline: Date.now() < quietUntil ? baseline : 0 });
    pushState();
  });

  let failed = false;
  wc.on('did-stop-loading', () => { webLoadedAt.set(acc.id, Date.now()); });
  wc.on('did-start-loading', () => {
    failed = false;
    if (Date.now() >= quietUntil) baseline = notifier.unread.get(acc.id) || 0; // 连续刷新时保留第一次的原数
    quietUntil = Date.now() + RELOAD_QUIET_MS;
  });
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 是被新的加载打断，不算错误
    failed = true;
    console.warn(`账号 ${acc.id} 页面加载失败：${code} ${desc}`);
    if (PROXY_ERRORS.has(code)) {
      setProblem(acc.id, {
        kind: 'proxy',
        title: '代理连不上，这个账号已暂停联网',
        short: '代理连不上',
        text: `${acc.name} 设置的线路 ${acc.proxy} 没有响应（${desc}）。为了不暴露真实 IP，不会改用直连。请检查 Clash 是否在运行、端口是否正确。`,
        retrying: true,
      });
    } else {
      setProblem(acc.id, { kind: 'network', title: 'WhatsApp 页面打不开', short: '连不上', text: `页面加载失败（${desc}），可能是网络不通。`, retrying: true });
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
    rebuilding.add(acc.id);
    setTimeout(async () => {
      try {
        // 这 1 秒里账号被删了，或视图已经被别处重建（比如保存了设置），就不再动它
        if (!accounts.includes(acc) || views.get(acc.id) !== view) return;
        destroyView(acc.id);
        await createView(acc);
        refresh();
      } finally {
        rebuilding.delete(acc.id);
      }
    }, 1000);
  });

  if (applied.error) {
    setProblem(acc.id, {
      kind: 'config',
      title: '代理设置有误，这个账号已暂停联网',
      short: '代理设置有误',
      text: `${applied.error}。为避免暴露真实 IP，这个账号暂时不联网，请修改代理。`,
      config: true,
    });
    return view;
  }
  await fingerprint.attach(wc, acc.fingerprint);
  if (loadDelay) {
    pendingLoad.add(acc.id);
    setTimeout(() => {
      if (views.get(acc.id) === view) pendingLoad.delete(acc.id);
      if (!wc.isDestroyed()) wc.loadURL(WA_URL).catch(() => {});
    }, loadDelay);
  } else {
    wc.loadURL(WA_URL).catch(() => {}); // 失败由 did-fail-load 处理
  }
  return view;
}

function destroyView(id) {
  clearRetry(id);
  pendingLoad.delete(id);
  const view = views.get(id);
  if (!view) return;
  win.contentView.removeChildView(view);
  if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach();
  view.webContents.close();
  views.delete(id);
}

// ---------- 轻量模式 ----------

// 每个轻量账号一把随机数据密钥，用系统钥匙串加密后存在 accounts.json 里
function newLiteKey() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('这台电脑不支持加密保存，不能使用轻量模式');
  return safeStorage.encryptString(crypto.randomBytes(32).toString('hex')).toString('base64');
}

function liteKeyOf(acc) {
  const hex = safeStorage.decryptString(Buffer.from(acc.liteKey, 'base64'));
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('密钥格式不对');
  return hex;
}

const LITE_SCHEMES = ['socks5', 'http', 'https'];

// 后台进程用的代理地址：socks5 一律用 socks5h（域名交给代理解析）；http 代理带上解密后的密码
function liteProxyUrl(acc) {
  const p = proxy.parse(acc.proxy);
  if (!p || p.error || !LITE_SCHEMES.includes(p.scheme)) return null;
  if (p.scheme === 'socks5') return `socks5h://${p.host}:${p.port}`;
  const pass = proxy.decryptPassword(acc.proxyPassword) || p.password;
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(pass)}@` : '';
  return `${p.scheme}://${auth}${p.host}:${p.port}`;
}

function startLite(acc) {
  const url = liteProxyUrl(acc);
  if (!url) {
    setProblem(acc.id, {
      kind: 'config',
      title: '轻量模式必须设置代理，这个账号已暂停联网',
      short: '代理设置有误',
      text: '轻量模式只能通过 socks5 或 http 代理联网，不会直连。请在编辑里填写代理并测试。',
      config: true,
    });
    return;
  }
  let key;
  try { key = liteKeyOf(acc); } catch {
    setProblem(acc.id, {
      kind: 'authError',
      title: '读不出这个号的本机数据',
      short: '数据读不出',
      text: '这个号的加密密钥解不开，可能换了系统用户，或系统钥匙串被重置。只能删除这个号后重新添加、重新扫码。',
    });
    return;
  }
  liteStates.set(acc.id, { status: 'connecting', qr: null });
  liteHost.start(acc.id, { proxy: url, key, os: process.platform });
}

function startAccount(acc, loadDelay = 0) {
  if (isLite(acc)) { startLite(acc); return Promise.resolve(); }
  return createView(acc, loadDelay);
}

// 主进程看到的轻量模式状态 → 侧栏和卡片里的提示
const LITE_PROBLEMS = {
  proxyDown: (acc) => ({
    title: '代理连不上，这个账号已暂停联网',
    short: '代理连不上',
    text: `${acc.name} 设置的线路 ${acc.proxy} 没有响应。轻量模式不会改用直连。请检查 Clash 是否在运行、端口是否正确。`,
    retrying: true,
  }),
  loggedOut: () => ({
    title: '这个号已退出登录',
    short: '已退出登录',
    text: '手机上移除了这台设备，或者登录已经失效。点“重新连接”会显示新的二维码，用手机重新扫码即可。',
  }),
  banned: () => ({
    title: 'WhatsApp 拒绝了这个号的连接',
    short: '被拒绝连接',
    text: '这个号可能被封了或被限制了，已停止自动重连。请先在手机上打开 WhatsApp 看看情况。',
  }),
  replaced: () => ({
    title: '这个号的轻量模式在别处连上了',
    short: '在别处连上',
    text: '同一份登录数据在别的地方连接了 WhatsApp，这里已断开，不再自动重连。确认没有别处在用后，点“重新连接”。',
  }),
  outdated: () => ({
    title: 'WhatsApp 拒绝了旧版本',
    short: '需要更新',
    text: 'WhatsApp 拒绝了当前的协议版本，已停止自动重连。请更新 WAswitch：到 设置 › 关于 检查更新，或到 Releases 页面下载新版。',
  }),
  authError: () => ({
    title: '这个号的本机数据读不出来',
    short: '数据读不出',
    text: '登录数据可能损坏了。为了安全没有自动清除。可以删除这个号后重新添加。',
  }),
  stuck: () => ({
    title: '连接反复失败，已停止重连',
    short: '连接失败',
    text: 'WhatsApp 连续几次用同样的原因断开（可能是登录数据失效）。点“重新连接”再试一次；如果还是不行，删除这个号后重新添加、重新扫码。',
  }),
  crashLoop: () => ({
    title: '轻量模式后台进程反复出错，已停止自动恢复',
    short: '后台出错',
    text: '10 分钟内出错超过 3 次。点“重新连接”再试一次；如果还是不行，请在设置 › 关于里打开日志文件夹，把最近的日志发给我们。',
  }),
  crashed: () => ({
    title: '轻量模式后台进程意外退出',
    short: '后台出错',
    text: '正在自动恢复。如果反复出现，请在设置 › 关于里打开日志文件夹，把最近的日志发给我们。',
    retrying: true,
  }),
};

// 用户正在看这个号的这个对话（窗口在前台）
function userIsReading(id, jid) {
  return !!win && id === activeId && page === 'account' && win.isVisible() && win.isFocused() && liteOpen.get(id) === jid && !problems.has(id);
}

function bindLiteEvents() {
  liteHost.on('state', ({ id, status, qr }) => {
    const acc = findAcc(id);
    if (!acc || !isLite(acc)) return;
    const prev = liteStates.get(id)?.status;
    liteStates.set(id, { status, qr: status === 'qr' ? qr : null });
    if (status === 'open') { loginStates.set(id, 'logged_in'); noteLoggedIn(id, 'logged_in'); }
    if (['qr', 'qrExpired', 'loggedOut'].includes(status)) loginStates.set(id, 'needs_qr');
    if (['qr', 'qrExpired', 'loggedOut'].includes(status)) mcp?.controller.gate.clearAccount(id);
    const make = LITE_PROBLEMS[status];
    if (make) problems.set(id, { kind: status, ...make(acc) });
    else if (status === 'open' || status === 'qr') problems.delete(id);
    // 掉线、被封：不管有没有关通知都提醒
    if (prev !== status && status === 'loggedOut') notifier.notify(acc, '已退出登录，需要重新扫码。点这里打开这个号。');
    if (prev !== status && status === 'banned') notifier.notify(acc, 'WhatsApp 拒绝了这个号的连接，可能被封了。');
    if (prev !== status && status === 'stuck') notifier.notify(acc, '连接反复出错，已停止重连。点这里打开这个号重试。');
    refresh();
  });
  liteHost.on('unread', ({ id, count }) => {
    const acc = findAcc(id);
    if (!acc) return;
    notifier.update(acc, count, { isActive: id === activeId && page === 'account' });
    pushState();
  });
  liteHost.on('view', (v) => {
    if (!findAcc(v.id)) return;
    liteViews.set(v.id, v);
    pushState();
  });
  liteHost.on('incoming', ({ id, jid }) => {
    notifier.lastNewAt = Date.now(); // 自动装更新要看 10 分钟内有没有新消息
    if (userIsReading(id, jid)) liteHost.read(id, jid);
  });
  liteHost.on('guard', () => { liteGuardHits += 1; });
}

// 告诉后台进程现在在看哪个轻量账号、哪个对话（只有它会推送对话列表）
function syncLiteWatch() {
  if (!liteHost) return;
  const acc = accounts.find((a) => a.id === activeId);
  const id = page === 'account' && isLite(acc) ? acc.id : null;
  liteHost.setWatch(id, id ? liteOpen.get(id) || null : null);
}

function liteStateForShell() {
  const acc = accounts.find((a) => a.id === activeId);
  if (!isLite(acc)) return null;
  const st = liteStates.get(acc.id) || {};
  const view = liteViews.get(acc.id);
  return {
    id: acc.id,
    status: st.status || 'connecting',
    qr: st.qr || null,
    openJid: liteOpen.get(acc.id) || null,
    view: view ? { rev: view.rev, chats: view.chats, jid: view.jid, title: view.title, messages: view.messages } : null,
  };
}

// focus：用户自己切的号（点侧栏、Ctrl+数字、托盘或通知）才把键盘焦点交给新账号，切完就能直接打字。
// MCP 引起的切换不给焦点，免得用户打的字落到别的号里。
function activate(id, { focus = false } = {}) {
  activeId = id;
  // 记住在看哪个号，下次启动直接打开它
  if (id && settings.lastAccountId !== id) { settings.lastAccountId = id; memory.saveSettings(settings); }
  if (!accounts.length) page = 'welcome';
  refresh();
  if (focus) focusActive();
}

function focusActive() {
  const acc = findAcc(activeId);
  const view = views.get(activeId);
  // 锁着时只把焦点给界面（锁屏卡片），绝不给藏起来的账号页面
  if (!locked && page === 'account' && acc && !isLite(acc) && view && !problems.has(acc.id) && !view.webContents.isDestroyed()) view.webContents.focus();
  else if (shellView && !shellView.webContents.isDestroyed()) shellView.webContents.focus();
}

// ---------- MCP 的切换请求 ----------

// 窗口在前台、30 秒内按过键，或者正在编辑账号（可能有没保存的修改），都算用户正在用
function userBusy() {
  if (!win || !win.isVisible() || win.isMinimized()) return false;
  if (page === 'editor') return true;
  return win.isFocused() && Date.now() - lastTypedAt < TYPING_MS;
}

// 横幅 30 秒没人点就自动消失，算忽略。MCP 工具不等用户回答，立刻返回“已询问”
const AI_ASK_MS = 30 * 1000;
let aiTimer = null;
function setAiRequest(req) {
  clearTimeout(aiTimer);
  aiRequest = req;
  if (req) aiTimer = setTimeout(() => { aiRequest = null; refresh(); }, AI_ASK_MS);
  refresh();
}

function aiAsk(req) {
  if (req.kind === 'switch' && !findAcc(req.id)) return 'done';
  if (userBusy()) {
    setAiRequest(req);
    return 'pending';
  }
  runAiRequest(req, false);
  // 窗口在托盘里：添加页已经开好，但用户看不见，告诉 AI 让用户打开窗口
  return req.kind === 'add' && win && (!win.isVisible() || win.isMinimized()) ? 'hidden' : 'done';
}

// byUser：用户在横幅里点了“切换”，可以把窗口拿到前台并给焦点。
// MCP 直接切的时候窗口保持原样：在后台就留在后台，不 show、不抢焦点
function runAiRequest(req, byUser) {
  if (byUser) notifier.showWindow();
  if (req.kind === 'switch') {
    if (!findAcc(req.id)) return;
    if (byUser) { userActivate(req.id); return; }
    page = 'account';
    activate(req.id, { focus: false });
  } else {
    openEditor(null, { name: req.name, region: req.region });
  }
}

function aiRequestForShell() {
  if (!aiRequest) return null;
  if (aiRequest.kind === 'add') return { kind: 'add', name: aiRequest.name || '' };
  const acc = findAcc(aiRequest.id);
  return acc ? { kind: 'switch', name: acc.name } : null;
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
  editorDirty = false;
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
      detail: `${isLite(acc)
        ? '会让手机“已关联的设备”里的这台设备退出（已连上时），并清除这个号在本机的全部数据（登录状态、聊天缓存、代理设置）。手机上的聊天记录不受影响。'
        : '注意：这不会让手机退出。删除后请在手机 WhatsApp › 设置 › 已关联的设备 里手动退出这台电脑。\n\n会清除这个号在本机的全部数据（登录状态、聊天缓存、代理设置），之后要重新扫码才能登录。手机上的聊天记录不受影响。'}${timeoutMs ? '\n\n这个请求来自 MCP 客户端（AI 助手）。' : ''}`,
    }));
  } finally {
    clearTimeout(timer);
    confirmDialogOpen = false;
  }
  if (response !== 1 || abort.signal.aborted) return 'cancelled';
  const lite = isLite(acc);
  if (lite) await liteHost.logout(id); else destroyView(id);
  problems.delete(id);
  exitIps.delete(id);
  exitChanges.delete(id);
  loginStates.delete(id);
  liteStates.delete(id);
  liteViews.delete(id);
  liteOpen.delete(id);
  mcp?.controller.gate.clearAccount(id);
  notifier.forget(id);
  memoryManager.forget(id);
  if (!lite) await session.fromPartition(`persist:wa-${id}`).clearStorageData();
  const wasPrimary = acc.primary;
  accounts = accounts.filter((a) => a.id !== id);
  // 删掉主号后，第一个网页版账号自动成为主号
  const newPrimary = wasPrimary ? accounts.find((a) => a.mode === 'web') : null;
  if (newPrimary) newPrimary.primary = true;
  saveAccounts();
  // 主号换了：轻量小号只在保存时和主号比过出口，提醒跑一次隔离自检（和在编辑里换主号一样）
  if (newPrimary && accounts.some(isLite)) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: '请跑一次隔离自检',
      message: `主号已改为「${newPrimary.name}」`,
      detail: '轻量小号只在保存时和主号比较过出口 IP。请到 设置 › 隔离自检 跑一次，确认小号和新主号不在同一个 IP。',
    }).catch(() => {});
  }
  // 删掉磁盘上的数据文件夹；文件还被占用时删不掉，下次启动会再清理
  const dir = lite ? liteDir(id) : partitionDir(id);
  if (dir) fs.rm(dir, { recursive: true, force: true }, (e) => { if (e) console.warn(`暂时删不掉账号 ${id} 的数据，下次启动再清理`); });
  if (page === 'editor' && editorId === id) page = 'account';
  if (aiRequest && aiRequest.id === id) setAiRequest(null);
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
  } else if (key === 'lockMinutes') {
    if (!memory.LOCK_CHOICES.includes(value)) return;
  } else {
    return;
  }
  settings[key] = value;
  if (key === 'recycleMB' && value > 0) settings.recycleLastMB = value; // 关掉再打开时沿用
  memory.saveSettings(settings);
  if (key === 'openAtLogin') applyLoginItem();
  notifier.refresh();
  refresh();
}

// 重启 WAswitch：走正常退出流程（轻量模式后台先写盘），再重新打开
function relaunchApp() {
  app.relaunch();
  quitting = true;
  app.quit();
}

// 托盘里切换了省内存模式：问一下要不要现在重启
async function askRestart() {
  if (settings.lowMemoryMode === startupLowMemory) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['稍后', '现在重启'],
    defaultId: 1,
    cancelId: 0,
    message: '省内存模式要重启 WAswitch 才生效',
    detail: '重启大约需要十几秒，账号不用重新登录。',
  });
  if (response === 1) relaunchApp();
}

// ---------- 编辑页没保存就离开 ----------

let editorDirty = false; // 编辑页有没有改过（界面告诉主进程）

// 用户要离开编辑页时：有改动先问一句。返回 true 表示可以离开
async function confirmLeaveEditor() {
  if (page !== 'editor' || !editorDirty) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['继续编辑', '放弃修改'],
    defaultId: 0,
    cancelId: 0,
    message: '放弃还没保存的修改？',
    detail: '编辑账号页里的修改还没有保存。',
  });
  if (response !== 1) return false;
  editorDirty = false;
  return true;
}

// 用户自己切号（侧栏、Ctrl+数字、托盘、通知）：编辑页有改动先问，再切过去并给焦点
async function userActivate(id) {
  if (!findAcc(id) || !(await confirmLeaveEditor())) return;
  page = 'account';
  activate(id, { focus: true });
}

// ---------- 快捷键和菜单 ----------

// Ctrl/Cmd + 1–9 切换账号。只在 WAswitch 窗口有焦点时生效，不抢其他软件的快捷键。
app.on('web-contents-created', (_e, wc) => {
  wc.on('before-input-event', (event, input) => {
    // 只管主窗口（软件界面和各账号页面）；MCP 设置窗口里按 Ctrl+数字不切号
    const inMain = (shellView && wc === shellView.webContents) || [...views.values()].some((v) => v.webContents === wc);
    if (!inMain) return;
    if (input.type === 'keyDown') lastTypedAt = Date.now();
    if (input.type !== 'keyDown' || input.alt || input.shift) return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    // Ctrl+L（Mac 是 Cmd+L）：立即锁定聊天
    if (mod && input.key.toLowerCase() === 'l') {
      event.preventDefault();
      setLocked(true);
      return;
    }
    if (!mod || !/^[1-9]$/.test(input.key)) return;
    const acc = displayOrder()[Number(input.key) - 1];
    if (!acc) return;
    event.preventDefault();
    userActivate(acc.id);
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

// ---------- 自动更新 ----------

// 在托盘里自动装更新时留个记号，装完重启后直接回到托盘（15 分钟内有效）
const updateMarker = () => path.join(app.getPath('userData'), 'update-relaunch-hidden');
function takeUpdateMarker() {
  try {
    const at = Number(fs.readFileSync(updateMarker(), 'utf8'));
    fs.rmSync(updateMarker(), { force: true });
    return Date.now() - at < 15 * 60 * 1000;
  } catch { return false; }
}

const QUIET_MS = 10 * 60 * 1000; // 10 分钟内有新消息就不自动装
const rebuilding = new Set(); // 页面进程崩溃后正在重建的账号
const webLoadedAt = new Map(); // 网页版账号最近一次页面加载完的时间
let updater = null;

// 现在能不能自动装更新；不能时返回原因（只记日志用）
function updateIdleReason() {
  if (!win || (win.isVisible() && !win.isMinimized())) return '窗口开着';
  if (win.isVisible()) return '窗口最小化但没缩到托盘';
  if (notifier.total() > 0) return '有未读';
  if (Date.now() - notifier.lastNewAt < QUIET_MS) return '10 分钟内有新消息';
  if (accounts.some((a) => isLite(a) && ['connecting', 'qr'].includes(liteStates.get(a.id)?.status || 'connecting'))) return '有轻量账号在登录或扫码';
  if (pendingLoad.size || [...views.values()].some((v) => !v.webContents.isDestroyed() && v.webContents.isLoading())) return '有页面在加载';
  // 网页版停在二维码页、且 10 分钟内刚加载过：可能有人正要扫码。长期掉线的号不挡更新
  if (accounts.some((a) => !isLite(a) && loginStates.get(a.id) === 'needs_qr' && Date.now() - (webLoadedAt.get(a.id) || 0) < QUIET_MS)) return '有网页版账号在等扫码';
  if (rebuilding.size) return '有页面在重建';
  if (liteHost && liteHost.busy()) return '有消息在发';
  if (clearingCache || confirmDialogOpen) return '正在操作';
  return null;
}

function setupUpdater() {
  updater = new Updater({
    onChange: () => { notifier.refresh(); pushState(); },
    idleReason: updateIdleReason,
    beforeInstall: async () => {
      if (!win || !win.isVisible()) fs.writeFileSync(updateMarker(), String(Date.now()));
      quitting = true;
      // 和正常退出一样，先让轻量模式后台进程把凭据和聊天缓存写盘
      if (liteHost && liteHost.running() && !liteFlushed) {
        await liteHost.shutdown().catch(() => {});
        liteFlushed = true;
      }
    },
    // 没装成：取消退出状态、删掉回托盘记号、重新连上轻量账号，软件继续正常收消息
    installFailed: async () => {
      quitting = false;
      liteFlushed = false;
      fs.rmSync(updateMarker(), { force: true });
      if (liteHost) {
        liteHost.resume();
        for (const acc of accounts.filter(isLite)) startLite(acc);
      }
      refresh();
    },
    notify: (title, body, onClick) => notifier.notifyApp(title, body, onClick),
  });
  updater.start();
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
  // 回到窗口时，如果正开着某个轻量账号的对话，把它标成已读
  win.on('blur', () => { unfocusedSince = Date.now(); });
  win.on('focus', () => {
    // 锁着时切回窗口：焦点放回锁屏卡片，也不把轻量号的消息标成已读
    if (locked) { if (shellView && !shellView.webContents.isDestroyed()) shellView.webContents.focus(); return; }
    const jid = liteOpen.get(activeId);
    if (jid && page === 'account' && isLite(findAcc(activeId))) liteHost.read(activeId, jid);
  });
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

  liteHost = new LiteHost({ dataDir: app.getPath('userData') });
  bindLiteEvents();
  groups = loadGroups();
  accounts = loadAccounts();
  if (accountsFileOk) saveAccounts();
  cleanupPartitions();
  applyLoginItem();
  activeId = (findAcc(settings.lastAccountId) || accounts[0])?.id ?? null;
  page = accounts.length ? 'account' : 'welcome';
  refresh();
  if (!shouldStartHidden()) win.show();

  // 电脑睡眠醒来后，网络和 Clash 需要几秒恢复，之后重连所有连不上的账号
  setInterval(checkIdleLock, LOCK_POLL_MS);
  // 系统锁屏时直接锁上，回来解开系统锁屏后还要右滑一次
  powerMonitor.on('lock-screen', () => { if (settings.lockMinutes) setLocked(true); });
  powerMonitor.on('suspend', () => { if (settings.lockMinutes) setLocked(true); });
  powerMonitor.on('resume', () => {
    setTimeout(() => {
      for (const [id, p] of problems) if (!p.config) { clearRetry(id); reconnect(id); }
      // 轻量账号：代理断开、正在重连或停止重连的，马上重试一次
      for (const acc of accounts.filter(isLite)) {
        if (['proxyDown', 'reconnecting', 'crashed', 'stuck', 'qrExpired'].includes(liteStates.get(acc.id)?.status)) startLite(acc);
      }
    }, 5000);
  });

  // 分批启动：先打开当前账号，其他账号每隔 2.5 秒打开一个，避免同时加载卡顿
  const order = [...accounts].sort((a, b) => (b.id === activeId) - (a.id === activeId)); // 正在看的号先开
  for (const [i, acc] of order.entries()) {
    await startAccount(acc, i * 2500);
    refresh();
  }
  memoryManager.start();
  setInterval(checkLogins, LOGIN_CHECK_MS);
  setTimeout(checkLogins, 60 * 1000);
  setInterval(watchExits, EXIT_WATCH_MS);
  setTimeout(watchExits, 3 * 60 * 1000);

  mcp = setupMcp({ hooks: mcpHooks, lockLocalPage });
  await mcp.init();
  setupUpdater();
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

onShell('switch', (id) => userActivate(id));
onShell('editor:dirty', (dirty) => { if (page === 'editor') editorDirty = dirty === true; });
onShell('remove', (id) => { if (findAcc(id)) removeAccount(id); });
onShell('app:restart', () => relaunchApp());
// 用户在顶部横幅里回答 AI 的切换请求
onShell('ai:answer', (yes) => {
  const req = aiRequest;
  setAiRequest(null);
  if (yes === true && req) runAiRequest(req, true);
});
onShell('add', async () => { if (await confirmLeaveEditor()) openEditor(null); });
onShell('edit', async (id) => { if (findAcc(id) && await confirmLeaveEditor()) openEditor(id); });
// 编辑页的“取消”是明确放弃，不再问（discard 为 true）
onShell('page', async (p, discard) => {
  if (!['account', 'settings'].includes(p)) return;
  if (discard !== true && !(await confirmLeaveEditor())) return;
  editorDirty = false;
  showPage(p);
});
onShell('collapse', () => setSetting('sidebarCollapsed', !settings.sidebarCollapsed));
onShell('lock', (on) => setLocked(on === true));
onShell('setting', ({ key, value } = {}) => setSetting(key, value));
onShell('reload', (id) => {
  if (!findAcc(id)) return;
  if (problems.has(id) || isLite(findAcc(id))) retryNow(id);
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

// 轻量模式聊天页
onShell('lite:open', ({ id, jid } = {}) => {
  const acc = findAcc(id);
  if (!isLite(acc) || typeof jid !== 'string' || !jid || jid.length > 200) return;
  liteOpen.set(id, jid);
  syncLiteWatch();
  liteHost.read(id, jid); // 用户点开了这个对话，发已读回执
  pushState();
});
handleShell('lite:send', async ({ id, jid, text } = {}) => {
  const acc = findAcc(id);
  if (!isLite(acc) || typeof jid !== 'string' || typeof text !== 'string') return { error: '参数不对' };
  try {
    await liteHost.sendText(id, jid, text);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});
// ---------- 一键清理缓存 ----------
// 只清网页版账号可以重新下载的缓存（见 cache.js），不清登录状态和本地聊天记录。
// 分区只从账号列表里枚举，不接受外部传入；不开放给 MCP。轻量模式账号没有网页缓存，不动。

const webSessions = () => accounts.filter((a) => a.mode === 'web').map((acc) => ({ acc, ses: session.fromPartition(`persist:wa-${acc.id}`) }));

async function cacheBytes() {
  let n = await session.defaultSession.getCacheSize();
  for (const { ses } of webSessions()) n += await ses.getCacheSize();
  return n;
}

let clearingCache = false;
handleShell('cache:size', async () => ({ bytes: await cacheBytes() }));
handleShell('cache:clear', async () => {
  if (clearingCache) return { error: '正在清理，请稍等' };
  clearingCache = true;
  try {
    const before = await cacheBytes();
    const later = [];
    for (const { acc, ses } of webSessions()) {
      const view = views.get(acc.id);
      // 正在加载的账号等加载完再清；出错的账号跳过
      if (problems.has(acc.id) || (view && view.webContents.isLoading())) { later.push({ acc, ses }); continue; }
      await clearSessionCache(ses);
    }
    let skipped = 0;
    for (const { acc, ses } of later) {
      const view = views.get(acc.id);
      const end = Date.now() + 15000;
      while (view && !view.webContents.isDestroyed() && view.webContents.isLoading() && Date.now() < end) {
        await new Promise((resolve) => { setTimeout(resolve, 500); });
      }
      if (problems.has(acc.id) || (view && !view.webContents.isDestroyed() && view.webContents.isLoading())) { skipped += 1; continue; }
      await clearSessionCache(ses);
    }
    await session.defaultSession.clearCache(); // 软件界面自己的
    const after = await cacheBytes();
    console.log(`清理缓存：${before} → ${after} 字节，跳过 ${skipped} 个账号`);
    return { ok: true, freedMB: Math.max(0, Math.round((before - after) / 1048576)), afterMB: Math.round(after / 1048576), skipped };
  } finally {
    clearingCache = false;
  }
});

// 聊天里的链接：只放行 http、https、mailto、tel，用系统程序打开
onShell('open-link', (url) => { if (isSafeLink(url)) shell.openExternal(url); });
onShell('open-source', () => shell.openExternal(SOURCE_URL));

// 右键账号或点顶栏“⋯”：编辑 / 刷新 / 通知 / 删除
onShell('context', (id) => {
  const acc = findAcc(id);
  if (!acc) return;
  Menu.buildFromTemplate([
    { label: '编辑名称、颜色和代理…', click: () => openEditor(id) },
    { label: isLite(acc) ? '重新连接' : '刷新', click: () => (problems.has(id) || isLite(acc) ? retryNow(id) : views.get(id)?.webContents.reload()) },
    {
      label: '不弹通知', type: 'checkbox', checked: acc.muted,
      click: () => { acc.muted = !acc.muted; saveAccounts(); notifier.refresh(); pushState(); },
    },
    { type: 'separator' },
    // 不用拖也能排：上移、下移、移到分组
    { label: '上移', click: () => stepAccount(id, -1) },
    { label: '下移', click: () => stepAccount(id, 1) },
    {
      label: '移到分组',
      submenu: [
        { label: '未分组', type: 'radio', checked: !groupOf(acc), click: () => moveAccount(id, '', null) },
        ...groups.map((g) => ({ label: g.name, type: 'radio', checked: acc.groupId === g.id, click: () => moveAccount(id, g.id, null) })),
        { type: 'separator' },
        { label: '新建分组…', enabled: groups.length < GROUP_MAX, click: () => createGroup(id) },
      ],
    },
    { type: 'separator' },
    { label: isLite(acc) ? `删除「${acc.name}」并退出登录…` : `删除「${acc.name}」…`, click: () => removeAccount(id) },
  ]).popup({ window: win });
});

// ---------- 分组 ----------
// 分组只影响侧栏怎么摆，不卸载页面、不停收消息。解散分组只是把号放回“未分组”，绝不删号
const findGroup = (gid) => groups.find((g) => g.id === gid);
function setGroup(gid, patch) {
  const g = findGroup(gid);
  if (!g) return;
  Object.assign(g, patch);
  saveGroups();
  notifier.refresh();
  refresh();
}
function deleteGroup(gid) {
  if (!findGroup(gid)) return;
  // 组里的号挪到“未分组”最后，保持原来的先后
  const members = accounts.filter((a) => a.groupId === gid);
  accounts = [...accounts.filter((a) => a.groupId !== gid), ...members.map((a) => Object.assign(a, { groupId: '' }))];
  groups = groups.filter((g) => g.id !== gid);
  if (editGroupId === gid) editGroupId = '';
  saveAccounts();
  saveGroups();
  notifier.refresh();
  refresh();
}
onShell('acc:move', ({ id, groupId, beforeId } = {}) => {
  if (typeof id !== 'string' || typeof (groupId ?? '') !== 'string') return;
  moveAccount(id, groupId || '', typeof beforeId === 'string' ? beforeId : null);
});
onShell('group:create', () => createGroup(null));
onShell('group:rename', ({ id, name } = {}) => {
  if (editGroupId === id) editGroupId = '';
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  if (clean) setGroup(id, { name: clean });
  else refresh();
});
onShell('group:toggle', (id) => { const g = findGroup(id); if (g) setGroup(id, { collapsed: !g.collapsed }); });
onShell('group:context', (id) => {
  const g = findGroup(id);
  if (!g) return;
  Menu.buildFromTemplate([
    { label: '改名', click: () => { editGroupId = id; refresh(); } },
    { label: g.collapsed ? '展开' : '折叠', click: () => setGroup(id, { collapsed: !g.collapsed }) },
    {
      label: '整组不弹通知', type: 'checkbox', checked: g.muted,
      // 整组静音不改组里每个号自己的设置；取消后各号恢复原来的设置
      click: () => setGroup(id, { muted: !g.muted }),
    },
    { type: 'separator' },
    { label: `解散「${g.name}」（号不会删）`, click: () => deleteGroup(id) },
  ]).popup({ window: win });
});

// ---------- 编辑账号（新建和修改共用） ----------

handleShell('editor:load', (id) => {
  const acc = findAcc(id);
  return {
    id: acc ? acc.id : null,
    isNew: !acc,
    name: acc ? acc.name : String(editorPrefill?.name || nextName()).slice(0, 40),
    note: acc ? acc.note : '',
    color: acc ? acc.color : editorColor || nextColor(),
    proxy: acc ? acc.proxy : '',
    hasPassword: !!(acc && acc.proxyPassword),
    region: acc ? acc.fingerprint.region : (fingerprint.regions[editorPrefill?.region] ? editorPrefill.region : 'auto'),
    regions: Object.entries(fingerprint.regions).map(([key, v]) => ({ key, label: v.label })),
    regionLabel: acc ? regionLabel(acc.fingerprint.region) : '',
    uiLanguage: fingerprint.UI_LANGUAGE_LABEL,
    mode: acc ? acc.mode : 'web',
    allowCalls: !!(acc && acc.allowCalls),
    // 新账号：还没有主号时默认就是主号
    primary: acc ? acc.primary : !accounts.some((a) => a.primary),
    primaryName: accounts.find((a) => a.primary && a.id !== id)?.name || '',
    liteAvailable: safeStorage.isEncryptionAvailable(),
    platform: process.platform,
  };
});

// 主号的出口 IP（轻量小号不能和主号用同一个 IP）。主号没设代理时查本机直连的出口。
async function primaryExit(exceptId) {
  const primary = accounts.find((a) => a.primary && a.id !== exceptId);
  if (!primary) return { ip: null };
  if (primary.proxy && exitIps.has(primary.id)) return { ip: exitIps.get(primary.id), name: primary.name };
  const res = primary.proxy ? await proxy.test(primary.proxy, proxy.decryptPassword(primary.proxyPassword)) : await proxy.testDirect();
  if (!res.ok) return { error: `查不到主号「${primary.name}」的出口 IP（${res.error}），没法确认这个号和主号不在同一个 IP，暂时不能保存。请确认主号的网络正常后再试。` };
  if (primary.proxy) recordExit(primary, res.ip);
  return { ip: res.ip, name: primary.name };
}

// 测试代理：返回出口 IP、所在地、时区，给出匹配的地区，并提示和别的账号出口相同
handleShell('editor:test', async ({ id, proxy: proxyText, password } = {}) => {
  const acc = findAcc(id);
  const pass = String(password || '') || (acc ? proxy.decryptPassword(acc.proxyPassword) : '');
  const res = await proxy.test(String(proxyText || ''), pass);
  if (!res.ok) return res;
  res.region = regionForTimezone(res.timezone);
  if (res.region) res.regionLabel = regionLabel(res.region);
  res.country = regionName(res.country);
  const same = accounts.find((a) => a.id !== id && exitIps.get(a.id) === res.ip);
  const before = same ? null : accounts.find((a) => a.id !== id && a.lastExit && a.lastExit.ip === res.ip);
  if (same) res.sameAs = same.name;
  else if (before) { res.sameAs = before.name; res.sameAt = before.lastExit.at; }
  lastTest = { proxy: proxy.parse(proxyText)?.rules, ip: res.ip, label: res.country, region: res.region };
  return res;
});

handleShell('editor:save', async ({ id, name, note, color, proxy: proxyText, password, region, mode, primary, liteConfirm, allowCalls } = {}) => {
  name = String(name || '').trim().slice(0, 40);
  note = cleanNote(note);
  if (!name) return { error: '请填写名称' };
  if (!COLORS.includes(color)) color = nextColor();
  const parsed = proxy.parse(String(proxyText || ''));
  if (parsed && parsed.error) return { error: parsed.error };
  if (!isValidRegion(region)) region = 'auto';
  const proxyStored = parsed ? parsed.display : '';
  // 允许通话只对网页版直连号有意义
  const callsWanted = allowCalls === true && !parsed && mode !== 'lite';
  let acc = findAcc(id);
  // 模式只在添加时选，之后不能改（换模式等于换一台关联设备）
  mode = acc ? acc.mode : (mode === 'lite' ? 'lite' : 'web');
  // 主号只能在别的账号里勾选来更换，不能直接取消
  const wantPrimary = mode === 'web' && (primary === true || !!(acc && acc.primary) || !accounts.some((a) => a.primary && a.id !== id));
  const testedNow = lastTest && parsed && lastTest.proxy === parsed.rules ? lastTest : null;
  if (mode === 'lite') {
    if (primary === true) return { error: '主号只能用网页版，不能用轻量模式' };
    if (!acc && liteConfirm !== true) return { error: '请先勾选下面的风险确认' };
    if (!parsed) return { error: '轻量模式必须设置代理，不能直连' };
    if (!LITE_SCHEMES.includes(parsed.scheme)) return { error: '轻量模式只支持 socks5 和 http 代理' };
    const proxyChanged = !acc || acc.proxy !== proxyStored || !!String(password || '');
    if (proxyChanged) {
      if (!testedNow) return { error: '请先点“测试”，代理测试通过后才能保存' };
      const pe = await primaryExit(id);
      if (pe.error) return { error: pe.error };
      if (pe.ip && pe.ip === testedNow.ip) return { error: `这个代理的出口 IP（${testedNow.ip}）和主号「${pe.name}」相同。轻量小号必须和主号用不同的 IP，请换一个代理端口或节点。` };
    }
  }

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
  let tested = lastTest && parsed && lastTest.proxy === parsed.rules ? lastTest : null;
  // 网页版选了“跟随本机”又设了代理：没测过就先测一次，按出口所在地填好时区。
  // 测不通也照样保存；用户自己选了地区的不改
  if (mode === 'web' && parsed && region === 'auto') {
    if (!tested) {
      const res = await proxy.test(String(proxyText || ''), String(password || '') || (parsed.password) || (acc ? proxy.decryptPassword(acc.proxyPassword) : ''));
      if (res.ok) tested = { proxy: parsed.rules, ip: res.ip, label: regionName(res.country), region: regionForTimezone(res.timezone) };
    }
    if (tested && tested.region) region = tested.region;
  }

  let liteKey = '';
  if (mode === 'lite' && !acc) {
    try { liteKey = newLiteKey(); } catch (e) { return { error: e.message }; }
  }
  // 换了主号、或主号换了代理：轻量小号只在保存时和主号比过出口，提醒跑一次隔离自检
  const oldPrimary = accounts.find((a) => a.primary);
  const primaryMoved = wantPrimary && oldPrimary && oldPrimary.id !== id;
  const primaryProxyChanged = wantPrimary && acc && acc.primary && acc.proxy !== proxyStored;
  const remindCheck = (primaryMoved || primaryProxyChanged) && accounts.some(isLite);
  if (wantPrimary) for (const a of accounts) if (a.id !== id) a.primary = false;

  if (!acc) {
    acc = { id: String(Date.now()), name, note, color, proxy: proxyStored, proxyPassword: encPassword, exitLabel: tested ? tested.label : '', fingerprint: fingerprint.generate(region), muted: false, mode, primary: wantPrimary, liteKey, loggedIn: false, allowCalls: callsWanted };
    accounts.push(acc);
    if (tested) recordExit(acc, tested.ip);
    saveAccounts();
    page = 'account';
    activeId = acc.id;
    await startAccount(acc);
    refresh();
  } else if (isLite(acc)) {
    const changed = acc.proxy !== proxyStored || acc.proxyPassword !== encPassword;
    if (acc.proxy !== proxyStored) { acc.exitLabel = ''; acc.lastExit = null; exitIps.delete(acc.id); exitChanges.delete(acc.id); }
    if (tested) { acc.exitLabel = tested.label; recordExit(acc, tested.ip); }
    acc.name = name;
    acc.note = note;
    acc.color = color;
    acc.proxy = proxyStored;
    acc.proxyPassword = encPassword;
    saveAccounts();
    page = 'account';
    activeId = acc.id;
    if (changed) { problems.delete(acc.id); startLite(acc); }
    refresh();
  } else {
    acc.primary = wantPrimary;
    const changed = acc.proxy !== proxyStored || acc.proxyPassword !== encPassword || acc.fingerprint.region !== region || acc.allowCalls !== callsWanted;
    acc.allowCalls = callsWanted;
    if (acc.proxy !== proxyStored) { acc.exitLabel = ''; acc.lastExit = null; exitIps.delete(acc.id); exitChanges.delete(acc.id); }
    if (tested) { acc.exitLabel = tested.label; recordExit(acc, tested.ip); }
    acc.name = name;
    acc.note = note;
    acc.color = color;
    acc.proxy = proxyStored;
    acc.proxyPassword = encPassword;
    // 只改地区（时区），浏览器标识保持不变
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
  // 第二个直连号：提醒，不拦。几个直连号在 WhatsApp 看来是同一个 IP、同一个地方
  const otherDirect = !parsed && accounts.filter((a) => a.id !== acc.id && !a.proxy).map((a) => `「${a.name}」`);
  if (otherDirect && otherDirect.length) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: '这个号和别的号共用本机真实 IP',
      message: `「${name}」和${otherDirect.join('、')}都是直连`,
      detail: '直连的号都用这台电脑的真实 IP 上网，在 WhatsApp 看来它们在同一个地方，容易被关联。建议在 Clash 里给每个号开一个端口，在编辑里填上代理。',
    }).catch(() => {});
  }
  if (remindCheck) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: '请跑一次隔离自检',
      message: primaryMoved ? '主号已更换' : '主号的代理已修改',
      detail: '轻量小号只在保存时和主号比较过出口 IP。请到 设置 › 隔离自检 跑一次，确认小号和主号不在同一个 IP。',
    }).catch(() => {});
  }
  return { ok: true };
});

// ---------- 隔离自检 ----------
// 逐个测试每个账号的代理出口，找出走真实 IP 的号、共用出口的号、时区和出口对不上的号。

handleShell('check:run', async () => {
  const items = [];
  const byPort = new Map();
  const byIp = new Map();
  const direct = accounts.filter((a) => !proxy.parse(a.proxy)).map((a) => a.name);
  if (direct.length > 1) items.push({ level: 'bad', title: `${direct.join('、')} 共用本机真实 IP`, detail: '这几个号都是直连，在 WhatsApp 看来在同一个地方。建议每个号在 Clash 里开一个端口，填上代理。' });
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const acc of accounts) {
    const p = proxy.parse(acc.proxy);
    if (!p) { if (direct.length < 2) items.push({ level: 'warn', title: `${acc.name}：直连`, detail: '没有设代理，用的是这台电脑的真实 IP。' }); continue; }
    if (p.error) { items.push({ level: 'bad', title: `${acc.name}：代理设置有误`, detail: p.error }); continue; }
    const key = `${p.host}:${p.port}`;
    byPort.set(key, [...(byPort.get(key) || []), acc.name]);
    if (isLite(acc)) {
      if (!LITE_SCHEMES.includes(p.scheme)) items.push({ level: 'bad', title: `${acc.name}：轻量模式不支持 ${p.scheme} 代理`, detail: '请改用 socks5 或 http 代理。' });
    } else {
      // 会话里的代理规则不能带“直连”兜底
      const rule = await session.fromPartition(`persist:wa-${acc.id}`).resolveProxy(WA_URL);
      if (/DIRECT/i.test(rule)) items.push({ level: 'bad', title: `${acc.name}：代理规则里有直连兜底`, detail: rule });
    }
    const res = await proxy.test(acc.proxy, proxy.decryptPassword(acc.proxyPassword));
    if (!res.ok) { items.push({ level: 'bad', title: `${acc.name}：代理连不上`, detail: res.error }); continue; }
    recordExit(acc, res.ip);
    acc.exitLabel = regionName(res.country);
    byIp.set(res.ip, [...(byIp.get(res.ip) || []), acc.name]);
    const tz = fingerprint.resolve(acc.fingerprint).timezone;
    const place = [acc.exitLabel, res.city].filter(Boolean).join(' · ');
    // 轻量模式没有浏览器环境，不涉及时区
    if (isLite(acc)) { items.push({ level: 'ok', title: `${acc.name}（轻量模式）：出口 ${res.ip}（${place}）`, detail: '域名由代理解析，本机不查 DNS。' }); continue; }
    // 跟随本机时，实际时区就是本机时区
    const effTz = tz || localTz;
    const fixRegion = regionForTimezone(res.timezone);
    const fix = fixRegion ? { id: acc.id, region: fixRegion, label: regionLabel(fixRegion) } : null;
    if (effTz !== res.timezone) {
      items.push({
        level: 'warn',
        title: `${acc.name}：出口 ${res.ip}（${place}）`,
        detail: tz
          ? `出口时区是 ${res.timezone}，账号设置的是 ${tz}。${fix ? '' : '出口时区无法识别，请在编辑里选最接近的。'}`
          : `地区是“跟随本机”（${localTz}），但出口在 ${res.timezone}。在 WhatsApp 看来时区和 IP 对不上。${fix ? '' : '出口时区无法识别，请在编辑里选最接近的。'}`,
        fix,
      });
    } else {
      items.push({ level: 'ok', title: `${acc.name}：出口 ${res.ip}（${place}）`, detail: tz ? `时区 ${tz}，和出口一致。` : `时区跟随本机（${localTz}），和出口一致。` });
    }
  }
  for (const [key, names] of byPort) {
    if (names.length > 1) items.push({ level: 'bad', title: `${names.join('、')} 共用同一个代理端口`, detail: `${key}。这几个号会从同一个 IP 上网，建议每个号一个端口。` });
  }
  for (const [ip, names] of byIp) {
    if (names.length > 1) items.push({ level: 'bad', title: `${names.join('、')} 的出口 IP 相同`, detail: `${ip}。在 WhatsApp 看来这几个号在同一个地方。` });
  }
  if (accounts.some(isLite)) {
    items.push(liteGuardHits
      ? { level: 'bad', title: `轻量模式：网络护栏拦下了 ${liteGuardHits} 次直连`, detail: '这些请求没有发出去，真实 IP 没有暴露。日志里有详细记录，请把日志发给我们排查。' }
      : { level: 'ok', title: '轻量模式：后台进程只连代理，没有出现直连' });
  }
  // WebRTC：走代理的号必须只走代理；直连号按“允许通话”开关分别显示
  const webrtcBad = accounts.filter((a) => !isLite(a) && views.has(a.id) && views.get(a.id).webContents.getWebRTCIPHandlingPolicy() !== webrtcPolicy(a));
  const proxied = accounts.filter((a) => !isLite(a) && a.proxy);
  if (webrtcBad.length) items.push({ level: 'bad', title: `${webrtcBad.map((a) => a.name).join('、')}：WebRTC 设置和账号不一致`, detail: '请重启 WAswitch 后再检查。' });
  else if (proxied.length) items.push({ level: 'ok', title: '走代理的号：WebRTC 只走代理，不泄露本机 IP' });
  for (const a of accounts.filter((x) => !isLite(x) && !x.proxy && x.allowCalls)) {
    items.push({ level: 'warn', title: `${a.name}：允许通话（直连）`, detail: '通话的 UDP 走这台电脑的真实 IP。如果 Clash 开着系统代理（不是 TUN 模式），网页和通话会显示两个不同的 IP。不需要打电话请在编辑里关掉。' });
  }
  const uaOk = accounts.every((a) => !/Electron|waswitch/i.test(fingerprint.resolve(a.fingerprint).userAgent));
  items.push({ level: uaOk ? 'ok' : 'bad', title: '浏览器标识里没有 Electron 或软件名' });
  saveAccounts();
  pushState();
  return { items, time: new Date().toLocaleString('zh-CN') };
});

// 用户点了顶栏的“出口 IP 变了”：知道了，不再标黄
handleShell('exit:ack', ({ id } = {}) => {
  if (exitChanges.delete(String(id))) refresh();
  return { ok: true };
});

// 隔离自检里的“改成和出口一致”：只改地区（时区），然后重建页面
handleShell('check:fix', async ({ id, region } = {}) => {
  const acc = findAcc(id);
  if (!acc || isLite(acc) || !isValidRegion(region) || region === 'auto') return { error: '改不了' };
  if (acc.fingerprint.region === region) return { ok: true };
  acc.fingerprint.region = region;
  saveAccounts();
  destroyView(acc.id);
  problems.delete(acc.id);
  await createView(acc);
  refresh();
  return { ok: true };
});

// 关于页：检查更新、重启以更新（Mac：打开安装包）
onShell('update:check', () => updater?.check());
onShell('update:install', () => { if (!updater) return; if (updater.mac) updater.openMacInstaller(); else updater.install(); });

// 退出前让轻量模式后台进程把凭据和聊天缓存写盘（最多等 4 秒）
let liteFlushed = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (liteHost && liteHost.running() && !liteFlushed) {
    event.preventDefault();
    liteHost.shutdown().finally(() => { liteFlushed = true; app.quit(); });
  }
});
// 窗口只是隐藏，不因为“没有可见窗口”而退出
app.on('window-all-closed', () => {});
// macOS 点 Dock 图标时重新显示窗口
app.on('activate', () => notifier.showWindow());
