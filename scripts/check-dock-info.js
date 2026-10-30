// 翻译页点收到消息译文右下角的时间，弹出翻译时间、用时、模型（shen 2026-10-30）。
// 真的 shell 页面 + 假的主进程，窗口 900×600（工作台 380 宽）。检查：
// 1) 哪些时间是按钮（翻好的、记着翻译情况的）、哪些还是普通文字（老记录改过、不用翻、翻译中、出错、没翻、读不到时间）；
// 2) 点时间出框：三行字不被裁、不换行变形，整个框在面板里面，在气泡上方 4px、右边和时间对齐，最上面那条放到下方；
// 3) 重画（推一次状态）、来新消息、滚动：框不关，跟着那条；那条滚出去藏起来，滚回来再出现；只在第一次打开时淡入；
// 4) 再点同一个时间、点别处、Esc（焦点回到时间上）、换对话、那条开始重翻都关；一次只开一个。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-dock-info.js
const path = require('path');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

const setup = () => {
  const base = 'Hallo! Ich habe Ihre Anzeige gesehen. Ist das Modell noch verfügbar und wie lange dauert der Versand nach München?';
  const zh = '你好！我看到了你的广告。这个型号还有货吗？发货到慕尼黑要多久？';
  const day = (d, h, mi) => new Date(2026, 9, d, h, mi).getTime();
  const full = { at: Date.now() - 5 * 60000, ms: 1234, name: '智谱', model: 'glm-4-flash', fix: false };
  const items = Array.from({ length: 16 }, (_, i) => ({ h: `h${i}`, text: `#${i} ${base.slice(0, 30 + (i * 23) % 90)}`, t: `10:${String(i).padStart(2, '0')}`, state: 'done', tr: zh.slice(0, 10 + (i * 17) % 40), via: { ...full, at: Date.now() - (30 - i) * 60000, ms: 800 + i * 100 } }));
  items[1].via = { at: day(28, 20, 45), fix: false }; // 老记录：只有时间
  items[2].via = null; // 老记录手动改过：不显示
  items[2].edited = true;
  items[3].state = 'skip'; items[3].tr = '';
  items[4].state = 'running'; items[4].tr = '';
  items[5].state = 'error'; items[5].tr = ''; items[5].err = '翻译失败';
  items[6].state = 'manual'; items[6].tr = '';
  items[7].t = ''; // 页面上读不到消息时间
  items[8].via = { at: Date.now() - 3600000, ms: 65000, name: 'OpenRouter', model: 'openai/gpt-4o-mini-2024-07-18-with-a-very-long-suffix-name', fix: true };
  items[8].fixed = true;
  items[9].via = { at: day(1, 9, 5), ms: 12000, name: 'DeepL', model: '', fix: false };
  const d = { accountId: 'a1', readable: 'ok', title: 'Lukas Becker', items, paused: '', auto: true, dailyCap: 500, hasProvider: true, needKey: null,
    primaryId: 'z', fallbackId: '', providers: [{ id: 'z', name: '智谱', model: 'glm-4-flash' }], modes: { out: [{ id: 'o', name: '商务' }], in: [{ id: 'i', name: '收到' }] }, inModeId: 'i',
    langs: ['英语', '德语'], target: '德语', targetSrc: 'detected', autoTarget: '德语', canRemember: true };
  window.__dock = d;
  window.__push = () => window.__cbs.dock(JSON.parse(JSON.stringify(d)));
  window.__cbs.state({ accounts: [{ id: 'a1', name: 'Lukas', color: '#3b82f6' }], groups: [], activeId: 'a1', page: 'account', panelOpen: true, panelTab: 'translate', platform: 'linux', collapsed: false });
  window.__push();
};

const probe = () => {
  const box = document.querySelector('.dk-listbox');
  const list = document.querySelector('.dk-list');
  const pops = [...document.querySelectorAll('.dk-info')];
  const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const out = { count: pops.length, openBtns: [...document.querySelectorAll('.dk-time-btn.open')].length, expanded: [...document.querySelectorAll('.dk-time-btn[aria-expanded="true"]')].length, panel: r(document.querySelector('#panel')), box: r(box), list: r(list) };
  if (pops.length) {
    const p = pops[0];
    out.pop = r(p);
    out.hidden = p.hidden;
    out.cls = p.className;
    out.rows = [...p.querySelectorAll('dl > *')].map((e) => ({ tag: e.tagName, text: e.textContent, h: e.getBoundingClientRect().height, clipped: e.scrollWidth > e.clientWidth + 1, ws: getComputedStyle(e).whiteSpace }));
    out.font = getComputedStyle(p).fontSize;
    out.overflow = p.scrollWidth > p.clientWidth + 1 || p.scrollHeight > p.clientHeight + 1;
    const item = document.querySelector(`.dk-item[data-h="${dk.info}"]`);
    if (item) { out.row = r(item); out.btn = r(item.querySelector('.dk-time-btn')); }
  }
  return out;
};

