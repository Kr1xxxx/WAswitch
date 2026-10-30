// 自动更新。
//
// 只连 GitHub：github.com 和它放安装包的 objects.githubusercontent.com / release-assets.githubusercontent.com，
// 重定向到别的地方一律当失败。只走电脑本机网络直连：不用任何账号的代理，也不用系统代理设置
// （Clash 等的“系统代理”）。系统级 VPN / TUN 模式在网卡层接管流量，软件绕不开。
// 新版本刚发布时安装包还在打包上传（约 10 分钟），这时 latest*.yml 是 404：不算失败，过一会儿自己再查。
// 启动 1 分钟后查一次，之后每 1 小时查一次，有新版就自动下载。
//
// Windows：electron-updater 下载并校验 sha512。下载好后两种安装时机：
//   - 用户点“立即更新”（侧栏、关于页或托盘菜单）：马上静默安装并自动重新打开，不弹任何确认；
//   - 用户点“检查并更新”：下好后自动安装并重新打开，只等用户手上的事做完（30 秒内打过字、在编辑账号等）；
//   - 都没点：窗口缩在托盘、所有账号都没有未读、10 分钟内没有新消息、没有账号在登录或扫码、
//     没有消息在发、没有页面在重建时，自动静默安装并重启（重启后回到托盘）。窗口开着不会自己重启。
// macOS：没有签名证书，electron-updater 的 Mac 流程（Squirrel.Mac）用不了，自己做：
//   下载 zip，按 latest-mac.yml 里的 sha512 校验，用 ditto 解压，确认是 WAswitch.app、版本号对得上。
//   App 在「应用程序」里且有写权限时，和 Windows 一样的安装时机：App 退出后由一个小脚本替换旧的 WAswitch.app、
//   清掉“已损坏”标记（xattr -cr）、重新打开。替换失败会放回旧版并重新打开，下次改成手动安装。
//   App 不在「应用程序」里、在安装盘里直接运行、或者没有写权限时，提示用户把新的 WAswitch.app 拖进「应用程序」。
const { app, net, session, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const errtext = require('./errtext');

const OWNER = 'Kr1xxxx';
const REPO = 'WAswitch';
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const IDLE_POLL_MS = 60 * 1000;
const WAIT_POLL_MS = 5 * 1000; // 用户点了更新但还在打字：每 5 秒看一次停手没有
const FAIL_WARN_AT = 3; // 连续失败这么多次，关于页标黄
const IDLE_TIMEOUT_MS = 60 * 1000; // Mac 下载：这么久没收到数据就算失败
const STUCK_CHECKING_MS = 5 * 60 * 1000; // 检查超过 5 分钟没结果
const STUCK_DOWNLOAD_MS = 30 * 60 * 1000; // 下载 30 分钟没有进度
const PENDING_RETRY_MS = 10 * 60 * 1000; // 新版本还在上传时，过这么久再查
const MAC_QUIT_WAIT_S = 25; // 替换脚本最多等旧版本退出这么久
const APP_ID = 'com.waswitch.app';
const UPDATER_PARTITION = 'waswitch-updater'; // 更新专用的临时会话（不是 persist:，不碰账号）

// 更新专用会话：强制直连，不读系统代理
let directSession = null;
async function updaterSession() {
  if (!directSession) {
    const ses = session.fromPartition(UPDATER_PARTITION, { cache: false });
    await ses.setProxy({ mode: 'direct' });
    directSession = ses;
  }
  return directSession;
}

// 正在运行的 WAswitch.app 的路径（/Applications/WAswitch.app/Contents/MacOS/WAswitch → /Applications/WAswitch.app）
function appBundlePath(execPath = process.execPath) {
  const m = String(execPath).match(/^(\/.*?\.app)\/Contents\/MacOS\/[^/]+$/);
  return m ? m[1] : null;
}

// 不能自动替换的原因；null 表示可以
function replaceBlocker(bundle, home) {
  if (!bundle) return '找不到 WAswitch.app';
  if (/\/AppTranslocation\//.test(bundle) || bundle.startsWith('/Volumes/')) return '是从安装盘或下载文件夹直接打开的';
  const parent = path.dirname(bundle);
  if (parent !== '/Applications' && parent !== path.join(home, 'Applications')) return '不在「应用程序」文件夹里';
  try {
    fs.accessSync(parent, fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch { return '没有「应用程序」文件夹的写入权限'; }
  return null;
}

// App 退出后替换的脚本。参数：旧进程 pid、要替换的 WAswitch.app、新的 WAswitch.app、失败记录文件
// 先把新版复制到同一文件夹，再两次改名对调，中途失败就把旧版放回去；最后都会重新打开 WAswitch
const MAC_INSTALL_SCRIPT = `#!/bin/bash
PID="$1"; OLD="$2"; NEW="$3"; RESULT="$4"
PARENT="$(dirname "$OLD")"
TMP="$PARENT/.WAswitch-new-$$.app"
BAK="$PARENT/.WAswitch-old-$$.app"
fail() { echo "$1" > "$RESULT"; rm -rf "$TMP"; /usr/bin/open "$OLD"; exit 1; }
for i in $(seq 1 ${MAC_QUIT_WAIT_S * 2}); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then echo "旧版本没有退出" > "$RESULT"; exit 1; fi
rm -rf "$TMP"
/usr/bin/ditto "$NEW" "$TMP" || fail "复制新版本失败"
/usr/bin/xattr -cr "$TMP" 2>/dev/null
mv "$OLD" "$BAK" || fail "移走旧版本失败"
if ! mv "$TMP" "$OLD"; then mv "$BAK" "$OLD"; fail "放入新版本失败"; fi
rm -rf "$BAK" "$NEW"
rm -f "$RESULT"
/usr/bin/open "$OLD"
`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(String(out).trim())));
  });
}

