// 更新卡片和关于页的文案（shen 2026-10-29：按钮叫「立即更新」；点完自动完成更新，不二次确认；下载完没点就不自己重启）。
// 真的 shell 页面 + 假的主进程。检查侧栏卡片和关于页在这几种状态下的字：下载中（点过和没点过）、下好后、点过更新后在等手上的事、Mac 手动；
// 都没有「重启」，按钮是「立即更新」，「稍后」只在等手上的事时通知主进程；900×600 下文字不被裁掉。SHOT_DIR 设了就存截图。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-update-card.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const accounts = [
  { id: 'a1', name: 'Lukas', color: '#3b82f6', proxyLabel: '直连', mode: 'web', groupId: '' },
  { id: 'a2', name: 'Emma', color: '#e5484d', proxyLabel: '127.0.0.1:7891', mode: 'web', groupId: '' },
];
const upd = (patch) => ({ status: 'downloaded', version: '0.5.18', percent: 100, manual: false, userAsked: false, waitReason: '', failures: 0, warn: false, lastCheckAt: 1, lastResult: '新版本 0.5.18 已下载', ...patch });
const base = (update, page = 'account') => ({ accounts, groups: [], activeId: 'a1', page, platform: 'linux', collapsed: false, settings: {}, update, about: { version: '0.5.17', platform: 'linux' }, mcp: { status: 'dev', version: '0.5.17' } });
const done = (code, msg) => { fs.writeSync(2, `${msg}\n`); app.exit(code); };

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: true, width: 900, height: 600, webPreferences: { preload: path.join(__dirname, 'fixtures', 'update-card-fake-preload.js'), contextIsolation: false, sandbox: false } });
  w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) fs.writeSync(2, `[console] ${msg}\n`); });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => { if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
  const card = () => js(() => {
    const el = document.querySelector('#side .updcard');
    if (!el) return null;
    const clipped = [...el.querySelectorAll('*')].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflow !== 'visible' && !n.classList.contains('grow'));
    return { text: el.innerText.replace(/\s+/g, ' ').trim(), btns: [...el.querySelectorAll('button')].map((b) => b.innerText.trim()), clipped: clipped.length, wrapped: [...el.querySelectorAll('button')].some((b) => b.getBoundingClientRect().height > 40) };
  });
  const state = async (s) => { await js((x) => window.__cbs.state(x), s); await wait(300); };

  // 下载中
  await state(base(upd({ status: 'downloading', percent: 40 })));
  let c = await card();
  assert(c && /正在下载 0\.5\.18/.test(c.text), `下载中卡片：${c && c.text}`);
  assert.strictEqual(await js(() => document.querySelector('#side .updcard').title), '下载好后会提示你');
  await state(base(upd({ status: 'downloading', percent: 40, userAsked: true })));
  assert.strictEqual(await js(() => document.querySelector('#side .updcard').title), '下载完自动更新');

  // 下好，没点过更新：不写说明行
  await state(base(upd()));
  c = await card();
  assert(c.text.includes('新版本 0.5.18 已就绪') && !/重启|账号和聊天/.test(c.text), `下好后卡片：${c.text}`);
  assert.deepStrictEqual(c.btns, ['稍后', '立即更新']);
  assert(!c.clipped && !c.wrapped, '按钮和文字没被裁掉');
  await shot('card-ready');

  // 在等手上的事
  await state(base(upd({ waitReason: '正在打字' })));
  c = await card();
  assert(c.text.includes('正在打字，结束后自动更新'), `等待中卡片：${c.text}`);
  assert(!c.clipped, '等待说明没被裁掉');
  await shot('card-waiting');

  // Mac 手动
  await state(base(upd({ manual: true, mac: true })));
  c = await card();
  assert(c.btns.join() === '稍后,打开安装包' && c.text.includes('拖进“应用程序”'), `Mac 手动卡片：${c.text}`);

  // 「稍后」只在等手上的事时通知主进程（没点过更新就没有要取消的）
  await state(base(upd()));
  await js(() => document.querySelector('#side .updcard .later').click());
  assert.deepStrictEqual(await js(() => window.__calls), [], '没在等的时候点「稍后」不通知主进程');
  await state(base(upd({ version: '0.5.19', waitReason: '正在打字', userAsked: true }))); // 换个版本号：上一个已经被「稍后」藏起
  await js(() => document.querySelector('#side .updcard .later').click());
  assert.deepStrictEqual(await js(() => window.__calls), [['updateLater']], '等手上的事时点「稍后」要通知主进程');

  // 关于页
  const about = () => js(() => {
    const el = document.querySelector('.update-box');
    return el ? { text: el.innerText.replace(/\s+/g, ' ').trim(), btns: [...el.querySelectorAll('button')].map((b) => b.innerText.trim()) } : null;
  });
  await state(base(upd({ status: 'downloading', percent: 40 })));
  await js(() => document.querySelector('#side .updcard').click()); // 点卡片打开关于页
  await state(base(upd({ status: 'downloading', percent: 40 }), 'settings'));
  let a = await about();
  assert(a && a.btns.join() === '立即更新' && !/重启/.test(a.text), `关于页下载中，没点过：${a && a.text} ${a && a.btns}`);
  await js(() => { window.__calls.length = 0; document.querySelector('.update-box .btn').click(); });
  assert.deepStrictEqual(await js(() => window.__calls), [['updateCheck']], '下载中点「立即更新」：下完直接装');
  await state(base(upd({ status: 'downloading', percent: 40, userAsked: true }), 'settings'));
  a = await about();
  assert(a.text.includes('下载完自动更新') && a.btns.length === 0, `关于页下载中，点过：${a.text} ${a.btns}`);
  await state(base(upd(), 'settings'));
  a = await about();
  assert(a.btns.join() === '立即更新' && !/重启|空闲时/.test(a.text), `关于页下好后：${a.text} ${a.btns}`);
  await state(base(upd({ waitReason: '正在打字' }), 'settings'));
  a = await about();
  assert(a.text.includes('正在打字，结束后自动更新'), `关于页等待中：${a.text}`);
  await shot('about-waiting');
  await state(base(upd({ status: 'downloading', percent: 40, manual: true, mac: true }), 'settings'));
  a = await about();
  assert(a.btns.join() === '下好后打开安装包', `关于页 Mac 手动下载中：${a.btns}`);
  done(0, 'check-update-card: ok');
}).catch((e) => done(1, `check-update-card 失败：${e && e.stack || e}`));
