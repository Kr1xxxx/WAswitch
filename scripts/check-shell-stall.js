// 自检：界面还没加载出来时主进程卡住十几秒以上，之后界面要自己加载出来，不能一直是空窗口。
// 真实情况：Mac 上换了 Electron 版本的更新装完后，系统弹「访问钥匙串」，没回答之前主进程一直等着；
// 超过约 15 秒 Chromium 的网络进程被收掉，界面那次加载永远停在 about:blank，也没有任何失败事件。
// 做法：开发版设 WASWITCH_TEST_BOOT_STALL_MS，界面刚开始加载主进程就停这么久。
//   1. 卡 20 秒：卡完 5 秒内界面加载出来（侧栏有内容）
//   2. 不卡：界面只加载一次，不多余地重新加载
// 运行：node scripts/check-shell-stall.js（Linux 无界面环境用 xvfb-run）
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const electron = require('electron');
const { teamOff } = require('./fixtures/team-off');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const STALL_MS = 20000;
const RELOADED = '重新加载';

// 界面那一页现在的样子：地址，侧栏里有没有东西
async function shellState(port) {
  let targets = [];
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return null; }
  const t = targets.find((x) => x.url.includes('shell/index.html'));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true,
        expression: 'JSON.stringify({ href: location.href, side: !!document.querySelector("#side *") })' } }));
      ws.onmessage = (m) => { clearTimeout(timer); try { resolve(JSON.parse(JSON.parse(m.data).result.result.value)); } catch { resolve(null); } };
      ws.onerror = () => { clearTimeout(timer); resolve(null); };
    });
  } finally { ws.close(); }
}

async function boot(stallMs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-stall-'));
  const port = await freePort();
  const env = { ...process.env, XDG_CONFIG_HOME: home, HOME: home, ...teamOff(path.join(home, 'waswitch')) };
  if (stallMs) env.WASWITCH_TEST_BOOT_STALL_MS = String(stallMs);
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { log: '', port, startedAt: Date.now() };
  child.stdout.on('data', (d) => { run.log += d; });
  child.stderr.on('data', (d) => { run.log += d; });
  run.stop = async () => { child.kill(); await sleep(500); fs.rmSync(home, { recursive: true, force: true }); };
  return run;
}

const painted = (s) => !!s && s.href.includes('shell/index.html') && s.side;
async function waitPainted(run, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (painted(await shellState(run.port))) return true; await sleep(200); }
  return false;
}

(async () => {
  let failures = 0;
  const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };

  // 1. 界面刚开始加载就卡 20 秒
  const a = await boot(STALL_MS);
  try {
    await sleep(STALL_MS - 2000);
    check(!painted(await shellState(a.port)), '主进程卡着的时候界面还没出来');
    const ok = await waitPainted(a, 2000 + 5000 + 3000);
    check(ok, `卡 ${STALL_MS / 1000} 秒后界面自己加载出来了（启动后 ${Math.round((Date.now() - a.startedAt) / 1000)} 秒）`);
    check(a.log.includes(RELOADED), '日志里记了重新加载');
  } catch (e) { console.error(e); failures += 1; } finally { await a.stop(); }
  if (failures) console.log(a.log.split('\n').filter((l) => !/dbus|NODE_OPTION/.test(l)).slice(-15).join('\n'));

  // 2. 不卡：不重新加载
  const b = await boot(0);
  try {
    check(await waitPainted(b, 20000), '不卡时界面正常加载');
    await sleep(2500);
    check(!b.log.includes(RELOADED), '不卡时不重新加载');
  } catch (e) { console.error(e); failures += 1; } finally { await b.stop(); }

  console.log(failures ? `有 ${failures} 项没通过` : 'check-shell-stall 全部通过');
  process.exit(failures ? 1 : 0);
})();
