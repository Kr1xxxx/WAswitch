// 自检：译文显示在消息下面时，往上翻聊天记录看到的更早的客户消息也有东西（1.0.4 bug 检查第 3 条）。
// 读页面只读最后 20 条（翻译栏用），往上翻时那次读数整个不用；消息下面另外按「屏幕上看得到的消息」放：
//   1. 停在最下面：最近的客户消息照常自动翻
//   2. 往上翻到最上面：以前存过译文的旧消息直接显示译文，没翻过的显示「翻译」按钮，不自动调翻译
//   3. 点旧消息的「翻译」：翻好放在下面，上下文是它前面的消息（不是对话最新的）
//   4. 回到最下面：新来的客户消息照常自动翻
//   5. 停在中间往上翻（滚动层不做滚动锚定）：放上译文、按钮后正在看的消息不跳
// 用真的软件 + 本地假 web.whatsapp.com + 假来财（fixtures/cloud-team.js，启动时已登录团队），不连外网。
// 用法：xvfb-run -a -s "-screen 0 1920x1200x24" node scripts/check-tr-history.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startCloud, teamOn, CLOUD_MAIN } = require('./fixtures/cloud-team');
const net = require('net');
const https = require('https');
const electron = require('electron');
const { TrStore, textKey } = require('../src/trstore');
const { hashOf } = require('../src/floatcore');

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
  return { evaluate, send, close: () => ws.close() };
}

