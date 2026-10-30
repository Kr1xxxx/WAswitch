// 自检：右侧「翻译」页在没打开任何对话时，用户点开一个对话，对话里的消息不到 1 秒就显示出来。
// 以前没打开对话时每 3 秒才看一次页面（页面变化的监听看的是已经存在的对话区），点开后最多要等 3 秒。
// 做法：本地起一个假的 web.whatsapp.com（HTTPS 自签证书 + host-resolver-rules），页面只有对话列表、没有对话区；
// 等翻译页提示「先在左边点开一个聊天」（已经读过一次页面了），隔 0.7 秒（比 0.3 秒的间隔长）后在页面里放进一个对话，
// 量翻译页多久出现这个对话的消息；放进去、拿掉各做 3 轮，每轮的等待错开。
// 窗口要够宽（不到 1000 宽工作台默认收起）：Linux 无界面环境用 xvfb-run -a -s "-screen 0 1920x1200x24" node scripts/check-tr-nochat.js
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
  return { evaluate, close: () => ws.close() };
}

// 对话列表 + 一个能放进 / 拿掉对话区（#main）的假页面
const side = Array.from({ length: 3 }, (_, i) => `<div role="row" class="c"><div role="gridcell"><span dir="auto" title="Customer ${i}">Customer ${i}</span></div></div>`).join('');
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp</title></head><body>
<div id="side"><div contenteditable="true" role="textbox" aria-label="Search"></div><div id="pane-side"><div role="grid" aria-label="Chat list">${side}</div></div></div>
<div id="wrap"></div>
<script>
const row = (i) => '<div role="row"><div data-id="false_4915111111111@c.us_NC' + i + '" class="message-in"><div class="copyable-text" data-pre-plain-text="[10:0' + i + ', 30/10/2026] Emma Schneider: "><span class="selectable-text copyable-text"><span>Guten Tag, ist Nummer ' + i + ' noch lieferbar?</span></span></div></div></div>';
window.__open = () => { document.getElementById('wrap').innerHTML = '<div id="main"><header><span dir="auto" title="Emma Schneider">Emma Schneider</span></header><div class="scroll"><div role="application">' + [1, 2, 3].map(row).join('') + '</div></div><footer><div contenteditable="true"></div></footer></div>'; return 1; };
window.__close = () => { document.getElementById('wrap').innerHTML = ''; return 1; };
</script></body></html>`;

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-nochat-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web.whatsapp.com',
    '-keyout', path.join(home, 'key.pem'), '-out', path.join(home, 'cert.pem')], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(path.join(home, 'key.pem')), cert: fs.readFileSync(path.join(home, 'cert.pem')) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
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
    const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(20); } return -1; };
    const hint = () => shellC.evaluate("document.body.innerText.includes('先在左边点开一个聊天')");
    const items = () => shellC.evaluate("document.querySelectorAll('.dk-item').length");

    check(await waitFor(hint, 20000) >= 0, '没打开对话时翻译页提示先点开一个聊天');
    const times = [];
    for (let k = 0; k < 3; k++) {
      await sleep(700 + k * 450); // 错开读页面的节拍
      await pageC.evaluate('window.__open()');
      const t = await waitFor(async () => (await items()) >= 3, 6000);
      times.push(t);
      check(t >= 0 && t < 1000, `第 ${k + 1} 次点开对话，翻译页 ${t} 毫秒内显示了消息（要求 1000 毫秒内）`);
      await pageC.evaluate('window.__close()');
      check(await waitFor(hint, 6000) >= 0, `第 ${k + 1} 次关掉对话后翻译页又提示先点开一个聊天`);
    }
    console.log('点开到显示（毫秒）', times.join(' / '));
    shellC.close();
    pageC.close();
  } finally {
    child.kill();
    server.close();
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
