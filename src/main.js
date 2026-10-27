// WAswitch 主进程。
// 窗口 = 一个本地界面视图（侧栏、顶栏、设置等，铺满整个窗口）+ 每个账号一个 WhatsApp 视图（盖在右侧卡片里）。
// 每个账号三层隔离：
//   1. 数据：独立的 session 分区（persist:wa-<id>），cookie、存储、缓存互不相通
//   2. 网络：独立代理（proxy.js），代理不通时不回落直连，并禁止 WebRTC 绕过代理
//   3. 环境：独立的浏览器标识、语言、时区（fingerprint.js），只用官方接口设置
// 小号可以用“轻量模式”（src/lite）：不开网页，在一个共用的后台进程里直接连 WhatsApp，省内存。
// 主号只能用网页版。轻量小号可以走代理，也可以直连（用户自己选，有风险提示）。
// 走代理的轻量号在带网络护栏的后台进程里，任何直连都会被拦下；直连的轻量号在另一个单独的进程里。
const { app, BaseWindow, WebContentsView, ipcMain, session, shell, Menu, dialog, powerMonitor, safeStorage, clipboard, screen, net: electronNet } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const log = require('./log');
const fingerprint = require('./fingerprint');
const proxy = require('./proxy');
const ports = require('./ports');
const { isValidRegion, regionForTimezone, regionLabel } = require('./regions');
const { Notifier } = require('./notify');
const { EventLog } = require('./eventlog');
const records = require('./records');
const { Translator, DEFAULT_MODES, retireModes, needsKey } = require('./translate');
const { TrStore, pickDir: pickTrDir, migrate: migrateTr, dirInfo: trDirInfo } = require('./trstore');
const { FloatCore } = require('./floatcore');
const { detectLang } = require('./langdetect');
const memory = require('./memory');
const waPage = require('./wa-page');
const { matchChatCustomer } = require('./chatlang');
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
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(groups, null, 2));
  fs.renameSync(`${file}.tmp`, file);
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
    // 自定义下载文件夹：只能是用户在对话框里选的绝对路径，其他一律当没设
    acc.downloadDir = typeof acc.downloadDir === 'string' && path.isAbsolute(acc.downloadDir) ? acc.downloadDir : '';
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
      if (!findAcc(acc.id) || acc.proxy !== proxyAtStart) continue;
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
  skip: (id) => problems.has(id) || isParkedId(id) || activeDownloads.has(id), // 出错、停用、正在下载的账号不刷新
  onUpdate: () => { notifier.refresh(); pushState(); },
});

const notifier = new Notifier({
  getAccounts: () => displayOrder(),
  onNew: (e) => addNotifLog(e),
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
    { label: '立即清理内存（刷新没有未读的后台账号）', click: () => { memoryManager.cleanNow(); } },
    {
      label: '省内存模式（关闭显卡加速，重启后生效）',
      type: 'checkbox',
      checked: settings.lowMemoryMode,
      click: () => { setSetting('lowMemoryMode', !settings.lowMemoryMode); askRestart(); },
    },
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
// 只锁账号页面：设置、编辑、总览页照常可以用，切回账号时仍是锁屏卡片。
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
let panelTab = 'replies'; // replies | customers | translate
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
    notifier.notifyApp('WAswitch', `跟进提醒：${c.name || '一位客户'}`, () => {
      notifier.showWindow();
      if (findAcc(accId)) userActivate(accId); // 只切换账号，不自动打开面板
    });
  }
  if (due.length > 3) notifier.notifyApp('WAswitch', `还有 ${due.length - 3} 条跟进提醒`, () => notifier.showWindow());
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
  layoutFloat(bounds);
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

function pushState() {
  team?.noteChange();
  crmReconcile();
  trackNet();
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
    floatOpen,
    lockChoices: memory.LOCK_CHOICES,
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
  else if (problem) state = problem.kind === 'proxy' || problem.kind === 'proxyDown' ? 'proxy_down' : problem.kind === 'banned' ? 'banned' : 'error';
  else if (loginStates.get(acc.id) === 'needs_qr') state = 'needs_qr';
  else state = accountStatus(acc.id) === 'ready' ? 'ready' : accountStatus(acc.id) === 'not_loaded' ? 'stopped' : 'loading';
  return {
    state,
    unread: notifier.unread.get(acc.id) || 0,
    proxy_ok: acc.proxy ? (problem && (problem.kind === 'proxy' || problem.kind === 'proxyDown') ? false : health ? health.ok : null) : null,
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
  let id = Date.now();
  while (accounts.some((a) => a.id === String(id))) id += 1;
  const acc = {
    id: String(id), name: seat.name, color: COLORS.includes(seat.color) ? seat.color : nextColor(), proxy: '', proxyPassword: '', exitLabel: '',
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
    if (['proxyDown', 'connecting', 'reconnecting', 'crashed', 'stuck', 'qrExpired'].includes(liteStates.get(acc.id)?.status)) startLite(acc);
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
  const tr = translateSession(false); // 翻译可能跟随系统代理
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
async function checkLogins() {
  let changed = false;
  for (const acc of accounts) {
    const view = views.get(acc.id);
    if (!view || problems.has(acc.id)) continue;
    const state = await waPage.loginState(view.webContents);
    if (state === 'unknown') continue;
    // 登录后读一次自己的手机号（只读 localStorage，见 wa-page.js）；掉线后重新登录再读
    if (state === 'needs_qr') phoneRead.delete(acc.id);
    if (state === 'logged_in' && !phoneRead.has(acc.id)) {
      const phone = await waPage.readOwnNumber(view.webContents);
      if (phone) { phoneRead.add(acc.id); setDetectedPhone(acc, phone); }
    }
    const before = loginStates.get(acc.id);
    if (state === before) continue;
    if (state === 'needs_qr') mcp?.controller.gate.clearAccount(acc.id);
    if (state === 'needs_qr' && before === 'logged_in') team?.recordEvent(acc, 'dropped');
    if (state === 'logged_in' && before === 'needs_qr') team?.recordEvent(acc, 'recovered');
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
      const file = notifLogFile();
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(notifLog));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) { console.warn('通知记录保存失败', e.message); }
  }, 2000);
}
function addNotifLog({ id, count, popped }) {
  if (!notifLog) notifLog = loadNotifLog();
  notifLog.push({ at: Date.now(), id: String(id), count, popped: !!popped });
  if (notifLog.length > NOTIF_LOG_MAX) notifLog.splice(0, notifLog.length - NOTIF_LOG_MAX);
  saveNotifLogSoon();
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

// ---------- 下载：每个号存到自己的文件夹 ----------
// 默认：系统“下载”文件夹/WAswitch/<账号名>。可以在右键菜单里改成别的文件夹（只能从对话框里选）。
// 文件夹写不进去时，退回系统的“另存为”对话框。下载完不会自动打开文件。
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
function safeName(name, fallback) {
  let n = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim();
  n = n.replace(/[. ]+$/, ''); // Windows 不允许结尾是点或空格
  if (WIN_RESERVED.test(n)) n = `_${n}`;
  n = n.slice(0, 80).replace(/[. ]+$/, '');
  return n || fallback;
}
function downloadDirOf(acc) {
  if (acc.downloadDir) return acc.downloadDir;
  // 两个号同名时，文件夹名后面加上账号编号，免得混在一起
  const base = safeName(acc.name, `account-${safeName(acc.id, 'x')}`);
  const dup = accounts.some((a) => a !== acc && !a.downloadDir && safeName(a.name, '') === base);
  return path.join(app.getPath('downloads'), 'WAswitch', dup ? `${base}-${safeName(acc.id, 'x')}` : base);
}
const reservedDownloads = new Set(); // 正在下载的目标路径，同时下两个同名文件不会撞
function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length) || 'file';
  for (let i = 0; i < 1000; i += 1) {
    const p = path.join(dir, i ? `${stem} (${i})${ext}` : `${stem}${ext}`);
    if (!reservedDownloads.has(p) && !fs.existsSync(p)) return p;
  }
  return null;
}
const activeDownloads = new Map(); // id -> 正在下载的文件数，下载中的账号不做内存回收
const downloadSessions = new WeakSet(); // 每个 session 只挂一次（视图重建时 session 不变）
function setupDownloads(acc, ses) {
  if (downloadSessions.has(ses)) return;
  downloadSessions.add(ses);
  const id = acc.id;
  ses.on('will-download', (_e, item) => {
    const cur = findAcc(id);
    if (!cur) return;
    activeDownloads.set(id, (activeDownloads.get(id) || 0) + 1);
    item.once('done', () => {
      const n = (activeDownloads.get(id) || 1) - 1;
      if (n > 0) activeDownloads.set(id, n); else activeDownloads.delete(id);
    });
    const dir = downloadDirOf(cur);
    let target = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.statSync(dir).isDirectory()) throw new Error('not a folder');
      fs.accessSync(dir, fs.constants.W_OK);
      const name = safeName(path.basename(item.getFilename() || ''), 'download');
      target = uniquePath(dir, WIN_RESERVED.test(name) ? `_${name}` : name);
    } catch (e) {
      console.warn(`账号 ${id} 的下载文件夹不可写（${e.code || e.message}），改用另存为对话框`);
    }
    if (!target) return; // 不设路径：Electron 会弹系统的“另存为”对话框
    reservedDownloads.add(target);
    item.setSavePath(target);
    item.once('done', () => reservedDownloads.delete(target));
  });
}
async function pickDownloadDir(id) {
  const acc = findAcc(id);
  if (!acc || isLite(acc)) return;
  const r = await dialog.showOpenDialog(win, { title: `「${acc.name}」的下载文件夹`, defaultPath: downloadDirOf(acc), properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0] || !findAcc(id)) return;
  acc.downloadDir = r.filePaths[0];
  saveAccounts();
}
function openDownloadDir(id) {
  const acc = findAcc(id);
  if (!acc) return;
  const dir = downloadDirOf(acc);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  // 只打开文件夹：路径如果指向的是文件（比如 accounts.json 被改过），什么都不做，绝不运行它
  try { if (!fs.statSync(dir).isDirectory()) return; } catch { return; }
  shell.openPath(dir);
}

