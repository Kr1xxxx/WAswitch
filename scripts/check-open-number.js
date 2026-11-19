// 自检：侧栏工具「开聊」（选一个网页号，粘贴号码打开对话，号码和名字记进客户资料）。用真的软件跑，不需要 WhatsApp 账号。
// 做法：本地起一个假的 web.whatsapp.com（HTTP/2 + 自签证书 + host-resolver-rules，和 check-blank-view.js 一样）。
// 首页是登录后的样子（对话列表 + 打开着 Emma 的对话，消息是真实结构：data-id 在外层、气泡尾巴、发送人标签）；
// /send?phone=号码 和真 WhatsApp 一样打开这个号码的新对话（顶栏是格式化的号码，还没有消息）。
// 两个网页号（德国、英国）和一个轻量号；两个网页页面按时区（指纹按地区设的）认出是哪个号的。
//   1. 侧栏「工具」里有「开聊」；账号只列两个网页号（一排按钮，不是系统下拉框），默认选当前的号；光标在号码框里；方向键换号
//   2. 选另一个号（英国号），填号码（一个字一个字地输，带 (0) 的德国写法）和名字，按回车：
//      切到英国号、只有英国号的页面跳到 /send?phone=4915123456789（网址里只有号码）、对话出现、客户资料里这条记在英国号下
//   3. 输入框里有没发的字：不跳也不切号，提示会丢字，按钮变「仍然打开」，点了才跳
//   4. 已经开着这个号码：不刷新页面，切到这个号
//   5. 没写区号、所选的号自己也没有号码：提示带上区号，不跳
//   6. 同一个号码再开一次不填名字：客户资料不多一条；填了新名字就改名
//   7. 工作台的客户资料页不再有「开聊」
//   8. 号码框下面那一行：没写区号按所选的号补（换号重算）、认出国家和当地时间、位数不对提醒但能点、老客户带出名字、别的号的客户写明是谁的；
//      按补好的号码打开，客户资料里存完整号码
// 截图：设了 WASWITCH_SHOT_DIR 就把页面截下来（整个屏幕，ImageMagick 的 import）。
// 运行：xvfb-run -a -s "-screen 0 1920x1200x24" node scripts/check-open-number.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http2 = require('http2');
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

