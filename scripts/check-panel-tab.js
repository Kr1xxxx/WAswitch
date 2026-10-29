// 自检：右侧工作台每次打开、换号都停在“翻译”页，不记上次停在哪一页（shen 2026-10-29「默认打开翻译页面」）。
// 做法：用一个临时配置启动真的软件（两个网页版账号，代理指向关着的端口，不联网），通过 CDP 读软件界面：
//   1) 设置文件里留着老版本记下的 panelTab: 'customers'，启动后工作台展开、选中的是“翻译”；
//   2) 点“客户资料”→ 换到第二个号 → 回到“翻译”；
//   3) 点“客户资料”→“新建”打开表单 → 换号：还在客户资料，表单没被冲掉；
//   4) 点“话术”→ 退出 → 同一个目录再启动：“翻译”，设置文件里没有 panelTab。
// 换客户对话（同一个号里换聊天）的那一半在 scripts/check-dock-draft.js 的 part4。
// 窗口要够宽（不到 1000 宽工作台默认收起）：Linux 无界面环境用 xvfb-run -a -s "-screen 0 1920x1200x24" node scripts/check-panel-tab.js
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
  return { evaluate, close: () => ws.close() };
}

const account = (id, name, proxyPort, seed) => ({
  id, name, color: '#16A34A', proxy: `socks5://127.0.0.1:${proxyPort}`, mode: 'web', primary: id === '1',
  fingerprint: { version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region: 'SG', seed },
});

// 启动软件，返回 { child, shell }；shell.evaluate 在软件界面里跑
async function launch(profile) {
  const port = await freePort();
  // HOME/XDG_CONFIG_HOME alone do not isolate Electron's userData on macOS.
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, path.join(__dirname, 'fixtures', 'view-race-main.js')],
    { env: { ...process.env, WASWITCH_TEST_PROFILE: profile }, stdio: ['ignore', 'ignore', 'pipe'] });
  let startupError = '';
  child.stderr.on('data', (chunk) => { startupError = (startupError + chunk).slice(-6000); });
  let shellT = null;
  for (let i = 0; i < 60 && !shellT; i++) {
    try { shellT = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.url.includes('index.html')); } catch {}
    if (child.exitCode !== null) throw new Error(`Test app exited (${child.exitCode}): ${startupError}`);
    if (!shellT) await sleep(500);
  }
  if (!shellT) throw new Error('shell page not found');
  return { child, shell: await cdp(shellT.webSocketDebuggerUrl) };
}

(async () => {
  const dead = [await freePort(), await freePort()];
  const mkProfile = (settings) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-paneltab-'));
    const profile = path.join(home, 'waswitch');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'accounts.json'), JSON.stringify([account('1', '测试号一', dead[0], 1), account('2', '测试号二', dead[1], 2)]));
    if (settings) fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
    return profile;
  };
  let failures = 0;
  const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
  const children = [];
  // 工作台现在选中的是哪一页（没展开 = 'closed'）
  const tabOf = (shell) => shell.evaluate(`(() => {
    const p = document.getElementById('panel');
    if (!p || p.hidden) return 'closed';
    const on = p.querySelector('.wb-tabs .tb-tab[aria-selected="true"]');
    return on ? on.textContent.replace(/\\d+\\+?$/, '').trim() : 'none';
  })()`);
  const waitTab = async (shell, want, ms = 4000) => {
    let got = '';
    for (let t = 0; t < ms; t += 200) { got = await tabOf(shell); if (got === want) return got; await sleep(200); }
    return got;
  };
  const clickTab = (shell, label) => shell.evaluate(`(() => { const b = [...document.querySelectorAll('#panel .wb-tabs .tb-tab')].find((x) => x.textContent.includes(${JSON.stringify(label)})); if (b) b.click(); return !!b; })()`);
  const clickBtn = (shell, label) => shell.evaluate(`(() => { const b = [...document.querySelectorAll('#panel .pn-btn')].find((x) => x.textContent === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
  try {
    // 1) 老设置文件里留着 panelTab: 'customers'
    const profile = mkProfile({ panelTab: 'customers' });
    let app = await launch(profile);
    children.push(app.child);
    let { shell } = app;
    check(await waitTab(shell, '翻译') === '翻译', '启动时设置文件里留着 panelTab: customers，工作台还是停在“翻译”');
    // 2) 点客户资料，换号
    await clickTab(shell, '客户资料');
    check(await waitTab(shell, '客户资料') === '客户资料', '点“客户资料”后停在客户资料');
    await shell.evaluate(`window.wa.switchTo('2')`);
    check(await waitTab(shell, '翻译') === '翻译', '换到第二个号后回到“翻译”');
    // 3) 填表单时换号不跳
    await clickTab(shell, '客户资料');
    await waitTab(shell, '客户资料');
    await sleep(300);
    check(await clickBtn(shell, '新建'), '客户资料页有“新建”');
    await sleep(300);
    const formOn = () => shell.evaluate(`!!document.querySelector('#panel .pn-form')`);
    check(await formOn(), '点“新建”打开了表单');
    await shell.evaluate(`window.wa.switchTo('1')`);
    await sleep(2000);
    check(await tabOf(shell) === '客户资料' && await formOn(), '填着表单时换号：还在客户资料，表单没被冲掉');
    // 取消表单后再换号，照样回到翻译
    await clickBtn(shell, '取消');
    await sleep(300);
    await shell.evaluate(`window.wa.switchTo('2')`);
    check(await waitTab(shell, '翻译') === '翻译', '表单关了以后换号回到“翻译”');
    shell.close();
    app.child.kill();

    // 4) 不记上次的页：点话术后退出，再启动
    const profile2 = mkProfile(null);
    app = await launch(profile2);
    children.push(app.child);
    shell = app.shell;
    check(await waitTab(shell, '翻译') === '翻译', '新装启动停在“翻译”');
    await clickTab(shell, '话术');
    check(await waitTab(shell, '话术') === '话术', '点“话术”后停在话术');
    await sleep(500);
    shell.close();
    app.child.kill();
    await sleep(800);
    const file = path.join(profile2, 'settings.json');
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    check(!('panelTab' in saved), `设置文件里没有 panelTab（${JSON.stringify(saved.panelTab)}）`);
    app = await launch(profile2);
    children.push(app.child);
    check(await waitTab(app.shell, '翻译') === '翻译', '退出再启动：停在“翻译”，不是上次的话术');
    app.shell.close();
  } finally {
    for (const c of children) c.kill();
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
