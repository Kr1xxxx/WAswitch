// 自检：选中文字后的「翻译」小视图不能抢走键盘焦点，聊天里选中的字第一次 Ctrl+C 就复制得到（src/sel-translate.js）。
// 1. 第一次选字（小视图新建）：焦点留在账号页面，复制到的是聊天里选中的字
// 2. 小视图空闲关掉后再选字（重建）：同样
// 3. 用户点了小视图：焦点留在它上面；点「翻译」后焦点回到账号页面，聊天里的选区还在，复制到的是原文
// 运行：xvfb-run -a npx electron --no-sandbox scripts/check-sel-focus.js
const { app, BaseWindow, WebContentsView, webContents, clipboard } = require('electron');
const path = require('path');
const { createSelTranslate } = require('../src/sel-translate');
const { makeCopyText } = require('../src/copy-text');
const waPage = require('../src/wa-page');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  let copyOk = true;
  const win = new BaseWindow({ width: 1000, height: 700, show: true });
  const acc = new WebContentsView({ webPreferences: { sandbox: true } });
  win.contentView.addChildView(acc);
  acc.setBounds({ x: 0, y: 0, width: 600, height: 700 });
  const wc = acc.webContents;
  await wc.loadFile(path.join(__dirname, 'fixtures', 'wa-selection.html'));
  const selTr = createSelTranslate({
    win: () => win, lockLocalPage: () => {}, canShow: () => true, viewOf: () => acc,
    readSelection: (w) => waPage.readSelection(w), translate: async (t) => ({ text: `ZH:${t}` }),
    copy: (t) => (copyOk ? makeCopyText(clipboard)(t) : Promise.resolve(false)), focus: () => wc.focus(),
  });
  selTr.watch('a1', wc);
  win.focus(); wc.focus(); await wait(200);

  const select = (id) => wc.executeJavaScript(`(() => { const t = document.getElementById('${id}').firstChild; const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()`);
  const click = (w, type) => w.sendInputEvent({ type, x: 300, y: 60, button: 'left', clickCount: 1 });
  const pick = async (id) => { click(wc, 'mouseDown'); const t = await select(id); click(wc, 'mouseUp'); await wait(800); return t; };
  // Ctrl+C 做的事：对有键盘焦点的页面执行复制
  const copyNow = async () => { await clipboard.writeText('(空)'); const f = webContents.getFocusedWebContents(); if (f) f.copy(); await wait(300); return clipboard.readText(); };
  const overlay = () => webContents.getAllWebContents().find((w) => /seltr[\\/]index\.html/.test(w.getURL()));

  // 1 第一次选字，小视图新建
  const t1 = await pick('m1');
  check(!!selTr.shown && selTr.shown.mode === 'button', '选字后出现翻译按钮');
  check(wc.isFocused(), '小视图新建后，键盘焦点还在账号页面');
  check(await copyNow() === t1, '第一次 Ctrl+C 复制到聊天里选中的字');

  // 2 小视图空闲关掉后再选字，重建
  selTr.close(); await wait(100); wc.focus(); await wait(100);
  const t2 = await pick('m2');
  check(!!selTr.shown, '小视图重建后又出现翻译按钮');
  check(wc.isFocused(), '小视图重建后，键盘焦点还在账号页面');
  check(await copyNow() === t2, '重建后第一次 Ctrl+C 也复制得到');

  // 3 用户点了小视图：焦点留在它上面；点「翻译」后焦点回到账号页面
  const ov = overlay();
  check(!!ov, '找得到翻译小视图');
  if (ov) {
    // 真点击时焦点事件和鼠标按下事件同一毫秒到（sendInputEvent 不走这个事件，所以直接发）
    ov.focus(); ov.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseDown', x: 38, y: 20 }); await wait(300);
    check(ov.isFocused() && !wc.isFocused(), '用户点了小视图：焦点留在小视图（不被抢回）');
    await ov.executeJavaScript('window.seltr.go()');
    await wait(400);
    check(wc.isFocused() && !ov.isFocused(), '点「翻译」后焦点回到账号页面');
    check(await wc.executeJavaScript('getSelection().toString()') === t2, '聊天里的选区还在');
    check(await copyNow() === t2, '点「翻译」后 Ctrl+C 复制到的是原文');

    // 4 译文窗的「复制」：复制上了才显示「已复制」，没复制上按钮保持原样；点完焦点回到账号页面
    const label = () => ov.executeJavaScript("document.querySelector('.sc-btn') && document.querySelector('.sc-btn').textContent");
    const clickCopy = async () => { ov.focus(); await ov.executeJavaScript("document.querySelector('.sc-btn').click()"); await wait(500); };
    check(await label() === '复制', '译文出来后有「复制」按钮');
    copyOk = false; await clipboard.writeText('(空)'); await clickCopy();
    check(await label() === '复制' && await clipboard.readText() === '(空)', '没复制上：按钮保持「复制」，不显示「已复制」');
    copyOk = true; await clickCopy();
    check(await label() === '已复制' && await clipboard.readText() === `ZH:${t2}`, '复制上了：显示「已复制」，剪贴板是译文');
    check(wc.isFocused() && !ov.isFocused(), '点「复制」后焦点回到账号页面');
  }

  selTr.shutdown();
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  app.exit(failures ? 1 : 0);
});
