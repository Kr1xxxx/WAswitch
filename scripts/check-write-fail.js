// 自检：写盘一直失败（C 盘满、杀毒软件锁文件）时，软件照常打开、不退出，界面上的改动在内存里照样生效。
// 做法：在临时配置里把 accounts.json.tmp、groups.json.tmp、settings.json.tmp、customers.json.tmp 建成文件夹，
// 安全写文件先写 .tmp，打开它必然失败（EISDIR），只影响这四个文件。
// 放一个网页号（代理指向关着的端口，不联网）和一个跟进时间已到的客户（第 15 秒弹提醒、写盘）。
// 检查：界面和账号页面出来了；20 秒后进程还在、没有未捕获的异常；静音一个号、改一个设置后进程还在，静音生效；日志里有「保存失败」。
// 运行：node scripts/check-write-fail.js（Linux 无界面环境用 xvfb-run）
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const electron = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; setTimeout(() => reject(new Error('连不上界面页面')), 5000); });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} 5 秒没有回应`)); }, 5000);
    waiting.set(id, (d) => { clearTimeout(timer); resolve(d); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  return { evaluate, close: () => ws.close() };
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-wfail-'));
  const profile = path.join(home, 'waswitch');
  const dead = await freePort();
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'accounts.json'), JSON.stringify([{
    id: '1', name: 'Emma Fischer', color: '#16A34A', proxy: `socks5://127.0.0.1:${dead}`, mode: 'web', primary: true,
    fingerprint: { version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region: 'DE', seed: 1 },
  }]));
  fs.writeFileSync(path.join(profile, 'customers.json'), JSON.stringify([{
    id: 'c1', accountId: '1', name: 'Lucas Martin', phone: '+33 6 12 34 56 78', followUpAt: Date.now() - 60 * 1000, reminded: false, updatedAt: Date.now(),
  }]));
  for (const f of ['accounts.json', 'groups.json', 'settings.json', 'customers.json']) fs.mkdirSync(path.join(profile, `${f}.tmp`));

  const port = await freePort();
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, path.join(__dirname, 'fixtures', 'view-race-main.js')],
    { env: { ...process.env, WASWITCH_TEST_PROFILE: profile }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const keep = (chunk) => { out = (out + chunk).slice(-20000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const alive = () => child.exitCode === null && child.signalCode === null;
  // 主进程卡在出错提示框里时调试接口也不回，所以都限时
  const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  let failures = 0;
  const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
  try {
    let shellT = null;
    let accPage = null;
    const t0 = Date.now();
    for (let i = 0; i < 60 && !(shellT && accPage); i++) {
      let targets = [];
      try { targets = await list(); } catch { /* 还没起来 */ }
      shellT = targets.find((t) => t.url.includes('index.html'));
      accPage = targets.find((t) => t.type === 'page' && !t.url.includes('index.html'));
      if (!alive()) break;
      if (!(shellT && accPage)) await sleep(500);
    }
    // 启动时先存一次 accounts.json，存不进去以前就卡在这里，界面出来了但账号页面不打开
    check(!!shellT && !!accPage, '写盘失败时界面和账号页面照常打开');
    if (!shellT) throw new Error('界面没出来');
    const shellC = await cdp(shellT.webSocketDebuggerUrl);
    await shellC.evaluate(`new Promise((resolve) => {
      window.__states = [];
      window.wa.onState((s) => window.__states.push(s));
      resolve(true);
    })`);
    // 跟进提醒在启动后第 15 秒跑，多等几秒
    await sleep(Math.max(0, 20000 - (Date.now() - t0)));
    check(alive() && !/未捕获的异常/.test(out), '跟进提醒写盘失败后软件还在');

    await shellC.evaluate(`(() => { window.wa.setMuted('1', true); window.wa.setSetting('popupSound', false); return true; })()`);
    await sleep(1500);
    check(alive() && !/未捕获的异常|界面操作 .* 出错/.test(out), '静音、改设置写盘失败后软件还在');
    const muted = await shellC.evaluate(`(() => { const s = window.__states.at(-1); const a = s && s.accounts.find((x) => x.id === '1'); return a ? a.muted : null; })()`);
    check(muted === true, `静音在内存里生效（${muted}）`);
    check(/accounts\.json 保存失败/.test(out) && /settings\.json 保存失败/.test(out) && /跟进提醒保存失败/.test(out), '日志里记了保存失败');
    shellC.close();
  } catch (e) {
    console.error(e.message);
    failures += 1;
  } finally {
    if (failures) console.log(`\n软件输出（最后部分）：\n${out.slice(-4000)}`);
    child.kill('SIGKILL');
    await sleep(500);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 临时文件夹，删不掉不要紧 */ }
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
