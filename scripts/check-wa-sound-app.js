// 自检（整个软件跑起来）：网页号来一条新消息，整个软件只响一次提示音（见 src/wa-sound.js）。
// 做法：本地起一个假的 web.whatsapp.com（host-resolver-rules 指过去），来消息时像 WhatsApp 那样
// 改标题 "(N) WhatsApp" 并用不挂在页面上的 new Audio 放提示音。主进程开 --inspect，每 20 毫秒看一遍所有页面
// （网页号页面、WAswitch 的弹窗）是不是在出声且没静音，出声一次记一次。
//   1. 窗口缩到托盘（没看着这个号）：只有 WAswitch 弹窗响，WhatsApp 页面静音
//   2. 窗口在前台开着这个号：WAswitch 不弹，只有 WhatsApp 自己响
// 运行：xvfb-run -a node scripts/check-wa-sound-app.js
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

// 假的 WhatsApp：登录后的对话列表，来消息时改标题、放提示音（WhatsApp 的做法：new Audio(...).play()）
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp</title></head><body>
<div id="app"><div id="side"><div id="pane-side" role="grid"><div role="row"><span title="Emma Schneider">Emma Schneider</span><span title="Hallo! Ist der Liefertermin noch der 12.11.?">Hallo! Ist der Liefertermin noch der 12.11.?</span></div></div></div></div>
<script>
function wav(seconds) {
  const sr = 8000, n = Math.round(sr * seconds), b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 660 / sr) * 20000, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
const ding = wav(0.6);
let unread = 0;
window.incoming = async () => {
  unread += 1;
  document.title = '(' + unread + ') WhatsApp';
  try { await new Audio(ding).play(); return 'played'; } catch (e) { return 'error ' + e.message; }
};
</script></body></html>`;

// 在主进程里：每 20 毫秒看一遍所有页面，出声（且没静音）一次记一次
const SAMPLER = `(() => {
  const { webContents } = process.mainModule.require('electron');
  globalThis.__heard = [];
  const was = new Map();
  clearInterval(globalThis.__sampler);
  globalThis.__sampler = setInterval(() => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      const on = wc.isCurrentlyAudible() && !wc.isAudioMuted();
      if (on && !was.get(wc.id)) globalThis.__heard.push(wc.getURL().includes('web.whatsapp.com') ? 'whatsapp' : wc.getURL().includes('popup') ? 'waswitch' : wc.getURL());
      was.set(wc.id, on);
    }
  }, 20);
  return true;
})()`;

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-sound-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web.whatsapp.com',
    '-keyout', path.join(home, 'key.pem'), '-out', path.join(home, 'cert.pem')], { stdio: 'ignore' });
  const web = https.createServer({ key: fs.readFileSync(path.join(home, 'key.pem')), cert: fs.readFileSync(path.join(home, 'cert.pem')) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  });
  const waPort = await freePort();
  await new Promise((r) => web.listen(waPort, '127.0.0.1', r));

  fs.mkdirSync(path.join(home, 'waswitch'), { recursive: true });
  fs.writeFileSync(path.join(home, 'waswitch', 'accounts.json'), JSON.stringify([{
    id: '1', name: 'Emma', color: '#16A34A', proxy: '', mode: 'web', primary: true,
    fingerprint: { version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region: 'DE', seed: 1 },
  }]));
  const port = await freePort();
  const inspect = await freePort();
  const env = { ...process.env, XDG_CONFIG_HOME: home, HOME: home, ...teamOff(path.join(home, 'waswitch')) };
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  delete env.NODE_OPTIONS;
  const child = spawn(electron, ['--no-sandbox', `--inspect=${inspect}`, `--remote-debugging-port=${port}`, '--ignore-certificate-errors',
    `--host-resolver-rules=MAP web.whatsapp.com:443 127.0.0.1:${waPort}`, root], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  let failures = 0;
  const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(100); } return -1; };
  try {
    let targets = [];
    await waitFor(async () => {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { targets = []; }
      return targets.some((t) => t.url.includes('web.whatsapp.com'));
    }, 30000);
    const waT = targets.find((t) => t.url.includes('web.whatsapp.com'));
    check(!!waT, '网页号页面打开了');
    if (!waT) throw new Error('网页号页面没打开');
    const wa = await cdp(waT.webSocketDebuggerUrl);
    await waitFor(async () => (await wa.evaluate('!!document.querySelector("#pane-side") && typeof window.incoming').catch(() => '')) === 'function', 15000);
    const mainT = (await (await fetch(`http://127.0.0.1:${inspect}/json/list`)).json())[0];
    const main = await cdp(mainT.webSocketDebuggerUrl);
    await main.send('Runtime.enable');
    const win = (js) => main.evaluate(`(() => { const w = process.mainModule.require('electron').BaseWindow.getAllWindows().find((x) => x.getMinimumSize()[0] === 900); ${js} })()`);
    check(await main.evaluate(SAMPLER), '主进程里开始记出声');
    await sleep(4000); // 页面刚打开时标题里的数字不算新消息（等它稳下来）

    const message = async () => {
      await main.evaluate('globalThis.__heard.length = 0');
      const r = await wa.evaluate('window.incoming()');
      await sleep(3000); // 等读对话列表、弹窗建好、两边都放完
      const heard = await main.evaluate('globalThis.__heard.slice()');
      return { r, heard };
    };

    // 1. 窗口缩到托盘
    await win('w.hide(); return true;');
    await sleep(500);
    let m = await message();
    check(m.r === 'played', `WhatsApp 页面放了提示音（${m.r}）`);
    check(m.heard.length === 1 && m.heard[0] === 'waswitch', `1. 窗口在托盘里：只听到 WAswitch 弹窗一次（听到：${m.heard.join('、') || '没有'}）`);

    // 2. 窗口在前台开着这个号
    await win('w.show(); w.focus(); return true;');
    const focused = await waitFor(async () => win('return w.isFocused();'), 5000);
    if (focused < 0) {
      console.log('跳过：这个环境里窗口拿不到焦点，测不了「正看着」');
    } else {
      await sleep(500);
      m = await message();
      check(m.heard.length === 1 && m.heard[0] === 'whatsapp', `2. 窗口在前台开着这个号：只听到 WhatsApp 自己一次（听到：${m.heard.join('、') || '没有'}）`);
    }
    wa.close();
    main.close();
  } catch (e) {
    console.error(e);
    failures += 1;
  } finally {
    child.kill();
    web.close();
    await sleep(500);
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (failures) console.log(log.split('\n').filter((l) => /失败|Error|error/.test(l)).slice(-20).join('\n'));
  console.log(failures ? `有 ${failures} 项没通过` : 'check-wa-sound-app 全部通过');
  process.exit(failures ? 1 : 0);
})();
