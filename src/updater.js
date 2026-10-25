// 自动更新。
//
// 只连 GitHub：github.com 和它放安装包的 objects.githubusercontent.com / release-assets.githubusercontent.com，
// 重定向到别的地方一律当失败。走系统网络设置，不用任何账号的代理（这不是 WhatsApp 流量）。
// 启动 1 分钟后查一次，之后每 6 小时查一次，有新版就自动下载。
//
// Windows：electron-updater 下载并校验 sha512。下载好后两种安装时机：
//   - 用户点“重启以更新”（关于页或托盘菜单）；
//   - 窗口缩在托盘、所有账号都没有未读、10 分钟内没有新消息、没有账号在登录或扫码、
//     没有消息在发、没有页面在重建时，自动静默安装并重启（重启后回到托盘）。
// macOS：没有签名证书，electron-updater 的 Mac 流程用不了。自己下载 dmg，按 latest-mac.yml 里的 sha512 校验，
//   校验通过后提示用户打开安装包手动替换。
const { app, net, session, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OWNER = 'Kr1xxxx';
const REPO = 'WAswitch';
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const IDLE_POLL_MS = 60 * 1000;
const FAIL_WARN_AT = 3; // 连续失败这么多次，关于页标黄
const IDLE_TIMEOUT_MS = 60 * 1000; // Mac 下载：这么久没收到数据就算失败
const STUCK_CHECKING_MS = 5 * 60 * 1000; // 检查超过 5 分钟没结果
const STUCK_DOWNLOAD_MS = 30 * 60 * 1000; // 下载 30 分钟没有进度

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
function request(url, { onData, maxBytes = 512 * 1024 * 1024, redirects = 5, idleMs = IDLE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!allowedUrl(url)) { reject(new Error(`不允许的下载地址：${safeHost(url)}`)); return; }
    const req = net.request({ url, session: session.defaultSession, redirect: 'manual', useSessionCookies: false });
    // 连接或下载中途挂住：idleMs 内没有任何数据就放弃
    let timer = null;
    let settled = false;
    const ok = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    const bad = (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); };
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
      request(next, { onData, maxBytes, redirects: redirects - 1, idleMs }).then(ok, bad);
    });
    req.on('response', (res) => {
      if (res.statusCode !== 200) { res.resume?.(); bad(new Error(`GitHub 返回 ${res.statusCode}`)); return; }
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
      failures: 0,
      mac: this.mac,
    };
    this.updater = null;
    this.macFile = '';
    this.timers = [];
    this.installing = false;
    this.idleMs = hooks.idleMs || IDLE_TIMEOUT_MS; // 测试时调小
    this.busySince = 0; // 进入 checking / downloading，或下载进度最近一次变化的时间
  }

  start() {
    if (!app.isPackaged) {
      this.set({ status: 'dev', lastResult: '开发版不检查更新' });
      return;
    }
    if (!this.mac) this.setupElectronUpdater();
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
    if (s.status === 'downloaded') return this.mac ? `新版本 ${s.version} 已下载` : `新版本 ${s.version} 已下载，重启后生效`;
    return '';
  }

  fail(e) {
    const msg = String(e && e.message ? e.message : e).split('\n')[0].slice(0, 200);
    console.warn(`检查更新失败：${msg}`);
    this.set({ status: 'error', lastCheckAt: Date.now(), lastResult: `失败：${msg}`, failures: this.state.failures + 1, percent: 0 });
  }

  succeed(status, lastResult, patch = {}) {
    this.set({ status, lastCheckAt: Date.now(), lastResult, failures: 0, ...patch });
  }

  async check() {
    if (this.state.status === 'dev' || this.state.status === 'off' || this.state.status === 'checking' || this.state.status === 'downloading') return;
    if (this.state.status === 'downloaded') return; // 已经下好了，等安装
    this.set({ status: 'checking' });
    const failuresBefore = this.state.failures;
    try {
      if (this.mac) await this.checkMac();
      else if (!(await this.updater.checkForUpdates())) {
        // 这种安装方式 updater 不工作（比如 Linux 不是 AppImage），不当作失败
        this.set({ status: 'off', lastCheckAt: Date.now(), lastResult: '这种安装方式不支持自动更新，请到 Releases 页面下载新版' });
      }
    } catch (e) {
      // electron-updater 出错时既发 error 事件又让 checkForUpdates 失败，同一次只记一次
      if (this.state.failures === failuresBefore) this.fail(e);
    }
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
    autoUpdater.on('error', (e) => this.fail(e));
  }

  // 自动安装：只在用户肯定不在用的时候
  maybeAutoInstall() {
    if (this.mac || this.state.status !== 'downloaded' || this.installing) return;
    const reason = this.hooks.idleReason();
    if (reason) return;
    console.log(`自动安装新版本 ${this.state.version}`);
    this.install();
  }

  // 用户点“重启以更新”，或空闲时自动调用
  async install() {
    if (this.mac || this.state.status !== 'downloaded' || this.installing) return;
    this.installing = true;
    try {
      await this.hooks.beforeInstall();
      // isSilent: 不弹安装界面；isForceRunAfter: 装完自动重新打开
      this.updater.quitAndInstall(true, true);
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

  // ---------- macOS：自己下载 dmg 并校验 ----------

  async checkMac() {
    const idleMs = this.idleMs;
    const atom = (await request(`https://github.com/${OWNER}/${REPO}/releases.atom`, { maxBytes: 2 * 1024 * 1024, idleMs })).toString('utf8');
    const tag = latestTagFromAtom(atom);
    if (!tag) throw new Error('没找到任何版本');
    if (compareVersions(tag, app.getVersion()) <= 0) { this.succeed('none', '已是最新版本'); return; }
    const yml = (await request(`https://github.com/${OWNER}/${REPO}/releases/download/${encodeURIComponent(tag)}/latest-mac.yml`, { maxBytes: 256 * 1024, idleMs })).toString('utf8');
    const info = parseLatestYml(yml);
    if (!info.version || compareVersions(info.version, app.getVersion()) <= 0) { this.succeed('none', '已是最新版本'); return; }
    const file = info.files.find((f) => /\.dmg$/i.test(f.url) && /arm64/i.test(f.url)) || info.files.find((f) => /\.dmg$/i.test(f.url));
    if (!file || !file.sha512) throw new Error('新版本里没有 Mac 安装包');
    const name = path.basename(file.url);
    if (!/^[\w.-]+\.dmg$/i.test(name)) throw new Error('安装包文件名不对');
    const dir = path.join(app.getPath('userData'), 'updates');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    // 之前下好并校验过的不再下
    if (fs.existsSync(dest) && await sha512Of(dest) === file.sha512) {
      this.macDownloaded(info.version, dest);
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
    // 旧版本的安装包不再需要
    for (const f of fs.readdirSync(dir)) if (f !== name) fs.rmSync(path.join(dir, f), { force: true });
    this.macDownloaded(info.version, dest);
  }

  macDownloaded(version, file) {
    this.macFile = file;
    this.succeed('downloaded', `新版本 ${version} 已下载并校验通过`, { version, percent: 100 });
    this.hooks.notify('WAswitch 有新版本', `${version} 已下载。点这里打开安装包，把 WAswitch 拖进“应用程序”替换旧版。`, () => this.openMacInstaller());
  }

  // 在 Finder 里打开下载好的 dmg
  openMacInstaller() {
    if (!this.macFile || !fs.existsSync(this.macFile)) return;
    shell.showItemInFolder(this.macFile);
    shell.openPath(this.macFile).catch(() => {});
  }
}

function sha512Of(file) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('base64'))).on('error', () => resolve(''));
  });
}

module.exports = { Updater, allowedUrl, compareVersions, latestTagFromAtom, parseLatestYml, ALLOWED_HOSTS };