async function createView(acc, loadDelay = 0) {
  const ses = session.fromPartition(`persist:wa-${acc.id}`);
  const r = fingerprint.resolve(acc.fingerprint);
  // 网络请求层面的 UA 和语言（包括 Service Worker 发出的请求）
  ses.setUserAgent(r.userAgent, r.acceptLanguage);
  setupPermissions(ses);
  // 代理没设好之前先关掉拼写检查，免得词典下载走真实 IP
  ses.setSpellCheckerEnabled(false);
  setupDownloads(acc, ses);
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
  if (p.error || p.error || !LITE_SCHEMES.includes(p.scheme)) return null;
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
  liteHost.on('state', ({ id, status, qr, me }) => {
    const acc = findAcc(id);
    if (!acc || !isLite(acc)) return;
    const prev = liteStates.get(id)?.status;
    liteStates.set(id, { status, qr: status === 'qr' ? qr : null });
    if (status === 'open') { loginStates.set(id, 'logged_in'); noteLoggedIn(id, 'logged_in'); if (me) liteMe.set(id, me); setDetectedPhone(acc, waPage.parseWid(me)); }
    if (['qr', 'qrExpired', 'loggedOut'].includes(status)) loginStates.set(id, 'needs_qr');
    if (['qr', 'qrExpired', 'loggedOut'].includes(status)) mcp?.controller.gate.clearAccount(id);
    const make = LITE_PROBLEMS[status];
    if (make) problems.set(id, { kind: status, ...make(acc) });
    else if (status === 'open' || status === 'qr') problems.delete(id);
    // 掉线、被封：不管有没有关通知都提醒
    if (prev !== status && status === 'loggedOut') notifier.notify(acc, '已退出登录，需要重新扫码。点这里打开这个号。');
    if (prev !== status && status === 'banned') notifier.notify(acc, 'WhatsApp 拒绝了这个号的连接，可能被封了。');
    if (prev !== status && status === 'banned') team?.recordEvent(acc, 'banned');
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
  if (translator) translator.forgetAccount(id);
  if (floatCore) floatCore.forget(id);
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
  } else if (['lowMemoryMode', 'closeToTray', 'openAtLogin', 'sidebarCollapsed', 'showUpdateButton'].includes(key)) {
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
  translator = new Translator({ dir: app.getPath('userData'), safeStorage, sessionFor: translateSession });
  applyTranslateNet().catch(() => {});
  setupFloatCore();
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
  if (!['replies', 'customers', 'translate'].includes(tab)) return;
  panelTab = tab;
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
  if (ok) pushFloat(); // 悬浮窗和面板的目标语言可能跟着这个客户变
  return ok ? panelData() : null;
});
handleShell('cust:delete', (id) => {
  if (typeof id === 'string' && customerStore.get(id) && !parkedCustomer(customerStore.get(id))) customerStore.remove(id);
  return panelData();
});
handleShell('panel:copy', (text) => { if (typeof text === 'string') clipboard.writeText(text.slice(0, 4000)); return true; });
// 插入到聊天框：等于用户自己按 Ctrl+V（会覆盖剪贴板），不发回车、不模拟按键，发送永远由人来按。
// 面板画出来时记下的账号必须还是当前账号，并且没锁、页面正常，否则拒绝，免得贴到别的号里
function insertText(accountId, text) {
  if (typeof accountId !== 'string' || typeof text !== 'string' || !text) return 'bad';
  const acc = findAcc(accountId);
  if (!acc || accountId !== activeId || page !== 'account' || locked || problems.has(accountId)) return 'changed';
  if (isLite(acc)) return 'lite'; // 轻量模式的输入框在软件界面里，由界面自己填
  const view = views.get(accountId);
  if (!view || view.webContents.isDestroyed()) return 'changed';
  clipboard.writeText(text.slice(0, 4000));
  view.webContents.focus();
  view.webContents.paste();
  return 'ok';
}
handleShell('panel:insert', ({ accountId, text } = {}) => insertText(accountId, text));
handleShell('panel:export', async ({ kind, format } = {}) => {
  if (!STORE_LABEL[kind]) return null;
  const store = storeOf(kind);
  const rows = kind === 'customers' ? panelData().customers : store.list();
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
  return { count: rows.length };
});
handleShell('panel:import', async ({ kind } = {}) => {
  if (!STORE_LABEL[kind]) return null;
  const r = await dialog.showOpenDialog(win, {
    title: STORE_LABEL[kind][2],
    properties: ['openFile'],
    filters: [{ name: 'CSV 或 JSON', extensions: ['csv', 'json'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const res = records.readImport(kind, r.filePaths[0]);
  if (res.error) return { error: res.error };
  const store = storeOf(kind);
  let added = 0;
  for (const row of res.rows) {
    const data = { ...row, id: undefined };
    // 客户：文件里的账号编号对得上就用它，否则记到当前账号
    if (kind === 'customers') data.accountId = typeof row.accountId === 'string' && findAcc(row.accountId) ? row.accountId : activeId || '';
    if (store.upsert(data, { save: false, imported: true })) added += 1;
  }
  store.save();
  return { added, skipped: res.rows.length - added, data: panelData(), modes: modeStore.list() };
});
// ---- 翻译（只翻用户自己放进来的文字；不读页面、不自动发送） ----
// 翻译请求用单独的内存会话，和任何 WhatsApp 账号都不共用 cookie 和代理
function translateSession(local) {
  return session.fromPartition(local ? 'wa-translate-local' : 'wa-translate');
}
async function applyTranslateNet() {
  const net = translator.load().network;
  const remote = translateSession(false);
  if (net.mode === 'proxy' && net.proxyUrl) await remote.setProxy({ proxyRules: net.proxyUrl, proxyBypassRules: '<local>' });
  else await remote.setProxy({ mode: net.mode === 'direct' ? 'direct' : 'system' });
  await translateSession(true).setProxy({ mode: 'direct' }); // 本机模型不走代理
}
const trState = () => ({ config: translator.publicConfig(), modes: modeStore.list() });
handleShell('tr:config', () => trState());
handleShell('tr:provider:save', (data) => { const r = translator.saveProvider(data); pushFloat(); return { ...r, ...trState() }; });
handleShell('tr:provider:delete', (id) => { if (typeof id === 'string') translator.deleteProvider(id); pushFloat(); return trState(); });
handleShell('tr:fix:zhipu', () => ({ ...translator.addZhipuForFix(), ...trState() }));
handleShell('tr:roles', (roles) => { translator.setRoles(roles && typeof roles === 'object' ? roles : {}); pushFloat(); return trState(); });
handleShell('tr:role', (text) => ({ ...translator.setRolePrompt(text), ...trState() }));
handleShell('tr:network', async (net) => {
  // 翻译代理不能和任何账号的代理是同一个地址端口：否则会共用出口，带密码的代理还会被自动填上那个号的账号密码
  if (net && net.mode === 'proxy') {
    let u = null;
    try { u = new URL(String(net.proxyUrl || '').trim()); } catch {}
    const norm = (h) => { const x = String(h || '').replace(/^\[|\]$/g, '').toLowerCase(); return ['localhost', '127.0.0.1', '::1'].includes(x) ? 'loopback' : x; };
    const same = u && accounts.some((a) => { const p = proxy.parse(a.proxy); return p && !p.error && norm(p.host) === norm(u.hostname) && String(p.port) === String(u.port); });
    if (same) return { error: '这个代理端口已经给某个账号用了，翻译请用别的端口（或选“跟随系统代理”）', ...trState() };
  }
  const r = translator.setNetwork(net && typeof net === 'object' ? net : {});
  if (r.ok) { try { await applyTranslateNet(); } catch { return { error: '代理设置没生效', ...trState() }; } }
  return { ...r, ...trState() };
});
handleShell('tr:test', (id) => (typeof id === 'string' ? translator.test(id) : { error: '找不到这个服务商' }));
// 用户点的翻译（面板、悬浮窗写中文）优先：自动翻译正在跑时等它这一条翻完（最多 35 秒），
// 等的这段时间自动翻译不再取下一条。等的时候点“取消”只取消自己，不打断自动翻译那条。
const userTr = { waiting: 0, running: false, gen: 0 };
async function userTranslate(args) {
  const gen = userTr.gen;
  const until = Date.now() + 35000;
  userTr.waiting += 1;
  try {
    for (;;) {
      if (userTr.gen !== gen) return { error: '已取消', kind: 'cancel' };
      if (!translator.busy) {
        userTr.running = true;
        let r;
        try { r = await translator.translate(args); } finally { userTr.running = false; }
        // 面板和悬浮窗同时点：后一个继续等
        if (!(r && r.kind === 'busy')) return r;
      }
      if (Date.now() > until) return { error: '上一段还在翻译', kind: 'busy' };
      await new Promise((res) => setTimeout(res, 250));
    }
  } finally {
    userTr.waiting -= 1;
  }
}
function userCancel() {
  if (userTr.running) return translator.cancel();
  userTr.gen += 1;
  return true;
}
handleShell('tr:run', async ({ text, modeId, target, source, ctxAccount, fix, draft } = {}) => {
  // 工作台写回复：带上当前对话最近几条当上下文（只在请求的号还是当前号时）
  const context = typeof ctxAccount === 'string' && ctxAccount === activeId && floatCore ? floatCore.contextOf(activeId) : undefined;
  // __back：回译成中文核对，用固定的忠实翻译提示词
  // 纠错要发的译文：内置校对提示词，对照中文原文和上下文改；设了纠错服务商就用它
  if (fix === true && typeof draft === 'string' && draft.trim()) return userTranslate({ text, mode: FIX_OUT, target, context, draft, fix: true });
  let mode = modeId === '__back' ? { prompt: '把用户的文字忠实地翻译成中文，不增不减，不润色。', temperature: 0 }
    : typeof modeId === 'string' ? modeStore.get(modeId) : null;
  return userTranslate({ text, mode, target, source, context: modeId === '__back' ? undefined : context });
});
handleShell('tr:cancel', () => userCancel());
// 当前对话对上的客户（用客户填的语言翻译）。只在用户点翻译时读一次对话标题，隔离环境只读，不碰页面
const chatCustomer = (accId, title) => matchChatCustomer(customerStore.list().filter((c) => !parkedCustomer(c)), accId, title);
handleShell('tr:chatlang', async (accountId) => {
  const acc = findAcc(accountId);
  if (!acc || accountId !== activeId || page !== 'account' || locked || isLite(acc) || problems.has(acc.id)) return null;
  const view = views.get(acc.id);
  if (!view || view.webContents.isDestroyed()) return null;
  const r = await waPage.readOpenChat(view.webContents);
  if (!r.ok || accountId !== activeId) return null;
  const c = chatCustomer(acc.id, r.title);
  return { title: r.title, lang: c ? c.lang : '', name: c ? c.name : '' };
});
handleShell('tr:lang', ({ accountId, lang } = {}) => { if (findAcc(accountId)) translator.setAccountLang(accountId, lang); return trState(); });
handleShell('tmode:save', (data) => {
  if (!data || typeof data !== 'object') return { error: '数据不对' };
  const rec = modeStore.upsert({ id: data.id, name: data.name, direction: data.direction, prompt: data.prompt, temperature: data.temperature });
  return rec ? { ok: true, id: rec.id, ...trState() } : { error: modeStore.list().length >= 200 ? '最多 200 个模式' : '名字和提示词都要填', ...trState() };
});
handleShell('tmode:delete', (id) => { if (typeof id === 'string') modeStore.remove(id); return trState(); });

// ---- 悬浮翻译窗（shen 2026-10-24 选的方案 B） ----
// 只读当前打开的对话（隔离环境，见 wa-page.js 的 readOpenChat），不改页面、不碰输入框。
// 悬浮窗是软件自己的小视图，叠在 WhatsApp 视图上面；关掉就销毁。读到的消息和译文只在内存里。
const FLOAT_W = 340;
const FLOAT_MIN_H = 260;
const FLOAT_MAX_H = 480;
const FLOAT_PILL = { width: 130, height: 34 };
const FLOAT_COMPOSE_GAP = 76; // 底部留给 WhatsApp 输入框，不盖住
let floatView = null;
let floatOpen = false;
let floatTimer = null;
let floatFails = 0;
let floatReadable = 'loading'; // ok | nochat | unreadable | loading
let floatArea = null; // 账号视图的位置（layout 算出来的）
let floatCore = null;
let trStore = null; // 收到的消息的译文，永久存在磁盘上
// 自动翻译默认开，只有手动关掉的号是 false
const floatAuto = (id) => !!id && translator.load().accountAuto[id] !== false;
// 读当前对话的条件之一：悬浮窗开着，或者右侧面板开着（翻译页显示收到的消息，其他页给“翻译”记未读）
const readerOn = () => (floatOpen && !!floatView) || panelShown();
let floatBusy = false;
function floatInMode() {
  const cfg = translator.load();
  const list = modeStore.list().filter((m) => m.direction === 'in' || m.direction === 'both');
  return list.find((m) => m.id === cfg.floatInMode) || list[0] || null;
}
// 纠错（AI 校对）的内置提示词：[原文] = <text>，[译文] = <draft>，[上下文] = <context>
const FIX_IN = {
  prompt: '你是翻译校对员。<text> 里是客户原文，<draft> 里是当前中文译文，<context> 里是最近聊天记录，只用来理解意思，不要翻译。'
    + '对照原文和上下文检查译文：错译、漏译、多译、语气不对，人名、数字、金额、日期、型号是否正确，俚语、缩写、错别字是否理解对。'
    + '只输出改好的中文译文，不要解释；如果已经正确，原样输出。',
  temperature: 0.2,
};
const FIX_OUT = {
  prompt: '你是{目标语言}母语的校对员。<text> 里是中文原文，<draft> 里是{目标语言}译文，<context> 里是最近聊天记录，只用来理解意思。'
    + '检查译文是否准确表达原文、有没有漏译多译，修正语法和拼写，让说法自然、符合当地人聊天习惯，保持原来的语气。'
    + '保留数字、链接、表情和换行，不增加任何承诺。只输出改好的译文，不要解释。',
  temperature: 0.2,
};
function setupFloatCore() {
  // 先用上次的位置（D 盘有就是 D 盘，否则 C），后台查 D 盘是不是本机固定硬盘，定下来后把另一处的译文搬过来
  const oldTrDir = path.join(app.getPath('userData'), 'translations');
  const dTrDir = 'D:\\WAswitch\\translations';
  const guess = process.platform === 'win32' && fs.existsSync(dTrDir) ? dTrDir : oldTrDir;
  trStore = new TrStore(guess);
  pickTrDir(oldTrDir, { preferred: dTrDir }).then((dir) => {
    if (!trStore) return;
    trStore.flush();
    if (process.platform === 'win32') migrateTr(dir === dTrDir ? oldTrDir : dTrDir, dir);
    if (dir !== trStore.dir) { trStore.setDir(dir); console.log(`译文存在：${dir}`); }
  }).catch((e) => console.warn(`译文位置检查失败：${e.message}`));
  floatCore = new FloatCore({
    store: trStore,
    translate: (text, { fix, context, prev } = {}) => {
      // 纠错：不用平时的模式，用内置的校对提示词，对照现在的译文和上下文改
      const draft = fix && typeof prev === 'string' ? prev : '';
      const mode = fix ? (draft ? FIX_IN : { prompt: '结合上下文，把用户的文字准确地翻译成中文。', temperature: 0.2 }) : floatInMode();
      if (!mode) return Promise.resolve({ error: '没有“收到”方向的翻译模式', kind: 'input' });
      // 用户点的翻译在等：先让它
      if (userTr.waiting || userTr.running) return Promise.resolve({ error: '让用户先翻', kind: 'busy' });
      return translator.translate({ text, mode, target: '中文', context, draft, fix: !!fix });
    },
  });
  floatCore.onChange = (accId) => { if (accId === activeId) pushFloat(); };
}
// 读页面的条件：悬浮窗开着、在账号页、窗口看得见、没锁、号正常、页面不在加载
function floatCanRead() {
  if (!readerOn() || page !== 'account' || locked || !win || !win.isVisible() || win.isMinimized()) return null;
  const acc = findAcc(activeId);
  if (!acc || isLite(acc) || problems.has(acc.id)) return null;
  const view = views.get(acc.id);
  if (!view || view.webContents.isDestroyed() || view.webContents.isLoading()) return null;
  return { acc, wc: view.webContents };
}
async function floatTick() {
  floatTimer = null;
  if (!readerOn() || floatBusy) return;
  const target = floatCanRead();
  let delay = 2000;
  if (target) {
    floatBusy = true;
    let r;
    try { r = await waPage.readOpenChat(target.wc); } finally { floatBusy = false; }
    if (!readerOn() || target.acc.id !== activeId) { scheduleFloat(500); return; }
    if (r.ok) {
      // 打开的对话里还没有消息也算读到了（悬浮窗会提示没有文字消息）
      floatFails = 0;
      const was = floatReadable;
      floatReadable = 'ok';
      const cfg = translator.load();
      let changed = floatCore.ingest(target.acc.id, r, { auto: floatAuto(target.acc.id), dailyCap: cfg.dailyCap });
      if (changed) changed = rememberDetected(target.acc.id) || changed;
      if (changed || was !== 'ok') pushFloat();
    } else if (r.why === 'nochat') {
      // 没打开对话：不算失败，3 秒后再看
      floatFails = 0;
      delay = 3000;
      if (floatReadable !== 'nochat') { floatReadable = 'nochat'; pushFloat(); }
    } else {
      // 读不到，或对话里有消息行但一条都认不出来：连续 3 次就放慢到 30 秒一次，并提示
      floatFails += 1;
      if (floatFails >= 3) {
        delay = 30000;
        if (floatReadable !== 'unreadable') { floatReadable = 'unreadable'; pushFloat(); }
      }
    }
  }
  scheduleFloat(delay);
}
function scheduleFloat(ms) {
  if (floatTimer) clearTimeout(floatTimer);
  floatTimer = readerOn() ? setTimeout(floatTick, ms) : null;
}
// 从最近收到的几条认出客户用的语言，记在这个对话上（手动选过的不改）
function rememberDetected(accId) {
  const v = floatCore.viewOf(accId);
  if (!v.chatKey || !v.items.length) return false;
  const lang = detectLang(v.items.slice(-5).map((it) => it.text).join('\n'));
  if (!lang || lang === '中文') return false;
  return translator.setChatLang(`${accId}:${v.chatKey}`, lang, 'detected');
}
// 发出的目标语言和它的来源：手动选的 > 客户名单里填的 > 认出来的 > 这个号的默认语言
function outTarget(acc, v) {
  const key = acc && v.chatKey ? `${acc.id}:${v.chatKey}` : '';
  const kept = key ? translator.chatLang(key) : null;
  const chat = acc && v.title ? chatCustomer(acc.id, v.title) : null;
  if (kept && kept.src === 'manual') return { lang: kept.lang, from: 'manual', name: chat ? chat.name : '', auto: autoTarget(acc, chat, null) };
  return { ...autoTarget(acc, chat, kept), auto: null };
}
// “自动”会翻成哪种：客户名单里填的 > 从客户消息认出来的 > 这个号的默认语言 > 英语
function autoTarget(acc, chat, kept) {
  const cfg = translator.load();
  if (chat) return { lang: chat.lang, from: 'customer', name: chat.name };
  if (kept && kept.src === 'detected') return { lang: kept.lang, from: 'detected', name: '' };
  return { lang: (acc && cfg.accountLang[acc.id]) || '英语', from: 'default', name: '' };
}
function floatState() {
  const cfg = translator.load();
  const acc = findAcc(activeId);
  const modes = modeStore.list();
  const v = acc ? floatCore.viewOf(acc.id) : { title: '', items: [], paused: '' };
  const primary = translator.provider(cfg.primaryId);
  const inMode = floatInMode();
  const out = outTarget(acc, v);
  return {
    accountId: acc ? acc.id : '',
    accountName: acc ? acc.name : '',
    lite: !!(acc && isLite(acc)),
    readable: floatReadable,
    title: v.title,
    items: v.items,
    paused: floatAuto(acc && acc.id) ? v.paused : '',
    today: v.today || 0,
    auto: !!(acc && floatAuto(acc.id)),
    dailyCap: cfg.dailyCap,
    hasProvider: !!primary,
    // 默认翻译服务还没填密钥：翻译页顶上显示黄条和“去填密钥”
    needKey: primary && needsKey(primary) ? { id: primary.id, name: primary.name || '翻译服务', others: (cfg.providers || []).some((p) => p.id !== primary.id && !needsKey(p)) } : null,
    providerName: primary ? primary.name : '',
    primaryId: primary ? primary.id : '',
    fallbackId: cfg.fallbackId || '',
    providers: (cfg.providers || []).map((p) => ({ id: p.id, name: p.name, model: p.model || '' })), // 翻译页的“换模型”下拉，不带密钥
    engine: primary ? (primary.model || primary.name) : '',
    collapsed: cfg.float.collapsed,
    modes: {
      out: modes.filter((m) => m.direction !== 'in').map(({ id, name }) => ({ id, name })),
      in: modes.filter((m) => m.direction !== 'out').map(({ id, name }) => ({ id, name })),
    },
    inModeId: inMode ? inMode.id : '',
    langs: translator.publicConfig().langs,
    target: out.lang,
    targetSrc: out.from, // manual | customer | detected | default
    autoTarget: (out.auto || out).lang, // 下拉里“自动（…）”显示的语言
    accountLang: (acc && cfg.accountLang[acc.id]) || '', // 读不到对话时，手动选的语言记在号上
    canRemember: !!v.chatKey, // 认得出是哪个对话，才能把语言记在对话上
    // 悬浮窗用：不是号的默认语言时，手动改只管这一个对话
    targetFrom: out.from === 'default' ? '' : (out.name || '这个对话'),
  };
}
function pushFloat() {
  const both = floatView && !floatView.webContents.isDestroyed();
  const dock = panelShown() && shellView && !shellView.webContents.isDestroyed();
  if (!both && !dock) return;
  const st = floatState();
  if (both) floatView.webContents.send('float:state', st);
  if (dock) shellView.webContents.send('dock:state', st);
}
let floatLastAcc = null;
function layoutFloat(area) {
  floatArea = area;
  // 换了号：重新开始读，悬浮窗和面板只显示新号的内容
  if (readerOn() && activeId !== floatLastAcc) {
    floatLastAcc = activeId;
    floatFails = 0;
    floatReadable = 'loading';
    pushFloat();
    scheduleFloat(200);
  } else if (readerOn() && !floatTimer && !floatBusy) scheduleFloat(300); // 面板刚打开、回到账号页、解锁
  if (!readerOn()) floatLastAcc = null;
  if (!floatView) return;
  const acc = findAcc(activeId);
  const show = floatOpen && page === 'account' && !locked && !!acc && !problems.has(acc.id) && area.width > FLOAT_W + 40;
  floatView.setVisible(show);
  if (!show) return;
  const pos = translator.load().float;
  const pill = pos.collapsed;
  const w = pill ? FLOAT_PILL.width : FLOAT_W;
  const h = pill ? FLOAT_PILL.height : Math.max(FLOAT_MIN_H, Math.min(FLOAT_MAX_H, area.height - 64 - FLOAT_COMPOSE_GAP));
  const maxX = area.x + area.width - w - 8;
  const maxY = area.y + area.height - h - FLOAT_COMPOSE_GAP;
  const x = Math.max(area.x + 8, Math.min(maxX, area.x + area.width - w - pos.dx));
  const y = Math.max(area.y + 8, Math.min(Math.max(area.y + 8, maxY), area.y + pos.dy));
  floatView.setBounds({ x, y, width: w, height: h });
  // 账号视图重建时会被加到最上面：保证悬浮窗始终在最上层
  const kids = win.contentView.children;
  if (kids[kids.length - 1] !== floatView) win.contentView.addChildView(floatView);
}
function openFloat() {
  if (floatView) { floatOpen = true; layout(); scheduleFloat(0); pushState(); return; }
  floatOpen = true;
  floatView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'float', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  floatView.setBackgroundColor('#00000000');
  lockLocalPage(floatView.webContents);
  floatView.webContents.loadFile(path.join(__dirname, 'float', 'index.html'));
  win.contentView.addChildView(floatView);
  floatReadable = 'loading';
  floatFails = 0;
  layout();
  scheduleFloat(300);
  pushState();
}
function closeFloat() {
  floatOpen = false;
  if (floatTimer) { clearTimeout(floatTimer); floatTimer = null; }
  if (floatView) {
    const v = floatView;
    floatView = null;
    try { win.contentView.removeChildView(v); } catch {}
    if (!v.webContents.isDestroyed()) v.webContents.close();
  }
  focusActive();
  pushState();
}
// 只接受悬浮窗自己发来的
const fromFloat = (e) => !!floatView && !floatView.webContents.isDestroyed() && e.sender === floatView.webContents;
const handleFloat = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
  if (!fromFloat(e)) throw new Error('not allowed');
  return fn(...args);
});
const onFloat = (channel, fn) => ipcMain.on(channel, (e, ...args) => { if (fromFloat(e)) fn(...args); });
onShell('float:toggle', (on) => { if (typeof on === 'boolean' ? on : !floatOpen) openFloat(); else closeFloat(); });
onFloat('float:ready', () => pushFloat());
onFloat('float:close', () => closeFloat());
onFloat('float:collapse', (on) => { translator.setFloat({ pos: { collapsed: on === true } }); layout(); pushFloat(); });
let floatDrag = null;
onFloat('float:move', ({ dx, dy } = {}) => {
  if (!floatView || !floatArea || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const b = floatView.getBounds();
  floatDrag = floatDrag || { x: b.x, y: b.y };
  floatDrag.x += Math.max(-500, Math.min(500, dx));
  floatDrag.y += Math.max(-500, Math.min(500, dy));
  const a = floatArea;
  const x = Math.max(a.x + 8, Math.min(a.x + a.width - b.width - 8, floatDrag.x));
  const y = Math.max(a.y + 8, Math.min(Math.max(a.y + 8, a.y + a.height - b.height - FLOAT_COMPOSE_GAP), floatDrag.y));
  floatView.setBounds({ ...b, x, y });
});
onFloat('float:moveend', () => {
  floatDrag = null;
  if (!floatView || !floatArea) return;
  const b = floatView.getBounds();
  translator.setFloat({ pos: { dx: floatArea.x + floatArea.width - b.width - b.x, dy: b.y - floatArea.y } });
});
function readerItem(h, fix) {
  if (typeof h !== 'string' || !activeId) return null;
  floatCore.manual(activeId, h, fix === true);
  pushFloat();
  return { ok: true };
}
function readerAuto(on) {
  const acc = findAcc(activeId);
  if (!acc) return null;
  const cfg = translator.load();
  translator.setFloat({ accId: acc.id, auto: on === true });
  if (on) floatCore.backfill(acc.id, { dailyCap: cfg.dailyCap });
  pushFloat();
  return { ok: true };
}
const readerInMode = (id) => { if (typeof id === 'string' && modeStore.get(id)) translator.setFloat({ inMode: id }); pushFloat(); return true; };
handleFloat('float:item', (h) => readerItem(h, false));
handleFloat('float:auto', readerAuto);
handleFloat('float:inmode', readerInMode);
// 面板“翻译”页用的同一套（只接受软件界面发来的）
handleShell('dock:get', () => floatState());
handleShell('dock:item', ({ h, fix } = {}) => readerItem(h, fix));
handleShell('dock:suggest', ({ accountId, h, take } = {}) => (accountId === activeId && typeof h === 'string' ? floatCore.suggestion(activeId, h, take === true) : false));
handleShell('dock:edit', ({ accountId, h, text } = {}) => {
  if (accountId !== activeId || typeof h !== 'string' || typeof text !== 'string') return false;
  return floatCore.edit(activeId, h, text);
});
handleShell('dock:auto', readerAuto);
handleShell('dock:inmode', readerInMode);
// 手动选这个对话的客户语言，记住；lang 为空 = 忘掉，回到自动。对话已经换了就不记
handleShell('dock:lang', ({ accountId, title, lang } = {}) => {
  const acc = findAcc(accountId);
  if (!acc || accountId !== activeId) return floatState();
  const v = floatCore.viewOf(acc.id);
  if (v.chatKey && v.title === title) translator.setChatLang(`${acc.id}:${v.chatKey}`, lang || '', 'manual');
  else if (!v.chatKey) translator.setAccountLang(acc.id, lang || ''); // 读不到对话（轻量模式等）：改这个号的默认语言，空 = 回到自动
  pushFloat();
  return floatState();
});
handleFloat('float:compose', ({ text, modeId, target, accountId } = {}) => {
  if (accountId !== activeId) return { error: '当前账号变了，请重新翻译', kind: 'input' };
  const mode = typeof modeId === 'string' ? modeStore.get(modeId) : null;
  return userTranslate({ text, mode, target, context: floatCore.contextOf(activeId) }); // 带上当前对话最近几条当上下文
});
handleFloat('float:cancel', () => userCancel());
handleFloat('float:insert', ({ accountId, text } = {}) => insertText(accountId, text));
handleFloat('float:copy', (text) => { if (typeof text === 'string') clipboard.writeText(text.slice(0, 4000)); return true; });
handleFloat('float:lang', ({ accountId, lang } = {}) => { if (accountId === activeId && findAcc(accountId)) translator.setAccountLang(accountId, lang); pushFloat(); return true; });
handleShell('tr:dailycap', (n) => { translator.setFloat({ dailyCap: n }); pushFloat(); return trState(); });
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
onShell('open-logs', () => { const dir = log.logDir(); if (dir) shell.openPath(dir); });
// 关于页：译文存在哪、占多大
handleShell('trdir:info', async () => {
  if (!trStore) return null;
  const dir = trStore.dir;
  return { dir, ...(await trDirInfo(dir)) };
});
onShell('trdir:open', () => {
  if (!trStore) return;
  const dir = trStore.dir;
  try { fs.mkdirSync(dir, { recursive: true }); if (!fs.statSync(dir).isDirectory()) return; } catch { return; }
  shell.openPath(dir);
});

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

// 立即清理内存：刷新所有没有未读的后台账号
handleShell('mem:clean', () => memoryManager.cleanNow());

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
    {
      label: isLite(acc) ? '拼写检查（轻量模式不支持）'
        : process.platform === 'darwin' ? '拼写检查（英文）'
          : `拼写检查（英文，第一次会${acc.proxy ? '通过本号代理' : '直连'}下载词典）`, type: 'checkbox', checked: acc.spellcheck, enabled: !isLite(acc),
      click: () => setSpellcheck(id, !acc.spellcheck),
    },
    {
      label: isLite(acc) ? '下载文件夹（轻量模式不支持）' : '下载文件夹',
      enabled: !isLite(acc),
      submenu: isLite(acc) ? [] : [
        { label: downloadDirOf(acc).length > 60 ? `…${downloadDirOf(acc).slice(-58)}` : downloadDirOf(acc), enabled: false },
        { label: '打开文件夹', click: () => openDownloadDir(id) },
        { label: '更改…', click: () => pickDownloadDir(id) },
        { label: '恢复默认', enabled: !!acc.downloadDir, click: () => { acc.downloadDir = ''; saveAccounts(); } },
      ],
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

// ---------- 编辑账号（新建和修改共用） ----------

handleShell('editor:load', (id) => {
  const acc = findAcc(id);
  return {
    id: acc ? acc.id : null,
    isNew: !acc,
    name: acc ? acc.name : String(editorPrefill?.name || nextName()).slice(0, 40),
    note: acc ? acc.note : '',
    phone: acc ? acc.phone : '',
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
    // 别的直连号（编辑页选直连时提醒一句同一出口 IP）
    otherDirect: accounts.filter((a) => a.id !== id && !a.proxy).map((a) => a.name),
    liteAvailable: canEncrypt(safeStorage),
    platform: process.platform,
  };
});

// 编辑页的代理预设：本机 7890–7899 哪些端口开着、能不能用、被哪个号占了
handleShell('editor:ports', async (id) => {
  const list = await ports.probeAll();
  const used = ports.usage(accounts.filter((a) => !isParked(a)), id);
  return list.map((p) => ({ ...p, usedBy: used[p.port] || [] }));
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

handleShell('editor:save', async ({ id, name, note, phone, color, proxy: proxyText, password, region, mode, primary, liteConfirm, allowCalls } = {}) => {
  name = String(name || '').trim().slice(0, 40);
  note = cleanNote(note);
  phone = cleanPhone(phone);
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
    // 直连可以（用户自己选，编辑页有风险提示）；设了代理就要测试通过、出口不能和主号相同
    if (parsed && !LITE_SCHEMES.includes(parsed.scheme)) return { error: '轻量模式只支持 socks5 和 http 代理' };
    const proxyChanged = !acc || acc.proxy !== proxyStored || !!String(password || '');
    if (parsed && proxyChanged) {
      if (!testedNow) return { error: '请先点“测试”，代理测试通过后才能保存' };
      const pe = await primaryExit(id);
      if (pe.error) return { error: pe.error };
      if (pe.ip && pe.ip === testedNow.ip) return { error: `这个代理的出口 IP（${testedNow.ip}）和主号「${pe.name}」相同。轻量小号必须和主号用不同的 IP，请换一个代理端口或节点。` };
    }
  }

  // 后台分来的号第一次保存：填了代理必须测试通过；不填就是直连（编辑页有一行风险提示，不拦）
  if (acc && acc.teamNeedsProxy && mode === 'web' && parsed && !testedNow) return { error: '请先点“测试”，代理测试通过后才能保存' };

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

  const teamFirstSave = !!(acc && acc.teamNeedsProxy);
  if (teamFirstSave) { acc.teamNeedsProxy = false; problems.delete(acc.id); }
  if (!acc) {
    acc = { id: String(Date.now()), name, note, phone, phoneManual: !!phone, color, proxy: proxyStored, proxyPassword: encPassword, exitLabel: tested ? tested.label : '', fingerprint: fingerprint.generate(region), muted: false, mode, primary: wantPrimary, liteKey, loggedIn: false, allowCalls: callsWanted };
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
    applyPhone(acc, phone);
    acc.color = color;
    acc.proxy = proxyStored;
    acc.proxyPassword = encPassword;
    saveAccounts();
    page = 'account';
    activeId = acc.id;
    if (changed || teamFirstSave) { problems.delete(acc.id); startLite(acc); }
    refresh();
  } else {
    acc.primary = wantPrimary;
    const changed = acc.proxy !== proxyStored || acc.proxyPassword !== encPassword || acc.fingerprint.region !== region || acc.allowCalls !== callsWanted;
    acc.allowCalls = callsWanted;
    if (acc.proxy !== proxyStored) { acc.exitLabel = ''; acc.lastExit = null; exitIps.delete(acc.id); exitChanges.delete(acc.id); }
    if (tested) { acc.exitLabel = tested.label; recordExit(acc, tested.ip); }
    acc.name = name;
    acc.note = note;
    applyPhone(acc, phone);
    acc.color = color;
    acc.proxy = proxyStored;
    acc.proxyPassword = encPassword;
    // 只改地区（时区），浏览器标识保持不变
    acc.fingerprint.region = region;
    saveAccounts();
    page = 'account';
    activeId = acc.id;
    if (changed || teamFirstSave) {
      destroyView(acc.id);
      problems.delete(acc.id);
      await createView(acc);
    }
    refresh();
  }
  notifier.refresh();
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
  // 多个号直连是允许的，只提醒一句（黄色，不算出错）
  if (direct.length > 1) items.push({ level: 'warn', title: `${direct.join('、')} 都是直连`, detail: '这几个号用同一个出口 IP，在 WhatsApp 看来在同一个地方，有被关联的风险。' });
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const acc of accounts) {
    const p = proxy.parse(acc.proxy);
    if (!p) { if (direct.length < 2) items.push({ level: 'warn', title: `${acc.name}：直连`, detail: '没有设代理，跟随电脑的系统代理：Clash 开着系统代理时走 Clash 当前节点，关了就是这台电脑的真实 IP。' }); continue; }
    if (p.error) { items.push({ level: 'bad', title: `${acc.name}：代理设置有误`, detail: p.error }); continue; }
    const key = `${p.host}:${p.port}`;
    byPort.set(key, [...(byPort.get(key) || []), acc.name]);
    if (isLite(acc)) {
      if (!LITE_SCHEMES.includes(p.scheme)) items.push({ level: 'bad', title: `${acc.name}：轻量模式不支持这种代理`, detail: '请换成 socks5:// 或 http:// 开头的代理地址。' });
    } else {
      // 会话里的代理规则不能带“直连”兜底
      const rule = await session.fromPartition(`persist:wa-${acc.id}`).resolveProxy(WA_URL);
      if (/DIRECT/i.test(rule)) items.push({ level: 'bad', title: `${acc.name}：代理可能漏走本机网络`, detail: '请重启 WAswitch 后再检查。' });
    }
    const res = await proxy.test(acc.proxy, proxy.decryptPassword(acc.proxyPassword));
    if (!res.ok) { items.push({ level: 'bad', title: `${acc.name}：代理连不上`, detail: res.error }); continue; }
    recordExit(acc, res.ip);
    acc.exitLabel = regionName(res.country);
    byIp.set(res.ip, [...(byIp.get(res.ip) || []), acc.name]);
    const tz = fingerprint.resolve(acc.fingerprint).timezone;
    const place = [acc.exitLabel, res.city].filter(Boolean).join(' · ');
    // 轻量模式没有浏览器环境，不涉及时区
    if (isLite(acc)) { items.push({ level: 'ok', title: `${acc.name}（轻量模式）：IP ${res.ip}（${place}）` }); continue; }
    // 跟随本机时，实际时区就是本机时区
    const effTz = tz || localTz;
    const fixRegion = regionForTimezone(res.timezone);
    const fix = fixRegion ? { id: acc.id, region: fixRegion, label: regionLabel(fixRegion) } : null;
    if (effTz !== res.timezone) {
      items.push({
        level: 'warn',
        title: `${acc.name}：IP ${res.ip}（${place}）`,
        detail: tz
          ? `IP 在 ${res.timezone} 时区，账号设的是 ${tz}，对不上。${fix ? '' : '请在编辑账号里选一个最接近的地区。'}`
          : `时区跟随本机（${localTz}），但 IP 在 ${res.timezone}，对不上。${fix ? '' : '请在编辑账号里选一个最接近的地区。'}`,
        fix,
      });
    } else {
      items.push({ level: 'ok', title: `${acc.name}：IP ${res.ip}（${place}）`, detail: '时区和 IP 一致。' });
    }
  }
  for (const [key, names] of byPort) {
    if (names.length > 1) items.push({ level: 'bad', title: `${names.join('、')} 共用同一个代理端口`, detail: `${key}。它们会用同一个 IP，建议每个号一个端口。` });
  }
  for (const [ip, names] of byIp) {
    if (names.length > 1) items.push({ level: 'bad', title: `${names.join('、')} 的出口 IP 相同`, detail: `${ip}。在 WhatsApp 看来这几个号在同一个地方。` });
  }
  // 只看走代理的轻量号（直连的轻量号在另一个进程里，上面已经算进直连号）
  if (accounts.some((a) => isLite(a) && proxy.parse(a.proxy))) {
    items.push(liteGuardHits
      ? { level: 'bad', title: `轻量模式：拦下了 ${liteGuardHits} 次绕过代理的连接`, detail: '没有发出去，本机 IP 没暴露。日志里记着拦下的是哪些连接。', logs: true }
      : { level: 'ok', title: '轻量模式：都走代理，没有漏' });
  }
  // WebRTC：走代理的号必须只走代理；直连号按“允许通话”开关分别显示
  const webrtcBad = accounts.filter((a) => !isLite(a) && views.has(a.id) && views.get(a.id).webContents.getWebRTCIPHandlingPolicy() !== webrtcPolicy(a));
  const proxied = accounts.filter((a) => !isLite(a) && a.proxy);
  if (webrtcBad.length) items.push({ level: 'bad', title: `${webrtcBad.map((a) => a.name).join('、')}：通话的网络设置没生效`, detail: '请重启 WAswitch 后再检查。' });
  else if (proxied.length) items.push({ level: 'ok', title: '走代理的号：通话也走代理，不暴露本机 IP' });
  for (const a of accounts.filter((x) => !isLite(x) && !x.proxy && x.allowCalls)) {
    items.push({ level: 'warn', title: `${a.name}：允许通话（直连）`, detail: '通话会用本机 IP，可能和聊天的 IP 不一样。不打电话就在编辑账号里关掉。' });
  }
  const uaOk = accounts.every((a) => !/Electron|waswitch/i.test(fingerprint.resolve(a.fingerprint).userAgent));
  items.push({ level: uaOk ? 'ok' : 'bad', title: '浏览器标识正常，看不出是多开软件' });
  saveAccounts();
  pushState();
  return { items, time: new Date().toLocaleString('zh-CN') };
});

// 用户点了顶栏的“出口 IP 变了”：知道了，不再标黄
onShell('zoom', ({ id, dir } = {}) => { if (typeof id === 'string' && [1, -1, 0].includes(dir)) stepZoom(id, dir); });
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
onShell('update:check', () => updater?.userUpdate()); // 用户点的：下好后自动重启安装
onShell('update:check-only', () => updater?.check()); // 侧栏的检查更新按钮：只检查，下好后照常提醒，不自动重启
onShell('update:install', () => { if (!updater) return; if (updater.state.manual) updater.openMacInstaller(); else updater.install(); });

// 退出前让轻量模式后台进程把凭据和聊天缓存写盘（最多等 4 秒）
let liteFlushed = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (crmQueue) crmQueue.saveNow();
  if (netLog) netLog.flush();
  if (trStore) trStore.flush(); // 还没写盘的译文
  // 还没写盘的通知记录马上写
  if (notifLogTimer) {
    clearTimeout(notifLogTimer);
    notifLogTimer = null;
    try { fs.writeFileSync(notifLogFile(), JSON.stringify(notifLog || [])); } catch {}
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

