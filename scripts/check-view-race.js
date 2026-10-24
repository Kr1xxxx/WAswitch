// 自检：页面进程崩溃后的自动重建，不会把刚由“保存设置”重建好的新页面再销毁一次。
// 做法：用一个临时配置启动软件（一个网页版账号，代理指向关着的端口，不联网），
// 让这个账号的页面崩溃，150 毫秒后保存设置（换时区会重建页面），再等 2.5 秒，
// 看保存时建的那个页面是否还在。
// 运行：node scripts/check-view-race.js（Linux 无界面环境用 xvfb-run）
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
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

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-race-'));
  const dead = await freePort();
  fs.mkdirSync(path.join(home, 'waswitch'), { recursive: true });
  fs.writeFileSync(path.join(home, 'waswitch', 'accounts.json'), JSON.stringify([{
    id: '1', name: '测试号', color: '#16A34A', proxy: `socks5://127.0.0.1:${dead}`, mode: 'web', primary: true,
    fingerprint: { version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region: 'SG', seed: 1 },
  }]));
  const port = await freePort();
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, root], { env: { ...process.env, XDG_CONFIG_HOME: home, HOME: home }, stdio: 'ignore' });
  const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let failures = 0;
  const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
  try {
    let targets = [];
    for (let i = 0; i < 60; i++) {
      try { targets = await list(); } catch { targets = []; }
      if (targets.some((t) => t.url.includes('index.html')) && targets.some((t) => t.type === 'page' && !t.url.includes('index.html'))) break;
      await sleep(500);
    }
    const shellT = targets.find((t) => t.url.includes('index.html'));
    const pages = async () => (await list()).filter((t) => t.type === 'page' && !t.url.includes('index.html'));
    const before = await pages();
    check(!!shellT && before.length === 1, `启动后有 1 个账号页面（${before.length}）`);
    const shellC = await cdp(shellT.webSocketDebuggerUrl);
    const pageC = await cdp(before[0].webSocketDebuggerUrl);
    pageC.send('Page.crash');
    await sleep(150);
    const res = await shellC.evaluate(`(async () => {
      const d = await window.wa.editorLoad('1');
      return window.wa.editorSave({ id: '1', name: d.name, color: d.color, proxy: d.proxy, password: '', region: d.region === 'US' ? 'SG' : 'US', mode: 'web', primary: d.primary });
    })()`);
    check(res && res.ok, `崩溃后马上保存设置成功（${JSON.stringify(res)}）`);
    await sleep(400);
    const mid = await pages();
    await sleep(2500);
    const after = await pages();
    check(mid.length === 1 && after.length === 1 && mid[0].id === after[0].id, '保存时重建的页面没有被崩溃重建再销毁一次');
    shellC.close();
    pageC.close();
  } finally {
    child.kill();
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
