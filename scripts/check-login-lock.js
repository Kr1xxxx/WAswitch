// 自检：团队后台要求必须登录时，软件锁成登录页。
// 做法：起一个本机假后台（policy / code / login / logout / sync），用临时配置启动真的软件
// （两个网页版账号，代理指向关着的端口，不联网），通过 CDP 读软件界面：
//   1) 缓存的策略是 required、没登录：启动后只有登录页，一个账号页面都不建；没有“稍后”；软件更新照常（有更新状态）；
//   2) 邮箱回车要验证码（来财对任何邮箱都回 200）：按钮倒计时，提醒看看邮箱填对没有，焦点到验证码框；
//      填错码自动提交，只显示一行“验证码不对或已过期”，码清空，还锁着；
//   3) 填对 6 位自动登录成功：解锁，两个账号的页面建起来，两个号自动加入团队（/join，不用点按钮）；
//      设置 › 团队显示名字和“退出登录”，没有后台地址、登记码和“加入团队”按钮；
//   4) 后台说这台电脑被停用（403 revoked）：账号页面全部关掉，回到登录页，说明“这台电脑已被管理员停用”；
//   5) 策略改成 optional、重新启动：提示登录页有“稍后”，账号照常启动；点“稍后”回到账号页。
// 900×600 下登录页文字不裁、不换行。
// 运行：xvfb-run -a node scripts/check-login-lock.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const electron = require('electron');

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

// ---- 本机假后台 ----
const DEVICE = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'T'.repeat(43);
const CODE = '246810'; // 假后台“发到邮箱”的验证码
const srv = { policy: 'required', revoked: false, hits: [], joins: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    srv.hits.push(req.url);
    const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const authed = req.headers.authorization === `Bearer ${TOKEN}`;
    if (req.url === '/api/device/policy' && req.method === 'GET') return json(200, { v: 1, login: srv.policy });
    // 来财：格式对的邮箱一律 200，不说是不是成员
    if (req.url === '/api/device/code' && req.method === 'POST') return json(200, { ok: true, resend_after_s: 60 });
    if (req.url === '/api/device/login' && req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      if (b.email !== 'emma@example.com' || b.code !== CODE) return json(400, { error: '验证码不对或已过期' });
      return json(200, { device_id: DEVICE, token: TOKEN, user: { name: 'Emma Schulz' }, allow_private: true, login: srv.policy });
    }
    if (!authed) return json(401, { error: '设备令牌无效' });
    if (srv.revoked) return json(403, { error: '这台电脑已被管理员停用', revoked: true, device_id: DEVICE });
    if (req.url === '/api/device/logout') return json(200, { ok: true });
    if (req.url === '/api/device/join') {
      const b = JSON.parse(body || '{}');
      srv.joins.push(b);
      return json(200, { accounts: b.accounts.map((a, i) => ({ local_id: a.local_id, team_id: `11111111-2222-4333-8444-00000000000${i}` })) });
    }
    if (req.url === '/api/device/sync') return json(200, { ok: true, seats: [], cursor: 0, next_sync_s: 120, allow_private: true, login: srv.policy, user: { name: 'Emma Schulz' } });
    return json(404, { error: 'not found' });
  });
});

const account = (id, name, proxyPort, seed) => ({
  id, name, color: '#16A34A', proxy: `socks5://127.0.0.1:${proxyPort}`, mode: 'web', primary: id === '1',
  fingerprint: { version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region: 'SG', seed },
});