// 真实结构的消息（照 check-tr-inline.js 的 realText）
const TAIL = '<span aria-hidden="true" data-icon="tail-in" class="tail"><svg viewBox="0 0 8 13" width="8" height="13"><path d="M5.188 0H0v11.193l6.467-8.625C7.526 1.156 6.958 0 5.188 0z"></path></svg></span>';
const LABEL = '<span class="sender-label" aria-label="Emma Schneider:"></span>';
const realText = (id, time, text, tail) => `<div role="row"><div tabindex="-1" data-id="false_4915111111111@c.us_${id}"><div class="message-in">${tail ? TAIL : ''}${LABEL}<div class="bubble"><div class="copyable-text" data-pre-plain-text="[${time}, 30/10/2026] Emma Schneider: "><div><span class="selectable-text copyable-text"><span>${text}</span></span></div></div><div class="meta">${time}</div></div></div></div></div>`;
const CSS = '<style>body{margin:0;font:14px sans-serif;display:flex;height:100vh}#side{width:300px;border-right:1px solid #ddd}#main{flex:1;display:flex;flex-direction:column}#main header{padding:12px;border-bottom:1px solid #ddd}.msgs{flex:1;padding:12px;overflow:auto}footer{padding:10px;border-top:1px solid #ddd}footer [contenteditable]{min-height:20px;border:1px solid #ccc;padding:6px}</style>';
const SIDE = '<div id="side"><div id="pane-side"><div role="row"><span title="Emma Schneider" dir="auto">Emma Schneider</span><span title="Hallo, haben Sie 3D-Wimpern?">Hallo, haben Sie 3D-Wimpern?</span></div></div></div>';
const fmt = (d) => `+${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}`;
const page = (title, msgs) => `<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp</title>${CSS}</head><body>${SIDE}
<div id="main"><header><span title="${title}" dir="auto">${title}</span><span title="click here for contact info">click here for contact info</span></header>
<div class="msgs">${msgs}</div><footer><div contenteditable="true" role="textbox" data-testid="conversation-compose-box-input" data-tab="10"></div></footer></div></body></html>`;

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-opennum-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web.whatsapp.com',
    '-keyout', path.join(home, 'key.pem'), '-out', path.join(home, 'cert.pem')], { stdio: 'ignore' });
  const sends = []; // 收到的 /send 请求的完整网址
  const server = http2.createSecureServer({ key: fs.readFileSync(path.join(home, 'key.pem')), cert: fs.readFileSync(path.join(home, 'cert.pem')) }, (req, res) => {
    req.stream.on('error', () => {});
    res.on('error', () => {});
    const u = new URL(req.url, 'https://web.whatsapp.com');
    const html = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (u.pathname === '/') { res.writeHead(200, html); return res.end(page('Emma Schneider', realText('A1', '10:01', 'Hallo, haben Sie 3D-Wimpern?', true))); }
    if (u.pathname === '/send') {
      sends.push(req.url);
      const d = String(u.searchParams.get('phone') || '').replace(/\D/g, '');
      res.writeHead(200, html);
      return res.end(page(fmt(d), ''));
    }
    res.writeHead(404); res.end();
  });
  server.on('sessionError', () => {});
  const waPort = await freePort();
  await new Promise((r) => server.listen(waPort, '127.0.0.1', r));

  const profile = path.join(home, 'waswitch');
  fs.mkdirSync(profile, { recursive: true });
  const fp = (seed, region) => ({ version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region, seed });
  const deadPort = await freePort();
  fs.writeFileSync(path.join(profile, 'accounts.json'), JSON.stringify([
    { id: '1', name: '德国号', color: '#16A34A', proxy: '', mode: 'web', primary: true, fingerprint: fp(1, 'DE'), phone: '+49 151 1111111', phoneManual: true },
    { id: '2', name: '轻量号', color: '#2563EB', proxy: `socks5://127.0.0.1:${deadPort}`, mode: 'lite', primary: false, fingerprint: fp(2, 'FR') },
    { id: '3', name: '英国号', color: '#D97706', proxy: '', mode: 'web', primary: false, fingerprint: fp(3, 'GB') },
  ]));
  const port = await freePort();
  const env = { ...process.env, XDG_CONFIG_HOME: home, HOME: home, ...teamOff(profile) };
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, '--ignore-certificate-errors',
    `--host-resolver-rules=MAP web.whatsapp.com:443 127.0.0.1:${waPort}`, root], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', (d) => { log = (log + d).slice(-8000); });
  let failures = 0;
  const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(150); } return -1; };
  const shotDir = process.env.WASWITCH_SHOT_DIR;
  const shot = (name) => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); try { execFileSync('import', ['-window', 'root', path.join(shotDir, name)]); } catch (e) { console.log(`截图失败：${e.message}`); } };
  const customers = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'customers.json'), 'utf8')).filter((c) => !c.deleted); } catch { return []; } };
  try {
    const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    let targets = [];
    await waitFor(async () => {
      try { targets = await list(); } catch { targets = []; }
      return targets.some((t) => t.url.includes('index.html')) && targets.filter((t) => t.url.includes('web.whatsapp.com')).length >= 2;
    }, 40000);
    const shellT = targets.find((t) => t.url.includes('index.html'));
    const waTs = targets.filter((t) => t.url.includes('web.whatsapp.com'));
    if (!shellT || waTs.length < 2) throw new Error('页面没打开');
    const shell = await cdp(shellT.webSocketDebuggerUrl);
    // 两个网页页面按时区认：德国号 Europe/Berlin，英国号 Europe/London
    const pages = {};
    for (const t of waTs) {
      const c = await cdp(t.webSocketDebuggerUrl);
      let tz = '';
      await waitFor(async () => { tz = await c.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone').catch(() => ''); return tz === 'Europe/Berlin' || tz === 'Europe/London'; }, 15000);
      pages[tz === 'Europe/London' ? 'gb' : 'de'] = c;
    }
    if (!pages.de || !pages.gb) throw new Error(`认不出两个网页号的页面：${Object.keys(pages)}`);
    const header = (who) => pages[who].evaluate("document.querySelector('#main header span[title]')?.getAttribute('title') || ''").catch(() => '');
    await waitFor(async () => (await header('de')) === 'Emma Schneider' && (await header('gb')) === 'Emma Schneider', 20000);
    await sleep(1500); // 让软件认出登录状态

    const st = (expr) => shell.evaluate(`(() => { try { return ${expr}; } catch { return null; } })()`);
    const btn = (label) => shell.evaluate(`!![...document.querySelectorAll('#content .btn')].find((x) => x.textContent === ${JSON.stringify(label)})`);
    const click = (label) => shell.evaluate(`(() => { const b = [...document.querySelectorAll('#content .btn')].find((x) => x.textContent === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
    const msg = () => shell.evaluate("document.querySelector('#content .note.bad')?.textContent || ''");
    const see = () => shell.evaluate("(() => { const el = document.querySelector('#content .op-card .op-see'); return el ? (el.classList.contains('warn') ? 'warn:' : '') + [...el.children].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.textContent).join('|') : ''; })()");
    const goOff = () => shell.evaluate("document.querySelector('#content .op-card .op-foot .btn').disabled");
    const input = (i) => `document.querySelectorAll('#content .op-card input')[${i}]`;
    const clear = (i) => shell.evaluate(`(() => { const el = ${input(i)}; el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const toPage = async () => {
      await shell.evaluate("[...document.querySelectorAll('#side .tool-row')].find((b) => b.getAttribute('aria-label') === '开聊')?.click()");
      await waitFor(async () => (await st("s.page")) === 'opennum' && !!(await shell.evaluate(`!!${input(0)}`)), 4000);
      await sleep(300);
    };
    const pick = (id) => shell.evaluate(`(() => { const el = document.querySelector('#content .op-acc[data-id="${id}"]'); el.click(); return true; })()`);
    const picked = () => shell.evaluate("[...document.querySelectorAll('#content .op-acc')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.id).join(',')");
    // 一个字一个字地输（整段赋值会藏住 bug）
    const type = (i, text) => shell.evaluate(`(() => { const el = ${input(i)}; el.focus(); for (const c of ${JSON.stringify(text)}) { el.value += c; el.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
    const enter = (i, composing = false) => shell.evaluate(`${input(i)}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: ${composing}, bubbles: true, cancelable: true }))`);
    const fill = async (acc, phone, name) => { await toPage(); if (acc) await pick(acc); await sleep(200); await type(0, phone); if (name) await type(1, name); };
    const onAccount = (id) => waitFor(async () => (await st('s.page')) === 'account' && (await st('s.activeId')) === id, 8000);

    // 1. 入口
    check(await shell.evaluate("[...document.querySelectorAll('#side .tool-row')].map((b) => b.getAttribute('aria-label')).join(',')") === '翻译,待回复,开聊', '侧栏工具里有「开聊」，排在翻译、待回复后面');
    check(await st('s.activeId') === '1', '开始时在德国号上');
    await toPage();
    check(await st('s.page') === 'opennum', '点「开聊」打开开聊页');
    const opts = await shell.evaluate("[...document.querySelectorAll('#content .op-acc')].map((o) => o.dataset.id + ':' + o.textContent).join(',')");
    check(opts === '1:德国号,3:英国号', `账号只列网页号（${opts}）`);
    check(await picked() === '1', '默认选当前的号');
    check(!(await shell.evaluate("!!document.querySelector('#content select')")), '不用系统下拉框');
    check(await shell.evaluate(`document.activeElement === ${input(0)}`), '进来光标就在号码框里');
    check(!(await shell.evaluate("[...document.querySelectorAll('#content *')].some((el) => el.children.length === 0 && /·/.test(el.textContent))")), '页面里没有「·」');
    shot('page.png');

    // 1b. 键盘：Tab 到选中的号，方向键换号，焦点跟着走，重画后还在
    const tabIdx = await shell.evaluate("[...document.querySelectorAll('#content .op-acc')].map((b) => b.tabIndex).join(',')");
    check(tabIdx === '0,-1', `只有选中的号能 Tab 到（${tabIdx}）`);
    const arrow = (key) => shell.evaluate(`(() => { const el = document.querySelector('#content .op-acc.on'); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true, cancelable: true })); return true; })()`);
    await arrow('ArrowRight');
    await sleep(200);
    check(await picked() === '3' && await shell.evaluate("document.activeElement?.dataset?.id") === '3', '按右方向键换到英国号，焦点也在英国号上');
    await arrow('ArrowRight');
    await sleep(200);
    check(await picked() === '1' && await shell.evaluate("document.activeElement?.dataset?.id") === '1', '到头再按回到第一个号');

    // 2. 选英国号开聊
    await pick('3');
    await sleep(200);
    await type(0, '+49 (0)151 2345 6789');
    await type(1, 'Lena Fischer');
    await sleep(200);
    check(await picked() === '3', '打字时选的号没被重画冲掉');
    shot('form.png');
    await enter(1, true);
    await sleep(500);
    check(sends.length === 0, '输入法选字时的回车不算提交');
    await enter(1);
    const ms1 = await waitFor(async () => (await header('gb')) === '+49 1512 3456789', 15000);
    check(ms1 >= 0, `按回车后英国号打开了这个号码的对话（${ms1} 毫秒）`);
    check((await header('de')) === 'Emma Schneider', '德国号的页面没动');
    check(sends.length === 1 && sends[0] === '/send?phone=4915123456789', `只跳到 /send?phone=号码，网址里没有别的（${sends.join(' ')}）`);
    check(await onAccount('3') >= 0, '切到了英国号');
    await waitFor(async () => customers().length === 1, 8000); // 看到对话打开以后才记
    const c1 = customers();
    check(c1.length === 1 && c1[0].name === 'Lena Fischer' && c1[0].phone === '+4915123456789' && c1[0].accountId === '3', `客户资料里记在英国号下（${JSON.stringify(c1.map((c) => [c.name, c.phone, c.accountId]))}）`);

    // 3. 德国号输入框里有没发的字
    await pages.de.evaluate("document.querySelector('footer [contenteditable]').textContent = 'Guten Tag, '; 1");
    await fill('1', '+33 6 12 34 56 78', '');
    await click('开聊');
    await waitFor(async () => (await msg()).includes('没发的字'), 5000);
    check((await msg()).includes('没发的字') && await btn('仍然打开'), `输入框有字：提示会丢字，按钮变「仍然打开」（${await msg()}）`);
    check(sends.length === 1 && await st('s.page') === 'opennum', '输入框有字时没有跳转，也没切号');
    shot('not-empty.png');
    await click('仍然打开');
    check(await waitFor(async () => (await header('de')) === '+33 6123 45678', 15000) >= 0 && sends[1] === '/send?phone=33612345678', '点「仍然打开」后才跳过去');
    check(await onAccount('1') >= 0, '切到了德国号');
    await waitFor(async () => customers().length === 2, 8000);
    check(customers().length === 2 && customers().some((c) => c.phone === '+33612345678' && c.name === '' && c.accountId === '1'), '没填名字也记下号码');

    // 4. 已经开着这个号码（英国号开着 Lena）：从德国号上过来
    await fill('3', 'wa.me/4915123456789', '');
    await click('开聊');
    check(await onAccount('3') >= 0 && sends.length === 2, '已经开着这个号码：不刷新页面，切到这个号');

    // 5. 没写区号，所选的号（英国号）自己也没有号码：下面那一行要区号，点了也不跳
    await fill('3', '0151 2345678', '');
    await waitFor(async () => (await see()).includes('区号'), 3000);
    check((await see()) === 'warn:请带上区号，例如 +49', `账号没有自己的号码：提示带上区号（${await see()}）`);
    await click('开聊');
    await waitFor(async () => (await msg()).includes('区号'), 4000);
    check((await msg()).includes('区号') && sends.length === 2 && await st('s.page') === 'opennum', `没有区号的号码：提示，不跳（${await msg()}）`);

    // 6. 同一个号码再开：不多一条；填了新名字改名
    await shell.evaluate(`(() => { const el = ${input(0)}; el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await type(0, '0049 151 23456789');
    await pick('1');
    await click('开聊');
    await waitFor(async () => sends.length === 3, 8000);
    await onAccount('1');
    await waitFor(async () => customers().length === 3, 8000);
    check(customers().length === 3 && customers().find((c) => c.phone === '+4915123456789' && c.accountId === '3')?.name === 'Lena Fischer', '同一个号码在另一个号开：各记各的，名字不被清掉');
    await fill('1', '+49 151 23456789', '');
    await waitFor(async () => (await shell.evaluate(`${input(1)}.value`)) === 'Lena Fischer', 3000); // 英国号下记过名字，带出来
    await click('开聊');
    await onAccount('1');
    await sleep(500);
    check(customers().length === 3 && customers().find((c) => c.phone === '+4915123456789' && c.accountId === '1')?.name === 'Lena Fischer', '同一个号码带出了名字：不多一条，改成这个名字');

    // 8. 号码框下面那一行：边打边认，换号重算，位数提醒，老客户带出名字
    await toPage();
    check(await goOff(), '号码框空着时「开聊」不能点');
    check((await see()) === '', '号码框空着时没有那一行');
    await pick('1');
    await type(0, '0151 2345 6789');
    await waitFor(async () => (await see()).startsWith('德国'), 3000);
    const s1 = await see();
    check(/^德国\|\+49 1512 3456789\|区号按 德国号 补的\|当地 \d\d:\d\d$/.test(s1), `没写区号：按德国号补，认出德国，有当地时间（${s1}）`);
    check(await shell.evaluate(`document.activeElement === ${input(0)}`) && !(await goOff()), '边打边认：焦点还在号码框里，「开聊」能点');
    shot('see-added.png');
    await pick('3');
    await waitFor(async () => (await see()).startsWith('warn:'), 3000);
    check((await see()) === 'warn:请带上区号，例如 +49', `换成没有自己号码的英国号：那一行跟着重算（${await see()}）`);
    await pick('1');
    await waitFor(async () => (await see()).startsWith('德国'), 3000);
    check((await see()).startsWith('德国|+49 1512 3456789'), '换回德国号：又按德国号补');
    await clear(0);
    await type(0, '+33 6 12 34 56');
    await waitFor(async () => (await see()).startsWith('warn:'), 3000);
    check((await see()) === 'warn:法国|号码一般 9 位，现在 7 位' && !(await goOff()), `位数不对：琥珀色提醒，「开聊」照样能点（${await see()}）`);
    shot('see-warn.png');
    await clear(0);
    await type(0, '+44 7911 123456');
    await waitFor(async () => (await see()).startsWith('英国'), 3000);
    const s4 = await see();
    check(/^英国\|\+44 7911 123456\|当地 \d\d:\d\d$/.test(s4), `带区号的号码：认出英国，不写「补的」（${s4}）`);
    // 老客户：Lena 记在英国号和德国号下；从德国号开，名字框空着就带出来
    await clear(0);
    await type(0, '0049 151 23456789');
    await waitFor(async () => (await shell.evaluate(`${input(1)}.value`)) === 'Lena Fischer', 3000);
    check(await shell.evaluate(`${input(1)}.value`) === 'Lena Fischer', '客户资料里已有这个号码：名字自动带出');
    await type(0, '0');
    await waitFor(async () => (await shell.evaluate(`${input(1)}.value`)) === '', 3000);
    check(await shell.evaluate(`${input(1)}.value`) === '', '号码改成别的：带出来的名字跟着清掉');
    await clear(0);
    await type(1, 'Paul Weber');
    await type(0, '+49 151 23456789');
    await sleep(600);
    check(await shell.evaluate(`${input(1)}.value`) === 'Paul Weber', '用户自己填了名字：不被客户资料里的名字换掉');
    await clear(1);
    await clear(0);
    await pick('3');
    await type(0, '+33 6 12 34 56 78');
    await waitFor(async () => (await see()).startsWith('法国'), 3000);
    check((await see()).includes('德国号 的客户'), `别的号下的客户：写明是谁的（${await see()}）`);
    // 按补好的号码打开，客户资料里存完整号码
    await pick('1');
    await clear(0);
    await type(0, '0170 1234567');
    await waitFor(async () => (await see()).includes('补的'), 3000);
    const before = sends.length;
    await click('开聊');
    await waitFor(async () => sends.length === before + 1, 8000);
    check(sends[before] === '/send?phone=491701234567', `没写区号的号码按德国号补好再打开（${sends[before]}）`);
    await onAccount('1');
    await waitFor(async () => customers().some((c) => c.phone === '+491701234567'), 8000);
    check(customers().some((c) => c.phone === '+491701234567' && c.accountId === '1'), '客户资料里存的是补好区号的完整号码');

    // 7. 工作台客户资料页没有「开聊」
    await shell.evaluate("window.wa.panelTab('customers')");
    await sleep(800);
    check(!(await shell.evaluate("[...document.querySelectorAll('#panel .pn-btn')].some((x) => x.textContent === '开聊')")), '工作台的客户资料页不再有「开聊」');
    shell.close();
    for (const c of Object.values(pages)) c.close();
  } catch (e) {
    failures += 1;
    console.error(e);
    console.error(log);
  } finally {
    child.kill();
    server.close();
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
