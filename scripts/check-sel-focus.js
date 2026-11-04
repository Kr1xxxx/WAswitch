// 自检：选中文字后的「翻译」小视图不能抢走键盘焦点，聊天里选中的字第一次 Ctrl+C 就复制得到（src/sel-translate.js）。
// 1. 第一次选字（小视图新建）：焦点留在账号页面，复制到的是聊天里选中的字
// 2. 小视图空闲关掉后再选字（重建）：同样
// 3. 用户点了小视图：焦点留在它上面；点「翻译」后焦点回到账号页面，聊天里的选区还在，复制到的是原文
// 5. 气泡译文的编辑小窗（mode tr）：打开后焦点留在小窗里（打字进小窗）；松开鼠标读不到选区不收；按下页面收起、焦点回账号页面；
//    收起后马上又点同一个铅笔当作收起；保存交给 trEdit 并收起
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
    trEdit: {
      save: (id, h, text) => { trCalls.push(['save', h, text]); return true; }, fix: (id, h, text) => { trCalls.push(['fix', h, text]); return true; },
      take: () => true, draft: (id, h, text) => { trCalls.push(['draft', h, text]); }, key: () => {}, closed: (id, h) => { trCalls.push(['closed', h]); },
    },
  });
  const trCalls = [];
  selTr.watch('a1', wc);
  win.focus(); wc.focus(); await wait(200);

  const select = (id) => wc.executeJavaScript(`(() => { const t = document.getElementById('${id}').firstChild; const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()`);
  const click = (w, type) => w.sendInputEvent({ type, x: 300, y: 60, button: 'left', clickCount: 1 });
  // 像用户那样先按下再选字。sendInputEvent 和 executeJavaScript 走两条路，按下可能比选字晚到页面，把刚选好的字点没（CI 上偶尔这样）：
  // 页面里数着收到几次按下，等按下到了再选
  await wc.executeJavaScript("window.__downs = 0; document.addEventListener('mousedown', () => { window.__downs += 1; }, true); 1");
  const downs = () => wc.executeJavaScript('window.__downs');
  const pick = async (id) => {
    const n = await downs();
    click(wc, 'mouseDown');
    for (let i = 0; i < 100 && await downs() === n; i += 1) await wait(10);
    const t = await select(id);
    click(wc, 'mouseUp');
    await wait(800);
    return t;
  };
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

  // 5 气泡译文的编辑小窗
  {
    selTr.hide();
    await wc.executeJavaScript('getSelection().removeAllRanges(); 1');
    wc.focus(); await wait(100);
    const H = 'abcdef0123456789';
    const entry = { h: H, state: 'done', orig: true, tr: 'Hallo auf Deutsch', edited: false, fixed: false, suggest: '', err: '', rows: [['翻译时间', '10:02']] };
    const opened = await selTr.openTr({ id: 'a1', wc, h: H, rect: { x: 20, y: 40, w: 300, h: 20 }, top: 30, entry, draft: '' });
    await wait(400);
    const ov2 = overlay();
    check(opened && !!selTr.shown && selTr.shown.mode === 'tr' && selTr.shown.h === H, '编辑小窗打开（mode tr）');
    check(!!ov2 && ov2.isFocused() && !wc.isFocused(), '编辑小窗打开后焦点在小窗里');
    check(!!ov2 && await ov2.executeJavaScript('document.activeElement && document.activeElement.tagName') === 'TEXTAREA', '光标在译文框里');
    if (ov2) {
      ov2.sendInputEvent({ type: 'char', keyCode: 'X' });
      await wait(200);
      check(await ov2.executeJavaScript("document.querySelector('.tc textarea').value") === 'Hallo auf DeutschX', '打字进了小窗');
      check(trCalls.some((c) => c[0] === 'draft' && c[2] === 'Hallo auf DeutschX'), '改的字告诉了主进程（收起后还在）');
    }
    await wait(300);
    check(!!selTr.shown && selTr.shown.mode === 'tr' && ov2.isFocused(), '过了一会儿焦点还在小窗（不被还给页面）');
    // 松开鼠标（点铅笔时）读不到选区：不收
    click(wc, 'mouseUp'); await wait(300);
    check(!!selTr.shown && selTr.shown.mode === 'tr', '松开鼠标读不到选区时编辑小窗不收');
    // 按下页面：收起，焦点回账号页面
    wc.emit('input-event', {}, { type: 'mouseDown', button: 'left' });
    await wait(200);
    check(!selTr.shown && wc.isFocused(), '按下页面收起编辑小窗，焦点回到账号页面');
    check(trCalls.some((c) => c[0] === 'closed' && c[1] === H), '收起时告诉了主进程');
    // 收起后马上点同一个铅笔：当作收起，不再打开
    const again = await selTr.openTr({ id: 'a1', wc, h: H, rect: { x: 20, y: 40, w: 300, h: 20 }, top: 30, entry, draft: '' });
    check(again === false && !selTr.shown, '收起后马上又点同一个铅笔：不再打开');
    await wait(700);
    // 再打开，按 Enter 保存：交给 trEdit，收起
    await selTr.openTr({ id: 'a1', wc, h: H, rect: { x: 20, y: 40, w: 300, h: 20 }, top: 30, entry, draft: 'Hallo!' });
    await wait(400);
    const ov3 = overlay();
    check(await ov3.executeJavaScript("document.querySelector('.tc textarea').value") === 'Hallo!', '打开时用上次没保存的字');
    ov3.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    ov3.sendInputEvent({ type: 'char', keyCode: '\r' });
    ov3.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await wait(300);
    check(trCalls.some((c) => c[0] === 'save' && c[2] === 'Hallo!') && !selTr.shown && wc.isFocused(), '按 Enter 保存：交给主进程，收起，焦点回账号页面');
  }

  selTr.shutdown();
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  app.exit(failures ? 1 : 0);
});
