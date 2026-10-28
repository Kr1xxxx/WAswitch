// 翻译服务商太忙（429）、等着重试时：转圈的按钮显示还要等几秒，倒数到 0 回到「翻译中」；
// 翻译页和工作台各管各的（lane），翻完、取消后不留倒计时。
// 真的 shell 页面 + 假的主进程（fixtures/tr-wait-fake-preload.js）。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-tr-wait.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: true, width: 1200, height: 760, webPreferences: { preload: path.join(__dirname, 'fixtures', 'tr-wait-fake-preload.js'), contextIsolation: false, sandbox: false } });
  const errs = [];
  w.webContents.on('console-message', (e) => { if (e.level === 'error' || /Error/.test(e.message || '')) errs.push(e.message); });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => { if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
  const goText = () => js(() => { const b = document.querySelector('.tp-go'); const vis = [...b.children].find((c) => getComputedStyle(c).visibility === 'visible'); return { st: b.dataset.st, text: vis ? vis.textContent : '' }; });

  assert.strictEqual(await js(() => window.__cbs.trWait.length), 2, '工作台和翻译页都在听等待时间');

  // 翻译页
  await js(() => {
    localStorage.clear();
    window.__cbs.state({ accounts: [{ id: 'a1', name: 'Lukas', color: '#3b82f6', mode: 'web' }], groups: [], activeId: 'a1', page: 'translate', platform: 'linux', collapsed: false, settings: {} });
  });
  await wait(400);
  await js(() => { const t = document.querySelector('.tp-in .tp-text'); t.value = 'Can this wig reach Berlin by Friday?'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.tp-go').click(); });
  await wait(100);
  let g = await goText();
  assert.deepStrictEqual(g, { st: 'busy', text: '翻译中' });
  // 工作台的等待不影响翻译页
  await js(() => window.__wait({ lane: 'dock', ms: 3000 }));
  await wait(50);
  assert.strictEqual((await goText()).text, '翻译中', '工作台的倒计时不该出现在翻译页');
  await js(() => window.__wait({ lane: 'page', ms: 2900 }));
  await wait(50);
  g = await goText();
  assert.deepStrictEqual(g, { st: 'busy', text: '3 秒后重试' }, JSON.stringify(g));
  await shot('page-wait');
  await wait(1000);
  assert.strictEqual((await goText()).text, '2 秒后重试', '每秒倒数');
  await js(() => window.__wait({ lane: 'page', ms: 0 }));
  await wait(50);
  assert.strictEqual((await goText()).text, '翻译中', '等完回到翻译中');
  // 又要等；倒数到 0 自己回到翻译中（主进程的 0 还没到也一样）
  await js(() => window.__wait({ lane: 'page', ms: 400 }));
  await wait(50);
  assert.strictEqual((await goText()).text, '1 秒后重试');
  await wait(600);
  assert.strictEqual((await goText()).text, '翻译中', '倒数到 0 回到翻译中');
  // 等着的时候翻完了：不留倒计时
  await js(() => window.__wait({ lane: 'page', ms: 5000 }));
  await wait(50);
  assert(await js(() => window.__release('这顶假发周五前能到柏林吗？')));
  await wait(50);
  assert(await js(() => window.__release('这顶假发周五之前可以寄到柏林吗？'))); // 对照栏
  await wait(100);
  g = await goText();
  assert(g.st !== 'busy' && !/秒/.test(g.text), JSON.stringify(g));
  await wait(2000); // 等「已翻译」回到「翻译」
  // 纠错按钮倒计时不折行（Fable 审计 #246 必修）：中文翻成英语才有纠错
  await js(() => { const t = document.querySelector('.tp-in .tp-text'); t.value = '这顶假发周五前能到柏林吗？'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.tp-go').click(); });
  await wait(100);
  assert(await js(() => window.__release('Can this wig reach Berlin by Friday?')));
  await wait(50);
  assert(await js(() => window.__release('Will this wig arrive in Berlin before Friday?')));
  await wait(2200);
  await js(() => document.querySelector('.tp-fix').click());
  await wait(100);
  await js(() => window.__wait({ lane: 'page', ms: 2900 }));
  await wait(50);
  const fx = await js(() => { const b = document.querySelector('.tp-fix'); const sp = b.querySelector('.mb-busy'); return { st: b.dataset.st, text: sp.textContent, h: sp.getBoundingClientRect().height, bh: b.clientHeight, sw: b.scrollWidth, cw: b.clientWidth }; });
  assert.strictEqual(fx.st, 'busy', JSON.stringify(fx));
  assert.strictEqual(fx.text, '3 秒后重试', JSON.stringify(fx));
  assert(fx.cw > 0 && fx.h > 0 && fx.h < 24 && fx.sw <= fx.cw, `纠错按钮倒计时折行或溢出 ${JSON.stringify(fx)}`);
  await shot('fix-wait');
  await js(() => document.querySelector('.tp-fix').click()); // 取消
  await wait(150);
  // 下一次转圈还是「翻译中」
  await js(() => document.querySelector('.tp-go').click());
  await wait(100);
  assert.deepStrictEqual(await goText(), { st: 'busy', text: '翻译中' }, '上一次的倒计时不该留下');
  await js(() => document.querySelector('.tp-go').click()); // 取消
  await wait(150);

  // 工作台
  await js(() => {
    window.__calls = [];
    const d = { accountId: 'a1', readable: 'ok', title: 'Lukas Becker', items: [], paused: '', auto: true, dailyCap: 500, hasProvider: true, needKey: null,
      primaryId: 'z', fallbackId: 'h', providers: [{ id: 'z', name: '智谱', model: 'glm-4-flash' }, { id: 'h', name: '腾讯混元', model: 'hy-mt2-plus' }],
      modes: { out: [{ id: 'o', name: '商务', direction: 'out' }], in: [{ id: 'i', name: '收到' }] }, inModeId: 'i', outModeId: 'o',
      langs: ['英语', '德语'], target: '德语', targetSrc: 'detected', autoTarget: '德语', canRemember: true };
    window.__dock = d;
    window.__cbs.state({ accounts: [{ id: 'a1', name: 'Lukas', color: '#3b82f6' }], groups: [], activeId: 'a1', page: 'account', panelOpen: true, panelTab: 'translate', platform: 'linux', collapsed: false });
    window.__cbs.dock(JSON.parse(JSON.stringify(d)));
  });
  await wait(300);
  const dockBtn = () => js(() => { const b = document.querySelector('.dk-cancel'); return b ? b.textContent : null; });
  await js(() => { const t = document.querySelector('.dk-compose textarea'); t.value = '周五前能寄到柏林'; t.dispatchEvent(new Event('input', { bubbles: true })); });
  await wait(50);
  await js(() => { const b = [...document.querySelectorAll('.dk-outhead .dk-btn')].find((x) => x.textContent === '翻译'); b.click(); });
  await wait(100);
  assert.strictEqual(await js(() => window.__calls[0] && window.__calls[0][0]), 'trRun', JSON.stringify(await js(() => window.__calls)));
  assert.strictEqual(await dockBtn(), '翻译中… 取消');
  await js(() => window.__wait({ lane: 'page', ms: 3000 }));
  await wait(50);
  assert.strictEqual(await dockBtn(), '翻译中… 取消', '翻译页的倒计时不该出现在工作台');
  await js(() => window.__wait({ lane: 'dock', ms: 2900 }));
  await wait(50);
  assert.strictEqual(await dockBtn(), '3 秒后重试… 取消');
  await shot('dock-wait');
  await wait(1000);
  assert.strictEqual(await dockBtn(), '2 秒后重试… 取消');
  // 倒计时时点「取消」：走工作台自己的取消，按钮消失
  await js(() => document.querySelector('.dk-cancel').click());
  await wait(150);
  assert.strictEqual(await dockBtn(), null, '取消后不再转圈');
  assert(await js(() => window.__calls.some((c) => c[0] === 'trCancel')));
  // 再翻一次：不带上次的倒计时
  await js(() => { const b = [...document.querySelectorAll('.dk-outhead .dk-btn')].find((x) => x.textContent === '翻译'); b.click(); });
  await wait(100);
  assert.strictEqual(await dockBtn(), '翻译中… 取消', '上一次的倒计时不该留下');
  await js(() => window.__release('Kann das bis Freitag in Berlin sein?'));
  await wait(100);

  assert.deepStrictEqual(errs, [], '页面没有报错');
  fs.writeSync(2, '翻译限流倒计时自检通过\n');
  app.exit(0);
}).catch((e) => { fs.writeSync(2, `${e.stack || e}\n`); app.exit(1); });
