// WAswitch 主进程。
// 窗口 = 一个本地界面视图（侧栏、顶栏、设置等，铺满整个窗口）+ 每个账号一个 WhatsApp 视图（盖在右侧卡片里）。
// 每个账号三层隔离：
//   1. 数据：独立的 session 分区（persist:wa-<id>），cookie、存储、缓存互不相通
//   2. 网络：独立代理（proxy.js），代理不通时不回落直连，并禁止 WebRTC 绕过代理
//   3. 环境：独立的浏览器标识、语言、时区（fingerprint.js），只用官方接口设置
// 小号可以用“轻量模式”（src/lite）：不开网页，在一个共用的后台进程里直接连 WhatsApp，省内存。
// 主号只能用网页版。轻量小号可以走代理，也可以直连（用户自己选，有风险提示）。
// 走代理的轻量号在带网络护栏的后台进程里，任何直连都会被拦下；直连的轻量号在另一个单独的进程里。
const { app, BaseWindow, WebContentsView, ipcMain, session, shell, Menu, dialog, powerMonitor, safeStorage, clipboard, ClipboardItem, screen, net: electronNet } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const log = require('./log');
const { writeJsonAtomic, hasBrokenBackup } = require('./atomic');
const fingerprint = require('./fingerprint');
const proxy = require('./proxy');
const errtext = require('./errtext');
const ports = require('./ports');
const { regionLabel } = require('./regions');
const { Notifier } = require('./notify');
const { PopupWindow } = require('./popup');
const { EventLog } = require('./eventlog');
const records = require('./records');
const { Translator, DEFAULT_MODES, retireModes } = require('./translate');
const memory = require('./memory');
const waPage = require('./wa-page');
const { createDraftPlacer } = require('./draft-place');
const { setupMcp } = require('./mcp');
const { LiteHost } = require('./lite/host');
const { isSafeLink } = require('./links');
const { clearSessionCache } = require('./cache');
const { Updater } = require('./updater');
const { TeamSync } = require('./team');
const { CrmQueue } = require('./crm/queue');
const crmWeb = require('./crm/web');
const { CrmUploader } = require('./crm/upload');
const { canEncrypt } = require('./secure-storage');
const { problemCode } = require('./problem-codes');
const { setupEditorIpc } = require('./editor-ipc');
const { createDownloads } = require('./downloads');
const { newAccountId } = require('./account-id');
const { setupCheckIpc } = require('./check-ipc');
const { setupTranslateIpc } = require('./translate-ipc');
const { setupPeerClock } = require('./peer-clock');
const { OfflineWatch, LITE_OFFLINE, WEB_OFFLINE, offlineMessage } = require('./offline-watch');

