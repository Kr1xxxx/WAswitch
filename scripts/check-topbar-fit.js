// 顶栏精简（设计复查第 2 条）：没有锁图标和「web.whatsapp.com」，没有缩放和内存（挪进「⋯」菜单），
// 客户时间不写星期；窗口窄放不下时按优先级整块藏起（备注 → 线路 → 时钟），不出现省略号，右边三个按钮一直在顶栏里。
// 真的 shell 页面 + 假的主进程（和侧栏 + 号自检共用假接口）。SHOT_DIR 设了就存截图。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-topbar-fit.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const acc = { id: 'a1', name: '德国客户号', note: 'Emma 负责，主要做德国 B2B 大客户', color: '#3b82f6', proxyLabel: 'Clash 7891', exitIp: '203.0.113.7', mode: 'web', groupId: '', memMB: 110, zoom: 0.9 };
const base = { accounts: [acc], groups: [], activeId: 'a1', page: 'account', platform: 'linux', collapsed: false, settings: {}, panelOpen: false };
const done = (code, msg) => { fs.writeSync(2, `${msg}\n`); app.exit(code); };

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: true, width: 1400, height: 600, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'fixtures', 'add-menu-fake-preload.js'), contextIsolation: false, sandbox: false } });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => { if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
  // 顶栏现在看得见的块，以及有没有被截断的文字
  const top = () => js(() => {
    const bar = document.querySelector('#topbar');
    const box = bar.getBoundingClientRect();
    const seen = (el) => el && el.getClientRects().length > 0;
    const cut = [...bar.querySelectorAll('*')].filter((el) => seen(el) && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible').map((el) => el.className || el.tagName);
    const acts = bar.querySelector('.top-acts').getBoundingClientRect();
    return {
      text: bar.innerText,
      note: seen(bar.querySelector('.who-note')),
      exit: seen(bar.querySelector('.chip.exit')),
      clock: seen(bar.querySelector('.chip.clock')),
      clockText: bar.querySelector('.chip.clock') ? bar.querySelector('.chip.clock').innerText : '',
      name: seen(bar.querySelector('.who')),
      overflow: bar.scrollWidth > bar.clientWidth,
      actsInside: acts.right <= box.right + 0.5 && acts.width > 60,
      cut,
    };
  });
  const sizeTo = async (width) => { w.setContentSize(width, 600); await wait(400); };

  // 1) 宽窗口：该有的都在，去掉的都不在
  await js((s) => window.__cbs.state(s), base);
  await wait(300);
  let r = await top();
  assert(r.name && r.note && r.exit && r.clock, `宽窗口时账号名、备注、线路、时钟都该在：${JSON.stringify(r)}`);
  assert(!/web\.whatsapp\.com|轻量模式/.test(r.text), `顶栏不该再写网址：${r.text}`);
  assert(!/MB/.test(r.text), `内存挪进「⋯」菜单了：${r.text}`);
  assert(!/%/.test(r.text), `缩放挪进「⋯」菜单了：${r.text}`);
  assert(!/周[一二三四五六日]/.test(r.clockText), `时钟不写星期：${r.clockText}`);
  assert(/伦敦 \d\d:\d\d/.test(r.clockText), `时钟是「城市 时间」：${r.clockText}`);
  await shot('topbar-wide');

  // 2) 一点点变窄：每一档都不截断、不溢出，右边按钮一直在；先藏备注，再藏线路，再藏时钟
  const order = [];
  for (let width = 1400; width >= 420; width -= 40) {
    await sizeTo(width);
    r = await top();
    assert(!r.overflow, `${width} 宽时顶栏溢出了`);
    assert(r.actsInside, `${width} 宽时右边三个按钮被挤出去了`);
    assert(r.name, `${width} 宽时账号名不该藏`);
    assert.deepStrictEqual(r.cut.filter((c) => c !== 'who'), [], `${width} 宽时有文字被截成省略号：${r.cut}`);
    for (const k of ['note', 'exit', 'clock']) if (!r[k] && !order.includes(k)) order.push(k);
  }
  assert.deepStrictEqual(order, ['note', 'exit', 'clock'], `藏起的顺序不对：${order}`);
  await shot('topbar-narrow');

  // 3) 代理连不上的号：线路比时钟晚藏
  await sizeTo(1400);
  await js((s) => window.__cbs.state(s), { ...base, accounts: [{ ...acc, problem: 'P1', problemShort: '代理连不上' }] });
  await wait(300);
  const order2 = [];
  for (let width = 1400; width >= 420; width -= 40) {
    await sizeTo(width);
    r = await top();
    assert(!r.overflow && r.actsInside, `${width} 宽时（代理坏了）顶栏溢出了`);
    for (const k of ['note', 'exit', 'clock']) if (!r[k] && !order2.includes(k)) order2.push(k);
  }
  assert.deepStrictEqual(order2, ['note', 'clock', 'exit'], `代理坏了时藏起的顺序不对：${order2}`);

  // 4) 再变宽：藏起的都回来
  await sizeTo(1400);
  r = await top();
  assert(r.note && r.exit && r.clock, `变宽后都该回来：${JSON.stringify(r)}`);
  done(0, 'check-topbar-fit OK');
}).catch((e) => done(1, `check-topbar-fit FAIL: ${e.stack || e}`));
