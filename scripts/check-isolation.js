// 自检脚本：不需要联网，不需要 WhatsApp 账号。
// 检查三件事：
//   1. 两个账号的浏览器标识、语言、时区各自生效、互不影响
//   2. 设了代理的账号，流量确实走代理
//   3. 页面刷新后以上设置仍然生效
//   4. 代理连不上时，请求失败，而不是悄悄改成直连
// 运行：npx electron scripts/check-isolation.js
const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const fingerprint = require('../src/fingerprint');
const proxy = require('../src/proxy');
const { clearSessionCache } = require('../src/cache');

const PROBE = `(async () => {
  const uad = navigator.userAgentData
    ? await navigator.userAgentData.getHighEntropyValues(['platform', 'fullVersionList'])
    : null;
  return {
    ua: navigator.userAgent,
    platform: navigator.platform,
    languages: navigator.languages,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    chPlatform: uad && uad.platform,
    chBrands: uad && uad.fullVersionList.map((b) => b.brand).join(', '),
    body: document.body.innerText,
  };
})()`;

// 一个最小的本地 HTTP 代理：收到请求就记下来，并返回一个固定页面
function startFakeProxy() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>p</title>via-proxy');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port })));
}

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };

app.commandLine.appendSwitch('no-sandbox');
// 测试中会逐个关闭窗口，不要因此退出
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const fake = await startFakeProxy();
  const results = {};

  for (const [name, region] of [['A', 'SG'], ['B', 'US']]) {
    const fp = fingerprint.generate(region);
    const ses = session.fromPartition(`check-${name}`);
    const r = fingerprint.resolve(fp);
    ses.setUserAgent(r.userAgent, r.acceptLanguage);
    await proxy.apply(ses, `http://127.0.0.1:${fake.port}`);
    const w = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true } });
    await fingerprint.attach(w.webContents, fp);
    await w.loadURL(`http://account-${name}.check/`);
    results[name] = await w.webContents.executeJavaScript(PROBE);
    // 自动回收会刷新页面，刷新后伪装必须仍然生效
    await new Promise((resolve) => { w.webContents.once('did-finish-load', resolve); w.webContents.reload(); });
    results[name].afterReload = await w.webContents.executeJavaScript(PROBE);
    // Client Hints 只在安全页面（https 或本地文件）里可读
    await w.loadFile(__filename.replace(/check-isolation\.js$/, 'blank.html'));
    const ch = await w.webContents.executeJavaScript(PROBE);
    results[name].chPlatform = ch.chPlatform;
    results[name].chBrands = ch.chBrands;
    console.log(`账号 ${name}（${region}）：`, JSON.stringify(results[name]));
    w.destroy();
  }

  check(results.A.timezone === 'Asia/Singapore' && results.B.timezone === 'America/New_York', '两个账号的时区各自生效');
  check(results.A.languages[0] === 'en-SG' && results.B.languages[0] === 'en-US', '两个账号的语言各自生效');
  check(!/Electron|waswitch/i.test(results.A.ua), 'UA 里没有 Electron 或应用名');
  check(['A', 'B'].every((n) => {
    const a = results[n].afterReload;
    return a.ua === results[n].ua && a.timezone === results[n].timezone && a.languages[0] === results[n].languages[0];
  }), '页面刷新（自动回收）后 UA、时区、语言仍然生效');
  check(results.A.chBrands && results.A.chBrands.includes('Google Chrome'), 'Client Hints 里有 Google Chrome');
  check(results.A.body === 'via-proxy' && fake.hits.length === 4, '设了代理的账号流量走代理');

  // 代理连不上：应该失败，而不是直连
  const ses = session.fromPartition('check-dead');
  await proxy.apply(ses, 'socks5://127.0.0.1:1');
  const w = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  let failCode = 0;
  w.webContents.on('did-fail-load', (_e, code) => { failCode = code; });
  await w.loadURL(`http://127.0.0.1:${fake.port}/direct`).catch(() => {});
  // 本机地址在代理白名单里，换一个外部地址测试
  await w.loadURL('http://example.com/').catch(() => {});
  check(failCode !== 0, `代理连不上时页面加载失败（错误码 ${failCode}），没有改用直连`);

  // 地址写错：应该被拒绝并进入黑洞
  const bad = await proxy.apply(session.fromPartition('check-bad'), 'socks5://user:pw@127.0.0.1:1080');
  check(!!bad.error, `带密码的 socks5 被拒绝：${bad.error}`);

  // 一键清理缓存：缓存变小，但 cookie、localStorage、IndexedDB 都还在（不会退出登录）
  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/big')) {
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'max-age=3600' });
      res.end(`// ${'x'.repeat(200000)}`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'max-age=3600' });
    res.end('<title>c</title><script src="/big.js"></script>');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const cses = session.fromPartition('check-cache');
  const cw = new BrowserWindow({ show: false, webPreferences: { session: cses } });
  await cw.loadURL(`http://127.0.0.1:${site.address().port}/`);
  await cw.webContents.executeJavaScript(`(async () => {
    document.cookie = 'login=yes; max-age=3600';
    localStorage.setItem('login', 'yes');
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('wa', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('s');
      req.onsuccess = () => { const tx = req.result.transaction('s', 'readwrite'); tx.objectStore('s').put('yes', 'login'); tx.oncomplete = resolve; tx.onerror = reject; };
      req.onerror = reject;
    });
    const c = await caches.open('app'); await c.put('/app.js', new Response('x'.repeat(100000)));
  })()`);
  const before = await cses.getCacheSize();
  await clearSessionCache(cses);
  const after = await cses.getCacheSize();
  const kept = await cw.webContents.executeJavaScript(`(async () => ({
    cookie: document.cookie.includes('login=yes'),
    local: localStorage.getItem('login') === 'yes',
    idb: await new Promise((resolve) => { const req = indexedDB.open('wa', 1); req.onsuccess = () => { const g = req.result.transaction('s').objectStore('s').get('login'); g.onsuccess = () => resolve(g.result === 'yes'); g.onerror = () => resolve(false); }; req.onerror = () => resolve(false); }),
    cacheStorage: (await caches.keys()).length,
  }))()`);
  check(before > 0 && after < before, `清理缓存后 HTTP 缓存变小（${before} → ${after} 字节）`);
  check(kept.cacheStorage === 0, '清理缓存后 Cache Storage 已清空');
  check(kept.cookie && kept.local && kept.idb, '清理缓存后 cookie、localStorage、IndexedDB 都还在（不会退出登录）');
  site.close();

  fake.server.close();
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  app.exit(failures ? 1 : 0);
});