// 页面缩放的几档（和 Chrome 一样），网页版号默认 90%
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const DEFAULT_ZOOM = 0.9;

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
const PANEL_W = 380; // 右侧工作台（客户资料 / 话术 / 翻译）的宽度
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
  writeJsonAtomic(file, groups, 2);
}
const groupOf = (acc) => (acc.groupId ? groups.find((g) => g.id === acc.groupId) : null);
// 是否不弹通知：账号自己关了，或者所在分组整组关了
const isMuted = (acc) => acc.muted || !!groupOf(acc)?.muted;
// 侧栏的显示顺序：先是没分组的号，再按分组顺序；同一段里按 accounts.json 的顺序。Ctrl+数字、托盘也按这个顺序
function displayOrder() {
  const list = visibleAccounts();
  return [...list.filter((a) => !groupOf(a)), ...groups.flatMap((g) => list.filter((a) => a.groupId === g.id))];
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
  writeJsonAtomic(file, accounts, 2);
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
      try { fs.copyFileSync(file, backup); } catch (err) { console.warn(`备份 accounts.json 失败：${err.message}`); }
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
    // 手机号：登录后自动读到的，或用户在编辑里自己填的（phoneManual）。同样只在本机显示，不给 MCP
    acc.phone = cleanPhone(acc.phone);
    acc.phoneManual = acc.phoneManual === true && !!acc.phone;
    acc.color = COLORS.includes(acc.color) ? acc.color : COLORS[i % COLORS.length];
    acc.proxy = typeof acc.proxy === 'string' ? acc.proxy : '';
    acc.proxyPassword = typeof acc.proxyPassword === 'string' ? acc.proxyPassword : '';
    acc.exitLabel = typeof acc.exitLabel === 'string' ? acc.exitLabel : '';
    acc.fingerprint = fingerprint.normalize(acc.fingerprint);
    acc.muted = acc.muted === true;
    // 分组：指向不存在的分组时显示成未分组，但不清掉（groups.json 坏了、从备份恢复后还能回到原来的组）
    acc.groupId = typeof acc.groupId === 'string' ? acc.groupId.slice(0, 40) : '';
    // 网页默认缩放 90%。zoomSet：用户自己调过。老版本没有这个字段：停在 100% 的当作没调过，改成 90%
    if (acc.zoomSet !== true) acc.zoomSet = ZOOM_STEPS.includes(acc.zoom) && acc.zoom !== 1;
    acc.zoom = acc.zoomSet && ZOOM_STEPS.includes(acc.zoom) ? acc.zoom : DEFAULT_ZOOM;
    acc.spellcheck = acc.spellcheck === true;
    // 0.5.8 起不能再改下载文件夹：老版本存的自定义文件夹丢掉，下次保存时就从账号文件里消失
    delete acc.downloadDir;
    acc.mode = acc.mode === 'lite' ? 'lite' : 'web';
    acc.liteKey = typeof acc.liteKey === 'string' ? acc.liteKey : '';
    // 老版本没有这个字段：当作登录过（之前已经在用的号），掉线照样标红
    acc.loggedIn = acc.loggedIn === undefined ? true : acc.loggedIn === true;
    // 直连号是否允许网页版通话（WebRTC 走 UDP），默认不允许
    acc.allowCalls = acc.allowCalls === true;
    acc.lastExit = acc.lastExit && typeof acc.lastExit.ip === 'string' && Number.isFinite(acc.lastExit.at) ? { ip: acc.lastExit.ip, at: acc.lastExit.at } : null;
    // 主号只能用网页版
    acc.primary = acc.primary === true && acc.mode === 'web';
    // 团队模式（src/team）：团队账号 id、是否被后台收回、是否还没填代理、后台下发的备注
    acc.teamId = typeof acc.teamId === 'string' && /^[0-9a-f-]{36}$/.test(acc.teamId) ? acc.teamId : '';
    acc.teamHidden = !!acc.teamId && acc.teamHidden === true;
    acc.teamNeedsProxy = !!acc.teamId && acc.teamNeedsProxy === true;
    acc.teamNote = typeof acc.teamNote === 'string' ? acc.teamNote.slice(0, 500) : '';
    acc.teamCrm = acc.teamCrm === true && !!acc.teamId;
    acc.teamExpected = typeof acc.teamExpected === 'string' && /^[A-Z]{2}$/.test(acc.teamExpected) ? acc.teamExpected : '';
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

// 只留数字、空格、+ - ( )，最多 24 个字符
function cleanPhone(phone) {
  return String(phone || '').replace(/[^\d+\-() ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

// 编辑里改了手机号：填了就以用户的为准；清空则回到自动读取
function applyPhone(acc, phone) {
  if (acc.phone === phone) return;
  acc.phone = phone;
  acc.phoneManual = !!phone;
  if (!phone) {
    phoneRead.delete(acc.id);
    // 轻量模式：用上次连上时读到的号，不用等下次重连
    setDetectedPhone(acc, waPage.parseWid(liteMe.get(acc.id)));
  }
}

// 登录后读到的本号手机号。用户自己填过的不覆盖
function setDetectedPhone(acc, phone) {
  if (!acc || !phone || acc.phoneManual || acc.phone === phone) return;
  acc.phone = phone;
  saveAccounts();
  pushState();
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
  // accounts.json 以前读坏过（留着 .broken- 备份）：之后员工又加了号、文件又“正常”了，
  // 但里面只有新号，其他号的登录数据还在等着从备份恢复，绝不能当残留删掉。备份被处理掉之前一直不清理
  if (hasBrokenBackup(storeFile())) {
    console.warn('发现 accounts.json 的损坏备份，跳过清理残留账号数据');
    return;
  }
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
    // 停着的号（被收回/电脑停用）不测：不用它的代理凭据联网，不上报，不改它的记录
    for (const acc of visibleAccounts()) {
      if (!acc.proxy || quitting || isParked(acc) || !findAcc(acc.id)) continue;
      const prev = exitIps.get(acc.id) || (acc.lastExit ? acc.lastExit.ip : '');
      const prevLabel = acc.exitLabel;
      const proxyAtStart = acc.proxy;
      const res = await proxy.test(acc.proxy, proxy.decryptPassword(acc.proxyPassword));
      // 测的时候代理被改了、号被删了或被收回：结果作废
      if (isParked(acc) || !findAcc(acc.id) || acc.proxy !== proxyAtStart) continue;
      noteProxyHealth(acc, res);
      // 记延迟：成功记往返毫秒数；失败只记“失败”，不记错误原文（里面可能有代理地址）
      if (res.ok) {
        lastLatency.set(acc.id, { ms: res.ms, at: Date.now() });
        netEvent(acc.id, 'exit', { ms: res.ms });
      } else {
        netEvent(acc.id, 'exit_fail');
      }
      if (!res.ok) continue;
      const label = regionName(res.country);
      if (prev && prev !== res.ip) {
        team?.recordEvent(acc, 'exit_changed', res.country);
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
const liteUnreadChats = new Map(); // id -> 后台进程推来的有未读的对话（名字、未读条数、最后一条预览，弹窗里用）
const liteOpen = new Map(); // id -> 正在看的对话
let liteGuardHits = 0; // 网络护栏拦下的次数（隔离自检里显示）
const isLite = (acc) => acc && acc.mode === 'lite';

// 团队模式（在 app ready 之后创建）。被后台收回、电脑被停用、或后台不允许的私人号都“停着”：不运行、不显示，数据保留
let team = null;
const isParked = (acc) => !!(team && acc && team.isParked(acc));
const visibleAccounts = () => accounts.filter((a) => !isParked(a));
const isParkedId = (id) => accounts.some((a) => a.id === String(id) && isParked(a));

const memoryManager = new memory.MemoryManager(settings, {
  views,
  // 轻量模式账号共用后台进程（走代理的一个、直连的一个），占用平均分给每个轻量账号（近似值）
  extraUsage: (byPid) => {
    const lite = accounts.filter(isLite);
    const pids = liteHost ? liteHost.pids() : [];
    if (!lite.length) return [];
    const each = Math.round(pids.reduce((sum, pid) => sum + (byPid.get(pid) || 0), 0) / lite.length);
    return lite.map((a) => [a.id, each]);
  },
  isBackground: (id) => id !== activeId || page !== 'account' || !win || !win.isVisible(),
  unreadOf: (id) => notifier.unread.get(id) || 0,
  skip: (id) => problems.has(id) || isParkedId(id) || downloads.isDownloading(id), // 出错、停用、正在下载的账号不刷新
  onUpdate: () => { notifier.refresh(); pushState(); },
});

// 新消息弹窗要用的对话列表：名字、未读条数、最后一条消息的预览（对话列表里本来就显示的那一行）。
// 网页号在隔离环境里只读（不往页面注入）；轻量号用后台进程推来的。
// 聊天锁定、账号出错、页面还在加载时返回 null，弹窗退回“有 N 个未读对话”
async function readUnreadChats(acc) {
  if (locked || problems.has(acc.id)) return null;
  if (isLite(acc)) return liteUnreadChats.get(acc.id) || null;
  const view = views.get(acc.id);
  if (!view || pendingLoad.has(acc.id)) return null;
  // 标题里的未读数先变，左边对话列表稍后才排好，等一下再读
  await new Promise((r) => setTimeout(r, 600));
  if (locked || views.get(acc.id) !== view || view.webContents.isDestroyed()) return null;
  const r = await waPage.readChatList(view.webContents, { includePreview: true });
  return r && r.ok ? r.chats : null;
}

// 自带通知弹窗（屏幕右上角）。所有提醒都走它，不用系统通知
const popup = new PopupWindow({
  getWindow: () => win,
  account: (id) => { const a = accounts.find((x) => x.id === id); return a ? { name: a.name, color: a.color } : null; },
  locked: () => locked,
  settings: () => settings,
  onOpen: (card) => notifier.open(card),
  onLater: (card) => notifier.later(card),
});
ipcMain.on('popup:ready', (e) => popup.onReady(e.sender));
ipcMain.on('popup:hover', (e, on) => popup.onHover(e.sender, on === true));
ipcMain.on('popup:act', (e, { uid, action } = {}) => {
  if (!['open', 'later', 'close'].includes(action)) return;
  popup.onAction(e.sender, Number(uid), action);
});

const notifier = new Notifier({
  getAccounts: () => displayOrder(),
  readChats: (acc) => readUnreadChats(acc),
  popup,
  openChat: (id, jid) => { const acc = findAcc(id); if (isLite(acc) && typeof jid === 'string' && jid) { liteOpen.set(id, jid); syncLiteWatch(); pushState(); } },
  setDnd: (on) => setSetting('popupDnd', on === true),
  isActive: (id) => id === activeId && page === 'account',
  onNew: (e) => addNotifLog(e),
  // 弹过哪一条（只存指纹，不存消息内容）：软件重启后同一条不再弹
  loadPopped: () => { try { return JSON.parse(fs.readFileSync(poppedFile(), 'utf8')); } catch { return null; } },
  savePopped: (data) => savePoppedSoon(data),
  isMuted: (acc) => isMuted(acc),
  getWindow: () => win,
  activate: (id) => { userActivate(id); },
  isOffline: (id) => offlineWatch.marked(id),
  quit: () => { quitting = true; app.quit(); },
  memoryOf: (id) => memoryManager.usageMB.get(id) || 0,
  totalMemory: () => memoryManager.totalMB(),
  settingsMenu: () => [
    { label: '立即清理内存（刷新没有未读的后台账号）', click: () => { memoryManager.cleanNow(); } },
    ...(visibleAccounts().length ? [{ label: locked ? '聊天已锁定' : '立即锁定聊天', enabled: !locked, click: () => setLocked(true) }] : []),
    { label: '未读总览…', click: () => { notifier.showWindow(); showPage('overview'); } },
    { label: '设置…', click: () => { notifier.showWindow(); showPage('settings'); } },
    ...(mcp ? [{ label: 'MCP 接口设置…', click: () => mcp.openSettings() }] : []),
  ],
  trayText: () => (updater ? updater.trayText() : ''),
  updateMenu: () => {
    const u = updater?.state;
    if (!u || u.status !== 'downloaded') return [];
    return u.manual
      ? [{ label: `打开新版本 ${u.version} 的安装包`, click: () => updater.openMacInstaller() }]
      : [{ label: `重启以更新到 ${u.version}`, click: () => updater.install() }];
  },
});

// 弹过的消息记录，2 秒内的多次改动合成一次写盘；退出前补写
const poppedFile = () => path.join(app.getPath('userData'), 'notify-popped.json');
let poppedPending = null;
let poppedTimer = null;
function writePoppedNow() {
  clearTimeout(poppedTimer);
  poppedTimer = null;
  if (!poppedPending) return;
  const data = poppedPending;
  poppedPending = null;
  try { writeJsonAtomic(poppedFile(), data); } catch (e) { console.warn('弹窗记录保存失败', e.message); }
}
function savePoppedSoon(data) {
  poppedPending = data;
  if (!poppedTimer) poppedTimer = setTimeout(writePoppedNow, 2000);
}
app.on('will-quit', writePoppedNow);

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
  listAccounts: () => visibleAccounts().map((a) => ({
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
  removeAccount: (id, opts) => (findAcc(id) ? removeAccount(id, opts) : 'not_found'),

  // ---- 第二层：读对话列表 ----
  // 读之前现查一次是否已登录（只读检测），结果同步到掉线检测的状态里
  checkLogin: async (id) => {
    // 轻量模式没有网页，登录状态来自后台进程
    if (isLite(findAcc(id))) return problems.has(id) ? 'unknown' : (loginStates.get(id) || 'unknown');
    const view = views.get(id);
    if (!view || problems.has(id)) return 'unknown';
    const state = await waPage.loginState(view.webContents);
    if (state !== 'unknown' && state !== loginStates.get(id)) { loginStates.set(id, state); noteLoggedIn(id, state); if (state === 'needs_qr') armQrWatch(); pushState(); }
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

  // ---- 起草回复：放进输入框，不发送（见 draft-place.js） ----
  placeDraft: (args) => draftPlacer.place(args),
};

// 轻量模式的输入框在软件界面里：请界面填进去，界面回 'ok' | 'not_empty' | 'chat' | 'none'
const liteFillWaits = new Map();
let liteFillSeq = 0;
function liteFill(id, jid, text, { force = false, focus = false } = {}) {
  if (!shellView || shellView.webContents.isDestroyed()) return Promise.resolve('none');
  liteFillSeq += 1;
  const n = liteFillSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { liteFillWaits.delete(n); resolve('none'); }, 3000);
    liteFillWaits.set(n, (r) => { clearTimeout(timer); liteFillWaits.delete(n); resolve(r); });
    shellView.webContents.send('draft:lite-fill', { n, id, jid, text, force: !!force, focus: !!focus });
  });
}

// 这个号正显示着、没锁、页面正常：读页面期间这些变了就不放
const draftShown = (id) => !!findAcc(id) && id === activeId && page === 'account' && !locked && !problems.has(id);
const draftPlacer = createDraftPlacer({
  findAcc: (id) => findAcc(id),
  isLite,
  autoBlock: (id) => {
    if (!win || !win.isVisible() || win.isMinimized()) return 'hidden';
    if (locked) return 'locked';
    if (id !== activeId || page !== 'account') return 'not_shown';
    if (problems.has(id)) return 'problem';
    if (userBusy()) return 'busy';
    return '';
  },
  stillShown: draftShown,
  webContents: (id) => {
    const view = views.get(id);
    return view && !view.webContents.isDestroyed() && !pendingLoad.has(id) ? view.webContents : null;
  },
  waPage,
  clipboard,
  ClipboardItem,
  liteOpenChat: (id) => {
    const jid = liteOpen.get(id);
    if (!jid) return null;
    const v = liteViews.get(id);
    const title = (v && v.jid === jid && v.title) || ((v && v.chats) || []).find((c) => c.jid === jid)?.name || '';
    return { jid, title };
  },
  liteChats: (id) => (liteViews.get(id)?.chats || []).filter((c) => c && typeof c.jid === 'string'),
  liteOpen: (id, jid) => { liteOpen.set(id, jid); syncLiteWatch(); pushState(); },
  liteFill,
  request: () => aiRequest,
  setRequest: (req, ms) => setAiRequest(req, ms),
  clearRequest: () => setAiRequest(null),
  activateForUser: async (id) => { notifier.showWindow(); await userActivate(id); },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
});

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
// 只锁账号页面：设置、编辑、总览页照常可以用，切回账号时仍是锁屏卡片。
// 只是防路过的人看到聊天内容：页面照常在后台运行，消息、未读数、通知都不受影响。不往 WhatsApp 页面注入任何东西。
let locked = false;
const LOCK_POLL_MS = 10 * 1000;
function setLocked(on) {
  on = !!on;
  if (locked === on) return;
  if (on && !accounts.length) return;
  locked = on;
  popup.refresh(); // 锁上后弹窗马上遮住客户名字和内容
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
let appReadyAt = Date.now(); // 启动时间（app ready 时再更新一次）
function idleSeconds() {
  const sys = powerMonitor.getSystemIdleTime();
  // 刚启动时不按系统空闲时间算（开机自启、电脑放了很久再打开软件，不会一打开就锁）
  const sysSinceReady = Math.min(sys, Math.floor((Date.now() - appReadyAt) / 1000));
  if (win && win.isVisible() && !win.isMinimized() && win.isFocused()) { unfocusedSince = 0; return sysSinceReady; }
  if (!unfocusedSince) unfocusedSince = Date.now();
  return Math.max(sysSinceReady, (Date.now() - unfocusedSince) / 1000);
}
function checkIdleLock() {
  const mins = settings.lockMinutes;
  if (!mins || locked || !visibleAccounts().length) return;
  if (idleSeconds() >= mins * 60) setLocked(true);
}

// 所有账号视图大小相同，只显示当前账号。其他账号设为隐藏，
// Chromium 会把它们当作后台页面处理（降低优先级、节流、释放画面缓存），但消息照常接收。
// ---------- 右侧面板：话术库和客户名单（只存本机，不同步、不上传） ----------
let panelOpen = false;
let panelTab = settings.panelTab; // replies | customers | translate，记在设置里，重启后还在这一页
let replyStore = null;
let customerStore = null;
let modeStore = null; // 翻译模式
let translator = null;
const panelShown = () => panelOpen && page === 'account' && !locked && visibleAccounts().length > 0;
function togglePanel(on = !panelOpen) {
  panelOpen = !!on;
  refresh();
}
// 停着的号（团队收回等）名下的客户也不显示、不提醒，数据保留
const parkedCustomer = (c) => !!c.accountId && accounts.some((a) => a.id === c.accountId && isParked(a));
function panelData() {
  const names = new Map(visibleAccounts().map((a) => [a.id, a.name]));
  return {
    replies: replyStore.list().map(({ id, title, text, updatedAt }) => ({ id, title, text, updatedAt })),
    customers: customerStore.list().filter((c) => !parkedCustomer(c)).map((c) => ({
      id: c.id, accountId: c.accountId, accountName: names.get(c.accountId) || '', name: c.name, phone: c.phone,
      note: c.note, tags: c.tags, followUpAt: c.followUpAt, updatedAt: c.updatedAt, lang: c.lang,
    })),
  };
}
// 跟进提醒：每分钟看一次，到时间的弹通知，只写名字（通知会显示在锁屏上，不写电话和备注）
// 一次最多弹 3 条，其余合成一条“还有 N 条跟进提醒”
function checkFollowUps() {
  if (!customerStore) return;
  const now = Date.now();
  const due = customerStore.list().filter((c) => c.followUpAt && !c.reminded && c.followUpAt <= now && !parkedCustomer(c));
  if (!due.length) return;
  for (const c of due) customerStore.patch(c.id, { reminded: true }, { save: false });
  customerStore.save();
  for (const c of due.slice(0, 3)) {
    const accId = c.accountId;
    notifier.notifyApp('跟进提醒', c.name || '一位客户', () => {
      notifier.showWindow();
      if (findAcc(accId)) userActivate(accId); // 只切换账号，不自动打开面板
    }, { sensitive: true });
  }
  if (due.length > 3) notifier.notifyApp('跟进提醒', `还有 ${due.length - 3} 条跟进提醒`, () => notifier.showWindow());
}

// 切换提速：切走的号会被降级（定时器节流、画面缓存释放），放久了再切回来要先补做积压的活、
// 重新画整页，看起来像刷新了一遍。最近用过的 2 个号不降级，切回来马上就有；
// 其余的号照旧降级省内存省电（省内存模式下全部降级）。不休眠，收消息和通知不受影响。
const WARM_KEEP = 2;
const recentIds = []; // 最近切走的网页号，最新的在前
function noteRecent(id) {
  const i = recentIds.indexOf(id);
  if (i >= 0) recentIds.splice(i, 1);
  if (id) recentIds.unshift(id);
  if (recentIds.length > 10) recentIds.length = 10;
}
const throttled = new WeakMap(); // 账号页面 -> 现在是否允许后台节流（页面重建后重新设）
let lastViewBounds = null;
function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  shellView.setBounds({ x: 0, y: 0, width, height });
  const side = sideWidth();
  const top = TOPBAR + (aiRequest ? AIBAR : 0);
  const onAccount = page === 'account';
  // 不在账号页（设置、内存页等）时账号页面都藏着，保持原来的尺寸，回来时 WhatsApp 不用重新排版
  const bounds = onAccount || !lastViewBounds ? {
    x: side,
    y: GAP + top,
    width: Math.max(0, width - side - GAP - (panelShown() ? PANEL_W : 0)),
    height: Math.max(0, height - GAP * 2 - top),
  } : lastViewBounds;
  if (onAccount) lastViewBounds = bounds;
  const keep = startupLowMemory ? 0 : WARM_KEEP;
  const warm = new Set(recentIds.filter((id) => id !== activeId && views.has(id)).slice(0, keep));
  if (activeId) warm.add(activeId);
  for (const [id, view] of views) {
    const current = onAccount && id === activeId;
    view.setBounds(bounds);
    view.setVisible(current && !problems.has(id) && !locked);
    const allow = !warm.has(id);
    if (throttled.get(view) !== allow && !view.webContents.isDestroyed()) {
      view.webContents.setBackgroundThrottling(allow);
      throttled.set(view, allow);
    }
    memoryManager.markBackground(id, !current || !win.isVisible());
  }
  trIpc.layoutFloat(bounds);
  syncLiteWatch();
}

// ---------- 连接记录（延迟和掉线） ----------
// 不额外发网络请求，只记已经看到的事：页面/代理连不上和恢复、掉线要扫码和重新登录、页面崩溃、
// 30 分钟一次的出口巡检（用它的往返时间当延迟）。detail 只放错误类型，不放代理地址和账号密码。
let netLog = null;
const netLastSeen = new Map(); // id -> { problem, login, downAt }
const lastLatency = new Map(); // id -> { ms, at }
function netEvent(id, kind, extra = {}) {
  if (!netLog) return;
  netLog.add({ id: String(id), kind, ...extra });
}
// 每次推状态前对比一下，状态变了就记一条（所有出问题的路径都会走到 pushState）
function trackNet() {
  if (!netLog) return;
  for (const acc of visibleAccounts()) {
    const prev = netLastSeen.get(acc.id) || { problem: '', login: '', downAt: 0 };
    const p = problems.get(acc.id);
    const problem = p ? String(p.kind || 'unknown').slice(0, 20) : '';
    const login = loginStates.get(acc.id) || '';
    const next = { ...prev, problem, login };
    if (problem && problem !== prev.problem) {
      netEvent(acc.id, 'down', { detail: problem });
      console.warn(`账号 ${acc.id} 出现问题 ${problemCode(problem) || '-'}（${problem}）`);
      if (!prev.problem) next.downAt = Date.now();
    } else if (!problem && prev.problem) {
      netEvent(acc.id, 'up', { ms: prev.downAt ? Date.now() - prev.downAt : undefined, detail: prev.problem });
      next.downAt = 0;
    }
    if (login === 'needs_qr' && prev.login === 'logged_in') netEvent(acc.id, 'qr');
    if (login === 'logged_in' && prev.login === 'needs_qr') netEvent(acc.id, 'login');
    netLastSeen.set(acc.id, next);
  }
}

// ---------- 断线提醒 ----------
// 登录过的号断线满 2 分钟：弹一次通知，托盘和托盘菜单标出来（规则在 offline-watch.js）。
// 状态变化时（pushState）和每 15 秒各看一次；两次之间隔了很久说明电脑睡过，断线时间从现在重新算。
const offlineWatch = new OfflineWatch();
const OFFLINE_TICK_MS = 15 * 1000;
let offlineLastTick = 0;
function offlineIds() {
  const ids = new Set();
  for (const acc of visibleAccounts()) {
    if (!acc.loggedIn) continue; // 还没登录过的新号：在设置阶段，不提醒
    const down = isLite(acc)
      ? LITE_OFFLINE.has(liteStates.get(acc.id)?.status || 'connecting')
      : WEB_OFFLINE.has(problems.get(acc.id)?.kind);
    if (down) ids.add(acc.id);
  }
  return ids;
}
// 网页号：同一个客户又发一条时标题里的未读对话数不变，每 10 秒看一眼有未读的号的对话列表（只读），
// 某个客户的未读条数变多了就弹（合并到这个客户的卡片上）。没有未读的号、静音的号、正在看的号不看
const RECHECK_MS = 10 * 1000;
function recheckUnread() {
  if (locked) return; // 勿扰时也看：不弹，只记下这期间来过的，关掉勿扰后不把它们当新消息弹
  for (const acc of visibleAccounts()) {
    if (isLite(acc) || !(notifier.unread.get(acc.id) > 0) || problems.has(acc.id)) continue;
    notifier.recheck(acc, { isActive: acc.id === activeId && page === 'account' });
  }
}
function checkOffline() {
  const now = Date.now();
  if (offlineLastTick && now - offlineLastTick > OFFLINE_TICK_MS * 4) offlineWatch.restart();
  offlineLastTick = now;
  const { due, changed } = offlineWatch.update(offlineIds());
  // 正开着窗口看着这个号：问题页就在眼前，不用再弹
  const looking = (id) => !!win && id === activeId && page === 'account' && win.isVisible() && win.isFocused();
  const pop = due.map(findAcc).filter((acc) => acc && !looking(acc.id));
  for (const acc of pop) console.warn(`账号 ${acc.id} 断线满 2 分钟，已提醒`);
  if (pop.length) {
    const { title, body } = offlineMessage(pop.map((a) => a.name));
    notifier.notifyApp(title, body, () => { notifier.showWindow(); userActivate(pop[0].id); });
  }
  if (changed) notifier.refresh();
}

function pushState() {
  team?.noteChange();
  crmReconcile();
  trackNet();
  checkOffline();
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
    team: team ? { ...team.snapshot(), crmUpload: crmUploader ? crmUploader.last : null } : null,
    locked,
    panelOpen: panelShown(),
    panelTab,
    floatOpen: trIpc.floatOpen,
    lockChoices: memory.LOCK_CHOICES,
    popupChoices: memory.POPUP_SECONDS,
    // 分组：每组带上未读总数，折叠后组头上也能看到
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      collapsed: g.collapsed,
      muted: g.muted,
      count: visibleAccounts().filter((a) => a.groupId === g.id).length,
      unread: visibleAccounts().filter((a) => a.groupId === g.id).reduce((n, a) => n + (notifier.unread.get(a.id) || 0), 0),
    })),
    editGroupId,
    accounts: displayOrder().map((acc) => {
      const problem = problems.get(acc.id);
      return {
        id: acc.id,
        name: acc.name,
        note: acc.note,
        phone: acc.phone,
        color: acc.color,
        muted: acc.muted,
        groupId: groupOf(acc) ? acc.groupId : '',
        groupMuted: !!groupOf(acc)?.muted,
        zoom: acc.zoom || DEFAULT_ZOOM,
        unread: notifier.unread.get(acc.id) || 0,
        memMB: memoryManager.usageMB.get(acc.id) || 0,
        lastRecycle: memoryManager.recycleInfo.get(acc.id) || null, // 上次自动/手动刷新回收：{ at, mb }
        proxyLabel: proxyLabel(acc),
        regionLabel: regionLabel(acc.fingerprint.region),
        // 顶栏的“当地时间”：账号的时区；跟随本机时为 null
        timezone: fingerprint.resolve(acc.fingerprint).timezone || null,
        exitIp: exitIps.get(acc.id) || (acc.lastExit ? acc.lastExit.ip : ''),
        exitAt: acc.lastExit ? acc.lastExit.at : 0,
        exitChange: exitChanges.get(acc.id) || null,
        latency: lastLatency.get(acc.id) || null,
        problem: problem ? problem.text : '',
        problemTitle: problem ? problem.title : '',
        problemShort: problem ? problem.short : '',
        problemDetail: problem ? problem.detail || '' : '',
        problemKind: problem ? problem.kind || '' : '',
        problemCode: problem ? problemCode(problem.kind) : '',
        direct: !acc.proxy,
        allowCalls: !!acc.allowCalls,
        // 从没登录成功过的号停在二维码页是正常的第一步，不算故障
        everLoggedIn: !!acc.loggedIn,
        retrying: !!(problem && problem.retrying),
        needsQr: loginStates.get(acc.id) === 'needs_qr',
        mode: acc.mode,
        primary: acc.primary,
        liteStatus: isLite(acc) ? (liteStates.get(acc.id)?.status || 'connecting') : '',
        team: !!acc.teamId,
        teamNote: acc.teamNote || '',
        // 开了“同步到 CRM”：侧栏一直显示标记；团队页显示条数（不显示内容）
        crm: crmOn(acc) ? crmQueue.stats(acc.id) : null,
        crmWanted: !!(acc.teamCrm && !isParked(acc)),
      };
    }),
    lite: liteStateForShell(),
    totalMB: memoryManager.totalMB(),
    settings,
    restartNeeded: settings.lowMemoryMode !== startupLowMemory,
    recycleChoices: memory.RECYCLE_CHOICES,
    capChoices: memory.CAP_CHOICES,
    capAdvice: memoryManager.capAdvice,
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
// 团队状态用：每个号最近一次巡检的代理结果（只在内存里）
const proxyHealth = new Map(); // id -> { ok, ms, country }
function noteProxyHealth(acc, res) {
  const before = proxyHealth.get(acc.id);
  proxyHealth.set(acc.id, { ok: !!res.ok, ms: res.ok && Number.isFinite(res.ms) ? Math.round(res.ms) : null, country: res.ok ? String(res.country || '') : '' });
  if (before && before.ok && !res.ok) team?.recordEvent(acc, 'proxy_down');
  if (before && !before.ok && res.ok) team?.recordEvent(acc, 'proxy_up');
}

// 上报给团队后台的状态：只有白名单字段（见 src/team）。不含聊天、代理地址和员工活动
function teamStatusOf(acc) {
  const problem = problems.get(acc.id);
  const health = proxyHealth.get(acc.id);
  let state;
  if (acc.teamNeedsProxy) state = 'needs_proxy';
  else if (problem) state = ['proxy', 'proxyDown', 'unreachable'].includes(problem.kind) ? 'proxy_down' : problem.kind === 'banned' ? 'banned' : 'error';
  else if (loginStates.get(acc.id) === 'needs_qr') state = 'needs_qr';
  else state = accountStatus(acc.id) === 'ready' ? 'ready' : accountStatus(acc.id) === 'not_loaded' ? 'stopped' : 'loading';
  return {
    state,
    unread: notifier.unread.get(acc.id) || 0,
    proxy_ok: acc.proxy ? (problem && ['proxy', 'proxyDown', 'unreachable'].includes(problem.kind) ? false : health ? health.ok : null) : null,
    proxy_ms: acc.proxy && health ? health.ms : null,
    exit_ip: acc.proxy ? exitIps.get(acc.id) || '' : '',
    exit_country: acc.proxy && health ? health.country : '',
    exit_changed: exitChanges.has(acc.id),
  };
}

// 后台分来、还没填代理的号：不联网，卡片上提示去填代理
const TEAM_PROXY_PROBLEM = {
  kind: 'teamProxy',
  title: '这个号是管理员分给你的，请先设置代理',
  short: '待填代理',
  text: '填好代理并测试通过后才会联网扫码。代理只保存在这台电脑上，不会上传到后台。',
  config: true,
};

// 停掉并隐藏一个号（被后台收回、电脑被停用、或不允许私人号）。数据全部保留
function parkAccount(acc) {
  if (isLite(acc)) liteHost.stop(acc.id); else destroyView(acc.id);
  clearRetry(acc.id);
  problems.delete(acc.id);
  loginStates.delete(acc.id);
  liteStates.delete(acc.id);
  liteViews.delete(acc.id);
  liteUnreadChats.delete(acc.id);
  liteOpen.delete(acc.id);
  mcp?.controller.gate.clearAccount(acc.id);
  notifier.forget(acc.id);
  memoryManager.forget(acc.id);
  if (page === 'editor' && editorId === acc.id) page = 'account';
  if (aiRequest && aiRequest.id === acc.id) setAiRequest(null);
  if (activeId === acc.id) activeId = visibleAccounts()[0]?.id ?? null;
}

// 重新显示并启动（还没填代理的只显示，不联网）
async function unparkAccount(acc) {
  if (isParked(acc)) return;
  if (acc.teamNeedsProxy) { problems.set(acc.id, { ...TEAM_PROXY_PROBLEM }); return; }
  if (isLite(acc) ? liteStates.has(acc.id) : views.has(acc.id)) return;
  await startAccount(acc);
}

// 后台新分来的号：建一个本地账号，先不联网，等员工填代理
function createTeamSeat(seat) {
  const acc = {
    id: newAccountId(accounts), name: seat.name, color: COLORS.includes(seat.color) ? seat.color : nextColor(), proxy: '', proxyPassword: '', exitLabel: '',
    fingerprint: fingerprint.generate('auto'), muted: false, mode: seat.mode, primary: false,
    liteKey: seat.mode === 'lite' ? newLiteKey() : '', loggedIn: false, allowCalls: false,
    teamId: seat.teamId, teamHidden: false, teamNeedsProxy: true, teamNote: seat.note, teamExpected: seat.expected, teamCrm: seat.crm === true,
  };
  accounts.push(acc);
  problems.set(acc.id, { ...TEAM_PROXY_PROBLEM });
  if (!activeId) activeId = acc.id;
  if (page === 'welcome') page = 'account';
  return acc;
}

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
  const acc = findAcc(id);
  if (!acc) return;
  clearRetry(id);
  const problem = problems.get(id);
  if (problem && problem.config) { openEditor(id); return; }
  if (isLite(acc)) { problems.delete(id); startLite(acc); refresh(); return; }
  if (!views.has(id)) { await createView(acc); refresh(); return; }
  reconnect(id);
}

// 把连不上的账号马上重连一次（不清登录、不清聊天）
function reconnectStuck() {
  for (const [id, p] of problems) if (!p.config) { clearRetry(id); reconnect(id); }
  // 轻量账号：代理断开、正在连、正在重连或停止重连的，马上重试一次
  for (const acc of visibleAccounts().filter(isLite)) {
    if (['proxyDown', 'unreachable', 'connecting', 'reconnecting', 'crashed', 'stuck', 'qrExpired'].includes(liteStates.get(acc.id)?.status)) startLite(acc);
  }
}

// ---------- 切换 VPN / 网络后尽快重连 ----------
// 换 Clash 节点、开关系统代理、开关 TUN、换 Wi-Fi 后，旧连接常常已经断了却还挂着，
// WhatsApp 要等心跳超时、再按越来越长的间隔重试，看起来就是“一直连不上”。
// 每 5 秒看一眼网卡地址和系统代理有没有变，变了就：重新读代理设置、断开旧连接、重连连不上的号。
const NET_POLL_MS = 5000;
let netSig = null;
let netBusy = false;
async function networkSignature() {
  const ifs = Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || [])
      // 只看 IPv4：IPv6 临时地址会定时轮换，不代表换了网络
      .filter((a) => !a.internal && (a.family === 'IPv4' || a.family === 4)).map((a) => `${name}=${a.address}`))
    .sort().join(',');
  let sys = '';
  try {
    // 默认会话跟随系统代理，用它看系统代理现在指向哪里（只算规则，不联网）
    await session.defaultSession.forceReloadProxyConfig();
    sys = await session.defaultSession.resolveProxy(WA_URL);
  } catch {}
  return `${electronNet.isOnline()}|${ifs}|${sys}`;
}
async function onNetworkChange() {
  console.log('检测到网络或系统代理变化，重新连接');
  for (const acc of visibleAccounts()) {
    if (isLite(acc)) continue;
    const ses = session.fromPartition(`persist:wa-${acc.id}`);
    await ses.forceReloadProxyConfig().catch(() => {});
    // 断开旧连接，WhatsApp 网页会立刻用新线路重连，登录和聊天都不受影响
    await ses.closeAllConnections().catch(() => {});
  }
  const tr = trIpc.translateSession(false); // 翻译可能跟随系统代理
  await tr.forceReloadProxyConfig().catch(() => {});
  await tr.closeAllConnections().catch(() => {});
  reconnectStuck();
  // 轻量号要等心跳发现旧连接断了才进入“重连中”，30 秒后再补一次
  setTimeout(reconnectStuck, 30000);
}
function watchNetwork() {
  setInterval(async () => {
    if (netBusy) return;
    netBusy = true;
    try {
      const sig = await networkSignature();
      const changed = netSig !== null && sig !== netSig;
      netSig = sig;
      // 等 2 秒让 VPN 稳定下来再重连
      if (changed) setTimeout(() => onNetworkChange().catch((e) => console.warn('网络切换后重连失败', e)), 2000);
    } finally { netBusy = false; }
  }, NET_POLL_MS);
}

// ---------- 掉线检测 ----------
// 每 3 分钟只读检查一次每个账号是否停在扫码页（在隔离环境里看页面结构，不读聊天内容）。
// 从“已登录”变成“要扫码”时，不管有没有关通知都提醒，因为掉线会漏掉所有消息。

const liteMe = new Map(); // 轻量模式：上次连上时的本号 id
const phoneRead = new Set(); // 这次登录已经读过手机号的网页版账号
// 检查一个网页版账号的登录状态，变了返回 true。同一个号同时只查一次（慢检查和扫码快检查可能撞上）
const loginChecking = new Set();
async function checkLogin(acc) {
  const view = views.get(acc.id);
  if (!view || problems.has(acc.id) || loginChecking.has(acc.id)) return false;
  loginChecking.add(acc.id);
  try {
    const state = await waPage.loginState(view.webContents);
    if (state === 'unknown') return false;
    // 登录后读一次自己的手机号（只读 localStorage，见 wa-page.js）；掉线后重新登录再读
    if (state === 'needs_qr') phoneRead.delete(acc.id);
    if (state === 'logged_in' && !phoneRead.has(acc.id)) {
      const phone = await waPage.readOwnNumber(view.webContents);
      if (phone) { phoneRead.add(acc.id); setDetectedPhone(acc, phone); }
    }
    const before = loginStates.get(acc.id);
    if (state === before) return false;
    if (state === 'needs_qr') mcp?.controller.gate.clearAccount(acc.id);
    if (state === 'needs_qr' && before === 'logged_in') team?.recordEvent(acc, 'dropped');
    if (state === 'logged_in' && before === 'needs_qr') team?.recordEvent(acc, 'recovered');
    if (state === 'needs_qr' && before === 'logged_in') {
      console.warn(`账号 ${acc.id} 已退出登录，需要重新扫码`);
      notifier.notify(acc, '已退出登录，需要重新扫码。点这里打开这个号。');
    }
    loginStates.set(acc.id, state);
    noteLoggedIn(acc.id, state);
    if (state === 'needs_qr') armQrWatch();
    return true;
  } finally {
    loginChecking.delete(acc.id);
  }
}

async function checkLogins(list = accounts) {
  let changed = false;
  for (const acc of list) if (await checkLogin(acc)) changed = true;
  if (changed) pushState();
}

// 扫码快检查：有网页版账号停在二维码页（或刚加载完、还不知道状态）时，每 3 秒看一次，
// 扫完几秒内侧栏就变成已登录。没有这样的号、或窗口藏起来/最小化（没人在扫码）就停下，
// 登录后的号只走 LOGIN_CHECK_MS 的慢检查。
const QR_CHECK_MS = 3000;
const QR_FRESH_MS = 60 * 1000; // 页面加载完 1 分钟内状态还没认出来，也算可能在等扫码
let qrWatchTimer = null;
function qrWatchList() {
  const now = Date.now();
  return accounts.filter((a) => {
    if (isLite(a) || isParked(a) || !views.has(a.id) || problems.has(a.id) || pendingLoad.has(a.id)) return false;
    const st = loginStates.get(a.id);
    if (st === 'needs_qr') return true;
    return st !== 'logged_in' && now - (webLoadedAt.get(a.id) || 0) < QR_FRESH_MS;
  });
}
function armQrWatch() {
  if (qrWatchTimer || quitting) return;
  qrWatchTimer = setTimeout(qrWatchTick, QR_CHECK_MS);
}
async function qrWatchTick() {
  const list = qrWatchList();
  if (!list.length || !win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) { qrWatchTimer = null; return; }
  await checkLogins(list);
  qrWatchTimer = null;
  armQrWatch();
}

// 页面加载失败时，代理类错误要明确告诉用户，而不是一片空白
// 页面显示出对话列表后再等这么久让未读数涨回原数；整个过程最多等 RELOAD_QUIET_MAX_MS
const RELOAD_QUIET_MS = 5 * 1000;
const RELOAD_QUIET_MAX_MS = 2 * 60 * 1000;
const PROXY_ERRORS = new Set([-111, -115, -120, -122, -125, -130, -336]);

// 页面打不开时给用户看的提示：按错误码说人话，Chromium 的原话（ERR_XXX）收进“详细信息”
// port：出错后探一下本机端口的结果 { open, socks }（见 portProbeFor）。端口通着还连不上，就是 Clash 当前节点挂了
function loadProblem(acc, code, desc, port) {
  const raw = `${desc || 'ERR_UNKNOWN'} (${code})${acc.proxy ? ` · ${acc.proxy}` : ''}`;
  const kind = errtext.netKind(desc);
  const p = acc.proxy ? proxy.parse(acc.proxy) : null;
  if (PROXY_ERRORS.has(code) || (p && !p.error && ['proxyDown', 'proxyNode', 'proxyAuth', 'refused'].includes(kind))) {
    const local = p && !p.error && errtext.isLocal(p.host);
    const nodeDead = local && kind === 'proxyDown' && !!(port && port.open && port.socks);
    const node = kind === 'proxyNode' || kind === 'dns' || nodeDead;
    const auth = kind === 'proxyAuth';
    const title = auth ? `${acc.name}的代理用户名或密码不对`
      : node ? (local ? `${acc.name}：Clash 当前节点不通` : `${acc.name}：代理打不开 WhatsApp`)
        : p && !p.error ? (local ? `${acc.name}连不上 Clash 的 ${p.port} 端口` : `${acc.name}连不上代理 ${p.host}:${p.port}`) : `${acc.name}连不上代理`;
    const why = auth ? '请在编辑里改好代理的用户名和密码。'
      : nodeDead ? `Clash 开着，${p.port} 端口也通，但这个端口对应的节点连不出去。去 Clash 给这个端口换个节点。`
      : node ? (local ? 'Clash 开着，但当前节点打不开 WhatsApp，在 Clash 里换个节点试试。' : '代理连上了，但通过它打不开 WhatsApp，代理那边的网络可能有问题。')
        : local ? '通常是 Clash 没开，或者 Clash 里没开这个端口。' : '代理可能停了，或者地址、端口不对。';
    return { kind: 'proxy', title, short: node && local ? '节点不通' : '代理连不上', text: `这个号先暂停联网，不会改用直连，手机上的消息不会丢。${why}`, detail: raw, retrying: !auth };
  }
  if (acc.proxy && (kind === 'dns' || kind === 'timeout' || kind === 'reset')) {
    return { kind: 'network', title: 'WhatsApp 页面打不开', short: '连不上', text: `${errtext.netReason(desc, { proxy: p && !p.error ? p : null })}。`, detail: raw, retrying: true };
  }
  const plain = {
    offline: ['这台电脑没联网', '没网', '网络恢复后会自动连上。'],
    changed: ['网络刚切换过', '网络切换', '马上会自动重新连接。'],
    dns: ['打不开 WhatsApp 网站', '连不上', acc.proxy ? '找不到 WhatsApp 的网站地址。' : '这个号是直连，跟随电脑的系统代理：要开着 Clash 的系统代理才能打开 WhatsApp。'],
    timeout: ['连接 WhatsApp 超时', '连不上', '网络太慢或不通。'],
    reset: ['到 WhatsApp 的连接被中断了', '连不上', '通常是网络不稳定。'],
    cert: ['安全连接出错', '连不上', '可能是网络被拦截，或者电脑时间不对。请检查电脑的日期和时间。'],
  }[kind] || ['WhatsApp 页面打不开', '连不上', '网络有问题，可能是没联网或代理不通。'];
  return { kind: 'network', title: plain[0], short: plain[1], text: plain[2], detail: raw, retrying: true };
}

// 本机端口代理报“连不上代理”时，先探一下端口：分清是 Clash/端口没开，还是端口开着但节点挂了。
// 只连本机，最多等 0.8 秒；不是本机端口或不是这类错误就不探
async function portProbeFor(acc, desc) {
  const p = acc.proxy ? proxy.parse(acc.proxy) : null;
  if (!p || p.error || !errtext.isLocal(p.host) || errtext.netKind(desc) !== 'proxyDown') return null;
  try { return await ports.probe(Number(p.port), { host: p.host.replace(/^\[|\]$/g, '') }); } catch { return null; }
}

// ---------- 缩放（每个号单独记） ----------
// 和 Chrome 一样的几档（ZOOM_STEPS 在文件开头）；只对网页版号生效（轻量模式的界面跟着软件走）
function applyZoom(acc) {
  const view = views.get(acc.id);
  if (view && !view.webContents.isDestroyed()) view.webContents.setZoomFactor(acc.zoom || DEFAULT_ZOOM);
}
// dir: 1 放大，-1 缩小，0 还原
function stepZoom(id, dir) {
  const acc = findAcc(id);
  if (!acc || isLite(acc)) return;
  const i = ZOOM_STEPS.indexOf(acc.zoom || DEFAULT_ZOOM);
  const next = dir === 0 ? DEFAULT_ZOOM : ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir))];
  if (next === acc.zoom) return;
  acc.zoom = next;
  acc.zoomSet = next !== DEFAULT_ZOOM;
  saveAccounts();
  applyZoom(acc);
  pushState();
}