let w;
const ev = (js) => w.webContents.executeJavaScript(js);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = async (n = 3) => { for (let i = 0; i < n; i++) await ev('new Promise((r) => requestAnimationFrame(() => r()))'); };
const P = async () => ev(`(${probe})()`);
// 元素中心的位置；先滚到看得见（鼠标点的是屏幕上的位置）
// 列表只有 199px 高：目标放在靠下的位置，上方放得下框；low=false 不动位置
const rectOf = async (sel, low = true) => {
  if (low) await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const l = document.querySelector('.dk-list'); const b = e.getBoundingClientRect(); const lb = l.getBoundingClientRect(); if (e.closest('.dk-list')) l.scrollTop += b.bottom - (lb.bottom - 12); })()`);
  await frames(2);
  return ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
};
const click = async ({ x, y }) => {
  w.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
  w.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  w.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  await wait(60); await frames(2);
};
const btnSel = (h) => `.dk-item[data-h="${h}"] .dk-time-btn`;
const scrollTo = async (top) => { await ev(`(() => { const l = document.querySelector('.dk-list'); l.scrollTop = ${top}; })()`); await wait(80); await frames(3); };
// 框贴着气泡：在上方 4px，或者（上面放不下时）在下方 4px
const beside = (p, msg) => assert(Math.abs(p.pop.b - (p.row.t - 4)) <= 1.5 || Math.abs(p.pop.t - (p.row.b + 4)) <= 1.5, `${msg}：${JSON.stringify([p.pop, p.row])}`);
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}：${a} 和 ${b} 差了 ${Math.abs(a - b).toFixed(1)}px`);

