// 自检：自动更新模块。
// 1. 静态检查：updater 不碰任何账号的会话；只走本机直连（不用账号代理，也不用系统代理）。
// 2. 只允许 GitHub 的地址；版本比较；解析 releases.atom 和 latest-mac.yml。
// 3. Mac 流程（自己下载 zip、解压、App 退出后脚本替换）：用假的 electron.net 跑一遍——正常下载并校验通过、sha512 不对时删掉、
//    重定向到别的主机时失败、已是最新版时不下载、连续失败 3 次标黄、新版本还在上传（404）时不算失败。
// 运行：node scripts/check-updater.js（不需要 Electron，也不联网）
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { EventEmitter } = require('events');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };

// ---------- 1. 静态检查 ----------
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'updater.js'), 'utf8');
const code = src.replace(/\/\/.*$/gm, ''); // 去掉注释再查
check(!/persist:/.test(code) && !/wa-/.test(code), 'updater 不引用账号分区（persist: / wa-）');
check(!/require\(['"]\.\/proxy['"]\)/.test(code), 'updater 不引用 proxy 模块');
check(!/defaultSession/.test(code), 'updater 不用默认会话（默认会话跟随系统代理）');
check((code.match(/setProxy\(\{ mode: 'direct' \}\)/g) || []).length === 2 && !/setProxy\(\{(?! mode: 'direct' \})/.test(code), 'Mac 和 Windows 两条路都只设直连，不设任何别的代理');
check(/redirect:\s*'manual'/.test(code), 'Mac 下载手动跟重定向（每一跳都检查主机）');

// ---------- 假的 electron ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-upd-'));
const routes = new Map(); // url -> { status, body, location }
const requested = [];
const proxies = []; // [分区名, mode]
const usedSessions = new Set();
const fakeNet = {
  request({ url, session: ses }) {
    usedSessions.add(ses && ses.name);
    const req = new EventEmitter();
    req.setHeader = () => {};
    req.abort = () => { req.aborted = true; };
    req.end = () => setImmediate(() => {
      requested.push(url);
      const r = routes.get(url);
      if (!r) { req.emit('error', new Error(`net::ERR_NAME_NOT_RESOLVED ${url}`)); return; }
      if (r.hang) return; // 连上了但一直没有回应
      if (r.location) { req.emit('redirect', 302, 'GET', r.location); return; }
      const res = new EventEmitter();
      res.statusCode = r.status || 200;
      res.headers = { 'content-length': String(r.body ? r.body.length : 0) };
      res.resume = () => {};
      req.emit('response', res);
      setImmediate(() => {
        if (r.stall) { res.emit('data', r.body.subarray(0, 1024)); return; } // 发了一点就不动了
        if (r.body) for (let i = 0; i < r.body.length; i += 64 * 1024) res.emit('data', r.body.subarray(i, i + 64 * 1024));
        res.emit('end');
      });
    });
    return req;
  },
};
const opened = [];
let quits = 0;
const fakeElectron = {
  app: { isPackaged: true, getVersion: () => '0.2.0', getPath: () => home, quit: () => { quits += 1; } },
  net: fakeNet,
  session: {
    defaultSession: { name: 'default' },
    fromPartition(name) { return { name, async setProxy(c) { proxies.push([name, c.mode]); } }; },
  },
  shell: { showItemInFolder: (f) => opened.push(f), openPath: async (f) => { opened.push(f); return ''; } },
};
const origLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};
Object.defineProperty(process, 'platform', { value: 'darwin' });

const { Updater, UPDATER_PARTITION, allowedUrl, compareVersions, latestTagFromAtom, parseLatestYml } = require('../src/updater');

// ---------- 2. 小工具 ----------
check(allowedUrl('https://github.com/Kr1xxxx/WAswitch/releases.atom'), '允许 github.com');
check(allowedUrl('https://objects.githubusercontent.com/x'), '允许 objects.githubusercontent.com');
check(!allowedUrl('http://github.com/x'), '不允许 http');
check(!allowedUrl('https://github.com.evil.example/x') && !allowedUrl('https://evil.example/github.com'), '不允许冒充 github 的主机');
check(compareVersions('0.2.1', '0.2.0') > 0 && compareVersions('v0.10.0', '0.9.9') > 0 && compareVersions('0.2.0', '0.2.0') === 0, '版本比较（数字按大小，不按字符）');
check(compareVersions('0.3.0', '0.3.0-beta.2') > 0 && compareVersions('0.3.0-beta.10', '0.3.0-beta.2') > 0, '版本比较（预发布版）');
const atom = `<?xml version="1.0"?><feed><entry><link rel="alternate" type="text/html" href="https://github.com/Kr1xxxx/WAswitch/releases/tag/v0.3.0"/></entry>
<entry><link rel="alternate" type="text/html" href="https://github.com/Kr1xxxx/WAswitch/releases/tag/v0.2.0"/></entry></feed>`;
check(latestTagFromAtom(atom) === 'v0.3.0', '从 releases.atom 取最新 tag');

// ---------- 3. Mac 流程 ----------
const dmg = crypto.randomBytes(300 * 1024);
const sha = crypto.createHash('sha512').update(dmg).digest('base64');
const yml = (s) => `version: 0.3.0
files:
  - url: WAswitch-0.3.0-arm64.dmg
    sha512: zzz
    size: 10
  - url: WAswitch-0.3.0-arm64.zip
    sha512: ${s}
    size: ${dmg.length}
path: WAswitch-0.3.0-arm64.zip
sha512: zzz
releaseDate: '2026-10-24T00:00:00.000Z'
`;
const parsed = parseLatestYml(yml(sha));
check(parsed.version === '0.3.0' && parsed.files.length === 2 && parsed.files[1].sha512 === sha && parsed.files[1].size === dmg.length, '解析 latest-mac.yml');

const base = 'https://github.com/Kr1xxxx/WAswitch';
const dmgUrl = `${base}/releases/download/v0.3.0/WAswitch-0.3.0-arm64.zip`;
const asset = 'https://objects.githubusercontent.com/github-production-release-asset/1';
function serve({ ymlSha = sha, dmgLocation = asset, tag = 'v0.3.0' } = {}) {
  routes.clear();
  routes.set(`${base}/releases.atom`, { body: Buffer.from(atom.replace('v0.3.0', tag)) });
  routes.set(`${base}/releases/download/v0.3.0/latest-mac.yml`, { location: `${asset}-yml` });
  routes.set(`${asset}-yml`, { body: Buffer.from(yml(ymlSha)) });
  routes.set(dmgUrl, { location: dmgLocation });
  routes.set(asset, { body: dmg });
  routes.set('https://evil.example/dmg', { body: dmg });
}
const notes = [];
let installFailedCalls = 0;
// 假的系统命令：解压时写一个 Info.plist（这里用 JSON），读取时按 key 取
const launched = [];
let bundle = null;
let fakeApp = { CFBundleIdentifier: 'com.waswitch.app', CFBundleShortVersionString: '0.3.0' };
const fakeOps = {
  bundle: () => bundle,
  extract: async (zip, dir) => {
    const c = path.join(dir, 'WAswitch.app', 'Contents');
    fs.mkdirSync(c, { recursive: true });
    fs.writeFileSync(path.join(c, 'Info.plist'), JSON.stringify(fakeApp));
  },
  plistValue: async (plist, key) => JSON.parse(fs.readFileSync(plist, 'utf8'))[key],
  clearQuarantine: async () => {},
  launch: (script, args) => launched.push({ script, args }),
};
let idle = null;
const make = () => new Updater({
  onChange() {}, idleReason: () => idle, beforeInstall: async () => {}, installFailed: async () => { installFailedCalls += 1; },
  notify: (t, b, click) => notes.push({ t, click }), idleMs: 200, macOps: fakeOps,
});
const updatesDir = path.join(home, 'updates');

(async () => {
  // 正常：下载、校验、提示
  serve();
  let u = make();
  await u.check();
  const file = path.join(updatesDir, 'WAswitch-0.3.0-arm64.zip');
  const staged = path.join(updatesDir, 'staging', 'WAswitch.app');
  check(u.state.status === 'downloaded' && u.state.version === '0.3.0' && u.state.percent === 100, `Mac：下载并校验通过（${u.state.status} ${u.state.lastResult}）`);
  check(fs.existsSync(file) && fs.readFileSync(file).equals(dmg) && !fs.existsSync(`${file}.part`), 'Mac：安装包存到数据目录，没有残留 .part');
  check(notes.length === 1, 'Mac：下载好后弹通知');
  notes[0].click();
  check(opened.includes(staged) && opened.includes('/Applications'), 'Mac 手动：点通知在 Finder 里选中新 WAswitch.app 并打开「应用程序」');
  check(u.state.manual && launched.length === 0 && quits === 0, 'Mac 手动：不在「应用程序」里时不自动替换');
  check(requested.every((x) => allowedUrl(x)), 'Mac：所有请求都是 GitHub 的地址');

  check(proxies.length === 1 && proxies[0][0] === UPDATER_PARTITION && proxies[0][1] === 'direct', `Mac：更新专用会话设成直连（${JSON.stringify(proxies)}）`);
  check(usedSessions.size === 1 && usedSessions.has(UPDATER_PARTITION), 'Mac：所有请求都走更新专用会话（不走默认会话）');

  // 已下载并校验过：不再下载
  requested.length = 0;
  u = make();
  await u.check();
  check(u.state.status === 'downloaded' && !requested.includes(asset), 'Mac：已下好的安装包不重复下载');

  // sha512 不对：失败并删除
  fs.rmSync(updatesDir, { recursive: true, force: true });
  serve({ ymlSha: crypto.createHash('sha512').update('别的').digest('base64') });
  u = make();
  await u.check();
  check(u.state.status === 'error' && /校验不通过/.test(u.state.lastResult), `Mac：sha512 不一致时报错（${u.state.lastResult}）`);
  check(!fs.existsSync(file) && !fs.existsSync(`${file}.part`), 'Mac：校验不通过的文件已删除');

  // 重定向到别的主机：失败，不请求那个地址
  serve({ dmgLocation: 'https://evil.example/dmg' });
  requested.length = 0;
  await u.check();
  check(u.state.status === 'error' && /不允许/.test(u.state.lastResult) && !requested.includes('https://evil.example/dmg'), `Mac：重定向到别的主机视为失败，也不会去请求（${u.state.lastResult}）`);
  check(u.state.failures === 2 && !u.snapshot().warn, '失败 2 次还不标黄');
  await u.check();
  check(u.state.failures === 3 && u.snapshot().warn, '连续失败 3 次标黄');
  check(u.state.lastCheckAt > 0, '记录上次检查时间');

  // 已是最新版
  serve({ tag: 'v0.2.0' });
  u = make();
  await u.check();
  check(u.state.status === 'none' && u.state.failures === 0, `已是最新版时不下载（${u.state.lastResult}）`);

  // 新版本刚发布、latest-mac.yml 还没传上去（404）：不算失败，稍后自己再查
  serve();
  routes.set(`${base}/releases/download/v0.3.0/latest-mac.yml`, { status: 404 });
  u = make();
  u.set({ failures: 2 });
  await u.check();
  check(u.state.status === 'none' && u.state.failures === 0 && /0\.3\.0.*上传/.test(u.state.lastResult) && u.pendingTimer, `新版本还在上传时不算失败、稍后再查（${u.state.lastResult}）`);
  clearTimeout(u.pendingTimer);
  routes.set(`${base}/releases.atom`, { status: 404 });
  u = make();
  await u.check();
  check(u.state.status === 'error' && /404/.test(u.state.lastResult), `别的地址 404 仍然算失败（${u.state.lastResult}）`);

  // Windows：electron-updater 的会话设成直连；找不到 latest.yml 不算失败
  {
    const winProxy = [];
    const w = make();
    w.mac = false;
    w.updater = {
      netSession: { async setProxy(c) { winProxy.push(c.mode); } },
      async checkForUpdates() { const e = new Error('Cannot find latest.yml'); e.code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'; throw e; },
    };
    await w.check();
    check(winProxy.join() === 'direct', 'Windows：检查前把 electron-updater 的会话设成直连');
    check(w.state.status === 'none' && w.state.failures === 0 && w.pendingTimer, `Windows：latest.yml 还没传上去时不算失败（${w.state.lastResult}）`);
    clearTimeout(w.pendingTimer);
    w.updater.netSession.setProxy = async () => { throw new Error('设不了'); };
    w.directReady = false;
    let called = false;
    w.updater.checkForUpdates = async () => { called = true; return {}; };
    await w.check();
    check(!called && w.state.status === 'error', 'Windows：设不了直连就不检查（不会退回走代理）');
  }

  // 请求挂住：超时算失败，状态不会一直停在“检查中”
  serve();
  routes.set(`${base}/releases.atom`, { hang: true });
  u = make();
  let t0 = Date.now();
  await u.check();
  check(u.state.status === 'error' && /超时/.test(u.state.lastResult) && Date.now() - t0 < 5000, `请求挂住时超时失败（${u.state.lastResult}）`);
  serve();
  fs.rmSync(updatesDir, { recursive: true, force: true });
  routes.set(asset, { body: dmg, stall: true });
  u = make();
  t0 = Date.now();
  await u.check();
  check(u.state.status === 'error' && /超时/.test(u.state.lastResult) && !fs.existsSync(`${file}.part`), `下载中途停住时超时失败并删掉半截文件（${u.state.lastResult}）`);

  // 卡住守卫：checking 超过 5 分钟、downloading 30 分钟没进度，按失败处理，之后能再检查
  u = make();
  u.set({ status: 'checking' });
  u.watchdog(Date.now() + 4 * 60 * 1000);
  check(u.state.status === 'checking', '检查 4 分钟还不算卡住');
  u.watchdog(Date.now() + 6 * 60 * 1000);
  check(u.state.status === 'error' && /卡住/.test(u.state.lastResult), '检查超过 5 分钟按失败处理');
  u.set({ status: 'downloading', percent: 10 });
  u.watchdog(Date.now() + 31 * 60 * 1000);
  check(u.state.status === 'error', '下载 30 分钟没进度按失败处理');
  serve({ tag: 'v0.2.0' });
  await u.check();
  check(u.state.status === 'none', '卡住复位后下次检查照常进行');

  // ---------- Mac 自动替换 ----------
  const { replaceBlocker, appBundlePath, MAC_INSTALL_SCRIPT } = require('../src/updater');
  check(appBundlePath('/Applications/WAswitch.app/Contents/MacOS/WAswitch') === '/Applications/WAswitch.app' && appBundlePath('/usr/bin/node') === null, '找到正在运行的 WAswitch.app');
  check(/安装盘/.test(replaceBlocker('/Volumes/WAswitch/WAswitch.app', '/Users/a')) && /安装盘/.test(replaceBlocker('/private/var/folders/x/AppTranslocation/y/d/WAswitch.app', '/Users/a')), '在安装盘里或被系统隔离运行时不自动替换');
  check(/不在/.test(replaceBlocker('/Users/a/Downloads/WAswitch.app', '/Users/a')), '不在「应用程序」里时不自动替换');
  check(/权限/.test(replaceBlocker('/Applications/WAswitch-not-here.app', '/Users/a')), '没有写入权限（或找不到）时不自动替换');
  const appsHome = path.join(home, 'Applications');
  fs.mkdirSync(path.join(appsHome, 'WAswitch.app'), { recursive: true });
  bundle = path.join(appsHome, 'WAswitch.app');
  check(replaceBlocker(bundle, home) === null, '在 ~/Applications 里、有写权限时可以自动替换');
  const fakeHome = fakeElectron.app.getPath;
  fakeElectron.app.getPath = (k) => (k === 'home' ? home : fakeHome(k));
  // 已经装上的旧安装包启动时清掉
  fs.writeFileSync(path.join(updatesDir, 'WAswitch-0.1.0-arm64.zip'), 'x');
  fs.writeFileSync(path.join(updatesDir, 'WAswitch-0.1.0-arm64.dmg'), 'x');
  u = make();
  u.setupMac();
  check(u.macAuto && !u.state.manual, `Mac：在「应用程序」里能自动替换（${u.macBlocker}）`);
  check(!fs.existsSync(path.join(updatesDir, 'WAswitch-0.1.0-arm64.zip')) && !fs.existsSync(path.join(updatesDir, 'WAswitch-0.1.0-arm64.dmg')), 'Mac：启动时清掉已经装过的旧安装包');
  serve();
  notes.length = 0;
  idle = '窗口开着';
  await u.check();
  check(u.state.status === 'downloaded' && fs.existsSync(staged) && notes.length === 0 && launched.length === 0, `Mac 自动：下好解压，不弹拖拽提示，用户在用时不装（${u.state.lastResult}）`);
  idle = null;
  u.maybeAutoInstall();
  await new Promise((r) => setTimeout(r, 20));
  const l = launched[0];
  check(launched.length === 1 && quits === 1 && l && l.args[0] === String(process.pid) && l.args[1] === bundle && l.args[2] === staged && /install-failed/.test(l.args[3]), `Mac 自动：空闲时启动替换脚本并退出（${JSON.stringify(l && l.args)}）`);
  check(l && fs.readFileSync(l.script, 'utf8') === MAC_INSTALL_SCRIPT, 'Mac 自动：替换脚本写到数据目录');
  // 用户点“检查并更新”：下好后不等空闲，马上重启安装（一次点击就够）
  fs.rmSync(path.join(updatesDir, 'staging'), { recursive: true, force: true });
  launched.length = 0;
  quits = 0;
  idle = '窗口开着';
  u = make();
  u.setupMac();
  u.userUpdate();
  check(u.state.userAsked, '点“检查并更新”后记下用户要更新');
  for (let i = 0; i < 50 && !launched.length; i += 1) await new Promise((r) => setTimeout(r, 20));
  check(launched.length === 1 && quits === 1, `Mac：用户点了更新，下好后窗口开着也直接重启安装（${u.state.status} ${u.state.lastResult}）`);
  idle = null;
  // 已是最新版：用户的“要更新”不留着
  serve({ tag: 'v0.2.0' });
  u = make();
  u.userUpdate();
  for (let i = 0; i < 50 && u.state.status === 'checking'; i += 1) await new Promise((r) => setTimeout(r, 20));
  check(u.state.status === 'none' && !u.state.userAsked, '已是最新版时清掉“用户要更新”');
  serve();
  // 已经下好：点一下直接装
  {
    const w = make();
    w.mac = false;
    let installs = 0;
    w.updater = { quitAndInstall: () => { installs += 1; } };
    w.set({ status: 'downloaded', version: '0.3.0', manual: false });
    idle = '窗口开着';
    w.maybeAutoInstall();
    await new Promise((r) => setTimeout(r, 10));
    check(installs === 0, 'Windows：没点更新、用户在用时不自动装');
    w.userUpdate();
    await new Promise((r) => setTimeout(r, 10));
    check(installs === 1, 'Windows：已下好时点一下就重启安装');
    // 下载中点了：下好事件一到就装
    const w2 = make();
    w2.mac = false;
    let installs2 = 0;
    w2.updater = { quitAndInstall: () => { installs2 += 1; } };
    w2.set({ status: 'downloading', version: '0.3.0', manual: false });
    w2.userUpdate();
    w2.succeed('downloaded', 'ok', { version: '0.3.0', percent: 100 });
    w2.maybeAutoInstall();
    await new Promise((r) => setTimeout(r, 10));
    check(installs2 === 1, 'Windows：下载中点了更新，下好后直接重启安装');
    // 下载中点了更新，下好时用户还在打字：先不重启，停手了再装
    let busy = '正在打字';
    let installs3 = 0;
    const w3 = new Updater({
      onChange() {}, idleReason: () => '窗口开着', busyReason: () => busy, beforeInstall: async () => {}, installFailed: async () => {},
      notify: () => {}, idleMs: 200, waitPollMs: 20, macOps: fakeOps,
    });
    w3.mac = false;
    w3.updater = { quitAndInstall: () => { installs3 += 1; } };
    w3.set({ status: 'downloading', version: '0.3.0', manual: false });
    w3.userUpdate();
    w3.succeed('downloaded', 'ok', { version: '0.3.0', percent: 100 });
    w3.maybeAutoInstall();
    await new Promise((r) => setTimeout(r, 60));
    check(installs3 === 0 && w3.state.waitReason === '正在打字', `Windows：用户点了更新但还在打字，下好后先不重启（${w3.state.waitReason}）`);
    busy = null;
    await new Promise((r) => setTimeout(r, 60));
    check(installs3 === 1 && !w3.state.waitReason, 'Windows：停手后自动重启安装');
    // 等停手时点了“稍后”：不自动重启，改回空闲时再装
    busy = '正在打字';
    let installs4 = 0;
    const w4 = new Updater({
      onChange() {}, idleReason: () => '窗口开着', busyReason: () => busy, beforeInstall: async () => {}, installFailed: async () => {},
      notify: () => {}, idleMs: 200, waitPollMs: 20, macOps: fakeOps,
    });
    w4.mac = false;
    w4.updater = { quitAndInstall: () => { installs4 += 1; } };
    w4.set({ status: 'downloading', version: '0.3.0', manual: false });
    w4.userUpdate();
    w4.succeed('downloaded', 'ok', { version: '0.3.0', percent: 100 });
    w4.maybeAutoInstall();
    await new Promise((r) => setTimeout(r, 30));
    w4.userLater();
    busy = null;
    await new Promise((r) => setTimeout(r, 60));
    w4.maybeAutoInstall();
    await new Promise((r) => setTimeout(r, 10));
    check(installs4 === 0 && !w4.state.userAsked && !w4.state.waitReason, 'Windows：等停手时点“稍后”，窗口开着就不自动重启');
    idle = null;
  }
  // 上次替换失败：这次改成手动
  fs.writeFileSync(u.macResultFile(), '放入新版本失败');
  u = make();
  u.setupMac();
  check(!u.macAuto && u.state.manual && /上次自动安装没成功/.test(u.macBlocker) && !fs.existsSync(u.macResultFile()), `Mac：上次自动替换失败，这次改成手动（${u.macBlocker}）`);
  // 解压出来的版本号不对：失败，删掉
  fakeApp = { CFBundleIdentifier: 'com.waswitch.app', CFBundleShortVersionString: '0.2.9' };
  fs.rmSync(updatesDir, { recursive: true, force: true });
  serve();
  u = make();
  u.setupMac();
  await u.check();
  check(u.state.status === 'error' && /版本不对/.test(u.state.lastResult) && !fs.existsSync(staged) && !fs.existsSync(file), `Mac：解压后版本号不对时报错并删掉（${u.state.lastResult}）`);
  fakeApp = { CFBundleIdentifier: 'com.evil', CFBundleShortVersionString: '0.3.0' };
  await u.check();
  check(u.state.status === 'error' && /不是 WAswitch/.test(u.state.lastResult), 'Mac：解压出来不是 WAswitch 时报错');
  fakeElectron.app.getPath = fakeHome;

  // 替换脚本本身：bash 语法检查，再用假的 ditto / xattr / open 在临时目录里真跑一遍
  const { execFileSync } = require('child_process');
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-sh-'));
  const sh = path.join(sdir, 'install.sh');
  const bin = path.join(sdir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ditto'), '#!/bin/bash\ncp -R "$1" "$2"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'xattr'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/bash\necho "$1" > "${sdir}/opened"\n`, { mode: 0o755 });
  fs.writeFileSync(sh, MAC_INSTALL_SCRIPT.replace(/\/usr\/bin\//g, `${bin}/`));
  execFileSync('bash', ['-n', sh]);
  const oldApp = path.join(sdir, 'Applications', 'WAswitch.app');
  const newApp = path.join(sdir, 'staging', 'WAswitch.app');
  fs.mkdirSync(oldApp, { recursive: true }); fs.writeFileSync(path.join(oldApp, 'v'), 'old');
  fs.mkdirSync(newApp, { recursive: true }); fs.writeFileSync(path.join(newApp, 'v'), 'new');
  const res = path.join(sdir, 'failed.txt');
  execFileSync('bash', [sh, '999999', oldApp, newApp, res]); // 这个 pid 不存在 = 旧版已退出
  check(fs.readFileSync(path.join(oldApp, 'v'), 'utf8') === 'new' && !fs.existsSync(newApp) && !fs.existsSync(res)
    && fs.readdirSync(path.dirname(oldApp)).length === 1 && fs.readFileSync(path.join(sdir, 'opened'), 'utf8').trim() === oldApp, '替换脚本：换成新版、不留备份、重新打开');
  // 新版不见了：旧版原样留着，记下失败，照样重新打开
  fs.rmSync(path.join(sdir, 'opened'));
  try { execFileSync('bash', [sh, '999999', oldApp, newApp, res]); } catch { /* 脚本按失败退出 */ }
  check(fs.readFileSync(path.join(oldApp, 'v'), 'utf8') === 'new' && fs.existsSync(res) && fs.existsSync(path.join(sdir, 'opened')) && fs.readdirSync(path.dirname(oldApp)).length === 1, '替换脚本：失败时保留旧版、记下原因、重新打开');
  fs.rmSync(sdir, { recursive: true, force: true });

  // Windows：安装没启动（quitAndInstall 出错）时恢复软件正常运行
  u = make();
  u.mac = false;
  u.state.manual = false;
  u.updater = { quitAndInstall() { throw new Error('安装包被删了'); } };
  u.set({ status: 'downloaded', version: '0.3.0' });
  installFailedCalls = 0;
  await u.install();
  check(installFailedCalls === 1 && u.state.status === 'error' && !u.installing, `安装出错时调用恢复并记为失败（${u.state.lastResult}）`);

  fs.rmSync(home, { recursive: true, force: true });
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
