// 翻译页：换模型重翻、展开补翻、纠错时主按钮也进忙碌态，并且能取消（Fable 审计 0.5.12 第 2 条）；
// 取消走翻译页自己的通道（trPageCancel），不碰工作台的 trCancel（第 3 条）。
// 真的 shell 页面 + 假的主进程（fixtures/trpage-fake-preload.js），翻译请求由自检放行。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-trpage-busy.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: true, width: 1200, height: 760, webPreferences: { preload: path.join(__dirname, 'fixtures', 'trpage-fake-preload.js'), contextIsolation: false, sandbox: false } });
  const errs = [];
  w.webContents.on('console-message', (e) => { if (e.level === 'error' || /Error/.test(e.message || '')) errs.push(e.message); });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => { if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
  // 主按钮、两栏纠错按钮的状态
  const st = () => js(() => {
    const b = (s) => { const e = document.querySelector(s); return e ? { st: e.dataset.st, off: e.disabled, hidden: e.hidden || !e.offsetParent } : null; };
    const fx = [...document.querySelectorAll('.tp-fix')];
    return { go: b('.tp-go'), fix1: fx[0] && { st: fx[0].dataset.st, off: fx[0].disabled }, out1: document.querySelectorAll('.tp-out .tp-text')[0].value, out2: document.querySelectorAll('.tp-out .tp-text')[1].value, pending: window.__pending.length, calls: window.__calls.slice() };
  });
  const clearCalls = () => js(() => { window.__calls = []; });
  const release = (t) => js((x) => window.__release(x), t);

  await js(() => {
    localStorage.clear();
    window.__cbs.state({ accounts: [{ id: 'a1', name: 'Lukas', color: '#3b82f6', mode: 'web' }], groups: [], activeId: 'a1', page: 'translate', platform: 'linux', collapsed: false, settings: {} });
  });
  await wait(400);

  // 先正常翻一次（两栏）：中文 → 英语，第一栏智谱、第二栏混元
  await js(() => { const t = document.querySelector('.tp-in .tp-text'); t.value = '这款假发周五前能寄到柏林吗？'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.tp-go').click(); });
  await wait(100);
  let s = await st();
  assert.strictEqual(s.go.st, 'busy', '点翻译后主按钮转圈');
  assert(await release('Can this wig reach Berlin by Friday?'));
  await wait(50);
  assert(await release('Can the wig be delivered to Berlin before Friday?'));
  await wait(200);
  s = await st();
  assert.strictEqual(s.out1, 'Can this wig reach Berlin by Friday?');
  assert.strictEqual(s.out2, 'Can the wig be delivered to Berlin before Friday?');

  // 1) 换第一栏的模型 → 重翻这一栏：主按钮进忙碌态，点它取消；取消走 trPageCancel，不走 trCancel
  await wait(2000); // 等「已翻译」回到「翻译」
  await clearCalls();
  // 第一栏换成第二栏正在用的模型：第二栏自动换成另一个并清空，第一栏用新模型重翻
  await js(() => { const sel = document.querySelectorAll('.tp-model')[0]; sel.value = 'h'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(100);
  s = await st();
  assert.deepStrictEqual(s.calls[0], ['trPage', 'h', false], `换模型后重翻第一栏 ${JSON.stringify(s.calls)}`);
  assert.strictEqual(s.go.st, 'busy', `重翻时主按钮应转圈 ${JSON.stringify(s.go)}`);
  assert.strictEqual(s.go.off, false, '重翻时主按钮能点（点了取消）');
  await shot('rerun-busy');
  await js(() => document.querySelector('.tp-go').click());
  await wait(200);
  s = await st();
  assert(s.calls.some((c) => c[0] === 'trPageCancel'), `点主按钮应取消 ${JSON.stringify(s.calls)}`);
  assert(!s.calls.some((c) => c[0] === 'trCancel'), '不该取消工作台的翻译');
  assert.strictEqual(s.go.st, 'idle', '取消后主按钮回到「翻译」');
  assert.strictEqual(s.pending, 0);
  assert.strictEqual(s.calls.filter((c) => c[0] === 'trPage').length, 1, '取消时不该又发起一次翻译');

  // 2) 重翻成功：主按钮短暂显示「已翻译」
  await js(() => document.querySelector('.tp-go').click());
  await wait(100);
  await release('Can this wig reach Berlin by Friday?'); await wait(50); await release('Can the wig be delivered to Berlin before Friday?');
  await wait(2200);
  await clearCalls();
  await js(() => { const sel = document.querySelectorAll('.tp-model')[0]; sel.value = 'z'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
  await wait(100);
  s = await st();
  assert.strictEqual(s.go.st, 'busy', '重翻时主按钮转圈');
  await release('Can this wig reach Berlin by Friday?');
  await wait(150);
  s = await st();
  assert.strictEqual(s.go.st, 'ok', `重翻完主按钮显示「已翻译」 ${JSON.stringify(s.go)}`);
  assert.strictEqual(s.out1, 'Can this wig reach Berlin by Friday?');
  await wait(2000);
  assert.strictEqual((await st()).go.st, 'idle', '过一会回到「翻译」');

  // 3) 收起对照栏、重新翻（只翻一栏），再展开 → 补翻对照栏：主按钮转圈，可以取消
  await js(() => document.querySelector('.tp-fold').click());
  await wait(400);
  await js(() => document.querySelector('.tp-go').click());
  await wait(100);
  await release('Can this wig reach Berlin by Friday?');
  await wait(2200);
  await clearCalls();
  await js(() => document.querySelector('.tp-open2').click());
  await wait(150);
  s = await st();
  assert.deepStrictEqual(s.calls[0], ['trPage', 'h', false], `展开后补翻对照栏 ${JSON.stringify(s.calls)}`);
  assert.strictEqual(s.go.st, 'busy', '补翻时主按钮应转圈');
  await shot('fill-busy');
  await release('Can the wig be delivered to Berlin before Friday?');
  await wait(150);
  s = await st();
  assert.strictEqual(s.go.st, 'ok', `补翻完主按钮显示「已翻译」 ${JSON.stringify(s.go)}`);
  assert.strictEqual(s.out2, 'Can the wig be delivered to Berlin before Friday?');

  // 4) 纠错：纠错按钮转圈，主按钮不能点（不是它在忙）；再点纠错按钮 = 取消
  await wait(2000);
  await clearCalls();
  await js(() => document.querySelector('.tp-fix').click());
  await wait(100);
  s = await st();
  assert.deepStrictEqual(s.calls[0], ['trPage', 'z', true], `纠错走翻译页通道 ${JSON.stringify(s.calls)}`);
  assert.strictEqual(s.fix1.st, 'busy');
  assert.strictEqual(s.go.off, true, `纠错时主按钮不能点 ${JSON.stringify(s.go)}`);
  await js(() => document.querySelector('.tp-go').click());
  await wait(100);
  s = await st();
  assert.strictEqual(s.calls.filter((c) => c[0] === 'trPage').length, 1, '纠错时点主按钮不该再发翻译');
  await shot('fix-busy');
  await js(() => document.querySelector('.tp-fix').click());
  await wait(150);
  s = await st();
  assert(s.calls.some((c) => c[0] === 'trPageCancel'), `再点纠错应取消 ${JSON.stringify(s.calls)}`);
  assert.strictEqual(s.fix1.st, 'idle', '取消后纠错回到原样');
  assert.strictEqual(s.go.off, false, '取消后主按钮能点');
  assert.strictEqual(s.out1, 'Can this wig reach Berlin by Friday?', '取消纠错不动原来的译文');

  // 5) 普通翻译中点主按钮取消也走翻译页通道，第二栏不再翻
  await clearCalls();
  await js(() => document.querySelector('.tp-go').click());
  await wait(100);
  await js(() => document.querySelector('.tp-go').click());
  await wait(200);
  s = await st();
  assert.deepStrictEqual(s.calls.map((c) => c[0]), ['trPage', 'trPageCancel'], `翻译中取消 ${JSON.stringify(s.calls)}`);
  assert.strictEqual(s.go.st, 'idle');

  assert.deepStrictEqual(errs, [], '页面没有报错');
  fs.writeSync(2, '翻译页忙碌 / 取消自检通过\n');
  app.exit(0);
}).catch((e) => { fs.writeSync(2, `${e.stack || e}\n`); app.exit(1); });
