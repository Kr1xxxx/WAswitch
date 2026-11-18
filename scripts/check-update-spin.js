// 下载更新时转圈不能一抽一抽的（shen 2026-11-18「这个按钮在下载的时候老抽搐」）。
// 原因：每涨 1% 主进程推一次状态，侧栏和设置页整块重画，新画出来的转圈从 0 度重转。
// 真的 shell 页面 + 假的主进程：每 120ms 推一次下载进度，逐帧量侧栏「检查更新」按钮和关于页转圈的角度，
// 每帧转过的角度要和过去的时间对得上（0.9 秒一圈），不能往回跳。SHOT_DIR 设了就存逐帧截图。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-update-spin.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const accounts = [{ id: 'a1', name: 'Lukas', color: '#3b82f6', proxyLabel: '直连', mode: 'web', groupId: '' }];
const st = (percent, page) => ({
  accounts, groups: [], activeId: 'a1', page, platform: 'linux', collapsed: false, settings: { showUpdateButton: true },
  update: { status: 'downloading', version: '1.0.16', percent, manual: false, userAsked: false, waitReason: '', failures: 0, warn: false, lastCheckAt: 1 },
  about: { version: '1.0.15', platform: 'linux' }, mcp: { status: 'dev', version: '1.0.15' },
});
const done = (code, msg) => { fs.writeSync(2, `${msg}\n`); app.exit(code); };

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: true, width: 900, height: 600, webPreferences: { preload: path.join(__dirname, 'fixtures', 'update-card-fake-preload.js'), contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 侧栏按钮在账号页量，关于页的转圈在设置页量（侧栏换成设置目录，没有按钮）
  for (const [page, sel, label] of [['account', '#side .upd-check.busy span', '侧栏检查更新按钮'], ['settings', '.update-box .spin', '关于页转圈']]) {
    if (page === 'settings') { await js(() => document.querySelector('#side .updcard').click()); await wait(200); }
    await js((s) => window.__cbs.state(s), st(1, page));
    await wait(300);
    // 页面里逐帧记角度；外面每 120ms 推一次新进度
    await js((q) => {
      window.__ang = [];
      const tick = (t) => {
        const el = document.querySelector(q);
        if (el) {
          const m = new DOMMatrix(getComputedStyle(el).transform);
          window.__ang.push([t, (Math.atan2(m.b, m.a) * 180 / Math.PI + 360) % 360]);
        }
        if (window.__ang.length < 600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, sel);
    for (let p = 2; p <= 30; p++) {
      await js((s) => window.__cbs.state(s), st(p, page));
      if (process.env.SHOT_DIR && page === 'account' && p <= 13) {
        const r = await js(() => { const b = document.querySelector('#side .upd-check').getBoundingClientRect(); return { x: Math.round(b.x) - 6, y: Math.round(b.y) - 6, width: 42, height: 42 }; });
        fs.writeFileSync(path.join(process.env.SHOT_DIR, `f${String(p).padStart(2, '0')}.png`), (await w.webContents.capturePage(r)).toPNG());
      }
      await wait(120);
    }
    const ang = await js(() => window.__ang);
    if (ang.length < 20) return done(1, `FAIL ${label}：只量到 ${ang.length} 帧`);
    let jumps = 0;
    for (let i = 1; i < ang.length; i++) {
      const want = ((ang[i][0] - ang[i - 1][0]) / 900) * 360;
      const got = ((ang[i][1] - ang[i - 1][1]) % 360 + 360) % 360;
      const off = Math.abs(((got - want) % 360 + 540) % 360 - 180);
      if (off > 15) jumps++;
    }
    fs.writeSync(2, `${label}：${ang.length} 帧，${jumps} 次跳角度\n`);
    if (jumps) return done(1, `FAIL ${label}：重画时转圈跳了 ${jumps} 次`);
  }
  done(0, 'PASS check-update-spin');
});
