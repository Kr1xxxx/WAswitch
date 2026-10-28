// 自检：网页版账号扫码后，侧栏几秒内从“等待扫码”变成已登录；登录后不再每几秒检查一次。
// 做法：本地起一个假的 web.whatsapp.com（HTTPS 自签证书 + host-resolver-rules），页面先放二维码，
// 等侧栏显示“等待扫码”后把页面换成对话列表（相当于扫完码），看侧栏多久变；
// 再把页面换回二维码（相当于掉线），6 秒内侧栏不该变（登录后只走 3 分钟一次的慢检查）。
// 运行：node scripts/check-qr-watch.js（Linux 无界面环境用 xvfb-run）
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const https = require('https');
const electron = require('electron');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const QR_HTML = '<div data-ref="test-qr">二维码</div>';
const CHATS_HTML = '<div id="side"><div id="pane-side">对话列表</div></div>';

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-qr-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web.whatsapp.com',
    '-keyout', path.join(home, 'key.pem'), '-out', path.join(home, 'cert.pem')], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(path.join(home, 'key.pem')), cert: fs.readFileSync(path.join(home, 'cert.pem')) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>WhatsApp</title></head><body>${QR_HTML}</body></html>`);
  });
  const waPort = await freePort();
  await new Promise((r) => server.listen(waPort, '127.0.0.1', r));

  fs.mkdirSync(path.join(home, 'waswitch'), { recursive: true });
  fs.writeFileSync(path.join(home, 'waswitch', 'accounts.json'), JSON.stringify([{
    id: '1', name: '测试号', color: '#16A34A', proxy: '', mode: 'web', primary: true,
    fingerprint: { version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region: 'SG', seed: 1 },
  }]));
  const port = await freePort();
  // 直连号跟随系统代理：去掉环境里的代理变量，让请求直接到本地假服务
  const env = { ...process.env, XDG_CONFIG_HOME: home, HOME: home };
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, '--ignore-certificate-errors',
    `--host-resolver-rules=MAP web.whatsapp.com:443 127.0.0.1:${waPort}`, root], { env, stdio: 'ignore' });
  const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let failures = 0;
  const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
  try {
    let targets = [];
    for (let i = 0; i < 60; i++) {
      try { targets = await list(); } catch { targets = []; }
      if (targets.some((t) => t.url.includes('index.html')) && targets.some((t) => t.url.includes('web.whatsapp.com'))) break;
      await sleep(500);
    }
    const shellT = targets.find((t) => t.url.includes('index.html'));
    const pageT = targets.find((t) => t.url.includes('web.whatsapp.com'));
    check(!!shellT && !!pageT, '启动后打开了侧栏和账号页面');
    if (!shellT || !pageT) throw new Error('页面没打开');
    const shellC = await cdp(shellT.webSocketDebuggerUrl);
    const pageC = await cdp(pageT.webSocketDebuggerUrl);
    // 只看左边的账号侧栏：右侧工作台默认打开，翻译页在二维码页也会显示“扫码登录后可用”，不算侧栏变化
    const sideText = () => shellC.evaluate("(document.getElementById('side') || document.body).innerText");
    const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(200); } return -1; };

    // 1. 页面加载完、停在二维码页：几秒内侧栏显示“等待扫码/需要扫码登录”（以前要等 1 分钟后的第一次检查）
    const t1 = await waitFor(async () => (await sideText()).includes('扫码'), 15000);
    check(t1 >= 0, `二维码页加载后侧栏几秒内显示扫码提示（${t1} 毫秒）`);
    if (t1 < 0) throw new Error('侧栏一直没显示扫码提示，后面两项没法测');

    // 2. 扫完码：页面换成对话列表，侧栏 6 秒内不再显示扫码提示
    await pageC.evaluate(`document.body.innerHTML = ${JSON.stringify(CHATS_HTML)}`);
    const t2 = await waitFor(async () => !(await sideText()).includes('扫码'), 6000);
    check(t2 >= 0, `扫码后侧栏 6 秒内变成已登录（${t2} 毫秒）`);

    // 3. 登录后不再快检查：页面换回二维码，6 秒内侧栏不该变（慢检查 3 分钟一次）
    await pageC.evaluate(`document.body.innerHTML = ${JSON.stringify(QR_HTML)}`);
    await sleep(6000);
    const text3 = await sideText();
    check(!text3.includes('扫码'), '登录后不再每几秒检查一次（6 秒内侧栏没变）');

    shellC.close();
    pageC.close();
  } finally {
    child.kill();
    server.close();
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
