// 自检：自动更新模块。
// 1. 静态检查：updater 不碰任何账号的会话；和团队同步一样直连（不用系统代理，也不用任何账号的代理）；不再连 GitHub。
// 2. 只允许来财的更新地址（laicrm.com/api/device/update/）；版本比较；解析 latest-mac.yml；失败原因的中文（401、403、下载时的 status 401）。
// 3. Mac 流程（自己下载 zip、解压、App 退出后脚本替换）：用假的 electron.net 跑一遍——每个请求带设备令牌、没登录团队不检查、
//    正常下载并校验通过、sha512 不对时删掉、任何重定向都失败、已是最新版时不下载、连续失败 3 次标黄、新版本还在上传（404）时不算失败。
// 4. Windows：electron-updater 用 generic 方式读来财，检查前换上令牌，只放行来财的地址。
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
check((code.match(/setProxy\(\{ mode: 'direct' \}\)/g) || []).length === 2 && !/setProxy\(\{(?! mode: 'direct' \})/.test(code), 'Mac 和 Windows 两条路都直连（和团队同步一样），不设任何别的代理');
check(/redirect:\s*'manual'/.test(code) && !/requestWith\([^)]*next/.test(code), 'Mac 下载不跟重定向（令牌不会带到别处）');
check(!/github|releases\.atom|releases\/download/i.test(code), 'updater 不再连 GitHub');
check(/require\('\.\/team'\)/.test(code) && /const FEED = `\$\{TEAM_SERVER\}\/api\/device\/update\/`/.test(code), '更新地址和团队同步是同一个来财（TEAM_SERVER）');
{
  const winCheck = (code.match(/async check\(\) \{[\s\S]*?\n  \}\n/) || [''])[0];
  check(winCheck.indexOf('requestHeaders') > 0 && winCheck.indexOf('requestHeaders') < winCheck.indexOf('checkForUpdates()'), 'Windows：每次检查前换上设备令牌');
}
check(/const CHECK_EVERY_MS = 60 \* 60 \* 1000;/.test(code) && /const FIRST_CHECK_MS = 60 \* 1000;/.test(code), '启动 1 分钟后查一次，之后每 1 小时查一次');

// 用户点了更新之后装之前，主进程的 busyReason 要等手上的事做完：打字、发消息、扫码、页面加载
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const busyFn = (mainSrc.match(/function updateBusyReason\(\) \{[\s\S]*?\n\}\n/) || [''])[0];
check(/lastTypedAt/.test(busyFn) && /liteHost\.busy\(\)/.test(busyFn) && !/idleSeconds/.test(busyFn), 'main.js：点了更新后，打字、发消息、扫码、页面加载要等；鼠标动了不拖着安装');

// 点一次“立即更新”就自动装好并重新打开，中间不弹任何确认（shen 2026-10-29）：更新流程里不能出现对话框，按钮也不能换回别的名字
check(!/\bdialog\b/.test(code) && !/showMessageBox|showMessageBoxSync|confirm\(/.test(code), 'updater 不弹任何对话框（点更新后不需要确认）');
const handlerLines = mainSrc.split('\n').filter((l) => /onShell\('update:/.test(l)).join('\n');
const trayBlock = (mainSrc.match(/updateMenu: \(\) => \{[\s\S]*?\n  \},/) || [''])[0];
check(handlerLines.includes('update:install') && trayBlock.includes('updater.install()')
  && !/dialog|showMessageBox|confirm\(/.test(handlerLines + trayBlock), 'main.js：更新按钮和托盘菜单只调 install() 或 openMacInstaller()，不经过确认框');
const shellSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell', 'shell.js'), 'utf8');
check(/deviceToken: \(\) => \(team \? team\.tokenPlain\(\) : ''\)/.test((mainSrc.match(/function setupUpdater\(\) \{[\s\S]*?\n\}\n/) || [''])[0]), 'main.js：更新用团队登录的设备令牌');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
check(JSON.stringify(pkg.build.publish) === JSON.stringify([{ provider: 'generic', url: 'https://laicrm.com/api/device/update/' }]), 'package.json：安装包里写的更新地址是来财（generic）');
check(!/GitHub|Releases 页面/.test(src.replace(/^\s*\/\/.*$/gm, '')) && !/Releases 页面/.test(mainSrc) && !/下载页/.test((shellSrc.match(/function updateBox\(u\) \{[\s\S]*?\n\}\n/) || [''])[0]), '更新的提示里不再提 GitHub、Releases 和下载页');
check(!/重启更新|现在重启并更新|重启以更新|下好后自动重启/.test(shellSrc + mainSrc + src), '更新按钮统一叫“立即更新”，没有旧名字');
check((shellSrc.match(/window\.wa\.updateInstall\(\)/g) || []).length >= 2
  && !/updateInstall\(\)[^\n]*confirm|confirm[^\n]*updateInstall/.test(shellSrc), '界面上点“立即更新”直接调 updateInstall，不经过 confirm');

// ---------- 假的 electron ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-upd-'));
const routes = new Map(); // url -> { status, body, location }
const requested = [];
const sentHeaders = []; // 每个请求带的头（小写的名字）
const proxies = []; // [分区名, mode]
const usedSessions = new Set();
const fakeNet = {
  request({ url, session: ses }) {
    usedSessions.add(ses && ses.name);
    const req = new EventEmitter();
    const hdr = {};
    req.setHeader = (k, v) => { hdr[String(k).toLowerCase()] = v; };
    req.abort = () => { req.aborted = true; };
    req.end = () => setImmediate(() => {
      requested.push(url);
      sentHeaders.push(hdr);
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
// 假的 electron-updater：记下 setFeedURL、开关和放行规则
const fakeAuto = new EventEmitter();
fakeAuto.feeds = [];
fakeAuto.setFeedURL = (o) => fakeAuto.feeds.push(o);
fakeAuto.netSession = { webRequest: { onBeforeRequest: (fn) => { fakeAuto.filter = fn; } } };
const origLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return fakeElectron;
  if (request === 'electron-updater') return { autoUpdater: fakeAuto };
  return origLoad.call(this, request, ...rest);
};
Object.defineProperty(process, 'platform', { value: 'darwin' });

const { Updater, UPDATER_PARTITION, FEED, NO_TOKEN_TEXT, allowedUrl, compareVersions, parseLatestYml, updateErrorText } = require('../src/updater');

// ---------- 2. 小工具 ----------
check(FEED === 'https://laicrm.com/api/device/update/', `更新地址是来财（${FEED}）`);
check(allowedUrl(`${FEED}latest-mac.yml`) && allowedUrl(`${FEED}WAswitch-Setup-1.0.7.exe`), '允许来财的更新文件');
check(!allowedUrl('https://github.com/Kr1xxxx/WAswitch/releases/download/v1.0.7/latest.yml') && !allowedUrl('https://objects.githubusercontent.com/x'), '不再允许 GitHub 的地址');
check(!allowedUrl('http://laicrm.com/api/device/update/latest.yml'), '不允许 http');
check(!allowedUrl('https://laicrm.com/api/device/join') && !allowedUrl('https://laicrm.com/api/device/update/a/b') && !allowedUrl('https://laicrm.com:8443/api/device/update/latest.yml'), '只允许来财的 /api/device/update/ 下面一层（别的接口、子目录、别的端口都不行）');
check(!allowedUrl('https://laicrm.com.evil.example/api/device/update/x') && !allowedUrl('https://evil.example/api/device/update/laicrm.com'), '不允许冒充来财的主机');
{
  const t = (e, msg) => updateErrorText(e, msg || String(e.message).split('\n')[0]).text;
  check(t(Object.assign(new Error('来财返回 401'), { statusCode: 401 })) === '登录已过期，重新登录后再检查更新', '401：登录已过期');
  check(t(Object.assign(new Error('来财返回 403'), { statusCode: 403 })) === '这台电脑已被停用', '403：这台电脑已被停用');
  check(t(new Error('Cannot download "https://laicrm.com/api/device/update/WAswitch-Setup-1.0.7.exe", status 401: Unauthorized')) === '登录已过期，重新登录后再检查更新', '下载时的 "status 401" 也认得出来');
  check(t(new Error('HttpError: 403 Forbidden\n{"ok":false,"error":"revoked"}')) === '这台电脑已被停用', 'electron-updater 检查时的 HttpError 403 也认得出来');
  check(/新版本可能还在发布中/.test(t(Object.assign(new Error('x'), { statusCode: 404 }))) && /来财那边/.test(t(Object.assign(new Error('x'), { statusCode: 502 }))), '404 和 5xx 的中文');
  check(/^连不上来财/.test(t(new Error('net::ERR_CONNECTION_RESET'))), `网络错误说连不上来财（${t(new Error('net::ERR_CONNECTION_RESET'))}）`);
}
check(compareVersions('0.2.1', '0.2.0') > 0 && compareVersions('v0.10.0', '0.9.9') > 0 && compareVersions('0.2.0', '0.2.0') === 0, '版本比较（数字按大小，不按字符）');
check(compareVersions('0.3.0', '0.3.0-beta.2') > 0 && compareVersions('0.3.0-beta.10', '0.3.0-beta.2') > 0, '版本比较（预发布版）');

// ---------- 3. Mac 流程 ----------
const dmg = crypto.randomBytes(300 * 1024);
const sha = crypto.createHash('sha512').update(dmg).digest('base64');
const yml = (s, v = '0.3.0') => `version: ${v}
files:
  - url: WAswitch-${v}-arm64.dmg
    sha512: zzz
    size: 10
  - url: WAswitch-${v}-arm64.zip
    sha512: ${s}
    size: ${dmg.length}
path: WAswitch-${v}-arm64.zip
sha512: zzz
releaseDate: '2026-10-24T00:00:00.000Z'
`;
const parsed = parseLatestYml(yml(sha));
check(parsed.version === '0.3.0' && parsed.files.length === 2 && parsed.files[1].sha512 === sha && parsed.files[1].size === dmg.length, '解析 latest-mac.yml');

const ymlUrl = `${FEED}latest-mac.yml`;
const asset = `${FEED}WAswitch-0.3.0-arm64.zip`;
function serve({ ymlSha = sha, zipLocation = '', version = '0.3.0' } = {}) {
  routes.clear();
  routes.set(ymlUrl, { body: Buffer.from(yml(ymlSha, version)) });
  routes.set(asset, zipLocation ? { location: zipLocation } : { body: dmg });
  routes.set('https://evil.example/dmg', { body: dmg });
  routes.set(`${FEED}moved.zip`, { body: dmg });
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
let token = 'tok-1';
const make = () => new Updater({
  onChange() {}, idleReason: () => idle, beforeInstall: async () => {}, installFailed: async () => { installFailedCalls += 1; },
  notify: (t, b, click) => notes.push({ t, click }), idleMs: 200, macOps: fakeOps, deviceToken: () => token,
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
  check(notes.length === 1 && opened.length === 0, 'Mac 手动：后台下完只弹通知，不自己打开安装包');
  notes[0].click();
  check(opened.includes(staged) && opened.includes('/Applications'), 'Mac 手动：点通知在 Finder 里选中新 WAswitch.app 并打开「应用程序」');
  check(u.state.manual && launched.length === 0 && quits === 0, 'Mac 手动：不在「应用程序」里时不自动替换');
  check(requested.length === 2 && requested[0] === ymlUrl && requested[1] === asset && requested.every((x) => allowedUrl(x)), `Mac：只请求来财的 latest-mac.yml 和 zip（${requested.join(' ')}）`);
  check(sentHeaders.length === 2 && sentHeaders.every((h) => h.authorization === 'Bearer tok-1'), 'Mac：每个请求都带设备令牌');

  check(proxies.length === 1 && proxies[0][0] === UPDATER_PARTITION && proxies[0][1] === 'direct', `Mac：更新专用会话直连（${JSON.stringify(proxies)}）`);
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

  // 写盘出错（磁盘满、没权限）：报更新失败，不能是没人接的 error 事件（会弹错并重启软件）
  {
    serve();
    fs.mkdirSync(`${file}.part`, { recursive: true }); // 占住 .part：写文件流一打开就出错
    const uncaught = [];
    const onUncaught = (e) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    const uw = make();
    await uw.check();
    await new Promise((r) => setTimeout(r, 100));
    process.off('uncaughtException', onUncaught);
    check(!uncaught.length, `Mac：写盘出错不崩（${uncaught.map((e) => e.code || e.message).join(' ')}）`);
    check(uw.state.status === 'error' && uw.state.failures === 1 && /磁盘/.test(uw.state.lastResult), `Mac：写盘出错时提示更新失败（${uw.state.status} ${uw.state.lastResult}）`);
    check(!fs.existsSync(`${file}.part`) && !fs.existsSync(file), 'Mac：写盘出错后不留 .part');
  }

  // 重定向到别的主机：失败，不请求那个地址（令牌不会带过去）
  serve({ zipLocation: 'https://evil.example/dmg' });
  requested.length = 0;
  await u.check();
  check(u.state.status === 'error' && /跳转/.test(u.state.lastResult) && !requested.includes('https://evil.example/dmg'), `Mac：重定向到别的主机视为失败，也不会去请求（${u.state.lastResult}）`);
  check(u.state.failures === 2 && !u.snapshot().warn, '失败 2 次还不标黄');
  // 来财不跳转：就算跳到来财自己的地址也当失败
  serve({ zipLocation: `${FEED}moved.zip` });
  requested.length = 0;
  await u.check();
  check(u.state.status === 'error' && !requested.includes(`${FEED}moved.zip`), `Mac：跳到来财自己的地址也不跟（${u.state.lastResult}）`);
  u.set({ failures: 2 });
  await u.check();
  check(u.state.failures === 3 && u.snapshot().warn, '连续失败 3 次标黄');
  check(u.state.lastCheckAt > 0, '记录上次检查时间');

  // 已是最新版
  serve({ version: '0.2.0' });
  u = make();
  await u.check();
  check(u.state.status === 'none' && u.state.failures === 0 && !u.state.needLogin, `已是最新版时不下载（${u.state.lastResult}）`);

  // 没登录团队：不发任何请求，不算失败，提示先登录
  serve();
  token = '';
  requested.length = 0;
  u = make();
  u.set({ failures: 2 });
  u.userUpdate();
  check(u.state.status === 'none' && u.state.needLogin && u.state.lastResult === NO_TOKEN_TEXT && u.state.failures === 0 && !u.state.userAsked && requested.length === 0,
    `没登录团队：不检查、不算失败（${u.state.lastResult}）`);
  token = 'tok-2';
  await u.check();
  check(u.state.status === 'downloaded' && !u.state.needLogin && sentHeaders[sentHeaders.length - 1].authorization === 'Bearer tok-2', '登录后下一次照常检查，用新的令牌');
  fs.rmSync(updatesDir, { recursive: true, force: true });

  // 来财说登录过期（401）、这台电脑被停用（403）：按失败记，说清楚原因
  routes.set(ymlUrl, { status: 401 });
  u = make();
  await u.check();
  check(u.state.status === 'error' && u.state.lastResult === '失败：登录已过期，重新登录后再检查更新' && u.state.failures === 1, `401：提示重新登录（${u.state.lastResult}）`);
  routes.set(ymlUrl, { status: 403 });
  await u.check();
  check(u.state.status === 'error' && u.state.lastResult === '失败：这台电脑已被停用', `403：提示这台电脑已被停用（${u.state.lastResult}）`);
  token = 'tok-1';

  // 新版本刚发布、latest-mac.yml 还没传上去（404）：不算失败，稍后自己再查
  serve();
  routes.set(ymlUrl, { status: 404 });
  u = make();
  u.set({ failures: 2 });
  await u.check();
  check(u.state.status === 'none' && u.state.failures === 0 && /上传/.test(u.state.lastResult) && u.pendingTimer, `新版本还在上传时不算失败、稍后再查（${u.state.lastResult}）`);
  clearTimeout(u.pendingTimer);
  serve();
  routes.set(asset, { status: 404 });
  u = make();
  await u.check();
  check(u.state.status === 'error' && /找不到更新文件/.test(u.state.lastResult) && u.state.failures === 1, `安装包 404 仍然算失败（${u.state.lastResult}）`);

  // Windows：electron-updater 用 generic 方式读来财，只放行来财的地址
  {
    const w = make();
    w.mac = false;
    w.setupElectronUpdater();
    check(fakeAuto.feeds.length === 1 && fakeAuto.feeds[0].provider === 'generic' && fakeAuto.feeds[0].url === FEED, `Windows：electron-updater 读来财（${JSON.stringify(fakeAuto.feeds)}）`);
    check(fakeAuto.disableDifferentialDownload === true && fakeAuto.disableWebInstaller === true && fakeAuto.autoDownload === true, 'Windows：整包下载（来财不支持一次取多段），不用网络安装包');
    const filtered = (url) => { let r; fakeAuto.filter({ url }, (x) => { r = x; }); return r.cancel; };
    check(!filtered(`${FEED}latest.yml`) && !filtered(`${FEED}WAswitch-Setup-1.0.7.exe`), 'Windows：放行来财的 latest.yml 和安装包');
    check(filtered('https://github.com/Kr1xxxx/WAswitch/releases/download/v1.0.7/latest.yml') && filtered('https://laicrm.com/api/device/join'), 'Windows：拦下 GitHub 和来财别的接口');
    fakeAuto.removeAllListeners();
  }
  // Windows：会话直连；检查前换上令牌；找不到 latest.yml 不算失败
  {
    const winProxy = [];
    const w = make();
    w.mac = false;
    let seen = null;
    w.updater = {
      netSession: { async setProxy(c) { winProxy.push(c.mode); } },
      async checkForUpdates() { seen = this.requestHeaders; const e = new Error('Cannot find latest.yml'); e.code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'; throw e; },
    };
    await w.check();
    check(winProxy.join() === 'direct', 'Windows：检查前把 electron-updater 的会话设成直连');
    check(seen && seen.authorization === 'Bearer tok-1', 'Windows：检查（和随后的下载）带设备令牌');
    check(w.state.status === 'none' && w.state.failures === 0 && w.pendingTimer, `Windows：latest.yml 还没传上去时不算失败（${w.state.lastResult}）`);
    clearTimeout(w.pendingTimer);
    // 下载时来财回 401：electron-updater 只给一句 "status 401"
    w.updater.checkForUpdates = async () => { throw new Error('Cannot download "https://laicrm.com/api/device/update/WAswitch-Setup-0.3.0.exe", status 401: Unauthorized'); };
    await w.check();
    check(w.state.status === 'error' && /登录已过期/.test(w.state.lastResult), `Windows：下载时 401 提示重新登录（${w.state.lastResult}）`);
    // 没登录团队：不调 checkForUpdates
    token = '';
    let called = false;
    w.updater.checkForUpdates = async () => { called = true; return {}; };
    await w.check();
    check(!called && w.state.status === 'none' && w.state.needLogin, 'Windows：没登录团队不检查');
    token = 'tok-1';
    w.updater.netSession.setProxy = async () => { throw new Error('设不了'); };
    w.netReady = false;
    await w.check();
    check(!called && w.state.status === 'error', 'Windows：会话设不好就不检查');
  }

  // 请求挂住：超时算失败，状态不会一直停在“检查中”
  serve();
  routes.set(ymlUrl, { hang: true });
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
  serve({ version: '0.2.0' });
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
  check(u.state.status === 'downloaded' && fs.existsSync(staged) && notes.length === 0 && launched.length === 0 && !u.state.waitReason, `Mac 自动：下好解压，不弹拖拽提示，窗口开着不装（${u.state.lastResult}）`);
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
  serve({ version: '0.2.0' });
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
    // 后台下完、什么都没点：窗口开着不会自己重启，缩到托盘空闲后才装
    w.maybeAutoInstall();
    await new Promise((r) => setTimeout(r, 10));
    check(installs === 0 && !w.state.waitReason, 'Windows：后台下完没点任何按钮，窗口开着不自动装');
    idle = null;
    w.maybeAutoInstall();
    await new Promise((r) => setTimeout(r, 10));
    check(installs === 1, 'Windows：没点任何按钮，缩到托盘空闲后自动装');
    // 点“立即更新”（已下好）：不看 busyReason，马上装一次
    idle = '窗口开着';
    installs = 0;
    w.installing = false;
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
    // 已下好、正在打字时点“立即更新”：不看 busyReason，马上装一次
    let installs6 = 0;
    const w6 = new Updater({
      onChange() {}, idleReason: () => '窗口开着', busyReason: () => '正在打字', beforeInstall: async () => {}, installFailed: async () => {},
      notify: () => {}, idleMs: 200, waitPollMs: 20, macOps: fakeOps,
    });
    w6.mac = false;
    w6.updater = { quitAndInstall: () => { installs6 += 1; } };
    w6.set({ status: 'downloaded', version: '0.3.0', manual: false });
    w6.userUpdate();
    await new Promise((r) => setTimeout(r, 10));
    check(installs6 === 1, 'Windows：正在打字时点“立即更新”，马上装一次，不再等');
    check(w4.trayText() === '新版本 0.3.0 已下载', `托盘提示不写“重启”（${w4.trayText()}）`);
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

  // 设置页点「重启」：Windows 上有下好的更新时走 install()（quitAndInstall(true, true) = 静默装 + 装完 --force-run 重新打开），
  // 不能自己 relaunch + quit（退出时 autoInstallOnAppQuit 静默装，没有 --force-run，装完软件就不再打开）
  {
    const relaunchSrc = (mainSrc.match(/async function relaunchApp\(\) \{[\s\S]*?\n\}\n/) || [''])[0];
    check(/await updater\.restartWithUpdate\(\)/.test(relaunchSrc) && relaunchSrc.indexOf('restartWithUpdate') < relaunchSrc.indexOf('app.relaunch()'),
      'main.js：relaunchApp 先看有没有下好的更新，没有才自己 relaunch');
    const run = async (setup) => {
      const w = make();
      w.mac = false;
      const calls = [];
      w.updater = { quitAndInstall: (...a) => calls.push(a) };
      setup(w);
      const handled = await w.restartWithUpdate();
      return { handled, calls, w };
    };
    let r = await run((w) => w.set({ status: 'downloaded', version: '0.3.0', manual: false }));
    check(r.handled === true && r.calls.length === 1 && r.calls[0][0] === true && r.calls[0][1] === true,
      '重启时有下好的更新：走 quitAndInstall(静默, 装完重新打开)，不再自己 relaunch');
    check(r.w.installing, '重启时有下好的更新：进入安装状态（30 秒内没退出会恢复）');
    // 已经在装了：不再装第二次，也不要再自己 relaunch
    r.calls.length = 0;
    check(await r.w.restartWithUpdate() === true && r.calls.length === 0, '已经在安装：不重复调用，调用方也不再 relaunch');
    r = await run(() => {});
    check(r.handled === false && r.calls.length === 0, '没有更新：返回 false，调用方照常 relaunch');
    r = await run((w) => w.set({ status: 'downloading', version: '0.3.0', manual: false }));
    check(r.handled === false && r.calls.length === 0, '更新还在下载：返回 false，照常 relaunch');
    r = await run((w) => w.set({ status: 'downloaded', version: '0.3.0', manual: true }));
    check(r.handled === false && r.calls.length === 0, 'Mac 手动安装：返回 false，照常 relaunch');
    // 安装没启动（quitAndInstall 出错）：返回 false，调用方自己 relaunch，软件照样重新打开
    {
      const w = make();
      w.mac = false;
      w.updater = { quitAndInstall() { throw new Error('安装包被删了'); } };
      w.set({ status: 'downloaded', version: '0.3.0', manual: false });
      installFailedCalls = 0;
      check(await w.restartWithUpdate() === false && installFailedCalls === 1 && !w.installing, '安装没启动：恢复运行并返回 false，调用方照常 relaunch');
    }
  }

  fs.rmSync(home, { recursive: true, force: true });
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
