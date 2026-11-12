// 自检：页面外壳加载完、WhatsApp 的脚本没下完时，页面一直空白（深色外观下一整块黑）的自动恢复。
// 做法：本地起一个假的 web.whatsapp.com（HTTP/2 + 自签证书 + host-resolver-rules；HTTP/1.1 的在途请求不会被
// closeAllConnections 打断，所以一定要 HTTP/2）。页面和真 WhatsApp 一样：外壳只有空的 #app 和深浅两用的 color-scheme，
// 加载完后再去下主脚本，脚本画出对话列表。
//   1. 主脚本在下的时候网络变了（开发版收到 SIGUSR2 就走 onNetworkChange，断开所有连接）：脚本被掐断，
//      软件马上重新加载这个号，不等兜底
//   2. 主脚本连着失败（服务器把请求重置掉），页面空着：兜底在空白一段时间后重新加载，先悄悄重来
//   3. 连着失败好几次：显示「WhatsApp 页面打不开」，之后脚本恢复，页面画出来时提示自己收起
//   4. 慢但正常：主脚本下得很慢（一直有字节在到）、或者先只画一个进度条：都不重新加载
// 兜底的等待时间在开发版里用 WASWITCH_TEST_BLANK_MS 缩短到 3 秒（正式版 20 秒）。
// 运行：node scripts/check-blank-view.js（Linux 无界面环境用 xvfb-run）
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
const BLANK_MS = 3000;

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

