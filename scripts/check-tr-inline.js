// 自检：设置里选了「收到的消息译文显示在：消息下面」（默认）时，网页号的译文放在 WhatsApp 气泡里、原文下面（shen 2026-10-30）。
// 做法：本地起一个假的 web.whatsapp.com（HTTPS 自签证书 + host-resolver-rules）和一个假的来财（fixtures/cloud-team.js，启动时已登录团队），
// 用真的软件跑，查：
//   1. 三条客户消息下面出现译文，自己发的、只有数字的不放；原来停在最下面的，放完还在最下面
//   2. 放好以后页面不再被改（没有来回改、没有一直重读重翻），读到的原文不带译文（不重翻）
//   3. 翻译失败的那条显示原因和「重试」，在页面里点「重试」后换成译文
//   4. 右侧工作台的翻译页不再列消息，只留回复框；关掉工作台也照样放译文
//   3b. 更像真 WhatsApp 的结构（data-id 在外层，气泡里第一个是尾巴小图标和隐藏的发件人标签）：文字、语音的译文都放在气泡里，语音放在播放条那一层的下面
//   3c. 点「重试」后马上又失败（文字一样）：按钮要重新能点
//   3d. 退出团队登录：新消息显示「先登录团队才能翻译」，不发给来财；重新登录后自动补上
//   3e. WhatsApp 换成深色主题（假页面里深色字、深色气泡）：译文块换成 Radix 深色色阶，对比度够；换回浅色后 3 秒内变回来，而且还是原来那个节点
//   5. 设置换成「右侧工作台」：页面里的译文全部拿掉，翻译页重新列出消息；换回来又放上
// 用法：xvfb-run -a -s "-screen 0 1920x1200x24" node scripts/check-tr-inline.js
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startCloud, teamOn, CLOUD_MAIN, EMAIL, CODE } = require('./fixtures/cloud-team');
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
  return { evaluate, send, close: () => ws.close() };
}