async function launch(profile, teamServer) {
  const port = await freePort();
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, path.join(__dirname, 'fixtures', 'login-lock-main.js')],
    { env: { ...process.env, WASWITCH_TEST_PROFILE: profile, WASWITCH_TEST_TEAM_SERVER: teamServer }, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', (chunk) => { log = (log + chunk).slice(-8000); });
  let shellT = null;
  for (let i = 0; i < 60 && !shellT; i++) {
    try { shellT = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.url.includes('shell/index.html')); } catch {}
    if (child.exitCode !== null) throw new Error(`Test app exited (${child.exitCode}): ${log}`);
    if (!shellT) await sleep(500);
  }
  if (!shellT) throw new Error('shell page not found');
  // 账号页面（WebContentsView）：除了软件自己的本地页面以外的页面
  const accountPages = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .filter((t) => t.type === 'page' && !t.url.startsWith('file://') && !t.url.startsWith('devtools://')).length;
  return { child, shell: await cdp(shellT.webSocketDebuggerUrl), accountPages, log: () => log };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const teamServer = `http://127.0.0.1:${server.address().port}`;
  const dead = [await freePort(), await freePort()];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-login-'));
  const profile = path.join(home, 'waswitch');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'accounts.json'), JSON.stringify([account('1', 'Sales DE', dead[0], 1), account('2', 'Sales FR', dead[1], 2)]));
  // 上次记下的策略：必须登录（还没登录过）
  fs.writeFileSync(path.join(profile, 'team.json'), JSON.stringify({ server: teamServer, policy: 'required' }));

  let failures = 0;
  const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
  const children = [];
  // shell.js 还没跑完时 s 不存在：返回空对象，waitFor 接着等
  const state = (shell) => shell.evaluate('JSON.stringify({ page: s && s.page, loginLocked: s && s.loginLocked, accounts: s ? s.accounts.length : -1, update: !!(s && s.update), team: s && s.team && { login: s.team.login, policy: s.team.policy, userName: s.team.userName } })').then(JSON.parse, () => ({}));
  const waitFor = async (fn, ms = 15000) => { for (let t = 0; t < ms; t += 250) { if (await fn()) return true; await sleep(250); } return false; };
  // 在邮箱框里填好并按回车（要验证码）
  const askCode = (shell, email) => shell.evaluate(`(() => {
    const el = document.querySelector('.login-card input[type=email]');
    el.focus(); el.value = ${JSON.stringify(email)}; el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  // 在验证码框里填 6 位（填满自动登录）
  const typeCode = (shell, code) => shell.evaluate(`(() => {
    const el = document.querySelector('.login-card input[inputmode=numeric]');
    el.value = ${JSON.stringify(code)}; el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const codeUi = (shell) => shell.evaluate(`(() => {
    const card = document.querySelector('.login-card');
    const sent = card.querySelector('.login-sent');
    const code = card.querySelector('input[inputmode=numeric]');
    return { btn: card.querySelector('.login-code').textContent, sent: sent.hidden ? '' : sent.textContent, codeFocused: document.activeElement === code, code: code.value };
  })()`);
  const errText = (shell) => shell.evaluate(`(() => { const e = document.querySelector('.login-err'); return e && !e.hidden ? e.textContent : ''; })()`);
  try {
    // 1) 锁着启动
    let app = await launch(profile, teamServer);
    children.push(app.child);
    let { shell } = app;
    await waitFor(async () => (await state(shell)).page === 'login');
    await sleep(3000); // 正常情况下这时候账号页面早就建好了
    let st = await state(shell);
    check(st.page === 'login' && st.loginLocked === true, `启动后锁在登录页（${JSON.stringify(st)}）`);
    check(st.accounts === 0, '界面里一个账号都没有');
    check(await app.accountPages() === 0, '没有建任何账号页面');
    check(st.update, '软件更新照常（有更新状态）');
    check(srv.hits.includes('/api/device/policy'), '启动时问了后台的策略');
    const ui = await shell.evaluate(`(() => {
      const card = document.querySelector('.login-card');
      const btns = [...card.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent);
      const clipped = [...card.querySelectorAll('h1, label, button')].filter((el) => !el.hidden && (el.scrollWidth > el.clientWidth + 1 || el.getClientRects().length > 1 && el.tagName === 'H1')).map((el) => el.textContent);
      const h1 = card.querySelector('h1');
      return { title: h1.textContent, oneLine: h1.getClientRects().length === 1 && h1.offsetHeight < 40, btns, clipped, side: document.getElementById('side').textContent, w: innerWidth, h: innerHeight };
    })()`);
    check(ui.title === '邮箱登录' && ui.oneLine, `标题「邮箱登录」一行显示（${JSON.stringify(ui)}）`);
    check(await shell.evaluate(`document.querySelector('.login-card label.field').firstChild.textContent`) === '公司邮箱', '邮箱框叫「公司邮箱」');
    check(ui.btns.join('|') === '获取验证码|登录', `必须登录时没有“稍后”（${ui.btns.join('|')}）`);
    check(ui.clipped.length === 0, '登录页文字没被裁');
    check(!/Sales/.test(ui.side), '侧栏里没有账号');
    // 2) 邮箱回车要验证码
    await askCode(shell, 'emma@example.com');
    check(await waitFor(async () => (await codeUi(shell)).sent === '验证码已发到这个邮箱。没收到的话，看看邮箱有没有填对。', 5000), '发码后提醒看看邮箱有没有填对');
    let cu = await codeUi(shell);
    check(/^\d+ 秒后重新获取$/.test(cu.btn) && cu.codeFocused, `按钮倒计时，焦点在验证码框（${JSON.stringify(cu)}）`);
    // 窗口最小 900×600：把软件界面按这个大小排版再量一次（倒计时状态）
    await shell.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const small = await shell.evaluate(`(() => {
      const card = document.querySelector('.login-card');
      const r = card.getBoundingClientRect();
      const bad = [...card.querySelectorAll('h1, label, button, input')].filter((el) => !el.hidden && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent);
      const wrapped = [...card.querySelectorAll('h1, button')].filter((el) => !el.hidden && el.getClientRects().length === 1 && el.offsetHeight > 44).map((el) => el.textContent);
      return { bad, wrapped, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
    })()`);
    check(!small.bad.length && !small.wrapped.length && small.inside, `900×600 下登录页不裁、不换行（${JSON.stringify(small)}）`);
    if (process.env.LOGIN_SHOT) {
      const shot = await shell.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.LOGIN_SHOT, Buffer.from(shot.result.data, 'base64'));
    }
    await shell.send('Emulation.clearDeviceMetricsOverride');

    // 填错码：填满 6 位自动提交
    await typeCode(shell, '135799');
    check(await waitFor(async () => (await errText(shell)) === '验证码不对或已过期', 5000), `码不对只显示一行（${await errText(shell)}）`);
    cu = await codeUi(shell);
    check(cu.code === '' && cu.codeFocused, `码清空，焦点还在验证码框（${JSON.stringify(cu)}）`);
    check((await state(shell)).loginLocked === true, '码不对还锁着');

    // 3) 填对码自动登录
    await typeCode(shell, CODE);
    check(await waitFor(async () => (await state(shell)).loginLocked === false), '登录成功后解锁');
    st = await state(shell);
    check(st.accounts === 2 && st.page === 'account', `两个账号回来了（${JSON.stringify(st)}）`);
    check(await waitFor(async () => (await app.accountPages()) === 2), `两个账号页面建起来了（${await app.accountPages()}）`);
    const teamTab = await shell.evaluate(`(async () => {
      window.wa.showPage('settings');
      await new Promise((r) => setTimeout(r, 400));
      settingsTab = 'team'; render(true);
      await new Promise((r) => setTimeout(r, 200));
      return document.getElementById('content').textContent;
    })()`);
    check(teamTab.includes('Emma Schulz') && teamTab.includes('退出登录'), '设置 › 团队显示名字和“退出登录”');
    check(!teamTab.includes('后台地址') && !teamTab.includes('登记码') && !teamTab.includes('加入团队') && !teamTab.includes('私人号'), '没有后台地址、登记码、“加入团队”和私人号');
    check(await waitFor(async () => srv.joins.length > 0, 5000), '登录后两个号自动加入团队');
    const joined = srv.joins[0] ? srv.joins[0].accounts.map((a) => `${a.local_id}:${a.phone}`).join(',') : '';
    check(joined === '1:,2:', `加入时带着每个号自己的号码（这里还没读到，是空的）（${joined}）`);
    await shell.evaluate(`window.wa.showPage('account')`);

    // 4) 运行中被停用
    srv.revoked = true;
    await shell.evaluate('window.wa.teamSync()');
    check(await waitFor(async () => (await state(shell)).page === 'login'), '被停用后回到登录页');
    check(await waitFor(async () => (await app.accountPages()) === 0), `账号页面全部关掉（${await app.accountPages()}）`);
    check(await waitFor(async () => (await errText(shell)) === '这台电脑已被管理员停用', 3000), `说明“这台电脑已被管理员停用”（${await errText(shell)}）`);
    // MCP 的接口在锁着时一律拒绝：直接调主进程的 hooks 看不到，这里只确认 MCP 看到的账号是空的（界面状态里也是 0 个）
    check((await state(shell)).accounts === 0, '停用后界面里没有账号');
    shell.close();
    app.child.kill();
    await sleep(800);

    // 5) 提示登录：有“稍后”，账号照常启动
    srv.revoked = false;
    srv.policy = 'optional';
    fs.writeFileSync(path.join(profile, 'team.json'), JSON.stringify({ server: teamServer, policy: 'optional' }));
    // 上一段登录后两个号已经加入团队；这里看的是“提示登录”本身，换回没加入过的两个号
    fs.writeFileSync(path.join(profile, 'accounts.json'), JSON.stringify([account('1', 'Sales DE', dead[0], 1), account('2', 'Sales FR', dead[1], 2)]));
    app = await launch(profile, teamServer);
    children.push(app.child);
    shell = app.shell;
    await waitFor(async () => (await state(shell)).page === 'login');
    st = await state(shell);
    check(st.page === 'login' && st.loginLocked === false, `提示登录：打开就是登录页，但不锁（${JSON.stringify(st)}）`);
    check(await waitFor(async () => (await app.accountPages()) === 2), '提示登录时账号照常启动');
    const later = await shell.evaluate(`(() => { const b = [...document.querySelectorAll('.login-card button')].find((x) => x.textContent === '稍后' && !x.hidden); if (b) b.click(); return !!b; })()`);
    check(later, '有“稍后”');
    check(await waitFor(async () => (await state(shell)).page === 'account', 4000), '点“稍后”回到账号页');
    shell.close();
  } finally {
    for (const c of children) c.kill();
    server.close();
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
