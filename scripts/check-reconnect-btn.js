// 自检：连不上 WhatsApp、正在自动重试时，提示页上也有「重新连接」，点了马上重连，自动重试从头算。
// 做法：本地起一个假的 web.whatsapp.com（host-resolver-rules 指过去），前面一层 TCP 按 mode 处理每个连接：
// 'rst' 直接重置（Chromium 报 ERR_CONNECTION_RESET，提示「到 WhatsApp 的连接被中断了」）、
// 'hold' 不回（页面一直在加载，提示页显示「正在连接…」）、'ok' 转给后面的 HTTPS 服务，回一个有对话列表的页面。
//   1. 一直被重置：提示页有「正在自动重试…」和「重新连接」
//   2. 等第二次自动重试也失败（下一次在 20 秒后）：点「重新连接」马上连，提示换成「正在连接…」
//   3. 这次也失败：提示回到「正在自动重试…」，下一次自动重试在约 10 秒后，不是 20 秒
//   4. 网络好了：点「重新连接」，提示页收起
// 截图写到 WASWITCH_SHOT_DIR（不设就不截）。
// 运行：node scripts/check-reconnect-btn.js（Linux 无界面环境用 xvfb-run）
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const https = require('https');
const electron = require('electron');
const { teamOff } = require('./fixtures/team-off');

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

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp</title></head><body><div id="app"><div id="side"><div id="pane-side">Emma Schneider</div></div></div></body></html>';

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-reconnect-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web.whatsapp.com',
    '-keyout', path.join(home, 'key.pem'), '-out', path.join(home, 'cert.pem')], { stdio: 'ignore' });
  const web = https.createServer({ key: fs.readFileSync(path.join(home, 'key.pem')), cert: fs.readFileSync(path.join(home, 'cert.pem')) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  });
  const webPort = await freePort();
  await new Promise((r) => web.listen(webPort, '127.0.0.1', r));

  const st = { mode: 'rst', conns: [], held: [] };
  const front = net.createServer((sock) => {
    st.conns.push(Date.now());
    sock.on('error', () => {});
    if (st.mode === 'rst') return sock.resetAndDestroy();
    if (st.mode === 'hold') { st.held.push(sock); return; }
    const up = net.connect(webPort, '127.0.0.1');
    up.on('error', () => sock.destroy());
    sock.pipe(up).pipe(sock);
  });
  const waPort = await freePort();
  await new Promise((r) => front.listen(waPort, '127.0.0.1', r));
  const release = () => { for (const s of st.held.splice(0)) s.resetAndDestroy(); };

  fs.mkdirSync(path.join(home, 'waswitch'), { recursive: true });
  fs.writeFileSync(path.join(home, 'waswitch', 'accounts.json'), JSON.stringify([{
    id: '1', name: 'Emma', color: '#16A34A', proxy: '', mode: 'web', primary: true,
    fingerprint: { version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region: 'DE', seed: 1 },
  }]));
  const port = await freePort();
  const env = { ...process.env, XDG_CONFIG_HOME: home, HOME: home, ...teamOff(path.join(home, 'waswitch')) };
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, '--ignore-certificate-errors',
    `--host-resolver-rules=MAP web.whatsapp.com:443 127.0.0.1:${waPort}`, root], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  let failures = 0;
  const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(100); } return -1; };
  try {
    const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    let targets = [];
    await waitFor(async () => {
      try { targets = await list(); } catch { targets = []; }
      return targets.some((t) => t.url.includes('index.html')) && targets.some((t) => t.url.includes('web.whatsapp.com'));
    }, 30000);
    const shellT = targets.find((t) => t.url.includes('index.html'));
    check(!!shellT, '启动后打开了侧栏');
    if (!shellT) throw new Error('侧栏没打开');
    const shellC = await cdp(shellT.webSocketDebuggerUrl);
    const text = () => shellC.evaluate("(document.querySelector('.center .panel') || {}).innerText || ''").catch(() => '');
    const btn = "[...document.querySelectorAll('.center .panel .btns button')].find((b) => b.textContent === '重新连接')";
    const hasBtn = () => shellC.evaluate(`!!${btn}`).catch(() => false);
    const click = () => shellC.evaluate(`${btn}.click()`);
    const shotDir = process.env.WASWITCH_SHOT_DIR;
    const shot = async (name) => {
      if (!shotDir) return;
      const r = await shellC.evaluate("(() => { const b = document.querySelector('.center .panel').getBoundingClientRect(); return { x: b.x - 24, y: b.y - 24, width: b.width + 48, height: b.height + 48 }; })()");
      const img = await shellC.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 } });
      fs.mkdirSync(shotDir, { recursive: true });
      fs.writeFileSync(path.join(shotDir, name), Buffer.from(img.result.data, 'base64'));
    };

    // 1
    const ms1 = await waitFor(async () => (await text()).includes('到 WhatsApp 的连接被中断了'), 20000);
    check(ms1 >= 0, '连接被重置：显示「到 WhatsApp 的连接被中断了」');
    check((await text()).includes('正在自动重试…'), '提示页写着「正在自动重试…」');
    check(await hasBtn(), '自动重试时也有「重新连接」');
    await shot('retrying.png');

    // 2：第一次自动重试在 10 秒后，失败后下一次要等 20 秒
    const n1 = st.conns.length;
    const ms2 = await waitFor(() => st.conns.length > n1, 15000);
    check(ms2 >= 0, `第一次自动重试（${ms2} 毫秒后）`);
    await sleep(1500);
    st.mode = 'hold';
    const n2 = st.conns.length;
    await click();
    const ms3 = await waitFor(() => st.conns.length > n2, 3000);
    check(ms3 >= 0, `点「重新连接」后马上重连（${ms3} 毫秒）`);
    const ms4 = await waitFor(async () => (await text()).includes('正在连接…'), 3000);
    check(ms4 >= 0, '点了以后提示换成「正在连接…」');
    check(!(await text()).includes('正在自动重试…'), '连接中不再写「正在自动重试…」');
    await shot('connecting.png');

    // 3：这次也失败，自动重试从头算（10 秒，不是 20 秒）
    st.mode = 'rst';
    release();
    const ms5 = await waitFor(async () => (await text()).includes('正在自动重试…'), 5000);
    check(ms5 >= 0, '重连失败：提示回到「正在自动重试…」');
    const t5 = Date.now();
    const n5 = st.conns.length;
    const ms6 = await waitFor(() => st.conns.length > n5, 16000);
    const after = Date.now() - t5;
    check(ms6 >= 0 && after > 8000 && after < 14000, `下一次自动重试在约 10 秒后（${after} 毫秒），自动重试从头算了`);

    // 4：网络好了，点「重新连接」，提示页收起
    st.mode = 'ok';
    await waitFor(async () => (await text()).includes('正在自动重试…') && await hasBtn(), 5000);
    await click();
    const ms7 = await waitFor(async () => !(await text()), 10000);
    check(ms7 >= 0, `网络好了点「重新连接」：提示页收起（${ms7} 毫秒）`);
    shellC.close();
  } catch (e) {
    console.error(e);
    failures += 1;
  } finally {
    child.kill();
    release();
    front.close();
    web.close();
    await sleep(500);
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (failures) console.log(log.split('\n').filter((l) => /失败|加载|重/.test(l)).slice(-20).join('\n'));
  console.log(failures ? `有 ${failures} 项没通过` : 'check-reconnect-btn 全部通过');
  process.exit(failures ? 1 : 0);
})();