// Mac 上用到的系统命令（自检时换成假的）
const macOps = {
  bundle: () => appBundlePath(),
  extract: (zip, dir) => run('/usr/bin/ditto', ['-x', '-k', zip, dir]),
  plistValue: (plist, key) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]),
  clearQuarantine: (target) => run('/usr/bin/xattr', ['-cr', target]),
  launch: (script, args) => {
    const child = spawn('/bin/bash', [script, ...args], { detached: true, stdio: 'ignore' });
    child.unref();
  },
};

// 最新版本的 latest*.yml 还没传上去（GitHub 404）
class PendingError extends Error {}

function allowedUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname);
  } catch { return false; }
}

// 版本号比较：1.2.3 / 1.2.3-beta.1。返回正数表示 a 比 b 新
function compareVersions(a, b) {
  const split = (v) => {
    const [main, pre] = String(v).replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((n) => Number(n) || 0), pre: pre || '' };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // 正式版比同号的预发布版新
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

// releases.atom 里最新的版本 tag（按发布时间倒序，第一个就是最新的，含预发布版）
function latestTagFromAtom(xml) {
  const m = String(xml).match(/\/releases\/tag\/(v[0-9][^"<\s]*)"/);
  return m ? decodeURIComponent(m[1]) : null;
}

// latest-mac.yml 只需要 version 和 files 里的 url / sha512 / size，格式固定，不引入 yaml 库
function parseLatestYml(text) {
  const version = (String(text).match(/^version:\s*['"]?([^'"\s]+)/m) || [])[1] || null;
  const files = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    let m = line.match(/^\s*-\s*url:\s*['"]?([^'"]+?)['"]?\s*$/);
    if (m) { cur = { url: m[1] }; files.push(cur); continue; }
    if (!cur) continue;
    m = line.match(/^\s+sha512:\s*['"]?([^'"\s]+)/);
    if (m) { cur.sha512 = m[1]; continue; }
    m = line.match(/^\s+size:\s*(\d+)/);
    if (m) { cur.size = Number(m[1]); continue; }
    if (/^\S/.test(line)) cur = null; // files 列表结束
  }
  return { version, files };
}

// 从 GitHub 下载：只用默认会话，手动跟重定向，每一跳都检查主机
async function request(url, opts = {}) {
  return requestWith(await updaterSession(), url, opts);
}
// signal：可选的 AbortSignal，用户点“取消”时中断下载
function requestWith(ses, url, { onData, maxBytes = 512 * 1024 * 1024, redirects = 5, idleMs = IDLE_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (!allowedUrl(url)) { reject(new Error(`不允许的下载地址：${safeHost(url)}`)); return; }
    if (signal?.aborted) { reject(Object.assign(new Error('已取消'), { cancelled: true })); return; }
    const req = net.request({ url, session: ses, redirect: 'manual', useSessionCookies: false });
    // 连接或下载中途挂住：idleMs 内没有任何数据就放弃
    let timer = null;
    let settled = false;
    const onAbort = () => { req.abort(); bad(Object.assign(new Error('已取消'), { cancelled: true })); };
    const ok = (v) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(v); };
    const bad = (e) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(e); };
    signal?.addEventListener('abort', onAbort);
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { req.abort(); bad(new Error('连接 GitHub 超时')); }, idleMs);
    };
    arm();
    req.setHeader('User-Agent', `WAswitch/${app.getVersion()}`);
    req.on('redirect', (_status, _method, next) => {
      clearTimeout(timer); // 下一跳有自己的超时
      req.abort();
      if (redirects <= 0) { bad(new Error('重定向次数太多')); return; }
      requestWith(ses, next, { onData, maxBytes, redirects: redirects - 1, idleMs, signal }).then(ok, bad);
    });
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume?.();
        const e = new Error(`GitHub 返回 ${res.statusCode}`);
        e.statusCode = res.statusCode;
        bad(e);
        return;
      }
      arm();
      const total = Number(res.headers['content-length']) || 0;
      const chunks = [];
      let got = 0;
      res.on('data', (c) => {
        if (settled) return;
        arm();
        got += c.length;
        if (got > maxBytes) { req.abort(); bad(new Error('文件太大')); return; }
        if (onData) onData(c, got, total); else chunks.push(c);
      });
      res.on('end', () => ok(onData ? got : Buffer.concat(chunks)));
      res.on('error', bad);
    });
    req.on('error', bad);
    req.end();
  });
}