const CHAT = '4915111111111@c.us';
const N = 40;
const SAVED = 5; // 最早的 5 条以前翻过（存在本机）
const textOf = (i) => `Frage Nummer ${i}: Haben Sie Perücken in Farbe ${i}?`;
const msgIn = (i) => `<div role="row"><div data-id="false_${CHAT}_IN${i}" class="message-in"><div><div class="copyable-text" data-pre-plain-text="[10:${String(i % 60).padStart(2, '0')}, 30/10/2026] Emma Schneider: "><div><span class="selectable-text copyable-text"><span>${textOf(i)}</span></span></div></div><div class="meta">10:${String(i % 60).padStart(2, '0')}</div></div></div></div>`;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp</title>
<style>body{margin:0;font:14px sans-serif} #app{display:flex;height:100vh} #side{width:300px} #main{flex:1;display:flex;flex-direction:column;min-width:0}
.scroll{flex:1;overflow-y:auto;overflow-anchor:none} .message-in,.message-out{margin:6px 20px;max-width:60%;padding:6px 8px} .meta{text-align:right}</style></head><body>
<div id="app"><div id="side"><div id="pane-side"><div role="grid" aria-label="Chat list"><div role="row"><span dir="auto" title="Emma Schneider">Emma Schneider</span></div></div></div></div>
<div id="main"><header><span dir="auto" title="Emma Schneider">Emma Schneider</span></header><div class="scroll"><div role="application">
${Array.from({ length: N }, (_, i) => msgIn(i)).join('\n')}
</div></div><footer><div contenteditable="true"></div></footer></div></div>
<script>const s = document.querySelector('.scroll'); s.scrollTop = s.scrollHeight;</script>
</body></html>`;
const answer = (n) => `译文 ${n}`;

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-trhist-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web.whatsapp.com',
    '-keyout', path.join(home, 'key.pem'), '-out', path.join(home, 'cert.pem')], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(path.join(home, 'key.pem')), cert: fs.readFileSync(path.join(home, 'cert.pem')) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  const waPort = await freePort();
  await new Promise((r) => server.listen(waPort, '127.0.0.1', r));

  // 假翻译服务：要翻的那条在最后，回「译文 N」；记下每次请求里出现的所有编号（上下文 + 这条）
  const calls = [];
  const cloud = await startCloud({ chat: (body) => {
    const text = (body.messages || []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const nums = [...text.matchAll(/Nummer (\d+)/g)].map((m) => Number(m[1]));
    const n = nums.length ? nums[nums.length - 1] : -1;
    calls.push({ n, nums });
    return { status: 200, body: { ok: true, text: answer(n), usage: { input_tokens: 10, output_tokens: 5 } } };
  } });

  const dir = path.join(home, 'waswitch');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([{
    id: '1', name: '测试号', color: '#16A34A', proxy: '', mode: 'web', primary: true,
    fingerprint: { version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region: 'SG', seed: 1 },
  }]));
  // 来财要花钱：更早的消息不在后台补翻，没存过的就该一直是「翻译」按钮
  fs.writeFileSync(path.join(dir, 'translate.json'), JSON.stringify({ termsDefaultOn: true, autoDefaultOn: true }));
  // 以前翻过、存在本机的最早几条（按原文存，和软件存的一样）
  const store = new TrStore(path.join(dir, 'translations'));
  const ck = hashOf('1', `chat|${CHAT}`);
  for (let i = 0; i < SAVED; i++) store.putKey('1', ck, textKey(textOf(i)), { tr: `存过的译文 ${i}`, text: textOf(i) });
  store.flush();

  const port = await freePort();
  const env = { ...process.env, XDG_CONFIG_HOME: home, HOME: home, ...teamOn(dir, cloud.url) };
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, '--ignore-certificate-errors',
    `--host-resolver-rules=MAP web.whatsapp.com:443 127.0.0.1:${waPort}`, CLOUD_MAIN], { env, stdio: 'ignore' });
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
    const pageT = targets.find((t) => t.url.includes('web.whatsapp.com'));
    check(!!pageT, '启动后打开了账号页面');
    if (!pageT) throw new Error('页面没打开');
    const pageC = await cdp(pageT.webSocketDebuggerUrl);
    const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(50); } return -1; };
    const trOf = (i) => pageC.evaluate(`(() => { const m = document.querySelector('[data-id$="_IN${i}"]'); const n = m && m.querySelector('[data-wasw-tr]'); return n ? n.textContent : null; })()`);
    const shot = async (name) => {
      if (!process.env.SHOT_DIR) return;
      const r = await pageC.send('Page.captureScreenshot', { format: 'png' });
      if (r.result) fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    };
    // 屏幕上看得到的客户消息（在滚动区里）各显示什么：译文 / 按钮上的字 / 没有
    const visible = () => pageC.evaluate(`(() => {
      const box = document.querySelector('.scroll').getBoundingClientRect();
      return [...document.querySelectorAll('[data-id]')].filter((m) => { const r = m.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; })
        .map((m) => { const n = m.querySelector('[data-wasw-tr]'); const b = n && n.querySelector('button'); return { i: Number(m.getAttribute('data-id').split('_IN').pop()), tr: n ? n.textContent : null, btn: b ? b.textContent : null }; });
    })()`);

    // 1. 停在最下面：最近的客户消息自动翻
    const t1 = await waitFor(async () => (await trOf(N - 1)) === answer(N - 1), 20000);
    check(t1 >= 0, `最下面的客户消息自动翻好了（${t1} 毫秒）`);
    await sleep(3000);
    const autoCalls = calls.length;
    await shot('hist-bottom');

    // 2. 往上翻到最上面
    await pageC.evaluate("document.querySelector('.scroll').scrollTop = 0");
    const t2 = await waitFor(async () => (await trOf(0)) === `存过的译文 0`, 8000);
    check(t2 >= 0, `往上翻到最上面，以前存过的译文显示在最早的消息下面（${t2} 毫秒）`);
    await sleep(2500);
    const top = await visible();
    check(top.length >= 8, `最上面一屏看得到 ${top.length} 条消息`);
    const savedOk = top.filter((v) => v.i < SAVED).every((v) => v.tr === `存过的译文 ${v.i}`);
    check(savedOk, '存过译文的旧消息都显示了译文');
    const rest = top.filter((v) => v.i >= SAVED);
    const bare = rest.filter((v) => !v.btn && !v.tr);
    check(rest.length > 0 && bare.length === 0, `没翻过的旧消息都有东西（${rest.length} 条，什么都没有的 ${bare.map((v) => v.i).join(',') || '无'}）`);
    check(rest.every((v) => v.btn === '翻译'), '没翻过的旧消息显示「翻译」按钮');
    check(calls.length === autoCalls, `往上翻没有自动调翻译（多调了 ${calls.length - autoCalls} 次）`);
    await shot('hist-top');

    // 放好以后页面不再被改
    await pageC.evaluate(`(() => { window.__muts = 0; new MutationObserver((r) => { window.__muts += r.length; }).observe(document.querySelector('#main'), { childList: true, subtree: true, characterData: true }); return 1; })()`);
    await sleep(4000);
    const muts = await pageC.evaluate('window.__muts');
    check(muts === 0, `放好以后 4 秒里页面没有再被改（改了 ${muts} 处）`);

    // 3. 点一条旧消息的「翻译」
    const pick = SAVED + 2;
    await pageC.evaluate(`document.querySelector('[data-id$="_IN${pick}"] [data-wasw-tr] button').click()`);
    const t3 = await waitFor(async () => (await trOf(pick)) === answer(pick), 10000);
    check(t3 >= 0, `点旧消息的「翻译」后放上了译文（${t3} 毫秒）`);
    const call = calls.find((c) => c.n === pick);
    check(!!call && call.nums.slice(0, -1).every((x) => x < pick) && call.nums.length > 1, `翻旧消息时带的上下文是它前面的消息（${call ? call.nums.join(',') : '没请求'}）`);
    check(calls.length === autoCalls + 1, '只翻了点的那一条');

    // 4. 回到最下面，来一条新消息：照常自动翻
    await pageC.evaluate(`(() => {
      document.querySelector('[role="application"]').insertAdjacentHTML('beforeend', ${JSON.stringify(msgIn(N))});
      const s = document.querySelector('.scroll'); s.scrollTop = s.scrollHeight;
      return 1;
    })()`);
    const t4 = await waitFor(async () => (await trOf(N)) === answer(N), 10000);
    check(t4 >= 0, `回到最下面，新来的消息照常自动翻（${t4} 毫秒）`);
    check((await trOf(N - 1)) === answer(N - 1), '最下面原来的译文还在');

    // 5. 再往上翻：点过的那条记住了（存进了本机），不再显示按钮
    await pageC.evaluate("document.querySelector('.scroll').scrollTop = 0");
    const t5 = await waitFor(async () => (await trOf(pick)) === answer(pick) && (await trOf(0)) === '存过的译文 0', 6000);
    check(t5 >= 0, '再往上翻，点过的旧消息还是译文');
    // 写盘隔 1 秒合并一次
    const t6 = await waitFor(async () => { const rec = new TrStore(path.join(dir, 'translations')).get('1', ck, textOf(pick)); return !!rec && rec.tr === answer(pick); }, 5000);
    check(t6 >= 0, '点过的旧消息的译文存进了本机');
    // 6. 往上翻又加载出 60 条更早的（WhatsApp 往上翻时就是这样往上面加），停在中间看：放好以后看的那条不跳
    await pageC.evaluate(`(() => {
      const s = document.querySelector('.scroll');
      const app = document.querySelector('[role="application"]');
      const h0 = s.scrollHeight;
      app.insertAdjacentHTML('afterbegin', ${JSON.stringify(Array.from({ length: 60 }, (_, i) => msgIn(100 + i)).join(''))});
      s.scrollTop += s.scrollHeight - h0;
      const t = document.querySelector('[data-id$="_IN130"]');
      s.scrollTop += t.getBoundingClientRect().top - s.getBoundingClientRect().top;
      return 1;
    })()`);
    const y0 = await pageC.evaluate(`document.querySelector('[data-id$="_IN130"]').getBoundingClientRect().top`);
    const t7 = await waitFor(async () => (await trOf(125)) !== null && (await trOf(131)) !== null, 8000);
    check(t7 >= 0, '中间新加载出来的旧消息也放上了「翻译」按钮');
    await sleep(1500);
    const y1 = await pageC.evaluate(`document.querySelector('[data-id$="_IN130"]').getBoundingClientRect().top`);
    check(Math.abs(y1 - y0) < 2, `上面的消息放上按钮后，正在看的消息没有跳（移动了 ${Math.round(y1 - y0)} 像素）`);
    console.log('调翻译的顺序', calls.map((c) => c.n).join(' '));
    pageC.close();
  } finally {
    child.kill();
    server.close();
    cloud.close();
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
