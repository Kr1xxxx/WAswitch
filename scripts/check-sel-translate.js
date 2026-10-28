// 自检：聊天里选中文字后的「翻译」小按钮（src/sel-translate.js、wa-page.js 的 readSelection）。
// 1. 读选区只在隔离环境里只读：不改页面、不改选区；只认右侧聊天区消息上的选区（输入框、对话列表不算）
// 2. 按钮放在选区下面、右边对齐，译文窗左边对齐；下面放不下就放上面；不出账号页面
// 运行：npx electron scripts/check-sel-translate.js（Linux 无界面环境用 xvfb-run）
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const waPage = require('../src/wa-page');
const { placeButton, placeBox, quietKey, BTN, CARD_W, PAD } = require('../src/sel-translate');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };

// ---- 按钮位置（纯计算） ----
{
  const view = { x: 300, y: 60, width: 800, height: 600 };
  const sel = { x: 100, y: 200, w: 120, h: 20, top: 200 };
  const b = placeButton(sel, view, 1);
  check(b.width === BTN.width && b.height === BTN.height, '按钮大小固定');
  // 看得见的按钮（去掉四周 6px 阴影边）右边 = 选区末尾，上边 = 选区下面 4px
  check(b.x + b.width - 6 === 300 + 220 && b.y + 6 === 60 + 220 + 4, `放在选区下面、右边对齐（${b.x},${b.y}）`);
  const z = placeButton(sel, view, 0.9);
  check(z.x + z.width - 6 === Math.round(300 + 220 * 0.9) && z.y + 6 === Math.round(60 + 220 * 0.9 + 4), `页面缩放 90% 时位置跟着缩放（${z.x},${z.y}）`);
  const low = placeButton({ x: 100, y: 580, w: 120, h: 20, top: 560 }, view, 1);
  check(low.y + low.height - 6 === 60 + 560 - 4, `选区在最下面：按钮放到选区上面（${low.y}）`);
  const left = placeButton({ x: 0, y: 200, w: 10, h: 20, top: 200 }, view, 1);
  check(left.x >= view.x, '选区在最左边：按钮不出账号页面');
  check(quietKey({ modifiers: ['control'], keyCode: 'C' }) && quietKey({ modifiers: ['meta'], keyCode: 'C' }) && quietKey({ keyCode: 'Shift' }), 'Ctrl/Cmd 组合键和单按修饰键不收起按钮（能 Ctrl+C）');
  check(!quietKey({ modifiers: [], keyCode: 'A' }) && !quietKey({ keyCode: 'Escape' }), '其它按键收起按钮');
  const right = placeButton({ x: 790, y: 200, w: 200, h: 20, top: 200 }, view, 1);
  check(right.x + right.width <= view.x + view.width, '选区超出右边：按钮不出账号页面');
  const card = placeBox(sel, view, 1, { width: CARD_W, height: 100 }, 'left');
  check(card.x + PAD === 300 + 100 && card.y + PAD === 60 + 220 + 4, `译文窗左边和选区最后一行开头对齐（${card.x},${card.y}）`);
  const cardR = placeBox({ x: 700, y: 200, w: 60, h: 20, top: 200 }, view, 1, { width: CARD_W, height: 100 }, 'left');
  check(cardR.x + cardR.width === view.x + view.width, '选区靠右：译文窗贴着右边，不出账号页面');
}

// ---- 读选区 ----
const select = (win, id, from = 0, to = null) => win.webContents.executeJavaScript(`(() => {
  const t = document.getElementById(${JSON.stringify(id)}).firstChild;
  const r = document.createRange(); r.setStart(t, ${from}); r.setEnd(t, ${to === null ? 't.length' : to});
  const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString();
})()`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadFile(path.join(__dirname, 'fixtures', 'wa-selection.html'));
  const wc = win.webContents;
  const pageEval = (code) => wc.executeJavaScript(code);

  check(await waPage.readSelection(wc) === null, '没选文字时是 null');
  await select(win, 'm2');
  await pageEval('Object.assign(window.__events, { mutations: 0, clicks: 0, scrolls: 0 })');
  const before = await pageEval('document.documentElement.outerHTML');
  const r = await waPage.readSelection(wc);
  check(!!r && r.text === 'For the 1st package', `选中消息里的文字：读到「${r && r.text}」`);
  check(!!r && r.w > 0 && r.h > 0 && r.y > 0 && r.top <= r.y, '带回选区最后一行的位置');
  const ev = await pageEval('window.__events');
  check(ev.mutations === 0 && ev.clicks === 0 && ev.scrolls === 0, '读选区没有改动页面、没有点击和滚动');
  check(await pageEval('document.documentElement.outerHTML') === before, '读之前和读之后页面 HTML 完全相同');
  check(await pageEval('getSelection().toString()') === 'For the 1st package', '读完选区还在（没被改）');

  await select(win, 'm1', 8, 21);
  check((await waPage.readSelection(wc))?.text === 'send tracking', '选中一条消息里的几个词');
  // 拖选整条消息（一直拖到时间）：只要正文，不带时间
  await pageEval("(() => { const s = getSelection(); const r = document.createRange(); r.setStart(document.getElementById('m2').firstChild, 4); r.setEnd(document.getElementById('t2').firstChild, 5); s.removeAllRanges(); s.addRange(r); return s.toString(); })()");
  check((await waPage.readSelection(wc))?.text === 'the 1st package', '选到时间也只取消息正文，不带「04:28」');
  // 跨两条消息：中间换行
  await pageEval("(() => { const s = getSelection(); const r = document.createRange(); r.setStart(document.getElementById('m1').firstChild, 22); r.setEnd(document.getElementById('m2').firstChild, 7); s.removeAllRanges(); s.addRange(r); return 1; })()");
  check((await waPage.readSelection(wc))?.text === 'number please\nFor the', '跨两条消息：两段之间换行');
  await select(win, 'compose');
  check(await waPage.readSelection(wc) === null, '选的是输入框里的字：不出按钮');
  await select(win, 'name');
  check(await waPage.readSelection(wc) === null, '选的是左边对话列表：不出按钮');
  await pageEval("(() => { const s = getSelection(); const r = document.createRange(); r.setStart(document.getElementById('name').firstChild, 2); r.setEnd(document.getElementById('m1').firstChild, 5); s.removeAllRanges(); s.addRange(r); return 1; })()");
  check(await waPage.readSelection(wc) === null, '从对话列表一直选到聊天区：不出按钮');
  await pageEval("document.getElementById('m2').textContent = 'x'.repeat(5000)");
  await select(win, 'm2');
  check((await waPage.readSelection(wc))?.text.length === 4000, '很长的选区只取前 4000 字');

  // 源码里不能有往页面里放东西、挂监听的写法（只读）
  const src = waPage.SELECTION_CODE;
  check(!/addEventListener|appendChild|append\(|insert|innerHTML|setAttribute|removeAllRanges|addRange|\.focus\(|\.click\(/.test(src), '读选区的代码里没有改页面、挂监听、改选区的写法');
  const mod = fs.readFileSync(path.join(__dirname, '..', 'src', 'sel-translate.js'), 'utf8');
  check(!/executeJavaScript\(|insertCSS|executeJavaScriptInIsolatedWorld/.test(mod), '按钮模块不往账号页面里跑脚本、加样式（读选区只走 wa-page.js）');

  console.log(failures ? `\n有 ${failures} 项没通过` : '\n全部通过');
  app.exit(failures ? 1 : 0);
});