function safeHost(raw) {
  try { return new URL(raw).hostname; } catch { return '（无效地址）'; }
}

class Updater {
  // hooks: {
  //   onChange(),                       状态变了（刷新关于页和托盘）
  //   idleReason() -> string | null,    现在不能自动安装的原因；null 表示可以装
  //   busyReason() -> string | null,    用户手上正在忙（打字、编辑账号）：用户点了更新也先等一等
  //   beforeInstall() -> Promise,       安装前（轻量模式写盘、记下要不要回托盘）
  //   installFailed() -> Promise,       安装没成功（恢复轻量模式、取消退出状态）
  //   notify(title, body, onClick),     系统通知
  // }
  constructor(hooks) {
    this.hooks = hooks;
    this.mac = process.platform === 'darwin';
    this.state = {
      status: 'idle', // idle | checking | none | downloading | downloaded | error | dev（开发版）| off（这种安装方式不支持）
      version: '', // 新版本号
      percent: 0,
      lastCheckAt: 0,
      lastResult: '',
      lastDetail: '', // 失败时的原话（英文），关于页收在“详细信息”里
      failures: 0,
      mac: this.mac,
      manual: this.mac, // Mac 只能手动安装（打开 Finder 把新版拖进「应用程序」）
      userAsked: false, // 用户点了“检查并更新”：下好后不等空闲就安装并重新打开，不用再点一次（只等用户停手）
      waitReason: '', // 用户点了更新、已经下好，但还在打字：等停手再更新
    };
    this.updater = null;
    this.ops = hooks.macOps || macOps;
    this.macAuto = false; // Mac 能自动替换
    this.macApp = ''; // 解压好、校验过的新 WAswitch.app
    this.timers = [];
    this.installing = false;
    this.idleMs = hooks.idleMs || IDLE_TIMEOUT_MS; // 测试时调小
    this.busySince = 0; // 进入 checking / downloading，或下载进度最近一次变化的时间
    this.pendingTimer = null;
    this.waitTimer = null;
    this.waitPollMs = hooks.waitPollMs || WAIT_POLL_MS; // 测试时调小
  }

  start() {
    if (!app.isPackaged) {
      this.set({ status: 'dev', lastResult: '开发版不检查更新' });
      return;
    }
    if (!this.mac) this.setupElectronUpdater();
    else this.setupMac();
    this.timers.push(setTimeout(() => this.check(), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => this.check(), CHECK_EVERY_MS));
    this.timers.push(setInterval(() => { this.watchdog(); this.maybeAutoInstall(); }, IDLE_POLL_MS));
  }

