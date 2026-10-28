// 侧栏不再有「添加账号」行，改成「账号」旁的 + 号，点开选添加账号或添加分组（shen 2026-10-28）。
// 真的 shell 页面 + 假的主进程。检查：1) 侧栏里没有「添加账号」行，展开和收起侧栏都有 + 号；
// 2) 点 + 号把按钮下方的坐标交给主进程弹菜单，菜单是「添加账号」「添加分组」，选了分别打开编辑页、新建分组；
// 另外：没放进分组的号上面没有「未分组」组头，拖到「账号」那一行就移出分组（shen 2026-10-28）。
// 7) 分组改名框：输入法选字时的回车不提交（第 7 步）。
// 3) 有分组时添加账号页有「分组」，默认是正在看的那个号所在的组，保存时带上；另外编辑页开多次，morphState 不留旧的测试按钮状态（正文第 6 步）。SHOT_DIR 设了就存截图（菜单用 import 截整屏）。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-add-menu.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { execFileSync } = require('child_process');
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { addMenuTemplate } = require('../src/add-menu');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const accounts = [
  { id: 'a1', name: 'Lukas', color: '#3b82f6', proxyLabel: '直连', mode: 'web', groupId: '' },
  { id: 'a2', name: 'Emma', color: '#e5484d', proxyLabel: '127.0.0.1:7891', mode: 'web', groupId: 'g1' },
];
const groups = [{ id: 'g1', name: '分组 1', count: 1, unread: 0, collapsed: false, muted: false }];
const base = { accounts, groups, activeId: 'a2', page: 'account', platform: 'linux', collapsed: false, settings: {} };
const editor = {
  id: null, isNew: true, name: '账号 3', note: '', phone: '', color: '#30a46c', proxy: '', hasPassword: false, region: 'auto',
  regions: [{ key: 'auto', label: '跟随本机' }], regionLabel: '', uiLanguage: '中文', mode: 'web', allowCalls: false, primary: false, primaryName: 'Lukas',
  otherDirect: [], otherLiteDirect: [], liteAvailable: true, platform: 'linux', groups: [{ id: 'g1', name: '分组 1' }], groupId: 'g1',
};
const done = (code, msg) => { fs.writeSync(2, `${msg}\n`); app.exit(code); };

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: true, width: 1000, height: 640, webPreferences: { preload: path.join(__dirname, 'fixtures', 'add-menu-fake-preload.js'), contextIsolation: false, sandbox: false } });
  const picked = [];
  let menuItems = null;
  let menuOpen = null;
  ipcMain.on('add:menu', (_e, { x, y }) => {
    const tpl = addMenuTemplate({ canGroup: true, addAccount: () => picked.push('account'), addGroup: () => picked.push('group') });
    menuItems = tpl;
    const m = Menu.buildFromTemplate(tpl);
    menuOpen = new Promise((r) => m.once('menu-will-show', r));
    m.popup({ window: w, x, y });
  });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => { if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
  const side = () => js(() => {
    const el = document.querySelector('#side');
    const b = el.querySelector('.add-btn');
    const r = b && b.getBoundingClientRect();
    return { text: el.innerText, btn: r ? [r.left, r.top, r.right, r.bottom] : null, label: b && b.getAttribute('aria-label') };
  });

  // 1) 展开的侧栏
  await js((s) => window.__cbs.state(s), base);
  await wait(300);
  let r = await side();
  assert(!/添加账号/.test(r.text), `侧栏里不该再有「添加账号」行：${r.text}`);
  assert(!/\+ 分组/.test(r.text), '旧的「+ 分组」不该再有');
  assert(r.btn, '「账号」旁要有 + 号');
  assert.strictEqual(r.label, '添加');
  assert(!/未分组/.test(r.text), `侧栏不该写「未分组」：${r.text}`);
  const heads = await js(() => [...document.querySelectorAll('#side .group-head')].map((e) => e.innerText.trim()));
  assert.deepStrictEqual(heads, ['分组 1'], '只有真分组才有组头');
  const order = await js(() => [...document.querySelectorAll('#side .list .row .name-text')].map((e) => e.textContent));
  assert.deepStrictEqual(order, ['Lukas', 'Emma'], '没放进分组的号排在最前面');
  await shot('side');
  // 把组里的号拖到「账号」那一行：移出分组，放到最前面那段的最后
  await js(() => {
    dragId = 'a2';
    const el = document.querySelector('#side .side-label');
    const dt = new DataTransfer();
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  const moved = (await js(() => window.__calls)).find((c) => c[0] === 'moveAccount');
  assert.deepStrictEqual(moved, ['moveAccount', 'a2', '', ''], '拖到「账号」行要移出分组');
  await js(() => { window.__calls = []; });

  // 2) 点 + 号：坐标是按钮左下方，菜单是添加账号、添加分组
  await js(() => document.querySelector('#side .add-btn').click());
  await wait(100);
  const calls = await js(() => window.__calls);
  assert.strictEqual(calls[0][0], 'addMenu');
  assert.strictEqual(calls[0][1], Math.round(r.btn[0]));
  assert.strictEqual(calls[0][2], Math.round(r.btn[3] + 4));
  assert(menuOpen, '主进程没收到弹菜单');
  await Promise.race([menuOpen, wait(2000)]);
  assert.deepStrictEqual(menuItems.map((i) => i.label), ['添加账号', '添加分组']);
  await wait(400);
  if (process.env.SHOT_DIR) { try { execFileSync('import', ['-window', 'root', path.join(process.env.SHOT_DIR, 'menu.png')]); } catch (e) { fs.writeSync(2, `截不了菜单：${e.message}\n`); } }
  menuItems[0].click();
  menuItems[1].click();
  assert.deepStrictEqual(picked, ['account', 'group']);
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await wait(200);

  // 3) 收起的侧栏也有 + 号
  await js((s) => window.__cbs.state({ ...s, collapsed: true }), base);
  await wait(300);
  r = await side();
  assert(r.btn, '收起侧栏后也要有 + 号');
  assert(!/添加账号/.test(r.text));
  await shot('side-collapsed');

  // 4) 添加账号页：有分组时可以选，默认是正在看的号所在的组；保存时带上
  await js((e) => { window.__editor = e; }, editor);
  await js((s) => window.__cbs.state({ ...s, page: 'editor', editorId: null, editorNonce: 1 }), base);
  await wait(500);
  const ed = await js(() => {
    const sel = document.querySelector('#body select[aria-label="分组"]');
    const on = document.querySelector('#side .add-btn.on');
    return { value: sel && sel.value, options: sel ? [...sel.options].map((o) => o.textContent) : null, on: !!on };
  });
  assert.deepStrictEqual(ed.options, ['未分组', '分组 1']);
  assert.strictEqual(ed.value, 'g1', '默认放进正在看的号所在的组');
  assert(ed.on, '添加账号页打开时 + 号高亮');
  await shot('editor');
  await js(() => { const sel = document.querySelector('#body select[aria-label="分组"]'); sel.value = ''; sel.dispatchEvent(new Event('change')); [...document.querySelectorAll('#body button')].find((b) => b.textContent.startsWith('保存')).click(); });
  await wait(300);
  const save = (await js(() => window.__calls)).find((c) => c[0] === 'editorSave');
  assert(save, '没调保存');
  assert.strictEqual(save[1].groupId, '', '保存时带上选的分组');

  // 5) 没有分组时编辑页不出现「分组」，保存时不传
  await js((e) => { window.__editor = { ...e, groups: [], groupId: '' }; window.__calls = []; }, editor);
  await js((s) => window.__cbs.state({ ...s, groups: [], page: 'editor', editorId: null, editorNonce: 2 }), base);
  await wait(500);
  assert.strictEqual(await js(() => !!document.querySelector('#body select[aria-label="分组"]')), false, '没有分组时不显示');

  // 6) 编辑页开很多次、每次点「测试」：morphState 里只留最后一次的测试按钮状态，不越攒越多
  for (let n = 3; n <= 8; n += 1) {
    await js((s, nonce) => window.__cbs.state({ ...s, groups: [], page: 'editor', editorId: null, editorNonce: nonce }), base, n);
    await wait(200);
    await js(() => [...document.querySelectorAll('#body button')].find((b) => b.textContent.includes('测试')).click());
    await wait(100);
  }
  const keys = await js(() => Object.keys(morphState).filter((k) => k.startsWith('editorTest:')));
  assert.deepStrictEqual(keys, ['editorTest:new:8'], `旧的编辑页测试状态没清掉：${keys}`);
  // 7) 分组改名：输入法还在选字时按回车（isComposing 或 keyCode 229）是上屏，不能提交；选完再按回车才改名
  await js(() => { window.__calls = []; });
  await js((s) => window.__cbs.state({ ...s, page: 'account', editGroupId: 'g1' }), base);
  await wait(300);
  const renames = () => js(() => window.__calls.filter((c) => c[0] === 'groupRename'));
  await js(() => {
    const el = document.querySelector('#side input.group-name');
    el.value = '欧洲';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    const win = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(win, 'keyCode', { get: () => 229 }); // Windows 输入法选字时回车的 keyCode
    el.dispatchEvent(win);
  });
  assert.deepStrictEqual(await renames(), [], '输入法选字时的回车不该提交改名');
  assert.strictEqual(await js(() => document.activeElement && document.activeElement.className), 'group-name', '选字时回车后还在改名框里');
  await js(() => {
    const el = document.querySelector('#side input.group-name');
    el.value += '客户';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  assert.deepStrictEqual(await renames(), [['groupRename', 'g1', '欧洲客户']], '选完字再按回车才改名');
  done(0, 'check-add-menu: ok');
}).catch((e) => done(1, `check-add-menu FAILED: ${e.stack || e.message}`));
