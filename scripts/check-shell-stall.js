// 自检：界面还没加载出来时主进程卡住十几秒以上，之后界面和账号页面都要自己出来，不能一直是空窗口。
// 真实情况：Mac 上换了 Electron 版本的更新装完后，系统弹「访问钥匙串」，没回答之前主进程一直等着；
// 超过约 15 秒 Chromium 的网络进程被收掉重开：
//   界面那次加载永远停在 about:blank，没有任何失败事件；
//   紧接着启动的账号卡在设代理那一步（断开旧连接的那一句发给了旧的网络进程，永远不回），后面的号也都起不来。
// 做法：开发版设 WASWITCH_TEST_BOOT_STALL_MS，界面刚开始加载主进程就停这么久。
// 配一个走本机代理的网页号：假的 web.whatsapp.com 只有经过这个代理才到得了（域名解析全部关掉），页面出来就说明走了代理。
//   1. 卡 20 秒：卡完界面加载出来（侧栏有内容），账号页面也打开，而且是从代理走的
//   2. 不卡：界面只加载一次，账号页面照常从代理打开
// 运行：node scripts/check-shell-stall.js（Linux 无界面环境用 xvfb-run）
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const electron = require('electron');
const { teamOff } = require('./fixtures/team-off');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const listen = (server) => new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const STALL_MS = 20000;
const RELOADED = '重新加载';
const WA_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp</title></head><body><div id="app"><div id="side"><div id="pane-side">Emma Schneider</div></div></div></body></html>';

// 在某一页里算一个表达式，返回 JSON 解出来的值；页面不在、没回话都返回 null
async function evalIn(port, urlPart, expression) {
  let targets = [];
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return null; }
  const t = targets.find((x) => x.url.includes(urlPart));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, expression: `JSON.stringify(${expression})` } }));
      ws.onmessage = (m) => { clearTimeout(timer); try { resolve(JSON.parse(JSON.parse(m.data).result.result.value)); } catch { resolve(null); } };
      ws.onerror = () => { clearTimeout(timer); resolve(null); };
    });
  } finally { ws.close(); }
}
const shellPainted = async (port) => {
  const s = await evalIn(port, 'shell/index.html', '{ href: location.href, side: !!document.querySelector("#side *") }');
  return !!s && s.href.includes('shell/index.html') && s.side;
};
const waShown = async (port) => (await evalIn(port, 'web.whatsapp.com', '!!document.querySelector("#pane-side")')) === true;
async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200); }
  return false;
}

(async () => {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-stall-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web.whatsapp.com',
    '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')], { stdio: 'ignore' });
  // 假的 web.whatsapp.com
  const wa = https.createServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }, (req, res) => {
    if (req.url.split('?')[0] === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(WA_PAGE); return; }
    res.writeHead(404); res.end();
  });
  const waPort = await listen(wa);
  // 本机代理：只放行去 WhatsApp 的 CONNECT，接到假服务器上，数一下放行了几次
  const st = { connects: 0 };
  const proxy = http.createServer((_req, res) => { res.writeHead(502); res.end(); });
  proxy.on('connect', (req, socket) => {
    socket.on('error', () => {});
    if (!/(^|\.)whatsapp\.(com|net):443$/.test(req.url)) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    st.connects += 1;
    const up = net.connect(waPort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(socket); socket.pipe(up); });
    up.on('error', () => socket.destroy());
  });
  const proxyPort = await listen(proxy);

  async function boot(stallMs) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-stall-'));
    fs.mkdirSync(path.join(home, 'waswitch'), { recursive: true });
    fs.writeFileSync(path.join(home, 'waswitch', 'accounts.json'), JSON.stringify([{
      id: '1', name: 'Emma', color: '#16A34A', proxy: `http://127.0.0.1:${proxyPort}`, mode: 'web', primary: true,
      fingerprint: { version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region: 'DE', seed: 1 },
    }]));
    const port = await freePort();
    const env = { ...process.env, XDG_CONFIG_HOME: home, HOME: home, ...teamOff(path.join(home, 'waswitch')) };
    if (stallMs) env.WASWITCH_TEST_BOOT_STALL_MS = String(stallMs);
    for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
    // 域名一个都解析不了：不经过代理就到不了假的 WhatsApp，更到不了真的
    const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, '--ignore-certificate-errors',
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const run = { log: '', port, startedAt: Date.now() };
    child.stdout.on('data', (d) => { run.log += d; });
    child.stderr.on('data', (d) => { run.log += d; });
    run.secs = () => Math.round((Date.now() - run.startedAt) / 1000);
    run.stop = async () => { child.kill(); await sleep(500); fs.rmSync(home, { recursive: true, force: true }); };
    return run;
  }

  let failures = 0;
  const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
  const tail = (run) => console.log(run.log.split('\n').filter((l) => l && !/dbus|NODE_OPTION/.test(l)).slice(-15).join('\n'));

  // 1. 界面刚开始加载就卡 20 秒
  const a = await boot(STALL_MS);
  const before = failures;
  try {
    await sleep(STALL_MS - 2000);
    check(!(await shellPainted(a.port)), '主进程卡着的时候界面还没出来');
    check(await waitFor(() => shellPainted(a.port), 2000 + 8000), `卡 ${STALL_MS / 1000} 秒后界面自己加载出来了（启动后 ${a.secs()} 秒）`);
    check(a.log.includes(RELOADED), '日志里记了重新加载');
    check(await waitFor(() => waShown(a.port), 20000), `卡完账号页面也打开了（启动后 ${a.secs()} 秒）`);
    check(st.connects >= 1, `账号页面是从代理走的（代理放行 ${st.connects} 次）`);
  } catch (e) { console.error(e); failures += 1; } finally { await a.stop(); }
  if (failures > before) tail(a);

  // 2. 不卡：不重新加载，账号照常打开
  st.connects = 0;
  const b = await boot(0);
  const mid = failures;
  try {
    check(await waitFor(() => shellPainted(b.port), 20000), '不卡时界面正常加载');
    check(await waitFor(() => waShown(b.port), 20000), `不卡时账号页面打开了（启动后 ${b.secs()} 秒）`);
    check(st.connects >= 1, `不卡时账号页面也是从代理走的（代理放行 ${st.connects} 次）`);
    check(!b.log.includes(RELOADED), '不卡时不重新加载');
  } catch (e) { console.error(e); failures += 1; } finally { await b.stop(); }
  if (failures > mid) tail(b);

  wa.close(); proxy.close();
  wa.closeAllConnections?.(); proxy.closeAllConnections?.();
  fs.rmSync(certDir, { recursive: true, force: true });
  console.log(failures ? `有 ${failures} 项没通过` : 'check-shell-stall 全部通过');
  process.exit(failures ? 1 : 0);
})();