app.whenReady().then(async () => {
  w = new BrowserWindow({ show: true, width: 900, height: 600, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'fixtures', 'dock-fake-preload.js'), contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const errs = [];
  w.webContents.on('console-message', (e) => { const m = e.message || ''; if (e.level === 'error' || /Error/.test(m)) errs.push(m); });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  await ev(`(${setup})()`);
  await wait(300);
  if (await ev('document.fonts && document.fonts.ready')) await frames(2);
  await frames(3);
  const base = await P();
  near(base.panel.r - base.panel.l, 380, 1, '工作台宽度');

  // 1. 哪些时间是按钮
  const kinds = await ev(`[...document.querySelectorAll('.dk-item[data-h]')].map((r) => [r.dataset.h, r.querySelector('.dk-time').tagName])`);
  const btns = kinds.filter(([, tag]) => tag === 'BUTTON').map(([h]) => h);
  assert.deepStrictEqual(btns, ['h0', 'h1', 'h8', 'h9', 'h10', 'h11', 'h12', 'h13', 'h14', 'h15'], `能点的时间：${btns}`);
  for (const h of ['h2', 'h3', 'h4', 'h5', 'h6', 'h7']) assert.strictEqual(kinds.find(([k]) => k === h)[1], 'SPAN', `${h} 的时间不是按钮`);
  // 时间按钮看上去和普通时间一样：字号、颜色、位置
  const look = await ev(`(() => { const a = getComputedStyle(document.querySelector(${JSON.stringify(btnSel('h0'))})); const b = getComputedStyle(document.querySelector('.dk-item[data-h="h3"] .dk-time')); return [a.fontSize, b.fontSize, a.color, b.color, a.lineHeight, b.lineHeight]; })()`);
  assert.strictEqual(look[0], look[1], '字号一样');
  assert.strictEqual(look[2], look[3], '颜色一样');
  assert.strictEqual(look[4], look[5], '行高一样');
  assert.strictEqual(base.count, 0, '开始时没有框');

  // 2. 点时间出框：h9 在中间（DeepL，没有模型名，12 秒）
  await scrollTo(0);
  await click(await rectOf(btnSel('h9')));
  let p = await P();
  assert.strictEqual(p.count, 1);
  assert.strictEqual(p.expanded, 1);
  assert.strictEqual(p.openBtns, 1);
  assert.deepStrictEqual(p.rows.map((r) => r.text), ['翻译时间', '10月1日 09:05', '用时', '12 秒', '模型', 'DeepL']);
  assert.deepStrictEqual(p.rows.map((r) => r.tag), ['DT', 'DD', 'DT', 'DD', 'DT', 'DD']);
  assert.strictEqual(p.font, '12px');
  assert(!p.overflow, '框里的字没有被裁');
  for (const r of p.rows) { assert(r.h <= 17, `${r.text} 没换行变形（高 ${r.h}）`); assert(!r.clipped, `${r.text} 没被裁`); }
  assert(p.pop.l >= p.panel.l + 8 - 1 && p.pop.r <= p.panel.r - 8 + 1, `框在面板里面 ${JSON.stringify([p.pop, p.panel])}`);
  assert(p.pop.t >= p.box.t - 0.5 && p.pop.b <= p.box.b + 0.5, '框在消息列表里面');
  near(p.pop.b, p.row.t - 4, 1.5, '框在气泡上方 4px');
  near(p.pop.r, p.btn.r, 1.5, '框的右边和时间的右边对齐');
  assert(p.cls.includes('fx-fade'), '第一次打开淡入');
  const topBefore = p.pop.t;

  // 3. 重画：推一次状态（连列表一起换），框还开着、位置不变、不再淡入
  await ev('window.__push()');
  await wait(80); await frames(3);
  p = await P();
  assert.strictEqual(p.count, 1, '重画后框还开着');
  assert.strictEqual(p.expanded, 1);
  near(p.pop.t, topBefore, 1, '重画后位置不变');
  assert(!p.cls.includes('fx-fade'), '重画不再淡入');
  // 来一条新消息：列表在最下面 → 跟到底，框跟着那条气泡走
  await scrollTo(100000);
  await click(await rectOf(btnSel('h14'), false));
  p = await P();
  assert.strictEqual(p.count, 1);
  near(p.pop.b, p.row.t - 4, 1.5, '换一条打开：气泡上方 4px');
  assert.strictEqual(await ev('dk.info'), 'h14');
  const rowBefore = p.row.t;
  await ev(`window.__dock.items.push({ h: 'new1', text: '#N Können Sie mir bitte ein Angebot schicken?', t: '11:00', state: 'done', tr: '能给我发个报价吗？', via: { at: Date.now(), ms: 700, name: '智谱', model: 'glm-4-flash', fix: false } }); window.__push()`);
  await wait(300); await frames(3);
  p = await P();
  assert.strictEqual(p.count, 1, '来新消息，框还开着');
  assert(p.row.t < rowBefore - 5, '新消息把这条气泡顶上去了');
  beside(p, '框跟着气泡走');
  // 一次只开一个：点另一条，上一条的收起
  // 框盖着旁边的气泡：点一个没被盖住、看得见的时间
  const free = await ev(`(() => { const pop = document.querySelector('.dk-info').getBoundingClientRect(); const lr = document.querySelector('.dk-list').getBoundingClientRect();
    const b = [...document.querySelectorAll('.dk-time-btn')].find((x) => { const r = x.getBoundingClientRect(); return x.closest('.dk-item').dataset.h !== dk.info && r.top > lr.top + 4 && r.bottom < lr.bottom - 4 && (r.bottom < pop.top || r.top > pop.bottom); });
    const r = b.getBoundingClientRect(); return { h: b.closest('.dk-item').dataset.h, x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await click(free);
  p = await P();
  assert.strictEqual(p.count, 1, '一次只开一个');
  assert.strictEqual(await ev('dk.info'), free.h);
  assert.strictEqual(p.expanded, 1);
  // 滚动：框跟着；气泡滚出看得见的范围就藏起来，滚回来再出现
  const top13 = p.pop.t;
  const st = await ev(`document.querySelector('.dk-list').scrollTop`);
  await scrollTo(st - 20);
  p = await P();
  beside(p, '滚动时框跟着气泡');
  assert(Math.abs(p.pop.t - top13) > 10, '框动了');
  await scrollTo(0);
  p = await P();
  assert.strictEqual(p.hidden, true, '气泡滚出去，框先藏起来');
  await scrollTo(100000);
  p = await P();
  assert.strictEqual(p.hidden, false, '滚回来框再出现');
  beside(p, '滚回来位置对');

  // 4. 最上面那条：上方放不下，放到气泡下方
  await scrollTo(0);
  await click(await rectOf(btnSel('h0')));
  p = await P();
  assert.strictEqual(p.count, 1);
  assert.strictEqual(await ev('dk.info'), 'h0');
  near(p.pop.t, p.row.b + 4, 1.5, '最上面那条：框放在气泡下方');
  assert(p.pop.t >= p.box.t, '框在列表里面');
  // 老记录只有一行
  await click(await rectOf(btnSel('h1')));
  p = await P();
  assert.deepStrictEqual(p.rows.map((r) => r.text), ['翻译时间', '10月28日 20:45'], '老记录只有一行：翻译时间');
  // 纠错过的：纠错时间、1 分 5 秒、模型名很长时只让值换行，框不超出面板
  await scrollTo(100000);
  await click(await rectOf(btnSel('h8')));
  p = await P();
  assert.deepStrictEqual(p.rows.map((r) => r.text).slice(0, 4), ['纠错时间', p.rows[1].text, '用时', '1 分 5 秒']);
  assert.strictEqual(p.rows[4].text, '模型');
  assert.strictEqual(p.rows[5].text, 'OpenRouter openai/gpt-4o-mini-2024-07-18-with-a-very-long-suffix-name');
  assert(p.rows[5].h > 17, '模型名太长，值换行');
  assert(p.rows.filter((r) => r.tag === 'DT').every((r) => r.h <= 17 && !r.clipped), '标签不换行');
  assert(p.pop.l >= p.panel.l + 8 - 1 && p.pop.r <= p.panel.r - 8 + 1, `长模型名时框也在面板里面 ${JSON.stringify([p.pop, p.panel])}`);
  assert(!p.overflow, '长模型名没被裁');

  // 5. 关：再点同一个时间
  await click(await rectOf(btnSel('h8')));
  p = await P();
  assert.strictEqual(p.count, 0, '再点同一个时间关');
  assert.strictEqual(p.expanded, 0);
  // 点别处关（点列表空白处）
  await click(await rectOf(btnSel('h12')));
  assert.strictEqual((await P()).count, 1);
  const header = await rectOf('.wb-tabs');
  await click({ x: header.x - 40, y: header.y });
  assert.strictEqual((await P()).count, 0, '点别处关');
  // Esc 关，焦点回到那个时间上
  await click(await rectOf(btnSel('h12')));
  assert.strictEqual((await P()).count, 1);
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(60); await frames(2);
  assert.strictEqual((await P()).count, 0, 'Esc 关');
  assert.strictEqual(await ev(`document.activeElement === document.querySelector(${JSON.stringify(btnSel('h12'))})`), true, 'Esc 关掉后焦点回到那个时间上');
  // 改译文时按 Esc 只取消修改，不关框
  await click(await rectOf(btnSel('h12')));
  assert.strictEqual((await P()).count, 1);
  await ev(`(() => { const ta = document.createElement('textarea'); ta.className = 'dk-out'; const box = document.createElement('div'); box.className = 'dk-edit'; box.append(ta); document.body.append(box); ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); box.remove(); })()`);
  await frames(2);
  assert.strictEqual((await P()).count, 1, '改译文时按 Esc 不关框');
  await click({ x: header.x - 40, y: header.y });
  assert.strictEqual((await P()).count, 0);
  // 这条开始重翻（翻译中）：关；翻好了也不自己再开
  await click(await rectOf(btnSel('h12')));
  assert.strictEqual((await P()).count, 1);
  await ev(`window.__dock.items.find((x) => x.h === 'h12').state = 'running'; window.__push()`);
  await wait(80); await frames(3);
  assert.strictEqual((await P()).count, 0, '重翻时关');
  await ev(`window.__dock.items.find((x) => x.h === 'h12').state = 'done'; window.__push()`);
  await wait(80); await frames(3);
  assert.strictEqual((await P()).count, 0, '翻好了不自己再开');
  // 那条被挤出去（不在列表里了）：关
  await click(await rectOf(btnSel('h13')));
  assert.strictEqual((await P()).count, 1);
  await ev(`window.__dock.items = window.__dock.items.filter((x) => x.h !== 'h13'); window.__push()`);
  await wait(80); await frames(3);
  assert.strictEqual((await P()).count, 0, '那条不在了就关');
  // 换对话：关
  await click(await rectOf(btnSel('h14')));
  assert.strictEqual((await P()).count, 1);
  await ev(`window.__dock.title = 'Emma Schmidt'; window.__dock.items = window.__dock.items.map((x) => ({ ...x, h: 'e' + x.h })); window.__push()`);
  await wait(80); await frames(3);
  assert.strictEqual((await P()).count, 0, '换对话关');
  // 离开翻译页关：再回来不自己开
  await click(await rectOf('.dk-item[data-h="eh14"] .dk-time-btn'));
  assert.strictEqual((await P()).count, 1);
  await ev(`window.__cbs.state({ accounts: [{ id: 'a1', name: 'Lukas', color: '#3b82f6' }], groups: [], activeId: 'a1', page: 'account', panelOpen: true, panelTab: 'replies', platform: 'linux', collapsed: false })`);
  await wait(100);
  assert.strictEqual(await ev('dk.info'), null, '离开翻译页关');
  await ev(`window.__cbs.state({ accounts: [{ id: 'a1', name: 'Lukas', color: '#3b82f6' }], groups: [], activeId: 'a1', page: 'account', panelOpen: true, panelTab: 'translate', platform: 'linux', collapsed: false })`);
  await wait(200); await frames(3);
  assert.strictEqual((await P()).count, 0, '回到翻译页不自己开');
  assert.deepStrictEqual(errs, [], '页面没有报错');
  console.log('翻译详情自检通过（时间可点、三行不被裁、跟着气泡走、滚出藏起来、关的各种方式）');
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
