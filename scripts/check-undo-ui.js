// 删除不再弹确认框，删完给「撤销」：提示放在刚才操作的地方，不被 WhatsApp 页面盖住（shen 2026-10-28「能撤回的操作直接做，不弹确认」）。
// 真的 shell 页面 + 假的主进程。检查：1) 点话术的“删除”马上删、不出确认框；2) 撤销提示在右侧面板里，点“撤销”带回编号并放回；
// 3) 设置页在内容区底部，账号页（侧栏解散分组）在顶栏，换页时跟着挪。SHOT_DIR 设了就存截图。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-undo-ui.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const acc = { id: 'a1', name: 'Lukas', color: '#3b82f6', proxyLabel: '直连', mode: 'web' };
const base = { accounts: [acc], groups: [], activeId: 'a1', platform: 'linux', collapsed: false, settings: {} };

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: true, width: 1200, height: 760, webPreferences: { preload: path.join(__dirname, 'fixtures', 'undo-fake-preload.js'), contextIsolation: false, sandbox: false } });
  const errs = [];
  w.webContents.on('console-message', (e) => { if (e.level === 'error' || /Error/.test(e.message || '')) errs.push(e.message); });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
  const shot = async (name) => { if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 撤销提示在不在 sel 的范围里
  const inside = (sel) => js((s) => {
    const u = document.querySelector('.undo');
    if (!u) return { error: '没有撤销提示' };
    const a = u.getBoundingClientRect(); const b = document.querySelector(s).getBoundingClientRect();
    return { ok: a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5, a: [a.left, a.top, a.right, a.bottom], b: [b.left, b.top, b.right, b.bottom], text: u.textContent };
  }, sel);

  // 1) 账号页打开话术面板，点第一条的“删除”
  await js((s) => window.__cbs.state({ ...s, page: 'account', panelOpen: true, panelTab: 'replies' }), base);
  await wait(300);
  const del = await js(() => {
    const b = [...document.querySelectorAll('#panel .pn-item .pn-btn')].find((x) => x.textContent === '删除');
    if (!b) return { error: '找不到删除按钮' };
    b.click();
    return {};
  });
  assert(!del.error, del.error);
  await wait(200);
  assert.deepStrictEqual(await js(() => window.__calls), [['replyDelete', 'r1']], '点删除要马上删');
  assert.strictEqual(await js(() => !!document.querySelector('[role=alertdialog]')), false, '不该出确认框');
  let r = await inside('#panel');
  assert(r.ok, `撤销提示应在右侧面板里 ${JSON.stringify(r)}`);
  assert.strictEqual(r.text, '已删除「Price」撤销');
  await shot('panel');
  await js(() => document.querySelector('.undo-btn').click());
  await wait(200);
  assert.deepStrictEqual((await js(() => window.__calls))[1], ['undo', 7], '撤销带回编号');
  assert.strictEqual(await js(() => !!document.querySelector('.undo')), false, '撤销后提示消失');
  assert.strictEqual(await js(() => document.querySelectorAll('#panel .pn-item').length), 2, '放回后又是两条');

  // 2) 设置页：内容区底部
  await js((s) => window.__cbs.state({ ...s, page: 'settings', panelOpen: false }), base);
  await js(() => window.__cbs.undo({ token: 8, kind: 'tr', where: 'body', text: '已删除「智谱」' }));
  await wait(300);
  r = await inside('#body');
  assert(r.ok, `设置页的撤销提示应在内容区 ${JSON.stringify(r)}`);
  await shot('settings');

  // 3) 账号页在侧栏解散分组：放顶栏（WhatsApp 页面盖不到，侧栏太窄放不下名字）
  await js((s) => window.__cbs.state({ ...s, page: 'account', panelOpen: false }), base);
  await js(() => window.__cbs.undo({ token: 9, kind: 'state', where: 'side', text: '已解散「Germany」' }));
  await wait(300);
  r = await inside('#topbar');
  assert(r.ok, `解散分组的撤销提示应在顶栏 ${JSON.stringify(r)}`);
  await shot('top');

  // 4) 收起侧栏也一样；回到设置页时挪到内容区
  await js((s) => window.__cbs.state({ ...s, page: 'account', panelOpen: false, collapsed: true }), base);
  await wait(100);
  r = await inside('#topbar');
  assert(r.ok, `收起侧栏时撤销提示应在顶栏 ${JSON.stringify(r)}`);
  await js((s) => window.__cbs.state({ ...s, page: 'settings', panelOpen: false }), base);
  await wait(100);
  r = await inside('#body');
  assert(r.ok, `换到设置页后撤销提示应挪到内容区 ${JSON.stringify(r)}`);

  assert.deepStrictEqual(errs, [], '页面没有报错');
  console.log('撤销提示自检通过（删除不弹确认；面板、内容区、顶栏位置都对；撤销带回编号）');
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