// ---------- 通知记录 ----------
// 只记 {at, id, count, popped}：哪个号、什么时候、涨到几个未读、有没有弹通知。不记消息内容、不记联系人。最多 300 条
const NOTIF_LOG_MAX = 300;
const notifLogFile = () => path.join(app.getPath('userData'), 'notif-log.json');
let notifLog = null;
let notifLogTimer = null;
function loadNotifLog() {
  try {
    const raw = JSON.parse(fs.readFileSync(notifLogFile(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e) => e && Number.isFinite(e.at) && typeof e.id === 'string' && Number.isFinite(e.count))
      .slice(-NOTIF_LOG_MAX).map((e) => ({ at: e.at, id: e.id, count: e.count, popped: e.popped === true }));
  } catch {
    return []; // 文件不存在或坏了：从空的开始（只是记录，丢了不影响使用）
  }
}
function saveNotifLogSoon() {
  clearTimeout(notifLogTimer);
  notifLogTimer = setTimeout(() => {
    notifLogTimer = null;
    try {
      writeJsonAtomic(notifLogFile(), notifLog);
    } catch (e) { console.warn('通知记录保存失败', e.message); }
  }, 2000);
}
function addNotifLog({ id, count, popped }) {
  if (!notifLog) notifLog = loadNotifLog();
  notifLog.push({ at: Date.now(), id: String(id), count, popped: !!popped });
  if (notifLog.length > NOTIF_LOG_MAX) notifLog.splice(0, notifLog.length - NOTIF_LOG_MAX);
  saveNotifLogSoon();
}

// 每个号最后一次的未读数，存在磁盘上。软件重启后页面重新加载，未读数涨回这个数不算新消息
const unreadLastFile = () => path.join(app.getPath('userData'), 'unread-last.json');
let unreadLast = null;
let unreadLastTimer = null;
function savedUnread(id) {
  if (!unreadLast) {
    try {
      const raw = JSON.parse(fs.readFileSync(unreadLastFile(), 'utf8'));
      unreadLast = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      unreadLast = {}; // 文件不存在或坏了：当成都没有未读
    }
  }
  const n = unreadLast[id];
  return Number.isInteger(n) && n > 0 ? n : 0;
}
function rememberUnread(id, count) {
  if (savedUnread(id) === count) return;
  unreadLast[id] = count;
  clearTimeout(unreadLastTimer);
  unreadLastTimer = setTimeout(() => {
    unreadLastTimer = null;
    const ids = new Set(accounts.map((a) => a.id));
    for (const k of Object.keys(unreadLast)) if (!ids.has(k) || !unreadLast[k]) delete unreadLast[k];
    try { writeJsonAtomic(unreadLastFile(), unreadLast); } catch (e) { console.warn('未读数保存失败', e.message); }
  }, 2000);
}

// ---------- 拼写检查（每个号单独开关） ----------
// macOS 用系统自带的拼写检查，不下载东西；Windows 第一次开可能会下载英文词典，
// 走的是这个号自己的 session，也就是这个号的代理（代理没设好时不打开）
const proxyReady = new Map(); // id -> 这个号的代理是否已经设好（没设好时绝不打开拼写检查）
function applySpellcheck(acc, ses = session.fromPartition(`persist:wa-${acc.id}`)) {
  const on = acc.spellcheck && proxyReady.get(acc.id) === true;
  if (on && process.platform !== 'darwin') ses.setSpellCheckerLanguages(['en-US']);
  ses.setSpellCheckerEnabled(on);
}
function setSpellcheck(id, on) {
  const acc = findAcc(id);
  if (!acc || isLite(acc)) return;
  acc.spellcheck = !!on;
  saveAccounts();
  applySpellcheck(acc);
  pushState();
}
// 账号页面里的右键菜单（原生菜单，不往页面里加东西）：拼写建议、加入词典、剪切/复制/粘贴。不提供“检查元素”
function setupPageMenu(wc, ses) {
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.misspelledWord) {
      for (const word of (p.dictionarySuggestions || []).slice(0, 5)) items.push({ label: word, click: () => wc.replaceMisspelling(word) });
      if (!items.length) items.push({ label: '没有拼写建议', enabled: false });
      items.push({ label: `把“${p.misspelledWord.slice(0, 30)}”加入词典`, click: () => ses.addWordToSpellCheckerDictionary(p.misspelledWord) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) {
      items.push(
        { label: '剪切', role: 'cut', enabled: p.editFlags.canCut },
        { label: '复制', role: 'copy', enabled: p.editFlags.canCopy },
        { label: '粘贴', role: 'paste', enabled: p.editFlags.canPaste },
        { label: '全选', role: 'selectAll', enabled: p.editFlags.canSelectAll },
      );
    } else if (p.selectionText) {
      items.push({ label: '复制', role: 'copy' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

// ---------- 下载：每个号存到自己的文件夹（位置固定，见 downloads.js） ----------
const downloads = createDownloads({
  downloadsPath: () => app.getPath('downloads'),
  getAccounts: () => accounts,
  findAcc: (id) => findAcc(id),
});

async function createView(acc, loadDelay = 0) {
  const ses = session.fromPartition(`persist:wa-${acc.id}`);
  const r = fingerprint.resolve(acc.fingerprint);
  // 网络请求层面的 UA 和语言（包括 Service Worker 发出的请求）
  ses.setUserAgent(r.userAgent, r.acceptLanguage);
  setupPermissions(ses);
  // 代理没设好之前先关掉拼写检查，免得词典下载走真实 IP
  ses.setSpellCheckerEnabled(false);
  downloads.setup(acc, ses);
  const applied = await proxy.apply(ses, acc.proxy);
  // 拼写检查每个号单独开关，默认关。代理设好了才打开（打开时 Windows 可能会下载词典）
  proxyReady.set(acc.id, !applied.error);
  if (!applied.error) applySpellcheck(acc, ses);

  const view = new WebContentsView({
    // spellcheck 在这里打开，真正开不开由 session 的开关决定（applySpellcheck），切换时不用重开页面
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });
  if (typeof view.setBorderRadius === 'function') view.setBorderRadius(14);
  const wc = view.webContents;
  wc.setWebRTCIPHandlingPolicy(webrtcPolicy(acc));
  setupNavigationGuards(wc);
  setupPageMenu(wc, ses);
  win.contentView.addChildView(view);
  views.set(acc.id, view);

  // 从页面标题里读未读数，例如 "(3) WhatsApp"
  // 页面刚开始加载时标题会从 0 涨回刷新前的数：涨回原数不弹、不记，超过原数（真有新消息）照常弹。
  // 软件重启后也一样：原数用上次关掉前记下的未读数，所以刷新、重启都不会多出一条“N 个未读”的通知记录。
  // 等到什么时候：标题出现数字，或者页面已经显示出对话列表后再等几秒（扫码页直接结束），最多 2 分钟
  let quietUntil = 0;
  let baseline = 0;
  wc.on('page-title-updated', (_e, title) => {
    const m = title.match(/^\((\d+)\)/);
    const count = m ? Number(m[1]) : 0;
    const restoring = Date.now() < quietUntil;
    notifier.update(acc, count, { isActive: acc.id === activeId && page === 'account', baseline: restoring ? baseline : 0 });
    // 标题里出现了数字，说明页面已经读出未读数，之后照常算
    if (restoring && count > 0) quietUntil = 0;
    if (!restoring || count > 0) rememberUnread(acc.id, count);
    pushState();
  });

  let failed = false;
  let failToken = null;
  wc.on('did-stop-loading', () => { webLoadedAt.set(acc.id, Date.now()); armQrWatch(); });
  wc.on('did-start-loading', () => {
    failed = false;
    failToken = null;
    // 连续刷新时保留第一次的原数；软件刚打开时用上次记下的数
    if (Date.now() >= quietUntil) baseline = notifier.unread.has(acc.id) ? notifier.unread.get(acc.id) : savedUnread(acc.id);
    quietUntil = Date.now() + RELOAD_QUIET_MAX_MS;
  });
  let settleRun = 0;
  wc.on('did-finish-load', async () => {
    const run = ++settleRun;
    while (run === settleRun && Date.now() < quietUntil && !wc.isDestroyed()) {
      const st = await waPage.loginState(wc); // 隔离环境只读检查，和掉线检测同一个
      if (run !== settleRun || Date.now() >= quietUntil) break;
      if (st === 'needs_qr') { quietUntil = 0; break; }
      if (st === 'logged_in') { quietUntil = Math.min(quietUntil, Date.now() + RELOAD_QUIET_MS); break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    // 等完了数字也没回来（比如在手机上都读掉了）：记下现在的数，免得下次重启还拿旧数当原数
    const left = Math.max(0, quietUntil - Date.now());
    setTimeout(() => { if (run === settleRun && !wc.isDestroyed() && Date.now() >= quietUntil) rememberUnread(acc.id, notifier.unread.get(acc.id) || 0); }, left + 500);
  });
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 是被新的加载打断，不算错误
    failed = true;
    console.warn(`账号 ${acc.id} 页面加载失败：${code} ${desc}`);
    const token = {};
    failToken = token;
    portProbeFor(acc, desc).then((port) => {
      // 探端口期间又开始了新的加载（重试、换代理）或者这个号已经关了：这次结果作废
      if (failToken !== token || wc.isDestroyed() || views.get(acc.id)?.webContents !== wc) return;
      if (port) console.warn(`账号 ${acc.id} 的 ${port.port} 端口：${port.open ? (port.socks ? '开着，节点不通' : '开着，但不是 socks5') : '没开'}`);
      setProblem(acc.id, loadProblem(acc, code, desc, port));
      scheduleRetry(acc.id);
    });
  });
  // Ctrl + 鼠标滚轮（或触控板缩放手势）：和快捷键走同一条路，记下的比例和顶栏一直对得上
  wc.on('zoom-changed', (_e, dir) => { if (!locked) stepZoom(acc.id, dir === 'in' ? 1 : -1); });
  wc.on('did-finish-load', () => {
    // 每次加载完都按这个号记下的比例设一次（刷新、崩溃重建后也一样）
    applyZoom(acc);
    if (failed || applied.error) return;
    clearRetry(acc.id);
    if (problems.has(acc.id)) setProblem(acc.id, null);
  });
  // 页面进程崩溃后调试连接会断开，直接重建这个账号的视图，保证环境设置重新生效
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    netEvent(acc.id, 'crash', { detail: String(details.reason).slice(0, 20) });
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
      text: `${errtext.hasChinese(applied.error) ? applied.error : '代理设置没能生效'}。为避免暴露真实 IP，这个账号暂时不联网，请修改代理。`,
      detail: errtext.hasChinese(applied.error) ? '' : applied.error,
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
  if (!canEncrypt(safeStorage)) throw new Error('系统没有安全钥匙环，不能使用轻量模式');
  return safeStorage.encryptString(crypto.randomBytes(32).toString('hex')).toString('base64');
}

function liteKeyOf(acc) {
  if (!canEncrypt(safeStorage)) throw new Error('系统没有安全钥匙环');
  const hex = safeStorage.decryptString(Buffer.from(acc.liteKey, 'base64'));
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('密钥格式不对');
  return hex;
}

const LITE_SCHEMES = ['socks5', 'http', 'https'];

// 后台进程用的代理地址：socks5 一律用 socks5h（域名交给代理解析）；http 代理带上解密后的密码。
// 直连返回 ''，代理设置有误返回 null
function liteProxyUrl(acc) {
  const p = proxy.parse(acc.proxy);
  if (!p) return '';
  if (p.error || !LITE_SCHEMES.includes(p.scheme)) return null;
  if (p.scheme === 'socks5') return `socks5h://${p.host}:${p.port}`;
  const pass = proxy.decryptPassword(acc.proxyPassword) || p.password;
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(pass)}@` : '';
  return `${p.scheme}://${auth}${p.host}:${p.port}`;
}

function startLite(acc) {
  const url = liteProxyUrl(acc);
  if (url === null) {
    setProblem(acc.id, {
      kind: 'config',
      title: '代理设置有误，这个账号已暂停联网',
      short: '代理设置有误',
      text: '轻量模式只支持 socks5 或 http 代理，代理设置有误时不会改用直连。请在编辑里改好代理并测试，或者清空代理改成直连。',
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
  liteHost.start(acc.id, { proxy: url, key, os: process.platform, crm: crmOn(acc) ? crmQueue.enable(acc.id) : 0 });
}

function startAccount(acc, loadDelay = 0) {
  if (isParked(acc)) return Promise.resolve();
  if (acc.teamNeedsProxy) { problems.set(acc.id, { ...TEAM_PROXY_PROBLEM }); return Promise.resolve(); }
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
  // 代理端口通，但 30 秒还没连上 WhatsApp（或连续失败 3 次）：多半是 Clash 当前节点挂了
  unreachable: (acc, { detail } = {}) => {
    const raw = detail ? `${detail}${acc.proxy ? ` · ${acc.proxy}` : ''}` : '';
    if (!acc.proxy) {
      return {
        kind: 'network', // 直连号没有代理可改，用“连不上”的代码 N1
        title: `${acc.name}连不上 WhatsApp`,
        short: '连不上',
        text: '这个号是直连轻量号，用这台电脑自己的网络，不经过系统代理。可能是电脑没联网，或者要把 Clash 改成 TUN 模式。',
        detail: raw,
        retrying: true,
      };
    }
    const p = proxy.parse(acc.proxy);
    const ok = p && !p.error;
    const local = ok && errtext.isLocal(p.host);
    return {
      title: local ? `${acc.name}：Clash 当前节点不通` : `${acc.name}：代理连不上 WhatsApp`,
      short: '节点不通',
      text: local
        ? `这个号先暂停联网，不会改用直连，手机上的消息不会丢。Clash 开着，${p.port} 端口也能连上，但当前节点连不上 WhatsApp：在 Clash 里给这个端口换个节点，或者点“修改代理”换个端口。`
        : `这个号先暂停联网，不会改用直连，手机上的消息不会丢。代理${ok ? ` ${p.host}:${p.port}` : ''}能连上，但通过它连不上 WhatsApp，代理那边的网络可能有问题。可以点“修改代理”换一条线路。`,
      detail: raw,
      retrying: true,
    };
  },
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
    text: '10 分钟内出错超过 3 次。点“重新连接”再试一次；如果还是不行，点“打开日志文件夹”，最新的日志里记着出错原因。',
  }),
  crashed: () => ({
    title: '轻量模式后台进程意外退出',
    short: '后台出错',
    text: '正在自动恢复。如果反复出现，点“打开日志文件夹”，最新的日志里记着出错原因。',
    retrying: true,
  }),
};

// 用户正在看这个号的这个对话（窗口在前台）
function userIsReading(id, jid) {
  return !locked && !!win && id === activeId && page === 'account' && win.isVisible() && win.isFocused() && liteOpen.get(id) === jid && !problems.has(id);
}

function bindLiteEvents() {
  liteHost.on('state', ({ id, status, qr, me, detail, fresh }) => {
    const acc = findAcc(id);
    if (!acc || !isLite(acc)) return;
    const prev = liteStates.get(id)?.status;
    liteStates.set(id, { status, qr: status === 'qr' ? qr : null, fresh: fresh !== false });
    if (status === 'open') { loginStates.set(id, 'logged_in'); noteLoggedIn(id, 'logged_in'); if (me) liteMe.set(id, me); setDetectedPhone(acc, waPage.parseWid(me)); }
    if (['qr', 'qrExpired', 'loggedOut'].includes(status)) loginStates.set(id, 'needs_qr');
    if (['qr', 'qrExpired', 'loggedOut'].includes(status)) mcp?.controller.gate.clearAccount(id);
    const make = LITE_PROBLEMS[status];
    if (make) problems.set(id, { kind: status, ...make(acc, { detail: typeof detail === 'string' ? detail.slice(0, 300) : '' }) });
    else if (status === 'open' || status === 'qr') problems.delete(id);
    // 掉线、被封：不管有没有关通知都提醒
    if (prev !== status && status === 'loggedOut') notifier.notify(acc, '已退出登录，需要重新扫码。点这里打开这个号。');
    if (prev !== status && status === 'banned') notifier.notify(acc, 'WhatsApp 拒绝了这个号的连接，可能被封了。');
    if (prev !== status && status === 'banned') team?.recordEvent(acc, 'banned');
    if (prev !== status && status === 'stuck') notifier.notify(acc, '连接反复出错，已停止重连。点这里打开这个号重试。');
    refresh();
  });
  liteHost.on('unread', ({ id, count, chats }) => {
    const acc = findAcc(id);
    if (!acc) return;
    liteUnreadChats.set(id, Array.isArray(chats) ? chats : []);
    const isActive = id === activeId && page === 'account';
    const grew = count > (notifier.unread.get(id) || 0);
    // 软件刚打开时的第一次：涨回上次关掉前的未读数不算新消息（和网页号一样），不然重启后会把以前弹过的再弹一遍
    const baseline = notifier.unread.has(id) ? 0 : savedUnread(id);
    notifier.update(acc, count, { isActive, baseline });
    rememberUnread(id, count);
    // 未读对话数没变、但某个客户又发了一条：也弹（同一个客户合并成一张）
    if (!grew) notifier.recheck(acc, { isActive });
    pushState();
  });
  liteHost.on('view', (v) => {
    if (!findAcc(v.id)) return;
    liteViews.set(v.id, v);
    pushState();
    trIpc.liteChanged(v.id); // 面板“翻译”页马上显示新消息
  });
  liteHost.on('incoming', ({ id, jid }) => {
    notifier.lastNewAt = Date.now(); // 自动装更新要看 10 分钟内有没有新消息
    if (userIsReading(id, jid)) liteHost.read(id, jid);
  });
  liteHost.on('guard', () => { liteGuardHits += 1; });
  // 轻量号采集到的 CRM 消息：主进程再查一遍开关，只进本机加密队列
  liteHost.on('crm', ({ id, items, skipped }) => {
    const acc = findAcc(id);
    if (!crmOn(acc) || !isLite(acc)) return;
    for (const item of Array.isArray(items) ? items.slice(0, 500) : []) crmQueue.add(acc.id, item);
    if (Number.isInteger(skipped) && skipped > 0) crmQueue.skip(acc.id, Math.min(skipped, 500));
  });
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
    fresh: st.fresh !== false, // 这次启动后还没连上过：写“正在连接”，不写“连接断开”
    openJid: liteOpen.get(acc.id) || null,
    view: view ? { rev: view.rev, chats: view.chats, jid: view.jid, title: view.title, messages: view.messages } : null,
  };
}

// focus：用户自己切的号（点侧栏、Ctrl+数字、托盘或通知）才把键盘焦点交给新账号，切完就能直接打字。
// MCP 引起的切换不给焦点，免得用户打的字落到别的号里。
function activate(id, { focus = false } = {}) {
  if (activeId && activeId !== id) crmReadWeb(activeId, true); // 切走前把这个号打开的对话再读一次
  if (activeId && activeId !== id && views.has(activeId)) noteRecent(activeId);
  activeId = id;
  // 记住在看哪个号，下次启动直接打开它
  if (id && settings.lastAccountId !== id) { settings.lastAccountId = id; memory.saveSettings(settings); }
  if (!visibleAccounts().length) page = 'welcome';
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
// ms：起草回复的横幅留得久一点（见 draft-place.js）
function setAiRequest(req, ms = AI_ASK_MS) {
  clearTimeout(aiTimer);
  aiRequest = req;
  if (req) aiTimer = setTimeout(() => { aiRequest = null; refresh(); }, ms);
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
  if (aiRequest.kind === 'draft') {
    const acc = findAcc(aiRequest.id);
    if (!acc) return null;
    // 锁着时不显示客户名字和草稿内容
    if (locked) return { kind: 'draft', locked: true };
    return { kind: 'draft', name: acc.name, chat: aiRequest.chat, preview: aiRequest.text.replace(/\s+/g, ' ').slice(0, 120), note: aiRequest.note || '' };
  }
  const acc = findAcc(aiRequest.id);
  return acc ? { kind: 'switch', name: acc.name } : null;
}

function showPage(next) {
  page = next === 'account' && !visibleAccounts().length ? 'welcome' : next;
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
  editorIpc.resetTest();
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
  liteUnreadChats.delete(id);
  liteOpen.delete(id);
  mcp?.controller.gate.clearAccount(id);
  notifier.forget(id);
  if (translator) translator.forgetAccount(id);
  if (trIpc.floatCore) trIpc.floatCore.forget(id);
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
  activate(visibleAccounts()[0]?.id ?? null);
  return 'removed';
}

// 代理认证必须属于请求的 session。后台请求无法归属且凭据有歧义时直接取消，绝不取第一个账号。
app.on('login', (event, webContents, _details, authInfo, callback) => {
  if (!authInfo.isProxy) return;
  const candidates = accounts.filter((a) => !isLite(a) && !isParked(a)
    && (!webContents || session.fromPartition(`persist:wa-${a.id}`) === webContents.session));
  const credentials = proxy.credentialsFor(authInfo, candidates);
  event.preventDefault();
  if (credentials) callback(credentials.username, credentials.password);
  else callback();
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
  } else if (key === 'capMB') {
    if (!memory.CAP_CHOICES.includes(value)) return;
  } else if (['autoRecycle', 'lowMemoryMode', 'closeToTray', 'openAtLogin', 'sidebarCollapsed', 'showUpdateButton', 'popupSound', 'popupDnd'].includes(key)) {
    if (typeof value !== 'boolean') return;
  } else if (key === 'lockMinutes') {
    if (!memory.LOCK_CHOICES.includes(value)) return;
  } else if (key === 'popupSeconds') {
    if (!memory.POPUP_SECONDS.includes(value)) return;
  } else {
    return;
  }
  settings[key] = value;
  if (key === 'recycleMB' && value > 0) settings.recycleLastMB = value; // 关掉再打开时沿用
  memory.saveSettings(settings);
  if (key === 'openAtLogin') applyLoginItem();
  if (key.startsWith('popup')) popup.refresh();
  notifier.refresh();
  refresh();
}

// 重启 WAswitch：走正常退出流程（轻量模式后台先写盘），再重新打开
function relaunchApp() {
  app.relaunch();
  quitting = true;
  app.quit();
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
    if (input.type !== 'keyDown' || input.alt) return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    // Ctrl + = / - / 0（Mac 用 Cmd）：缩放当前网页版号，只在账号页面里按才算
    if (mod && page === 'account' && !locked && ['=', '+', '-', '_', '0'].includes(input.key)) {
      const acc = findAcc(activeId);
      if (acc && !isLite(acc)) {
        event.preventDefault();
        stepZoom(acc.id, input.key === '0' ? 0 : input.key === '-' || input.key === '_' ? -1 : 1);
      }
      return;
    }
    // Ctrl+Shift+K（Mac 是 Cmd+Shift+K）：打开/收起右侧的话术和客户面板
    if (mod && input.shift && input.key.toLowerCase() === 'k') {
      event.preventDefault();
      togglePanel();
      return;
    }
    if (input.shift) return;
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
    // Windows 不显示菜单栏（默认菜单里有开发者工具），复制粘贴照常可用
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

// 用户点了更新、已经下好：窗口开着时，30 秒内打过字、在编辑账号或正在确认操作，先不重启
function updateBusyReason() {
  if (!win || !win.isVisible() || win.isMinimized()) return null;
  if (page === 'editor') return '正在编辑账号';
  if (confirmDialogOpen || clearingCache) return '正在操作';
  if (Date.now() - lastTypedAt < TYPING_MS) return '正在打字';
  return null;
}

function setupUpdater() {
  updater = new Updater({
    onChange: () => { notifier.refresh(); pushState(); },
    idleReason: updateIdleReason,
    busyReason: updateBusyReason,
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
        for (const acc of visibleAccounts().filter(isLite)) startAccount(acc); // 停着的号不重连，待填代理的号也不联网
      }
      refresh();
    },
    notify: (title, body, onClick) => notifier.notifyApp(title, body, onClick),
  });
  updater.start();
}

// ---------- 启动 ----------

app.on('second-instance', () => notifier.showWindow());

// ---------- 团队模式 ----------
// ---------- 同步到 CRM：采集到本机加密队列（第 1 步），定时传到团队后台（第 2 步） ----------
// 只有团队号、管理员在后台开了同步、号没停着、系统能真加密时才采集；私人号永远不采集
let crmQueue = null;
let crmTimer = null;
let crmUploader = null;
const CRM_UPLOAD_MS = 10 * 60 * 1000;
const CRM_READ_MS = 15 * 1000;
const crmOn = (acc) => !!(acc && crmQueue && team && team.enrolled() && acc.teamId && acc.teamCrm && !isParked(acc) && crmQueue.canEncrypt());
// 开关、收回、停用、换私人号、删号之后：停止采集，删掉队列和去重表
function crmReconcile() {
  if (!crmQueue) return;
  for (const id of crmQueue.enabledIds()) {
    if (crmOn(accounts.find((a) => a.id === id))) continue;
    crmQueue.purge(id);
    crmWebReader.forget(id);
    if (liteHost) liteHost.setCrm(id, 0);
  }
  for (const acc of accounts) {
    if (!crmOn(acc)) continue;
    const since = crmQueue.enable(acc.id);
    if (isLite(acc) && liteHost) liteHost.setCrm(acc.id, since);
  }
}
// 网页版号：只读员工正在看的对话，条件和悬浮窗一样（账号页、窗口看得见、没锁、号正常、页面没在加载）
// switching = 切走前最后读一次（这时它还是当前号）
async function crmReadWeb(id, switching) {
  const acc = findAcc(id);
  if (!crmOn(acc) || isLite(acc) || problems.has(acc.id)) return;
  if (page !== 'account' || locked || !win || !win.isVisible() || win.isMinimized()) return;
  if (!switching && id !== activeId) return;
  const view = views.get(acc.id);
  if (!view || view.webContents.isDestroyed() || view.webContents.isLoading()) return;
  const r = await waPage.readOpenChat(view.webContents);
  if (!r.ok || !crmOn(acc)) return;
  const since = crmQueue.since(acc.id);
  const now = Date.now();
  const got = crmWebReader.collect(acc.id, r.msgs, since, now);
  for (const item of got.items) crmQueue.add(acc.id, item);
  if (got.nonumber) crmQueue.skip(acc.id, got.nonumber);
  if (got.notime) crmQueue.skipNoTime(acc.id, got.notime);
}
// 每个对话读到过哪些消息（只在内存里）：读不出时间的旧消息不收、跳过的只算一次
const crmWebReader = new crmWeb.WebReader();

function setupTeam() {
  team = new TeamSync({
    dir: app.getPath('userData'),
    safeStorage,
    appVersion: app.getVersion(),
    platform: process.platform,
    hooks: {
      accounts: () => accounts,
      save: () => saveAccounts(),
      statusOf: (acc) => teamStatusOf(acc),
      deviceInfo: () => ({ mem_mb: Math.round(memoryManager.totalMB() || 0), low_mem: settings.lowMemoryMode === true }),
      park: (acc) => parkAccount(acc),
      unpark: (acc) => { unparkAccount(acc).then(refresh, (e) => console.warn(`恢复账号 ${acc.id} 失败：${e.message}`)); },
      createSeat: (seat) => createTeamSeat(seat),
      refresh: () => refresh(),
    },
  });
  crmQueue = new CrmQueue({ dir: app.getPath('userData'), safeStorage, onError: (e) => console.warn(`CRM 队列写盘失败：${e.message}`) });
  crmTimer = setInterval(() => {
    crmQueue.sweep();
    if (activeId) crmReadWeb(activeId, false);
  }, CRM_READ_MS);
  // 第 2 步：每 10 分钟把本机队列传到团队后台；后台确认收到才从本机删
  crmUploader = new CrmUploader({ queue: crmQueue, team, accounts: () => accounts, crmOn });
  const upload = () => crmUploader.run().then(() => refresh(), (e) => console.warn(`CRM 上传失败：${e.message}`));
  setTimeout(upload, 60 * 1000).unref?.();
  setInterval(upload, CRM_UPLOAD_MS).unref?.();
  // 停着的号启动时就不运行；后台不允许私人号时也一样（以最后一次同步的结果为准）
  for (const acc of accounts) if (acc.teamNeedsProxy && !isParked(acc)) problems.set(acc.id, { ...TEAM_PROXY_PROBLEM });
}

app.whenReady().then(async () => {
  appReadyAt = Date.now();
  if (!isPrimary) return;
  setupMenu();
  // 本地界面用的默认会话不需要任何权限
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setSpellCheckerEnabled(false);

  const mac = process.platform === 'darwin';
  // 默认窗口按 1520×960 打开（右侧会话区够宽），屏幕放不下就按工作区 92% 缩小，居中
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const winW = Math.max(900, Math.min(1520, Math.round(wa.width * 0.92)));
  const winH = Math.max(600, Math.min(960, Math.round(wa.height * 0.92)));
  win = new BaseWindow({
    width: winW, height: winH, center: true, minWidth: 900, minHeight: 600, show: false,
    title: 'WAswitch', backgroundColor: '#E6E9ED',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    // Mac 不进全屏：绿色按钮只做放大/还原，双击标题栏缩放也保留
    ...(mac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 }, fullscreenable: false } : {}),
  });
  notifier.init();
  // 窗口隐藏到托盘时，当前账号也算后台
  win.on('hide', layout);
  win.on('show', () => { layout(); armQrWatch(); });
  win.on('restore', armQrWatch); // 窗口回来时，等扫码的号重新开始快检查
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
      notifier.notifyApp('WAswitch 还在运行', '已缩到托盘，继续接收消息。右键托盘图标可以退出。');
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
  netLog = new EventLog(path.join(app.getPath('userData'), 'net-log.json'), { max: 1500, maxAgeMs: 7 * 24 * 3600 * 1000, routine: ['exit', 'exit_fail'], routinePerId: 50 });
  replyStore = new records.Records(app.getPath('userData'), 'replies');
  customerStore = new records.Records(app.getPath('userData'), 'customers');
  modeStore = new records.Records(app.getPath('userData'), 'tmodes');
  try { modeStore.seed(DEFAULT_MODES); } catch (e) { console.warn(`翻译模式初始化失败：${e.message}`); }
  try {
    const flag = path.join(app.getPath('userData'), 'tmodes-retired-1');
    retireModes(modeStore, fs.existsSync(flag));
    fs.writeFileSync(flag, '1');
  } catch (e) { console.warn(`旧翻译模式清理失败：${e.message}`); }
  translator = new Translator({ dir: app.getPath('userData'), safeStorage, sessionFor: trIpc.translateSession });
  trIpc.applyTranslateNet().catch(() => {});
  trIpc.setupFloatCore();
  setInterval(checkFollowUps, 60 * 1000);
  setTimeout(checkFollowUps, 15 * 1000);
  accounts = loadAccounts();
  if (accountsFileOk) saveAccounts();
  cleanupPartitions();
  applyLoginItem();
  setupTeam();
  activeId = (findAcc(settings.lastAccountId) || visibleAccounts()[0])?.id ?? null;
  page = visibleAccounts().length ? 'account' : 'welcome';
  refresh();
  if (!shouldStartHidden()) win.show();

  // 电脑睡眠醒来后，网络和 Clash 需要几秒恢复，之后重连所有连不上的账号
  setInterval(checkIdleLock, LOCK_POLL_MS);
  // 系统锁屏时直接锁上，回来解开系统锁屏后还要右滑一次
  powerMonitor.on('lock-screen', () => { if (settings.lockMinutes) setLocked(true); });
  powerMonitor.on('suspend', () => { if (settings.lockMinutes) setLocked(true); });
  powerMonitor.on('resume', () => {
    offlineWatch.restart();
    crmQueue?.sweep();
    setTimeout(reconnectStuck, 5000);
  });
  watchNetwork();

  // 分批启动：先打开当前账号，其他账号每隔 2.5 秒打开一个，避免同时加载卡顿
  const order = visibleAccounts().sort((a, b) => (b.id === activeId) - (a.id === activeId)); // 正在看的号先开
  for (const [i, acc] of order.entries()) {
    await startAccount(acc, i * 2500);
    refresh();
  }
  memoryManager.start();
  setInterval(checkOffline, OFFLINE_TICK_MS);
  setInterval(recheckUnread, RECHECK_MS);
  setInterval(checkLogins, LOGIN_CHECK_MS);
  setTimeout(checkLogins, 60 * 1000);
  setInterval(watchExits, EXIT_WATCH_MS);
  setTimeout(watchExits, 3 * 60 * 1000);

  mcp = setupMcp({ hooks: mcpHooks, lockLocalPage });
  await mcp.init();
  setupUpdater();
  team.start();
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
// 停着的号（见 isParked）对界面、MCP 和所有操作都当作不存在
const findAcc = (id) => accounts.find((a) => a.id === id && !isParked(a));

onShell('switch', (id) => userActivate(id));
onShell('editor:dirty', (dirty) => { if (page === 'editor') editorDirty = dirty === true; });
onShell('remove', (id) => { if (findAcc(id)) removeAccount(id); });
onShell('app:restart', () => relaunchApp());
// 用户在顶部横幅里回答 AI 的切换请求
onShell('ai:answer', (yes) => {
  const req = aiRequest;
  if (req && req.kind === 'draft') { draftPlacer.answer(yes === true); return; }
  setAiRequest(null);
  if (yes === true && req) runAiRequest(req, true);
});
onShell('add', async () => { if (await confirmLeaveEditor()) openEditor(null); });
onShell('edit', async (id) => { if (findAcc(id) && await confirmLeaveEditor()) openEditor(id); });
// 编辑页的“取消”是明确放弃，不再问（discard 为 true）
onShell('page', async (p, discard) => {
  if (!['account', 'settings', 'overview'].includes(p)) return;
  if (discard !== true && !(await confirmLeaveEditor())) return;
  editorDirty = false;
  showPage(p);
});
// 未读总览页要的通知记录（最新的在前）；清空只清记录，不动未读数
handleShell('notif:log', () => {
  if (!notifLog) notifLog = loadNotifLog();
  return notifLog.filter((e) => !isParkedId(e.id)).reverse();
});
handleShell('notif:clear', () => {
  notifLog = [];
  clearTimeout(notifLogTimer);
  try { fs.rmSync(notifLogFile(), { force: true }); } catch {}
  return true;
});
// 连接记录：最新的在前；清空只清记录
handleShell('netlog:get', () => (netLog ? netLog.load().filter((e) => !isParkedId(e.id)).reverse() : []));
handleShell('netlog:clear', () => { if (netLog) netLog.clear(); return true; });
// ---- 面板 ----
onShell('panel:toggle', (on) => togglePanel(typeof on === 'boolean' ? on : !panelOpen));
// 顶栏的“话术 / 客户 / 翻译”：点哪个就打开面板到哪一页
onShell('panel:tab', (tab) => {
  if (!memory.PANEL_TABS.includes(tab)) return;
  panelTab = tab;
  if (settings.panelTab !== tab) { settings.panelTab = tab; memory.saveSettings(settings); }
  panelOpen = true;
  refresh();
});
handleShell('panel:data', () => panelData());
handleShell('reply:save', (data) => (data && typeof data === 'object' && replyStore.upsert({ id: data.id, title: data.title, text: data.text }) ? panelData() : null));
handleShell('reply:delete', (id) => { if (typeof id === 'string') replyStore.remove(id); return panelData(); });
handleShell('cust:save', (data) => {
  if (!data || typeof data !== 'object') return null;
  const existing = typeof data.id === 'string' ? customerStore.get(data.id) : null;
  if (existing && parkedCustomer(existing)) return null;
  const accountId = typeof data.accountId === 'string' && findAcc(data.accountId) ? data.accountId : (customerStore.get(data.id)?.accountId || activeId || '');
  const ok = customerStore.upsert({ id: data.id, accountId, name: data.name, phone: data.phone, note: data.note, tags: data.tags, followUpAt: data.followUpAt, lang: data.lang });
  if (ok) trIpc.pushFloat(); // 悬浮窗和面板的目标语言可能跟着这个客户变
  return ok ? panelData() : null;
});
handleShell('cust:delete', (id) => {
  if (typeof id === 'string' && customerStore.get(id) && !parkedCustomer(customerStore.get(id))) customerStore.remove(id);
  return panelData();
});
handleShell('panel:copy', (text) => { if (typeof text === 'string') clipboard.writeText(text.slice(0, 4000)); return true; });
// 插入到聊天框：等于用户自己按 Ctrl+V（会覆盖剪贴板），不发回车、不模拟按键，发送永远由人来按。
// 面板画出来时记下的账号必须还是当前账号，并且没锁、页面正常，否则拒绝，免得贴到别的号里。
// 焦点不在对话下方的输入框（比如在搜索框）就不贴，返回 'focus' 让用户先点一下输入框
const insertBlocked = (accountId) => {
  const acc = findAcc(accountId);
  if (!acc || accountId !== activeId || page !== 'account' || locked || problems.has(accountId)) return 'changed';
  if (isLite(acc)) return 'lite'; // 轻量模式的输入框在软件界面里，由界面自己填
  const view = views.get(accountId);
  return !view || view.webContents.isDestroyed() ? 'changed' : '';
};
async function insertText(accountId, text) {
  if (typeof accountId !== 'string' || typeof text !== 'string' || !text) return 'bad';
  const blocked = insertBlocked(accountId);
  if (blocked) return blocked;
  const focus = await waPage.composeFocus(views.get(accountId).webContents);
  const after = insertBlocked(accountId); // 读焦点期间可能换号、锁定
  if (after) return after;
  if (focus !== 'compose') return 'focus';
  const view = views.get(accountId);
  await clipboard.writeText(text.slice(0, 4000)); // 剪贴板接口是异步的：写完再贴
  if (insertBlocked(accountId)) return 'changed';
  view.webContents.focus();
  view.webContents.paste();
  return 'ok';
}
handleShell('panel:insert', ({ accountId, text } = {}) => insertText(accountId, text));
// 导出导入：[文件名前缀, 保存框标题, 打开框标题]
const STORE_LABEL = { replies: ['话术', '导出话术', '导入话术'], customers: ['客户', '导出客户名单', '导入客户名单'], tmodes: ['翻译模式', '导出翻译模式', '导入翻译模式'] };
const storeOf = (kind) => ({ replies: replyStore, customers: customerStore, tmodes: modeStore })[kind];
handleShell('panel:export', async ({ kind, format } = {}) => {
  if (!STORE_LABEL[kind]) return null;
  const store = storeOf(kind);
  // 客户：停着的号（团队收回等）名下的也导出，账号名照写，方便收回前后都能备份
  let rows = store.list();
  let parked = 0;
  if (kind === 'customers') {
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    parked = rows.filter(parkedCustomer).length;
    rows = rows.map((c) => ({ ...c, accountName: names.get(c.accountId) || '' }));
  }
  const json = format === 'json';
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win, {
    title: STORE_LABEL[kind][1],
    defaultPath: path.join(app.getPath('documents'), `${STORE_LABEL[kind][0]}-${stamp}.${json ? 'json' : 'csv'}`),
    filters: [json ? { name: 'JSON', extensions: ['json'] } : { name: 'CSV（Excel 可以打开）', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const out = json
    ? JSON.stringify(rows.map(({ deleted, reminded, updatedAt, ...rest }) => rest), null, 2)
    : records.toCsv(kind, rows);
  fs.writeFileSync(r.filePath, out);
  return { count: rows.length, parked };
});
handleShell('panel:import', async ({ kind } = {}) => {
  if (!STORE_LABEL[kind]) return null;
  const r = await dialog.showOpenDialog(win, {
    title: STORE_LABEL[kind][2],
    properties: ['openFile'],
    filters: [{ name: 'CSV、文本或 JSON', extensions: ['csv', 'txt', 'tsv', 'json'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const res = records.readImport(kind, r.filePaths[0]);
  if (res.error) return { error: res.error };
  // 客户：文件里的账号编号本机还有（包括停着的号）就用它，否则记到当前账号。
  // 同一账号下电话（没电话按名字）已经有的跳过，同一个文件导两次不会多出来
  const rows = kind === 'customers'
    ? res.rows.map((row) => ({ ...row, accountId: typeof row.accountId === 'string' && accounts.some((a) => a.id === row.accountId) ? row.accountId : activeId || '' }))
    : res.rows;
  const { added, dup, bad } = storeOf(kind).importRows(rows);
  return { added, dup, bad, skipped: dup + bad, data: panelData(), modes: modeStore.list() };
});
// ---------- 拆出去的接口模块（editor-ipc.js、check-ipc.js、translate-ipc.js）共用的上下文 ----------
// 会重新赋值的状态用 getter：模块里读 ctx.activeId 拿到的总是现在的值；写 ctx.page = 'account' 就是改这里的变量
const ctx = {
  get accounts() { return accounts; },
  get activeId() { return activeId; },
  set activeId(v) { activeId = v; },
  get page() { return page; },
  set page(v) { page = v; },
  get locked() { return locked; },
  get win() { return win; },
  get shellView() { return shellView; },
  get translator() { return translator; },
  get modeStore() { return modeStore; },
  get customerStore() { return customerStore; },
  get editorPrefill() { return editorPrefill; },
  get editorColor() { return editorColor; },
  get liteGuardHits() { return liteGuardHits; },
  handleShell, onShell, findAcc, isParked, isLite, visibleAccounts, parkedCustomer, panelShown,
  // 轻量号正在看的对话和后台进程推来的内容（翻译页用）
  liteChat: (id) => ({ status: liteStates.get(id)?.status || '', jid: liteOpen.get(id) || null, view: liteViews.get(id) || null }),
  nextName, nextColor, cleanNote, cleanPhone, applyPhone, COLORS, LITE_SCHEMES, newLiteKey, WA_URL, webrtcPolicy,
  regionName, exitIps, exitChanges, recordExit, views, problems, notifier,
  saveAccounts, startAccount, startLite, createView, destroyView, refresh, pushState, layout, focusActive, lockLocalPage, insertText,
};

// ---- 翻译和悬浮翻译窗（在 translate-ipc.js） ----
const trIpc = setupTranslateIpc(ctx);
// ---- 顶栏“客户当地时间”（在 peer-clock.js） ----
setupPeerClock(ctx);
onShell('collapse', () => setSetting('sidebarCollapsed', !settings.sidebarCollapsed));
onShell('lock', (on) => setLocked(on === true));
onShell('setting', ({ key, value } = {}) => setSetting(key, value));
onShell('reload', (id) => {
  if (!findAcc(id)) return;
  if (problems.has(id) || isLite(findAcc(id))) retryNow(id);
  else views.get(id)?.webContents.reload();
});
onShell('retry', (id) => { if (findAcc(id)) retryNow(id); });
// 团队模式（设置 › 团队）
handleShell('team:enroll', async ({ server, code, deviceName, localIds, consent } = {}) => team.enroll({ server, code, deviceName, localIds, consent }));
handleShell('team:join', async ({ localIds } = {}) => team.join(localIds));
handleShell('team:sync', async () => team.syncNow());
onShell('mute', ({ id, muted } = {}) => {
  const acc = findAcc(id);
  if (!acc || typeof muted !== 'boolean') return;
  acc.muted = muted;
  saveAccounts();
  notifier.refresh();
  pushState();
});
// 设置 › 通知里的“试一下”：弹一张示例卡片（示例客户，不是真消息）
onShell('popup:test', () => {
  const acc = visibleAccounts()[0];
  popup.show({ key: 'sample', kind: 'sample', accId: acc ? acc.id : '', chat: 'Emma Schneider', text: 'Hallo! Ist der Liefertermin für Bestellung #4471 noch der 12.11.? Wir planen die Montage am 14.', count: 1 });
});
onShell('open-logs', () => { const dir = log.logDir(); if (dir) shell.openPath(dir); });

// 轻量模式聊天页
onShell('draft:lite-filled', (n, r) => {
  const done = liteFillWaits.get(n);
  if (done) done(['ok', 'not_empty', 'chat', 'none'].includes(r) ? r : 'none');
});
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
    // 自己写的提示是中文，原样给；底层库（Baileys）的英文换成人话，原话放“详细信息”
    const raw = errtext.rawOf(e);
    if (errtext.hasChinese(raw)) return { error: raw };
    console.warn(`轻量号 ${id} 发送失败：${raw}`);
    const kind = errtext.netKind(raw);
    const why = ['reset', 'timeout', 'offline', 'changed', 'dns', 'refused', 'unreachable'].includes(kind) || /closed|lost|not open|socket/i.test(raw)
      ? '没发出去：这个号正在重连，连上后再发一次（文字还在输入框里）'
      : '没发出去，稍后再发一次（文字还在输入框里）';
    return { error: why, detail: raw };
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

// 立即清理内存：刷新所有没有未读的后台账号
handleShell('mem:clean', () => memoryManager.cleanNow());

// 聊天里的链接：只放行 http、https、mailto、tel，用系统程序打开
onShell('open-link', (url) => { if (isSafeLink(url)) shell.openExternal(url); });
onShell('open-source', () => shell.openExternal(SOURCE_URL));

// 右键账号或点顶栏“⋯”：编辑 / 刷新 / 通知 / 删除
// 顶栏“⋯”旁边已经有常驻的刷新按钮，从顶栏打开时菜单里不再放“刷新”（shen 2026-10-27）；右键侧栏的号照旧有
onShell('context', (id, from) => {
  const acc = findAcc(id);
  if (!acc) return;
  Menu.buildFromTemplate([
    { label: '编辑名称、颜色和代理…', click: () => openEditor(id) },
    ...(from === 'top' ? [] : [{ label: isLite(acc) ? '重新连接' : '刷新', click: () => (problems.has(id) || isLite(acc) ? retryNow(id) : views.get(id)?.webContents.reload()) }]),
    {
      label: '不弹通知', type: 'checkbox', checked: acc.muted,
      click: () => { acc.muted = !acc.muted; saveAccounts(); notifier.refresh(); pushState(); },
    },
    {
      label: isLite(acc) ? '拼写检查（轻量模式不支持）'
        : process.platform === 'darwin' ? '拼写检查（英文）'
          : `拼写检查（英文，第一次会${acc.proxy ? '通过本号代理' : '直连'}下载词典）`, type: 'checkbox', checked: acc.spellcheck, enabled: !isLite(acc),
      click: () => setSpellcheck(id, !acc.spellcheck),
    },
    {
      label: isLite(acc) ? '缩放（轻量模式不支持）' : `缩放（${Math.round((acc.zoom || DEFAULT_ZOOM) * 100)}%）`,
      enabled: !isLite(acc),
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+=', registerAccelerator: false, click: () => stepZoom(id, 1) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => stepZoom(id, -1) },
        { label: '还原到默认 90%', accelerator: 'CmdOrCtrl+0', registerAccelerator: false, enabled: (acc.zoom || DEFAULT_ZOOM) !== DEFAULT_ZOOM, click: () => stepZoom(id, 0) },
      ],
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
// 解散分组前先问一下（和删除账号一样用系统确认框，默认是“取消”）
async function confirmDeleteGroup(gid) {
  const g = findGroup(gid);
  if (!g) return;
  const n = accounts.filter((a) => a.groupId === gid).length;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['取消', '解散'],
    defaultId: 0,
    cancelId: 0,
    title: '解散分组',
    message: `解散「${g.name}」？`,
    detail: n ? `组里的 ${n} 个号会移到“未分组”，号本身和登录状态都不受影响。` : '这个分组是空的。',
  });
  if (response === 1) deleteGroup(gid);
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
    { label: `解散「${g.name}」…（号不会删）`, click: () => confirmDeleteGroup(id) },
  ]).popup({ window: win });
});

// ---------- 编辑账号，新建和修改共用（在 editor-ipc.js） ----------
const editorIpc = setupEditorIpc(ctx);

// ---------- 隔离自检（在 check-ipc.js） ----------
setupCheckIpc(ctx);

// 用户点了顶栏的“出口 IP 变了”：知道了，不再标黄
onShell('zoom', ({ id, dir } = {}) => { if (typeof id === 'string' && [1, -1, 0].includes(dir)) stepZoom(id, dir); });
handleShell('exit:ack', ({ id } = {}) => {
  if (exitChanges.delete(String(id))) refresh();
  return { ok: true };
});

// 关于页：检查更新、重启以更新（Mac：打开安装包）
onShell('update:check', () => updater?.userUpdate()); // 用户点的：下好后自动重启安装
onShell('update:later', () => updater?.userLater()); // 等停手时点了“稍后”：不自动重启了
onShell('update:check-only', () => updater?.check()); // 侧栏的检查更新按钮：只检查，下好后照常提醒，不自动重启
onShell('update:install', () => { if (!updater) return; if (updater.state.manual) updater.openMacInstaller(); else updater.install(); });

// 退出前让轻量模式后台进程把凭据和聊天缓存写盘（最多等 4 秒）
let liteFlushed = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (crmQueue) crmQueue.saveNow();
  if (netLog) netLog.flush();
  if (trIpc.trStore) trIpc.trStore.flush(); // 还没写盘的译文
  // 还没写盘的通知记录马上写
  if (notifLogTimer) {
    clearTimeout(notifLogTimer);
    notifLogTimer = null;
    try { writeJsonAtomic(notifLogFile(), notifLog || []); } catch {}
  }
  if (liteHost && liteHost.running() && !liteFlushed) {
    event.preventDefault();
    liteHost.shutdown().finally(() => { liteFlushed = true; app.quit(); });
  }
});
// 窗口只是隐藏，不因为“没有可见窗口”而退出
app.on('window-all-closed', () => {});
// macOS 点 Dock 图标时重新显示窗口
app.on('activate', () => notifier.showWindow());