// 和真 WhatsApp 一样：外壳里没有任何能看见的东西，主脚本在 load 之后才插进来
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>WhatsApp</title></head>
<body><div id="app"></div><script>addEventListener('load', () => { const s = document.createElement('script'); s.src = '/app.js?t=' + Date.now(); document.body.appendChild(s); });</script></body></html>`;
const CHATS = 'document.getElementById("app").innerHTML = \'<div id="side"><div id="pane-side">Emma Schneider</div></div>\';';
const PROGRESS = 'document.getElementById("app").innerHTML = \'<progress style="width:300px;height:8px"></progress>\';';

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-blank-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=web.whatsapp.com',
    '-keyout', path.join(home, 'key.pem'), '-out', path.join(home, 'cert.pem')], { stdio: 'ignore' });

  // 主脚本怎么回：'fast' 马上回；'hold' 一直不回（等着被网络切换掐断）；'reset' 重置请求；'drip' 慢慢回；'progress' 先只画进度条
  const st = { shells: 0, scripts: 0, mode: 'fast', resets: 0, scriptAt: 0 };
  const server = http2.createSecureServer({ key: fs.readFileSync(path.join(home, 'key.pem')), cert: fs.readFileSync(path.join(home, 'cert.pem')) }, (req, res) => {
    req.stream.on('error', () => {});
    res.on('error', () => {});
    const url = req.url.split('?')[0];
    if (url === '/') {
      st.shells += 1;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(SHELL);
    }
    if (url === '/app.js') {
      st.scripts += 1;
      st.scriptAt = Date.now();
      const js = { 'content-type': 'text/javascript', 'cache-control': 'no-store' };
      if (st.mode === 'reset' && st.resets > 0) { st.resets -= 1; return req.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); }
      if (st.mode === 'hold') { st.mode = 'fast'; res.writeHead(200, js); return; } // 只回头，不回内容
      if (st.mode === 'drip') {
        res.writeHead(200, js);
        let i = 0;
        const timer = setInterval(() => {
          if (res.destroyed || res.closed) { clearInterval(timer); return; }
          if (++i < 16) { res.write(`/* ${'x'.repeat(64)} */\n`); return; }
          clearInterval(timer);
          res.end(CHATS);
        }, BLANK_MS / 4); // 一共约 4 倍等待时间
        return;
      }
      res.writeHead(200, js);
      if (st.mode === 'progress') return res.end(`${PROGRESS} setTimeout(() => { ${CHATS} }, ${BLANK_MS * 3});`);
      return res.end(CHATS);
    }
    res.writeHead(404); res.end();
  });
  server.on('sessionError', () => {});
  const waPort = await freePort();
  await new Promise((r) => server.listen(waPort, '127.0.0.1', r));

  fs.mkdirSync(path.join(home, 'waswitch'), { recursive: true });
  fs.writeFileSync(path.join(home, 'waswitch', 'accounts.json'), JSON.stringify([{
    id: '1', name: '测试号', color: '#16A34A', proxy: '', mode: 'web', primary: true,
    fingerprint: { version: 2, os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', region: 'DE', seed: 1 },
  }]));
  const port = await freePort();
  const env = { ...process.env, XDG_CONFIG_HOME: home, HOME: home, ...teamOff(path.join(home, 'waswitch')), WASWITCH_TEST_BLANK_MS: String(BLANK_MS), WASWITCH_TEST_NET_SIGNAL: '1' };
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  st.mode = 'hold';
  const child = spawn(electron, ['--no-sandbox', `--remote-debugging-port=${port}`, '--ignore-certificate-errors',
    `--host-resolver-rules=MAP web.whatsapp.com:443 127.0.0.1:${waPort}`, root], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  let failures = 0;
  const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(100); } return -1; };
  try {
    const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    let targets = [];
    await waitFor(async () => {
      try { targets = await list(); } catch { targets = []; }
      return targets.some((t) => t.url.includes('index.html')) && targets.some((t) => t.url.includes('web.whatsapp.com'));
    }, 30000);
    const shellT = targets.find((t) => t.url.includes('index.html'));
    const pageT = targets.find((t) => t.url.includes('web.whatsapp.com'));
    check(!!shellT && !!pageT, '启动后打开了侧栏和账号页面');
    if (!shellT || !pageT) throw new Error('页面没打开');
    const shellC = await cdp(shellT.webSocketDebuggerUrl);
    const pageC = await cdp(pageT.webSocketDebuggerUrl);
    const shown = async () => { try { return !!(await pageC.evaluate("!!document.querySelector('#pane-side')")); } catch { return false; } };
    const problemShown = async () => { try { return !!(await shellC.evaluate("document.body.innerText.includes('WhatsApp 页面打不开')")); } catch { return false; } };
    const reload = async () => { await pageC.evaluate('location.reload(), 0').catch(() => {}); };

    // 1. 开机：外壳到了、主脚本在下，网络变了
    await waitFor(() => st.scripts >= 1, 15000);
    check(st.scripts === 1 && !(await shown()), '主脚本在下的时候页面还是空的');
    await sleep(500);
    const shells1 = st.shells;
    const t1 = Date.now();
    process.kill(child.pid, 'SIGUSR2');
    const ms1 = await waitFor(shown, 15000);
    check(ms1 >= 0, `网络切换掐断主脚本后页面自动恢复（${ms1} 毫秒）`);
    check(st.shells === shells1 + 1, `只重新加载了一次（外壳加载 ${st.shells - shells1} 次）`);
    check(ms1 >= 0 && ms1 < BLANK_MS, '是网络切换时马上重新加载的，没等空白兜底');
    void t1;

    // 2. 主脚本失败一次：空白兜底悄悄重来
    st.mode = 'reset'; st.resets = 1;
    const shells2 = st.shells;
    await reload();
    const ms2 = await waitFor(async () => st.shells > shells2 + 1 && await shown(), BLANK_MS * 5);
    check(ms2 >= BLANK_MS, `主脚本失败后空白约 ${BLANK_MS} 毫秒自动重新加载，页面画出来了（${ms2} 毫秒）`);
    check(!(await problemShown()), '只失败一次时不显示「页面打不开」');
    await sleep(BLANK_MS); // 让软件看到页面画出来了，再开始下一段

    // 3. 连着失败：第三次显示「WhatsApp 页面打不开」，恢复后收起
    st.resets = 3;
    const shells3 = st.shells;
    await reload();
    const ms3 = await waitFor(problemShown, BLANK_MS * 8);
    check(ms3 >= 0, `连着空白三次后显示「WhatsApp 页面打不开」（${ms3} 毫秒）`);
    check(st.shells - shells3 === 3, `显示提示前悄悄重来了两次（外壳加载 ${st.shells - shells3} 次）`);
    const ms3b = await waitFor(async () => !(await problemShown()) && st.resets === 0, 30000);
    check(ms3b >= 0, `主脚本恢复后提示自己收起（${ms3b} 毫秒）`);
    check(await waitFor(shown, 5000) >= 0, '收起后对话列表显示出来');
    await sleep(BLANK_MS);

    // 4. 慢但正常：不重新加载
    st.mode = 'drip';
    const shells4 = st.shells;
    await reload();
    const ms4 = await waitFor(shown, BLANK_MS * 8);
    check(ms4 > BLANK_MS * 2, `主脚本下得很慢时等它下完（${ms4} 毫秒）`);
    check(st.shells === shells4 + 1, `下得慢时没有重新加载（外壳加载 ${st.shells - shells4} 次）`);

    st.mode = 'progress';
    const shells5 = st.shells;
    await reload();
    const ms5 = await waitFor(shown, BLANK_MS * 8);
    check(ms5 > BLANK_MS * 2, `只画了进度条时等它往下走（${ms5} 毫秒）`);
    check(st.shells === shells5 + 1, `画了进度条时没有重新加载（外壳加载 ${st.shells - shells5} 次）`);
    shellC.close(); pageC.close();
  } catch (e) {
    console.error(e);
    failures += 1;
  } finally {
    child.kill();
    server.close();
    await sleep(500);
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (failures) console.log(log.split('\n').filter((l) => /空白|网络|加载/.test(l)).slice(-20).join('\n'));
  console.log(failures ? `有 ${failures} 项没通过` : 'check-blank-view 全部通过');
  process.exit(failures ? 1 : 0);
})();
