// 自检：自动更新模块。
// 1. 静态检查：updater 不碰任何账号的会话；只走本机直连（不用账号代理，也不用系统代理）。
// 2. 只允许 GitHub 的地址；版本比较；解析 releases.atom 和 latest-mac.yml。
// 3. Mac 流程（自己下载 dmg）：用假的 electron.net 跑一遍——正常下载并校验通过、sha512 不对时删掉、
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
const fakeElectron = {
  app: { isPackaged: true, getVersion: () => '0.2.0', getPath: () => home },
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
  - url: WAswitch-0.3.0-arm64.zip
    sha512: zzz
    size: 10
  - url: WAswitch-0.3.0-arm64.dmg
    sha512: ${s}
    size: ${dmg.length}
path: WAswitch-0.3.0-arm64.zip
sha512: zzz
releaseDate: '2026-10-24T00:00:00.000Z'
`;
const parsed = parseLatestYml(yml(sha));
check(parsed.version === '0.3.0' && parsed.files.length === 2 && parsed.files[1].sha512 === sha && parsed.files[1].size === dmg.length, '解析 latest-mac.yml');

const base = 'https://github.com/Kr1xxxx/WAswitch';
const dmgUrl = `${base}/releases/download/v0.3.0/WAswitch-0.3.0-arm64.dmg`;
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
const make = () => new Updater({
  onChange() {}, idleReason: () => null, beforeInstall: async () => {}, installFailed: async () => { installFailedCalls += 1; },
  notify: (t, b, click) => notes.push({ t, click }), idleMs: 200,
});
const updatesDir = path.join(home, 'updates');

(async () => {
  // 正常：下载、校验、提示
  serve();
  let u = make();
  await u.check();
  const file = path.join(updatesDir, 'WAswitch-0.3.0-arm64.dmg');
  check(u.state.status === 'downloaded' && u.state.version === '0.3.0' && u.state.percent === 100, `Mac：下载并校验通过（${u.state.status} ${u.state.lastResult}）`);
  check(fs.existsSync(file) && fs.readFileSync(file).equals(dmg) && !fs.existsSync(`${file}.part`), 'Mac：安装包存到数据目录，没有残留 .part');
  check(notes.length === 1, 'Mac：下载好后弹通知');
  notes[0].click();
  check(opened.includes(file), 'Mac：点通知在 Finder 里打开安装包');
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

  // Windows：安装没启动（quitAndInstall 出错）时恢复软件正常运行
  u = make();
  u.mac = false;
  u.updater = { quitAndInstall() { throw new Error('安装包被删了'); } };
  u.set({ status: 'downloaded', version: '0.3.0' });
  installFailedCalls = 0;
  await u.install();
  check(installFailedCalls === 1 && u.state.status === 'error' && !u.installing, `安装出错时调用恢复并记为失败（${u.state.lastResult}）`);

  fs.rmSync(home, { recursive: true, force: true });
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