// 假对话：三条客户消息（第 3 条第一次翻译会失败）、一条自己发的、一条只有数字的。聊天区能滚动，打开时停在最下面
const msgIn = (id, time, text) => `<div role="row"><div data-id="false_4915111111111@c.us_${id}" class="message-in"><div><div class="copyable-text" data-pre-plain-text="[${time}, 30/10/2026] Emma Schneider: "><div><span class="selectable-text copyable-text"><span>${text}</span></span></div></div><div class="meta">${time}</div></div></div></div>`;
const msgOut = (id, time, text) => `<div role="row"><div data-id="true_4915111111111@c.us_${id}" class="message-out"><div><div class="copyable-text" data-pre-plain-text="[${time}, 30/10/2026] Ich: "><div><span class="selectable-text copyable-text"><span>${text}</span></span></div></div><div class="meta">${time}</div></div></div></div>`;
// 更像真 WhatsApp 的结构：data-id 在最外层；.message-in 里第一个是气泡尾巴的小图标（只有一组消息的第一条才有），
// 然后是读屏用的隐藏发件人标签，最后才是气泡本身。语音没有 .copyable-text，播放条下面是时间
const TAIL = '<span aria-hidden="true" data-icon="tail-in" class="tail"><svg viewBox="0 0 8 13" width="8" height="13"><path d="M5.188 0H0v11.193l6.467-8.625C7.526 1.156 6.958 0 5.188 0z"></path></svg></span>';
const LABEL = '<span class="sender-label" aria-label="Emma Schneider:"></span>';
const realText = (id, time, text, tail) => `<div role="row"><div tabindex="-1" data-id="false_4915111111111@c.us_${id}"><div class="message-in">${tail ? TAIL : ''}${LABEL}<div class="bubble"><div class="copyable-text" data-pre-plain-text="[${time}, 30/10/2026] Emma Schneider: "><div><span class="selectable-text copyable-text"><span>${text}</span></span></div></div><div class="meta">${time}</div></div></div></div></div>`;
const realVoice = (id, time, tail) => `<div role="row"><div tabindex="-1" data-id="false_4915111111111@c.us_${id}"><div class="message-in">${tail ? TAIL : ''}${LABEL}<div class="bubble"><div class="voice-row"><button aria-label="Play voice message"><span data-icon="audio-play">▶</span></button><div class="wave" role="slider"></div><span class="dur">0:07</span></div><div class="meta">${time}</div></div></div></div></div>`;
// 播放条直接是气泡里的一个横向排的块（没有外层容器）：译文不能插进播放按钮和波形中间
const flatVoice = (id, time) => `<div role="row"><div tabindex="-1" data-id="false_4915111111111@c.us_${id}"><div class="message-in">${LABEL}<div class="voice-row"><button aria-label="Play voice message"><span data-icon="audio-play">▶</span></button><div class="wave" role="slider"></div><span class="dur">0:09</span></div></div></div></div>`;
const filler = Array.from({ length: 24 }, (_, i) => msgOut(`OLD${i}`, '09:0' + (i % 10), `Older note ${i}`)).join('');
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp</title>
<style>body{margin:0;font:14px sans-serif;background:#fff;color:#111b21} .message-in{background:#fff} body.dark{background:#0b141a;color:#e9edef} body.dark .message-in{background:#202c33} #app{display:flex;height:100vh} #side{width:300px} #main{flex:1;display:flex;flex-direction:column;min-width:0}
.scroll{flex:1;overflow-y:auto} .message-in,.message-out{margin:6px 20px;max-width:60%;padding:6px 8px}
.message-out{margin-left:auto} .meta{text-align:right}
.message-in{position:relative;width:fit-content} .tail{position:absolute;top:0;left:-8px;width:8px;height:13px;display:block}
.sender-label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)} .bubble{padding:0} .voice-row{display:flex;align-items:center;gap:8px;width:260px} .wave{flex:1;height:4px;background:#999}</style></head><body>
<div id="app"><div id="side"><div contenteditable="true" role="textbox" aria-label="Search"></div><div id="pane-side"><div role="grid" aria-label="Chat list"><div role="row"><span dir="auto" title="Emma Schneider">Emma Schneider</span></div></div></div></div>
<div id="main"><header><span dir="auto" title="Emma Schneider">Emma Schneider</span></header><div class="scroll"><div role="application">
${filler}
${msgIn('IN1', '10:01', 'Guten Tag, ist Nummer 1 noch lieferbar?')}
${msgOut('OUT1', '10:02', 'Yes, it is in stock.')}
${msgIn('IN2', '10:03', 'Super, und Nummer 2 in Naturschwarz?')}
${msgIn('NUM', '10:04', '12345')}
${msgIn('IN3', '10:05', 'Kann ich Nummer 3 mit PayPal bezahlen?')}
${realVoice('V1', '10:06', true)}
${realText('R1', '10:07', 'Und Nummer 1 in Rot?', true)}
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

  // 假来财：按消息里的「Nummer N」回中文；第 3 条第一次回 502（来财连不上 DeepSeek）
  const calls = [];
  let fail3 = true;
  let failAll = false;
  const cloud = await startCloud({ chat: (body) => {
    const text = (body.messages || []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    // 带着上下文（前面几条）：要翻的那条在最后
    const n = ([...text.matchAll(/Nummer (\d)/g)].pop() || [])[1];
    calls.push(n || '?');
    if (failAll) return { status: 502, body: { ok: false, error: 'unreachable' } };
    if (n === '3' && fail3) { fail3 = false; return { status: 502, body: { ok: false, error: 'unreachable' } }; }
    return { status: 200, body: { ok: true, text: ANSWER[n] || '（看不懂）', usage: { input_tokens: 10, output_tokens: 5 } } };
  } });

  const dir = path.join(home, 'waswitch');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([{
    id: '1', name: '测试号', color: '#16A34A', proxy: '', mode: 'web', primary: true,
    fingerprint: { version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region: 'SG', seed: 1 },
  }]));
  fs.writeFileSync(path.join(dir, 'translate.json'), JSON.stringify({ termsDefaultOn: true, autoDefaultOn: true }));
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
    if (!atBottom) console.log(await pageC.evaluate("(() => { const s = document.querySelector('.scroll'); return JSON.stringify({ sh: s.scrollHeight, ch: s.clientHeight, st: s.scrollTop, trs: [...document.querySelectorAll('[data-wasw-tr]')].map((n) => n.closest('[data-id]').getAttribute('data-id').split('_').pop() + ':' + n.textContent.slice(0, 10)) }); })()"));
    await shot('inline-1');

    // 2. 放好以后页面不再被改，也不重翻（语音那条要先有结果：假页面里读不到语音，会从「转文字中」变成「重试」）
    await waitFor(async () => /重试/.test((await trOf('V1')) || ''), 15000);
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

    // 3b. 更像真 WhatsApp 的结构：文字（带尾巴）、语音（带尾巴和隐藏发件人标签）
    const rt1 = await waitFor(async () => (await trOf('R1')) === ANSWER[1], 10000);
    const rp = await pageC.evaluate(`(() => {
      const m = document.querySelector('[data-id$="_R1"]');
      const n = m.querySelector('[data-wasw-tr]');
      return { inBody: !!n && n.parentElement === m.querySelector('.copyable-text[data-pre-plain-text]'), tail: !!n && !!n.closest('.tail') };
    })()`);
    check(rt1 >= 0 && rp.inBody && !rp.tail, '带尾巴的文字消息，译文在气泡的正文块里');
    const v1 = await waitFor(async () => (await trOf('V1')) !== null, 10000);
    const vp = await pageC.evaluate(`(() => {
      const m = document.querySelector('[data-id$="_V1"]');
      const n = m.querySelector('[data-wasw-tr]');
      if (!n) return null;
      const r = n.getBoundingClientRect();
      const prev = n.previousElementSibling;
      const next = n.nextElementSibling;
      return {
        notDecor: !n.closest('.tail') && !n.closest('.sender-label'),
        wide: Math.round(r.width),
        inBubble: !!n.closest('.bubble'),
        afterRow: !!prev && prev.classList.contains('voice-row'),
        beforeTime: !!next && next.classList.contains('meta'),
        below: r.top >= m.querySelector('.voice-row').getBoundingClientRect().bottom - 1,
      };
    })()`);
    check(v1 >= 0 && !!vp, '语音消息下面有转文字的按钮或结果');
    check(!!vp && vp.notDecor && vp.inBubble && vp.wide >= 100, `语音的译文不在尾巴或发件人标签里，宽度正常（宽 ${vp && vp.wide}）`);
    check(!!vp && vp.afterRow && vp.beforeTime && vp.below, '语音的译文在播放条那一层的下面');
    if (vp && !(vp.afterRow && vp.beforeTime && vp.below)) console.log(JSON.stringify(vp), await pageC.evaluate("document.querySelector('[data-id$=\"_V1\"]').outerHTML"));
    await shot('inline-voice');
    await pageC.evaluate(`(() => {
      document.querySelector('[role="application"]').insertAdjacentHTML('beforeend', ${JSON.stringify(flatVoice('V2', '10:08'))});
      const s = document.querySelector('.scroll'); s.scrollTop = s.scrollHeight;
      return 1;
    })()`);
    const v2 = await waitFor(async () => (await trOf('V2')) !== null, 10000);
    const fp = await pageC.evaluate(`(() => {
      const m = document.querySelector('[data-id$="_V2"]');
      const n = m.querySelector('[data-wasw-tr]');
      const row = m.querySelector('.voice-row');
      return n ? { outside: !row.contains(n), after: n.previousElementSibling === row, wide: Math.round(n.getBoundingClientRect().width) } : null;
    })()`);
    check(v2 >= 0 && !!fp && fp.outside && fp.after && fp.wide >= 100, `播放条是横向排的块时，译文放在它下面，不插进中间（宽 ${fp && fp.wide}）`);

    // 3c. 点「重试」后马上又失败（文字一样）：按钮要重新能点
    failAll = true;
    await pageC.evaluate(`(() => {
      const app = document.querySelector('[role="application"]');
      app.insertAdjacentHTML('beforeend', ${JSON.stringify(msgIn('IN5', '10:08', 'Und Nummer 2 in Grau?'))});
      const s = document.querySelector('.scroll'); s.scrollTop = s.scrollHeight;
      return 1;
    })()`);
    const e5 = await waitFor(async () => /重试/.test((await trOf('IN5')) || ''), 15000);
    check(e5 >= 0, '翻译失败的第 5 条显示原因和「重试」');
    const before5 = calls.length;
    await pageC.evaluate(`document.querySelector('[data-id$="_IN5"] [data-wasw-tr] button').click()`);
    const again = await waitFor(async () => calls.length > before5, 8000);
    check(again >= 0, '点「重试」后真的又翻了一次');
    const live = await waitFor(() => pageC.evaluate(`(() => { const b = document.querySelector('[data-id$="_IN5"] [data-wasw-tr] button'); return !!b && !b.disabled; })()`), 6000);
    check(live >= 0, '又马上失败（文字一样）后，「重试」按钮重新能点');
    failAll = false;
    await pageC.evaluate(`document.querySelector('[data-id$="_IN5"] [data-wasw-tr] button').click()`);
    const ok5 = await waitFor(async () => (await trOf('IN5')) === ANSWER[2], 10000);
    check(ok5 >= 0, `服务恢复后再点「重试」，第 5 条换成了译文（${ok5} 毫秒）`);

    // 3d. 退出团队登录：新消息只显示「先登录团队才能翻译」和「重试」，没有「去填密钥」，不发给来财；重新登录后自动补上
    const out = await shellC.evaluate('window.wa.teamLogout()');
    check(!!out, '退出了团队登录');
    const before6 = calls.length;
    await pageC.evaluate(`(() => {
      const app = document.querySelector('[role="application"]');
      app.insertAdjacentHTML('beforeend', ${JSON.stringify(msgIn('IN6', '10:10', 'Und Nummer 1 in Blond?'))});
      const s = document.querySelector('.scroll'); s.scrollTop = s.scrollHeight;
      return 1;
    })()`);
    const k6 = await waitFor(async () => /先登录团队/.test((await trOf('IN6')) || ''), 10000);
    const kp = await pageC.evaluate(`(() => {
      const n = document.querySelector('[data-id$="_IN6"] [data-wasw-tr]');
      return n ? { text: n.textContent, btns: [...n.querySelectorAll('button:not([data-wasw-edit])')].map((b) => b.textContent) } : null;
    })()`);
    check(k6 >= 0 && !!kp && !kp.btns.includes('去填密钥') && kp.btns.includes('重试'), `没登录时显示「先登录团队才能翻译」和「重试」（${kp && kp.text}）`);
    check(calls.length === before6, '没登录时不发给来财');
    await shot('inline-nologin');
    const sent = await shellC.evaluate(`window.wa.teamCode({ email: ${JSON.stringify(EMAIL)} })`);
    const relog = await shellC.evaluate(`window.wa.teamLogin({ email: ${JSON.stringify(EMAIL)}, code: ${JSON.stringify(CODE)} })`);
    check(!!sent && !!relog && relog.ok === true, `重新登录了团队（${JSON.stringify(relog)}）`);
    await shellC.evaluate("window.wa.showPage('account')");
    const fixed6 = await waitFor(async () => (await trOf('IN6')) === ANSWER[1], 10000);
    check(fixed6 >= 0, `重新登录后第 6 条自动补上了译文（${fixed6} 毫秒）`);

    // 3e. WhatsApp 换成深色主题：译文块换成 Radix 深色色阶（唯一的深色例外，只给气泡里的译文块），换回浅色后变回来，不重建
    {
      const RADIX = require('../src/colors/radix.js');
      const nums = (c) => (String(c).match(/[\d.]+/g) || []).map(Number);
      const hexNums = (h) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(h); return [1, 2, 3].map((i) => parseInt(m[i], 16)).concat(m[4] ? [+(parseInt(m[4], 16) / 255).toFixed(3)] : []); };
      const same = (got, want) => got.length >= 3 && want.every((v, i) => Math.abs((got[i] === undefined ? 1 : got[i]) - v) < (i === 3 ? 0.01 : 1.01));
      const lum = (rgb) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
      const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      const look = (id, sel) => pageC.evaluate(`(() => { const n = document.querySelector('[data-id$="_${id}"] [data-wasw-tr]'); const t = n && ${sel}; return t ? { color: getComputedStyle(t).color, bg: getComputedStyle(t).backgroundColor, line: getComputedStyle(n).borderTopColor } : null; })()`);
      // 一条报错的消息（红字 + 重试按钮）
      failAll = true;
      await pageC.evaluate(`(() => {
        document.querySelector('[role="application"]').insertAdjacentHTML('beforeend', ${JSON.stringify(msgIn('IN7', '10:11', 'Und Nummer 3 in Weiß?'))});
        const s = document.querySelector('.scroll'); s.scrollTop = s.scrollHeight;
        return 1;
      })()`);
      await waitFor(async () => /重试/.test((await trOf('IN7')) || ''), 15000);
      failAll = false;
      const lightText = await look('IN1', 'n');
      check(!!lightText && same(nums(lightText.color), hexNums(RADIX.hex('slate', 11))), `浅色主题：译文字是 Radix slate 11（${lightText && lightText.color}）`);
      await shot('inline-light');
      await pageC.evaluate(`(() => { window.__n1 = document.querySelector('[data-id$="_IN1"] [data-wasw-tr]'); document.body.classList.add('dark'); return 1; })()`);
      const dk = await waitFor(async () => { const l = await look('IN1', 'n'); return !!l && same(nums(l.color), hexNums(RADIX.hexDark('slate', 12))); }, 3000);
      check(dk >= 0, `WhatsApp 换成深色后，译文字换成 Radix slate-dark 12，和 WhatsApp 正文一样白（${dk} 毫秒）`);
      const dText = await look('IN1', 'n');
      const dBad = await look('IN7', "n.querySelector('[data-wasw-bad]')");
      const dBtn = await look('IN7', "n.querySelector('button')");
      const dLine = await look('IN7', 'n');
      check(!!dBad && same(nums(dBad.color), hexNums(RADIX.hexDark('red', 11))), `深色：报错红字是 red-dark 11（${dBad && dBad.color}）`);
      check(!!dBtn && same(nums(dBtn.bg), hexNums(RADIX.hexDark('slate-a', 4))), `深色：按钮底是 slate-dark-a 4（${dBtn && dBtn.bg}）`);
      check(!!dBtn && same(nums(dBtn.color), hexNums(RADIX.hexDark('slate', 12))), `深色：按钮上的字是 slate-dark 12（${dBtn && dBtn.color}）`);
      check(!!dLine && same(nums(dLine.line), hexNums(RADIX.hexDark('slate-a', 6))), `深色：分隔线是 slate-dark-a 6（${dLine && dLine.line}）`);
      const bubble = hexNums('#202c33');
      check(!!dText && contrast(nums(dText.color).slice(0, 3), bubble) >= 4.5, `深色：译文字和气泡底色的对比度 ${dText && contrast(nums(dText.color).slice(0, 3), bubble).toFixed(1)}（要 4.5 以上）`);
      check(!!dBad && contrast(nums(dBad.color).slice(0, 3), bubble) >= 4.5, `深色：红字和气泡底色的对比度 ${dBad && contrast(nums(dBad.color).slice(0, 3), bubble).toFixed(1)}（要 4.5 以上）`);
      await shot('inline-dark');
      await pageC.evaluate("document.body.classList.remove('dark')");
      const lt = await waitFor(async () => { const l = await look('IN1', 'n'); return !!l && same(nums(l.color), hexNums(RADIX.hex('slate', 11))); }, 3000);
      check(lt >= 0, `WhatsApp 换回浅色后，译文字变回 slate 11（${lt} 毫秒）`);
      const keep = await pageC.evaluate(`window.__n1 === document.querySelector('[data-id$="_IN1"] [data-wasw-tr]') && window.__n1.isConnected`);
      check(keep, '换主题没有重建译文块（还是同一个节点）');
      const lBad = await look('IN7', "n.querySelector('[data-wasw-bad]')");
      check(!!lBad && same(nums(lBad.color), hexNums(RADIX.hex('red', 11))), `浅色：报错红字变回 red 11（${lBad && lBad.color}）`);
    }

    // 3f. 气泡译文末尾的小铅笔：点了在页面外面的小视图里弹编辑小窗，改、保存、纠错
    const pencilOf = (id) => pageC.evaluate(`(() => { const b = document.querySelector('[data-id$="_${id}"] [data-wasw-tr] button[data-wasw-edit]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, vis: getComputedStyle(b).visibility, exp: b.getAttribute('aria-expanded') }; })()`);
    check(!!(await pencilOf('IN1')) && !(await pencilOf('V1')), '有译文的消息有小铅笔，语音报错的没有');
    check((await pencilOf('IN1')).vis === 'hidden', '鼠标不在消息上时铅笔不显示');
    const mouse = async (c, type, x, y) => c.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    const clickAt = async (c, x, y) => { await mouse(c, 'mouseMoved', x, y); await mouse(c, 'mousePressed', x, y); await mouse(c, 'mouseReleased', x, y); };
    let pe = await pencilOf('IN1');
    await mouse(pageC, 'mouseMoved', pe.x, pe.y);
    check((await pencilOf('IN1')).vis === 'visible', '鼠标移到消息上，铅笔出现');
    const seltrC = async () => { const t = (await list()).find((x) => x.url.includes('seltr/index.html')); return t ? cdp(t.webSocketDebuggerUrl) : null; };
    const t0e = Date.now();
    await clickAt(pageC, pe.x, pe.y);
    let sc = null;
    await waitFor(async () => { sc = sc || (await seltrC()); return !!sc && !!(await sc.evaluate("!!document.querySelector('.tc textarea')")); }, 5000);
    const card = () => sc.evaluate(`(() => { const ta = document.querySelector('.tc textarea'); return ta ? { text: ta.value, focus: document.hasFocus() && document.activeElement === ta, btns: [...document.querySelectorAll('.tc-foot button')].map((b) => b.textContent), info: (document.querySelector('.tc-info') || {}).textContent || '' } : null; })()`);
    const openOk = await waitFor(async () => (await pencilOf('IN1')).exp === 'true' && (await card())?.text === ANSWER[1], 3000);
    check(!!sc && openOk >= 0, `点铅笔弹出编辑小窗，框里是译文（${Date.now() - t0e} 毫秒）`);
    const fc = await waitFor(async () => (await card())?.focus, 2000);
    check(fc >= 0, '小窗打开后光标在框里');
    let cd = await card();
    check(!!cd && JSON.stringify(cd.btns) === JSON.stringify(['纠错', '保存']) && /翻译时间/.test(cd.info) && /模型来财 DeepSeek/.test(cd.info), `小窗里有翻译信息和「纠错」「保存」（${cd && cd.info}）`);
    // 打字进了小窗，没进 WhatsApp 的输入框
    await sc.send('Input.insertText', { text: '（改）' });
    cd = await card();
    const compose = await pageC.evaluate("document.querySelector('footer [contenteditable]').textContent");
    check(!!cd && cd.text.endsWith('（改）') && compose === '', '打字进了小窗，没进 WhatsApp 的输入框');
    // 点聊天别处：收起，改的字记着
    await clickAt(pageC, 400, 60);
    const closed = await waitFor(async () => (await pencilOf('IN1')).exp === 'false', 3000);
    check(closed >= 0, '点页面别处收起小窗');
    await sleep(700);
    pe = await pencilOf('IN1');
    await mouse(pageC, 'mouseMoved', pe.x, pe.y);
    await clickAt(pageC, pe.x, pe.y);
    const kept = await waitFor(async () => (await card())?.text === `${ANSWER[1]}（改）` && (await pencilOf('IN1')).exp === 'true', 3000);
    check(kept >= 0, '改了没保存收起，再打开改的字还在');
    // 再点同一个铅笔：收起，不重开
    await clickAt(pageC, pe.x, pe.y);
    await sleep(1200);
    check((await pencilOf('IN1')).exp === 'false', '再点同一个铅笔收起，不重开');
    // 再打开，按 Enter 保存：气泡里换成新译文，小窗收起
    await sleep(700);
    await mouse(pageC, 'mouseMoved', pe.x, pe.y);
    await clickAt(pageC, pe.x, pe.y);
    await waitFor(async () => (await card())?.focus && (await pencilOf('IN1')).exp === 'true', 3000);
    await sc.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sc.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const sv = await waitFor(async () => (await trOf('IN1')) === `${ANSWER[1]}（改）` && (await pencilOf('IN1')).exp === 'false', 4000);
    check(sv >= 0, '按 Enter 保存：气泡里换成新译文，小窗收起');
    // 改过的再纠错：出纠错建议，采用后换上
    await sleep(700);
    pe = await pencilOf('IN1');
    await mouse(pageC, 'mouseMoved', pe.x, pe.y);
    await clickAt(pageC, pe.x, pe.y);
    const re = await waitFor(async () => /已手动修改/.test((await card())?.info || '') && (await pencilOf('IN1')).exp === 'true', 3000);
    if (re < 0) console.log('reopen', JSON.stringify(await pencilOf('IN1')), JSON.stringify(pe));
    check(/已手动修改/.test((await card())?.info || ''), '手动改过的小窗里标「已手动修改」');
    const beforeFix = calls.length;
    await sc.evaluate("[...document.querySelectorAll('.tc-foot button')].find((b) => b.textContent === '纠错').click()");
    const sg = await waitFor(async () => JSON.stringify((await card())?.btns) === JSON.stringify(['不用', '采用']), 8000);
    check(sg >= 0 && calls.length > beforeFix && (await trOf('IN1')) === `${ANSWER[1]}（改）`, '改过的再纠错：出纠错建议（不用、采用），气泡里先不换');
    if (sg < 0) console.log(JSON.stringify(await card()), calls.length - beforeFix, await trOf('IN1'), await sc.evaluate('document.body.innerHTML.slice(0, 1500)'));
    await sc.evaluate("[...document.querySelectorAll('.tc-foot button')].find((b) => b.textContent === '采用').click()");
    const took = await waitFor(async () => (await trOf('IN1')) === ANSWER[1] && (await pencilOf('IN1')).exp === 'false', 4000);
    check(took >= 0, '点「采用」：气泡里换成纠错后的译文，小窗收起');
    // 没改过的纠错：直接换上，标「已纠错」
    await sleep(700);
    await mouse(pageC, 'mouseMoved', pe.x, pe.y);
    await clickAt(pageC, pe.x, pe.y);
    await waitFor(async () => !!(await card()) && (await pencilOf('IN1')).exp === 'true', 3000);
    await sc.evaluate("[...document.querySelectorAll('.tc-foot button')].find((b) => b.textContent === '纠错').click()");
    const fx = await waitFor(async () => /已纠错/.test((await card())?.info || '') && /纠错时间/.test((await card())?.info || ''), 8000);
    check(fx >= 0 && (await trOf('IN1')) === ANSWER[1], '没改过的纠错：直接换上，小窗里标「已纠错」「纠错时间」');
    // 滚轮：收起
    await pageC.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pe.x, y: pe.y, deltaX: 0, deltaY: -100 });
    const wh = await waitFor(async () => (await pencilOf('IN1')).exp === 'false', 3000);
    check(wh >= 0, '在聊天里滚动，小窗收起');
    if (sc) sc.close();

    // 只选中译文：不出「翻译」按钮（选中原文照常出）
    const { SELECTION_CODE } = require('../src/wa-page');
    const selOn = (sel) => pageC.evaluate(`(() => {
      const el = document.querySelector('[data-id$="_IN1"] ${sel}');
      const r = document.createRange(); r.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      const v = ${SELECTION_CODE};
      s.removeAllRanges();
      return v && v.text;
    })()`);
    check((await selOn('[data-wasw-tr]')) === null, '只选中译文时不出「翻译」按钮');
    check((await selOn('span.selectable-text')) === 'Guten Tag, ist Nummer 1 noch lieferbar?', '选中原文照常出「翻译」按钮');

    // 同一条消息里多出一块（WhatsApp 重建了正文块、旧块还挂着）：只留一块
    await pageC.evaluate(`(() => { const m = document.querySelector('[data-id$="_IN1"]'); const x = document.createElement('div'); x.setAttribute('data-wasw-tr', ''); x.textContent = 'old'; m.firstElementChild.appendChild(x); return 1; })()`);
    const one = await waitFor(() => pageC.evaluate(`document.querySelectorAll('[data-id$="_IN1"] [data-wasw-tr]').length === 1`), 6000);
    check(one >= 0 && (await trOf('IN1')) === ANSWER[1], '同一条消息里多出来的旧块被拿掉，只留一块译文');

    // 4. 工作台的翻译页只留回复框；关掉工作台也照样放译文
    const dock = await shellC.evaluate(`(() => {
      const hgt = (q) => { const e = document.querySelector(q); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
      return { items: document.querySelectorAll('.dk-item').length, list: !!document.querySelector('.dk-listbox'), compose: !!document.querySelector('.dk-compose'), host: hgt('.dk-host'), inBox: hgt('.dk-compose .dk-in'), outBox: hgt('.dk-compose .dk-out') };
    })()`);
    check(dock.items === 0 && !dock.list && dock.compose, `翻译页不再列消息（${dock.items} 条），回复框还在`);
    // 只剩两个框：平分整页高度（各占三成以上，两个差不多高）
    check(dock.inBox > dock.host * 0.3 && dock.outBox > dock.host * 0.3 && Math.abs(dock.inBox - dock.outBox) < 24, `翻译页的两个框撑满整页（页 ${dock.host}，上 ${dock.inBox}，下 ${dock.outBox}）`);
    // 认不出消息时两个框上面照样说原因（只改一下画面用的状态，下次读对话会改回来）
    const why = await shellC.evaluate("(() => { const r = dk.st.readable; dk.st.readable = 'unreadable'; dockRender(true); const t = (document.querySelector('.dk-inline > .dk-hint') || {}).textContent || ''; dk.st.readable = r; dockRender(true); return t; })()");
    check(/认不出消息/.test(why), `认不出消息时翻译页说原因（${why}）`);
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
    cloud.close();
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