  set(patch) {
    const before = this.state.status;
    const prevPercent = this.state.percent;
    Object.assign(this.state, patch);
    if (this.state.status !== before || this.state.percent !== prevPercent) this.busySince = Date.now();
    this.hooks.onChange();
  }

  // 卡住守卫：检查 5 分钟没结果、下载 30 分钟没进度，就按一次失败处理，下次照常检查
  watchdog(now = Date.now()) {
    const s = this.state.status;
    if (s === 'checking' && now - this.busySince > STUCK_CHECKING_MS) this.fail(new Error('检查更新卡住了，已放弃这一次'));
    else if (s === 'downloading' && now - this.busySince > STUCK_DOWNLOAD_MS) this.fail(new Error('下载 30 分钟没有进度，已放弃这一次'));
  }

  snapshot() {
    return { ...this.state, warn: this.state.failures >= FAIL_WARN_AT };
  }

  // 托盘提示里的一小段
  trayText() {
    const s = this.state;
    if (s.status === 'downloading') return `正在下载新版本 ${s.percent}%`;
    if (s.status === 'downloaded') return `新版本 ${s.version} 已下载`;
    return '';
  }

  fail(e) {
    const msg = String(e && e.message ? e.message : e).split('\n')[0].slice(0, 200);
    console.warn(`检查更新失败：${msg}`);
    const { text, detail } = updateErrorText(e, msg);
    this.set({ status: 'error', lastCheckAt: Date.now(), lastResult: `失败：${text}`, lastDetail: detail, failures: this.state.failures + 1, percent: 0, userAsked: false, waitReason: '' });
  }

  succeed(status, lastResult, patch = {}) {
    this.set({ status, lastCheckAt: Date.now(), lastResult, lastDetail: '', failures: 0, ...(status === 'none' ? { userAsked: false } : {}), ...patch });
  }

  // 用户点“检查并更新”“立即更新”：下好后马上安装
  userUpdate() {
    const s = this.state.status;
    if (s === 'dev' || s === 'off') return;
    if (s === 'downloaded') { this.install(); return; }
    this.set({ userAsked: true });
    if (s !== 'checking' && s !== 'downloading') this.check();
  }

  // 下好后在等用户停手时点了“稍后”：不自动更新了，改回空闲（缩到托盘）时再装
  userLater() {
    if (!this.state.userAsked) return;
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.set({ userAsked: false, waitReason: '' });
  }

  async check() {
    if (this.state.status === 'dev' || this.state.status === 'off' || this.state.status === 'checking' || this.state.status === 'downloading') return;
    if (this.state.status === 'downloaded') return; // 已经下好了，等安装
    this.set({ status: 'checking' });
    const failuresBefore = this.state.failures;
    try {
      if (this.mac) await this.checkMac();
      else {
        await this.useDirectWindows();
        if (!(await this.updater.checkForUpdates())) {
          // 这种安装方式 updater 不工作（比如 Linux 不是 AppImage），不当作失败
          this.set({ status: 'off', lastCheckAt: Date.now(), lastResult: '这种安装方式不支持自动更新，请到 Releases 页面下载新版' });
        }
      }
    } catch (e) {
      if (isPending(e)) { this.pending(e.version); return; }
      // electron-updater 出错时既发 error 事件又让 checkForUpdates 失败，同一次只记一次
      if (this.state.failures === failuresBefore) this.fail(e);
    }
  }

