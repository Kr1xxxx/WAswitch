// 自检：轻量号的聊天页（软件自己画的）在收到的消息下面显示译文（设置里选了「消息下面」，shen 2026-10-30）。
// 真的 lite.js 和样式 + 最小的替身（fixtures/lite-tr.html），模拟主进程发来的 lite:tr：
// 译文、翻译中、失败 + 重试、「翻译」按钮各一条，自己发的不显示；点按钮按 hash 交给主进程；空列表全部拿掉；内容没变不重画。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-lite-tr.js（SHOT_DIR=目录 时存一张截图）
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true } });
  const wc = win.webContents;
  try {
    await win.loadFile(path.join(__dirname, 'fixtures', 'lite-tr.html'));
    const page = (code) => wc.executeJavaScript(code);
    const jid = '4915123456789@s.whatsapp.net';
    await page(`(() => {
      const acc = { id: 'l1', proxyLabel: 'DE 7891', direct: false };
      const view = { rev: 1, jid: ${JSON.stringify(jid)}, title: 'Anna Müller', chats: [{ jid: ${JSON.stringify(jid)}, name: 'Anna Müller', ts: 0, unread: 0, preview: 'Hi' }],
        messages: [
          { id: 'M1', me: false, text: 'Hallo! Gibt es die Perücke auch in 24 Zoll?', ts: 1793370000 },
          { id: 'M2', me: true, text: 'Yes, 24 inch is available.', ts: 1793370060 },
          { id: 'M3', me: false, text: 'Wie lange dauert der Versand nach München?', ts: 1793370120 },
          { id: 'M4', me: false, text: 'Kann ich mit PayPal bezahlen?', ts: 1793370180 },
          { id: 'M5', me: false, text: 'Bitte schicken Sie mir den Katalog.', ts: 1793370240 },
        ] };
      document.getElementById('host').append(litePage(acc, { id: 'l1', status: 'open', openJid: view.jid, view }));
      return true;
    })()`);
    const trs = () => page("[...document.querySelectorAll('.lite-msg')].map((m) => { const t = m.querySelector('.lite-tr'); return t ? t.textContent : null; })");
    check(JSON.stringify(await trs()) === JSON.stringify([null, null, null, null, null]), '没收到译文时消息下面什么都没有');
    const list = [
      { id: 'M1', h: '0000000000000001', k: 'done', t: '你好！这款假发有 24 英寸的吗？', b: '' },
      { id: 'M2', h: '0000000000000002', k: 'done', t: '不该显示', b: '' },
      { id: 'M3', h: '0000000000000003', k: 'busy', t: '翻译中…', b: '' },
      { id: 'M4', h: '0000000000000004', k: 'error', t: '翻译服务太忙', b: '重试' },
      { id: 'M5', h: '0000000000000005', k: 'manual', t: '', b: '翻译' },
    ];
    await page(`window.__liteTr({ accountId: 'l1', list: ${JSON.stringify(list)} })`);
    const got = await trs();
    check(got[0] === '你好！这款假发有 24 英寸的吗？', '译文显示在第 1 条原文下面');
    check(got[1] === null, '自己发的消息下面不显示');
    check(got[2] === '翻译中…', '翻译中的显示「翻译中…」');
    check(got[3] === '翻译服务太忙 重试', '失败的显示原因和「重试」');
    check(got[4] === '翻译', '没翻的显示「翻译」按钮');
    const order = await page("(() => { const m = document.querySelectorAll('.lite-msg')[0]; return [...m.children].map((c) => c.className); })()");
    check(JSON.stringify(order) === JSON.stringify(['text', 'lite-tr', 'time']), `译文在原文和时间中间（${order.join(' / ')}）`);
    const look = await page("(() => { const t = document.querySelector('.lite-tr'); const cs = getComputedStyle(t); return { color: cs.color, border: cs.borderTopStyle }; })()");
    check(look.border === 'solid', '原文和译文中间有一条细线');
    if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, 'lite-tr.png'), (await wc.capturePage()).toPNG());
    await page("document.querySelectorAll('.lite-msg')[3].querySelector('.lite-tr-btn').click()");
    await page("document.querySelectorAll('.lite-msg')[4].querySelector('.lite-tr-btn').click()");
    const items = await page('window.__items');
    check(JSON.stringify(items) === JSON.stringify(['0000000000000004', '0000000000000005']), '点「重试」「翻译」按 hash 交给主进程');
    // 同样的内容再发一次：不重画（按钮还是点过的那个，没有被换掉）
    await page("window.__mark = document.querySelectorAll('.lite-msg')[0]; true");
    await page(`window.__liteTr({ accountId: 'l1', list: ${JSON.stringify(list)} })`);
    check(await page("document.querySelectorAll('.lite-msg')[0] === window.__mark"), '内容没变时不重画');
    await page("window.__liteTr({ accountId: 'other', list: [] })");
    check((await trs())[0] === '你好！这款假发有 24 英寸的吗？', '别的号的消息不影响这个号');
    await page("window.__liteTr({ accountId: '', list: [] })");
    check(JSON.stringify(await trs()) === JSON.stringify([null, null, null, null, null]), '换成右侧工作台（空列表）后全部拿掉');
  } catch (e) {
    console.log(`失败：出错 ${e && e.stack}`);
    failures += 1;
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  app.exit(failures ? 1 : 0);
});
