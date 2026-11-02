// 自检：设置里选了「收到的消息译文显示在：消息下面」（默认）时，网页号的译文放在 WhatsApp 气泡里、原文下面（shen 2026-10-30）。
// 做法：本地起一个假的 web.whatsapp.com（HTTPS 自签证书 + host-resolver-rules）和一个假的翻译服务（OpenAI 兼容接口，本机地址不用密钥），
// 用真的软件跑，查：
//   1. 三条客户消息下面出现译文，自己发的、只有数字的不放；原来停在最下面的，放完还在最下面
//   2. 放好以后页面不再被改（没有来回改、没有一直重读重翻），读到的原文不带译文（不重翻）
//   3. 翻译失败的那条显示原因和「重试」，在页面里点「重试」后换成译文
//   4. 右侧工作台的翻译页不再列消息，只留回复框；关掉工作台也照样放译文
//   5. 设置换成「右侧工作台」：页面里的译文全部拿掉，翻译页重新列出消息；换回来又放上
// 用法：xvfb-run -a -s "-screen 0 1920x1200x24" node scripts/check-tr-inline.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
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
  return { evaluate, send, close: () => ws.close() };
}

// 假对话：三条客户消息（第 3 条第一次翻译会失败）、一条自己发的、一条只有数字的。聊天区能滚动，打开时停在最下面
const msgIn = (id, time, text) => `<div role="row"><div data-id="false_4915111111111@c.us_${id}" class="message-in"><div><div class="copyable-text" data-pre-plain-text="[${time}, 30/10/2026] Emma Schneider: "><div><span class="selectable-text copyable-text"><span>${text}</span></span></div></div><div class="meta">${time}</div></div></div></div>`;
const msgOut = (id, time, text) => `<div role="row"><div data-id="true_4915111111111@c.us_${id}" class="message-out"><div><div class="copyable-text" data-pre-plain-text="[${time}, 30/10/2026] Ich: "><div><span class="selectable-text copyable-text"><span>${text}</span></span></div></div><div class="meta">${time}</div></div></div></div>`;
const filler = Array.from({ length: 12 }, (_, i) => msgOut(`OLD${i}`, '09:0' + (i % 10), `Older note ${i}`)).join('');
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp</title>
<style>body{margin:0;font:14px sans-serif} #app{display:flex;height:100vh} #side{width:300px} #main{flex:1;display:flex;flex-direction:column;min-width:0}
.scroll{flex:1;overflow-y:auto} .message-in,.message-out{margin:6px 20px;max-width:60%;padding:6px 8px}
.message-out{margin-left:auto} .meta{text-align:right}</style></head><body>
<div id="app"><div id="side"><div contenteditable="true" role="textbox" aria-label="Search"></div><div id="pane-side"><div role="grid" aria-label="Chat list"><div role="row"><span dir="auto" title="Emma Schneider">Emma Schneider</span></div></div></div></div>
<div id="main"><header><span dir="auto" title="Emma Schneider">Emma Schneider</span></header><div class="scroll"><div role="application">
${filler}
${msgIn('IN1', '10:01', 'Guten Tag, ist Nummer 1 noch lieferbar?')}
${msgOut('OUT1', '10:02', 'Yes, it is in stock.')}
${msgIn('IN2', '10:03', 'Super, und Nummer 2 in Naturschwarz?')}
${msgIn('NUM', '10:04', '12345')}
${msgIn('IN3', '10:05', 'Kann ich Nummer 3 mit PayPal bezahlen?')}
</div></div><footer><div contenteditable="true"></div></footer></div></div>
<script>const s = document.querySelector('.scroll'); s.scrollTop = s.scrollHeight;</script>
</body></html>`;

const ANSWER = { 1: '你好，1 号还有货吗？', 2: '太好了，2 号有自然黑吗？', 3: '3 号可以用 PayPal 付款吗？' };

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-trinline-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web.whatsapp.com',
    '-keyout', path.join(home, 'key.pem'), '-out', path.join(home, 'cert.pem')], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(path.join(home, 'key.pem')), cert: fs.readFileSync(path.join(home, 'cert.pem')) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  const waPort = await freePort();
  await new Promise((r) => server.listen(waPort, '127.0.0.1', r));

  // 假翻译服务：按消息里的「Nummer N」回中文；第 3 条第一次回 500
  const calls = [];
  let fail3 = true;
  const trServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let text = '';
      try { const j = JSON.parse(body); text = (j.messages || []).filter((m) => m.role === 'user').map((m) => m.content).join('\n'); } catch {}
      // 带着上下文（前面几条）：要翻的那条在最后
      const n = ([...text.matchAll(/Nummer (\d)/g)].pop() || [])[1];
      calls.push(n || '?');
      if (n === '3' && fail3) { fail3 = false; res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"busy"}}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ANSWER[n] || '（看不懂）' } }] }));
    });
  });
  const trPort = await freePort();
  await new Promise((r) => trServer.listen(trPort, '127.0.0.1', r));

  const dir = path.join(home, 'waswitch');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([{
    id: '1', name: '测试号', color: '#16A34A', proxy: '', mode: 'web', primary: true,
    fingerprint: { version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region: 'SG', seed: 1 },
  }]));
  fs.writeFileSync(path.join(dir, 'translate.json'), JSON.stringify({
    seeded: true, seedVer: 3, termsDefaultOn: true, autoDefaultOn: true, network: { mode: 'direct', proxyUrl: '' },
    providers: [{ id: 'local', preset: 'custom', name: '本地测试', baseUrl: `http://127.0.0.1:${trPort}/v1`, model: 'test' }], primaryId: 'local',
  }));
  const port = await freePort();
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
    const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(50); } return -1; };
    const trOf = (id) => pageC.evaluate(`(() => { const m = document.querySelector('[data-id$="_${id}"]'); const n = m && m.querySelector('[data-wasw-tr]'); return n ? n.textContent : null; })()`);
    const shot = async (name, c = pageC) => {
      if (!process.env.SHOT_DIR) return;
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      if (r.result) fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    };

    // 1. 译文放在原文下面
    const t1 = await waitFor(async () => (await trOf('IN1')) === ANSWER[1] && (await trOf('IN2')) === ANSWER[2], 20000);
    check(t1 >= 0, `第 1、2 条客户消息下面出现了译文（${t1} 毫秒）`);
    const place = await pageC.evaluate(`(() => {
      const m = document.querySelector('[data-id$="_IN1"]');
      const body = m.querySelector('.copyable-text[data-pre-plain-text]');
      const n = m.querySelector('[data-wasw-tr]');
      const text = m.querySelector('span.selectable-text');
      return { inBody: !!n && n.parentElement === body, below: !!n && n.getBoundingClientRect().top >= text.getBoundingClientRect().bottom - 1, style: !!document.querySelector('style[data-wasw-style]') };
    })()`);
    check(place.inBody && place.below, '译文在气泡的正文块里、原文的下面');
    check(place.style, '页面里加了译文的样式');
    check((await trOf('OUT1')) === null, '自己发的消息下面没有译文');
    check((await trOf('NUM')) === null, '只有数字的消息下面没有译文');
    const t3 = await waitFor(async () => /重试/.test((await trOf('IN3')) || ''), 15000);
    check(t3 >= 0, '翻译失败的第 3 条显示原因和「重试」');
    const atBottom = await pageC.evaluate("(() => { const s = document.querySelector('.scroll'); return s.scrollHeight - s.clientHeight - s.scrollTop <= 2; })()");
    check(atBottom, '原来停在最下面，放好译文后还在最下面');
    await shot('inline-1');

    // 2. 放好以后页面不再被改，也不重翻
    const before = calls.length;
    await pageC.evaluate(`(() => { window.__muts = 0; new MutationObserver((r) => { window.__muts += r.length; }).observe(document.querySelector('#main'), { childList: true, subtree: true, characterData: true }); return 1; })()`);
    await sleep(5000);
    const muts = await pageC.evaluate('window.__muts');
    check(muts === 0, `放好以后 5 秒里页面没有再被改（改了 ${muts} 处）`);
    check(calls.length === before, `放好以后没有再调翻译（多调了 ${calls.length - before} 次）`);

    // 3. 在页面里点「重试」
    await pageC.evaluate(`document.querySelector('[data-id$="_IN3"] [data-wasw-tr] button').click()`);
    const tr3 = await waitFor(async () => (await trOf('IN3')) === ANSWER[3], 10000);
    check(tr3 >= 0, `点「重试」后第 3 条换成了译文（${tr3} 毫秒）`);

    // 4. 工作台的翻译页只留回复框；关掉工作台也照样放译文
    const dock = await shellC.evaluate("({ items: document.querySelectorAll('.dk-item').length, compose: !!document.querySelector('.dk-compose') })");
    check(dock.items === 0 && dock.compose, `翻译页不再列消息（${dock.items} 条），回复框还在`);
    await shot('shell-dock', shellC);
    if (process.env.SHOT_DIR) {
      await shellC.evaluate("settingsTab = 'translate'; window.wa.showPage('settings')");
      await sleep(800);
      await shot('shell-settings', shellC);
      await shellC.evaluate("window.wa.showPage('account')");
      await sleep(500);
    }
    await shellC.evaluate('window.wa.panelToggle(false)');
    await sleep(800);
    await pageC.evaluate(`(() => {
      const app = document.querySelector('[role="application"]');
      app.insertAdjacentHTML('beforeend', ${JSON.stringify(msgIn('IN4', '10:09', 'Und Nummer 1 in 24 Zoll?'))});
      const s = document.querySelector('.scroll'); s.scrollTop = s.scrollHeight;
      return 1;
    })()`);
    const t4 = await waitFor(async () => (await trOf('IN4')) === ANSWER[1], 10000);
    check(t4 >= 0, `工作台关着，新来的消息下面也放了译文（${t4} 毫秒）`);
    const read = await shellC.evaluate("window.wa.panelToggle(true)");
    void read;

    // 5. 换成「右侧工作台」再换回来
    const r1 = await shellC.evaluate("window.wa.trPlace('panel').then((r) => r.config.trPlace)");
    check(r1 === 'panel', '设置换成了右侧工作台');
    const gone = await waitFor(() => pageC.evaluate("!document.querySelector('[data-wasw-tr]') && !document.querySelector('style[data-wasw-style]')"), 5000);
    check(gone >= 0, '页面里的译文和样式都拿掉了');
    const listed = await waitFor(async () => (await shellC.evaluate("document.querySelectorAll('.dk-item').length")) >= 3, 8000);
    check(listed >= 0, '翻译页重新列出了收到的消息');
    await shot('panel');
    const r2 = await shellC.evaluate("window.wa.trPlace('inline').then((r) => r.config.trPlace)");
    check(r2 === 'inline', '设置换回了消息下面');
    const back = await waitFor(async () => (await trOf('IN2')) === ANSWER[2], 8000);
    check(back >= 0, '换回来后译文又放在消息下面');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'translate.json'), 'utf8'));
    check(cfg.trPlace === 'inline', '设置存进了 translate.json');
    console.log('调翻译的顺序', calls.join(' '));
    shellC.close();
    pageC.close();
  } finally {
    child.kill();
    server.close();
    trServer.close();
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