  // 新版本已发布但安装包还在上传：不算失败，10 分钟后再查一次
  pending(version) {
    this.succeed('none', `新版本${version ? ` ${version}` : ''}正在上传，稍后自动再查`);
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this.check(), PENDING_RETRY_MS);
    this.pendingTimer.unref?.();
  }

  // Windows：electron-updater 自己的会话也强制直连。设不上就抛错，这次不查（不会退回走代理）
  async useDirectWindows() {
    if (this.directReady) return;
    await this.updater.netSession.setProxy({ mode: 'direct' });
    this.directReady = true;
  }

  // ---------- Windows：electron-updater ----------

  setupElectronUpdater() {
    const { autoUpdater } = require('electron-updater');
    this.updater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.allowPrerelease = true; // 现在的版本都发成预发布版
    autoUpdater.allowDowngrade = false;
    autoUpdater.autoInstallOnAppQuit = true; // 用户自己退出时顺手装上，下次打开就是新版
    autoUpdater.logger = { info: () => {}, debug: () => {}, warn: (m) => console.warn(`[更新] ${m}`), error: (m) => console.warn(`[更新] ${m}`) };
    // updater 用自己的独立会话联网：只放行 GitHub 的地址，其他一律拦下
    autoUpdater.netSession.webRequest.onBeforeRequest((details, callback) => {
      const ok = allowedUrl(details.url);
      if (!ok) console.warn(`[更新] 拦下了非 GitHub 地址：${safeHost(details.url)}`);
      callback({ cancel: !ok });
    });
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('update-not-available', () => this.succeed('none', '已是最新版本'));
    autoUpdater.on('download-progress', (p) => {
      const percent = Math.floor(p.percent || 0);
      if (percent !== this.state.percent) this.set({ status: 'downloading', percent });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.succeed('downloaded', `新版本 ${info.version} 已下载`, { version: info.version, percent: 100 });
      this.maybeAutoInstall();
    });
    autoUpdater.on('error', (e) => { if (!isPending(e)) this.fail(e); });
  }

  // 自动安装：没点任何按钮时，只在用户肯定不在用的时候（缩到托盘且空闲）装，窗口开着不会自己重启。
  // 用户点了更新：不等缩到托盘，但手上在忙（30 秒内打过字、在编辑账号等）时先等，停手了再重启，免得打到一半的字没了
  maybeAutoInstall() {
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
    if (this.state.manual || this.state.status !== 'downloaded' || this.installing) {
      if (this.state.waitReason) this.set({ waitReason: '' });
      return;
    }
    if (this.state.userAsked) {
      const busy = this.hooks.busyReason ? this.hooks.busyReason() : null;
      if (busy !== (this.state.waitReason || null)) this.set({ waitReason: busy || '' });
      if (busy) {
        this.waitTimer = setTimeout(() => this.maybeAutoInstall(), this.waitPollMs);
        this.waitTimer.unref?.();
        return;
      }
    } else if (this.hooks.idleReason()) return;
    console.log(`${this.state.userAsked ? '用户点了更新，' : ''}自动安装新版本 ${this.state.version}`);
    this.install();
  }

  // 用户点“立即更新”，或自动调用
  async install() {
    if (this.state.manual || this.state.status !== 'downloaded' || this.installing) return;
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
    this.installing = true;
    try {
      if (this.mac && (!this.macApp || !fs.existsSync(this.macApp))) throw new Error('解压好的新版本不见了');
      await this.hooks.beforeInstall();
      if (this.mac) this.launchMacInstall();
      // isSilent: 不弹安装界面；isForceRunAfter: 装完自动重新打开
      else this.updater.quitAndInstall(true, true);
      // 正常情况下软件马上就会退出；30 秒后还在，说明安装没启动（会另有 error 事件），恢复正常运行
      setTimeout(() => {
        if (!this.installing) return;
        this.installing = false;
        Promise.resolve(this.hooks.installFailed()).catch(() => {});
        if (this.state.status === 'downloaded') this.fail(new Error('安装没有启动'));
      }, 30 * 1000).unref?.();
    } catch (e) {
      // 没装成：把安装前关掉的东西恢复，软件继续正常收消息
      this.installing = false;
      try { await this.hooks.installFailed(); } catch { /* 尽量恢复 */ }
      this.fail(e);
    }
  }

  // 软件要自己重启（设置页改了省内存模式）时：Windows 上有下好的更新，退出时 electron-updater 会静默装，
  // 参数里没有 --force-run，装完软件不会重新打开。这时改走 install()（装完自动重新打开）。
  // 返回 true 表示已经走了安装（正在退出），false 表示没有下好的更新或没装成，调用方照常重启
  async restartWithUpdate() {
    if (this.installing) return true;
    if (this.mac || this.state.manual || this.state.status !== 'downloaded') return false;
    await this.install();
    return this.installing;
  }

  // ---------- macOS：自己下载 dmg 并校验 ----------

  async checkMac() {
    const idleMs = this.idleMs;
    const atom = (await request(`https://github.com/${OWNER}/${REPO}/releases.atom`, { maxBytes: 2 * 1024 * 1024, idleMs })).toString('utf8');
    const tag = latestTagFromAtom(atom);
    if (!tag) throw new Error('没找到任何版本');
    if (compareVersions(tag, app.getVersion()) <= 0) { this.succeed('none', '已是最新版本'); return; }
    let yml;
    try {
      yml = (await request(`https://github.com/${OWNER}/${REPO}/releases/download/${encodeURIComponent(tag)}/latest-mac.yml`, { maxBytes: 256 * 1024, idleMs })).toString('utf8');
    } catch (e) {
      if (e.statusCode === 404) { const p = new PendingError('新版本还在上传'); p.version = tag.replace(/^v/, ''); throw p; }
      throw e;
    }
    const info = parseLatestYml(yml);
    if (!info.version || compareVersions(info.version, app.getVersion()) <= 0) { this.succeed('none', '已是最新版本'); return; }
    const file = info.files.find((f) => /\.zip$/i.test(f.url) && /arm64/i.test(f.url)) || info.files.find((f) => /\.zip$/i.test(f.url));
    if (!file || !file.sha512) throw new Error('新版本里没有 Mac 安装包');
    const name = path.basename(file.url);
    if (!/^[\w.-]+\.zip$/i.test(name)) throw new Error('安装包文件名不对');
    const dir = this.macDir();
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    // 之前下好并校验过的不再下
    if (fs.existsSync(dest) && await sha512Of(dest) === file.sha512) {
      await this.macDownloaded(info.version, dest);
      return;
    }
    this.set({ status: 'downloading', version: info.version, percent: 0 });
    const part = `${dest}.part`;
    const out = fs.createWriteStream(part);
    const hash = crypto.createHash('sha512');
    try {
      await request(`https://github.com/${OWNER}/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`, {
        idleMs,
        onData: (c, got, total) => {
          hash.update(c);
          out.write(c);
          const all = total || file.size || 0;
          const percent = all ? Math.min(99, Math.floor((got / all) * 100)) : 0;
          if (percent !== this.state.percent) this.set({ percent });
        },
      });
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    } catch (e) {
      out.destroy();
      fs.rmSync(part, { force: true });
      throw e;
    }
    if (hash.digest('base64') !== file.sha512) {
      fs.rmSync(part, { force: true });
      throw new Error('安装包校验不通过（sha512 不一致），已删除');
    }
    fs.renameSync(part, dest);
    await this.macDownloaded(info.version, dest);
  }

  macDir() { return path.join(app.getPath('userData'), 'updates'); }
  macResultFile() { return path.join(this.macDir(), 'install-failed.txt'); }

  // 启动时：看能不能自动替换；上次自动替换失败过就这次改成手动；清掉已经装上的旧安装包
  setupMac() {
    const dir = this.macDir();
    let lastFail = '';
    try { lastFail = fs.readFileSync(this.macResultFile(), 'utf8').trim().slice(0, 100); } catch { /* 没失败过 */ }
    fs.rmSync(this.macResultFile(), { force: true });
    const blocker = lastFail ? `上次自动安装没成功（${lastFail}）` : replaceBlocker(this.ops.bundle(), app.getPath('home'));
    this.macAuto = !blocker;
    this.macBlocker = blocker || '';
    this.state.manual = !this.macAuto;
    if (blocker) console.warn(`Mac 不能自动更新：${blocker}`);
    try {
      for (const f of fs.readdirSync(dir)) {
        const v = (f.match(/^WAswitch-(\d[^-]*(?:-[a-z]+\.\d+)?)-/i) || [])[1];
        if (f === 'staging' || f === 'install.sh' || /\.(dmg|part)$/.test(f) || (v && compareVersions(v, app.getVersion()) <= 0)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      }
    } catch { /* 还没有 updates 文件夹 */ }
  }

  // 解压、确认是 WAswitch.app 而且版本号对得上，再清掉隔离属性
  async stageMac(version, zip) {
    const dir = this.macDir();
    // 旧版本的安装包不再需要
    for (const f of fs.readdirSync(dir)) if (f !== path.basename(zip)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    const staging = path.join(dir, 'staging');
    fs.mkdirSync(staging, { recursive: true });
    try {
      await this.ops.extract(zip, staging);
      const appDir = path.join(staging, 'WAswitch.app');
      const plist = path.join(appDir, 'Contents', 'Info.plist');
      if (!fs.existsSync(plist)) throw new Error('安装包里没有 WAswitch.app');
      if (await this.ops.plistValue(plist, 'CFBundleIdentifier') !== APP_ID) throw new Error('安装包里的不是 WAswitch');
      const v = await this.ops.plistValue(plist, 'CFBundleShortVersionString');
      if (v !== version) throw new Error(`安装包版本不对（${v}）`);
      await this.ops.clearQuarantine(appDir).catch(() => {});
      return appDir;
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(zip, { force: true });
      throw new Error(`解压安装包失败：${String(e.message || e).split('\n')[0]}`);
    }
  }

  async macDownloaded(version, zip) {
    this.macApp = await this.stageMac(version, zip);
    this.succeed('downloaded', `新版本 ${version} 已下载并校验通过`, { version, percent: 100 });
    if (this.macAuto) { this.maybeAutoInstall(); return; }
    if (this.state.userAsked) { this.set({ userAsked: false }); this.openMacInstaller(); return; } // 不能自动替换：直接打开安装包
    this.hooks.notify('WAswitch 有新版本', `${version} 已下载。点这里打开，把新的 WAswitch 拖进“应用程序”替换旧版。`, () => this.openMacInstaller());
  }

  // 写好替换脚本，交给一个独立进程，然后退出。脚本等这个进程退出后替换并重新打开
  launchMacInstall() {
    const script = path.join(this.macDir(), 'install.sh');
    fs.writeFileSync(script, MAC_INSTALL_SCRIPT, { mode: 0o700 });
    this.ops.launch(script, [String(process.pid), this.ops.bundle(), this.macApp, this.macResultFile()]);
    app.quit();
  }

  // 手动安装：在 Finder 里选中解压好的新 WAswitch.app，同时打开「应用程序」文件夹
  openMacInstaller() {
    if (!this.macApp || !fs.existsSync(this.macApp)) return;
    shell.showItemInFolder(this.macApp);
    shell.openPath('/Applications').catch(() => {});
  }
}

// 检查更新失败的原因说人话：自己写的中文原样用；网络错误、electron-updater 的英文换成中文，原话放 lastDetail
function updateErrorText(e, msg) {
  if (errtext.hasChinese(msg)) return { text: msg, detail: '' };
  const raw = errtext.rawOf(e) || msg;
  const m = /HttpError:?\s*(\d{3})/.exec(raw);
  const status = (e && Number(e.statusCode)) || (m ? Number(m[1]) : 0);
  if (status === 404) return { text: '找不到更新文件，新版本可能还在发布中，过几分钟再试', detail: raw };
  if (status === 403 || status === 429) return { text: 'GitHub 暂时限制了访问，过一会儿再试', detail: raw };
  if (status >= 500) return { text: 'GitHub 那边暂时出错，过一会儿再试', detail: raw };
  const kind = errtext.netKind(raw);
  if (kind === 'other' && !/net::|ERR_|\bE[A-Z]{4,}\b|fetch failed|socket/.test(raw)) return { text: '检查更新出错了，过一会儿再试', detail: raw };
  return { text: `连不上 GitHub（${errtext.netReason(raw)}）`, detail: raw };
}

// 新版本的 yml 还没传上去：Mac 是自己的 PendingError；Windows 是 electron-updater 找不到 latest.yml
function isPending(e) {
  return e instanceof PendingError || (e && e.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
}

function sha512Of(file) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('base64'))).on('error', () => resolve(''));
  });
}

module.exports = { Updater, request, OWNER, REPO, UPDATER_PARTITION, MAC_INSTALL_SCRIPT, appBundlePath, replaceBlocker, allowedUrl, compareVersions, latestTagFromAtom, parseLatestYml, ALLOWED_HOSTS };
