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
    // 点了「重试」马上又失败（比如没登录团队）：译文和之前一样，按钮也要换回能点的
    check(await page("[...document.querySelectorAll('.lite-msg')].slice(3, 5).every((m) => !m.querySelector('.lite-tr-btn').disabled)"), '马上又失败的「重试」「翻译」，按钮换回能点');
    // 只有译文变了：不重建整列，别的消息的节点原样留着
    const list2 = list.map((e) => (e.id === 'M3' ? { ...e, k: 'done', t: '寄到慕尼黑要多久？' } : e));
    await page("window.__texts = [...document.querySelectorAll('.lite-msg .text')]; true");
    await page(`window.__liteTr({ accountId: 'l1', list: ${JSON.stringify(list2)} })`);
    check((await trs())[2] === '寄到慕尼黑要多久？', '第 3 条翻好了，译文换上');
    check(await page("[...document.querySelectorAll('.lite-msg .text')].every((t, i) => t === window.__texts[i])"), '只换变了的译文，原文的节点没重建');
    // 用户选着第 1 条的原文（要复制）时来了新译文：选区还在，译文先不换，选区没了再补上
    const sel = "(() => { const t = document.querySelectorAll('.lite-msg .text')[0]; const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()";
    await page("document.getElementById('host').style.userSelect = 'text'"); // 真界面里 #content 是 user-select: text
    check((await page(sel)).startsWith('Hallo!'), '选中第 1 条的原文');
    const list3 = list2.map((e) => (e.id === 'M4' ? { ...e, k: 'done', t: '可以用 PayPal 付款吗？', b: '' } : e));
    await page(`window.__liteTr({ accountId: 'l1', list: ${JSON.stringify(list3)} })`);
    check((await page('getSelection().toString()')).startsWith('Hallo!'), '选着字时来了新译文：选区还在，Ctrl+C 能复制');
    check((await trs())[3] === '翻译服务太忙 重试', '选着字时译文先不换');
    await page('getSelection().removeAllRanges()');
    await new Promise((r) => setTimeout(r, 100));
    check((await trs())[3] === '可以用 PayPal 付款吗？', '选区没了以后，压着的译文补上');
    // 选着不放超过 15 秒：不用等下一次来信，到时间就把压着的译文换上（选区还在）
    await page(`(() => {
      window.__timers = []; window.__realSet = window.setTimeout; window.__realNow = Date.now;
      window.setTimeout = (fn, ms) => { window.__timers.push([fn, ms]); return window.__timers.length; };
      const t = document.querySelectorAll('.lite-msg .text')[0]; const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return true; })()`);
    const list4 = list3.map((e) => (e.id === 'M5' ? { ...e, k: 'done', t: '请把目录发给我。', b: '' } : e));
    await page(`window.__liteTr({ accountId: 'l1', list: ${JSON.stringify(list4)} })`);
    check((await trs())[4] === '翻译', '选着字时（计时前）译文先不换');
    check(await page('window.__timers.some(([, ms]) => ms === 15000)'), '开始压的时候定了 15 秒的计时');
    await page("(() => { const t0 = Date.now(); Date.now = () => t0 + 16000; for (const [fn, ms] of window.__timers) if (ms === 15000) fn(); Date.now = window.__realNow; window.setTimeout = window.__realSet; return true; })()");
    check((await trs())[4] === '请把目录发给我。', '15 秒到了，没有新来信也把压着的译文换上');
    check((await page('getSelection().toString()')).startsWith('Hallo!'), '到时间换译文时选区还在');
    await page('getSelection().removeAllRanges()');
    // ---- 气泡译文的小编辑按钮（铅笔）和编辑小窗 ----
    const pencils = () => page("[...document.querySelectorAll('.lite-msg')].map((m) => !!m.querySelector('.lite-tr .lite-tr-edit'))");
    await page(`window.__liteTr({ accountId: 'l1', list: ${JSON.stringify(list)} })`);
    check(JSON.stringify(await pencils()) === JSON.stringify([true, false, false, false, false]), '只有「有译文」的消息有小铅笔（翻译中、失败、「翻译」按钮的没有）');
    check(await page("getComputedStyle(document.querySelector('.lite-tr-edit')).visibility") === 'hidden', '鼠标不在消息上时铅笔不显示（位置留着）');
    await page(`window.__liteTr({ accountId: 'l1', list: ${JSON.stringify(list4)} })`);
    const H1 = '0000000000000001';
    await page(`window.__entries = { ${JSON.stringify(H1)}: { h: ${JSON.stringify(H1)}, state: 'done', orig: true, tr: '你好！这款假发有 24 英寸的吗？', edited: false, fixed: false, suggest: '', err: '', rows: [['翻译时间', '10:02'], ['用时', '1.2 秒'], ['模型', '来财 DeepSeek']] } }; true`);
    const card = () => page(`(() => { const w = document.querySelector('.sel-pop .tc'); if (!w || w.closest('.sel-pop').hidden) return null;
      const ta = w.querySelector('textarea'); const tr = document.querySelectorAll('.lite-msg')[0].querySelector('.lite-tr').getBoundingClientRect(); const r = w.getBoundingClientRect();
      return { text: ta.value, focus: document.activeElement === ta, below: r.top >= tr.bottom - 1, left: Math.abs(r.left - tr.left) < 2, info: w.querySelector('.tc-info').textContent, btns: [...w.querySelectorAll('.tc-foot button')].map((b) => b.textContent + (b.disabled ? '(灰)' : '')), expanded: document.querySelectorAll('.lite-msg')[0].querySelector('.lite-tr-edit').getAttribute('aria-expanded') }; })()`);
    const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
    await page("document.querySelectorAll('.lite-msg')[0].querySelector('.lite-tr-edit').click()");
    await tick();
    let c = await card();
    check(!!c && c.text === '你好！这款假发有 24 英寸的吗？' && c.focus, '点铅笔弹出小窗，框里是译文，光标在框里');
    check(!!c && c.below && c.left, '小窗在这条译文下面，左边对齐');
    check(!!c && c.info.includes('翻译时间10:02') && c.info.includes('模型来财 DeepSeek'), `小窗里有翻译信息（${c && c.info}）`);
    check(!!c && JSON.stringify(c.btns) === JSON.stringify(['纠错', '保存(灰)']) && c.expanded === 'true', `按钮是「纠错」「保存」，没改时保存是灰的，铅笔保持显示（${c && c.btns.join(' ')}）`);
    // 小窗开着时译文块换了（别的消息的译文更新）：小窗不收
    await page(`window.__liteTr({ accountId: 'l1', list: ${JSON.stringify(list4.map((e) => (e.id === 'M1' ? { ...e, t: e.t + ' ' } : e)))} })`);
    await tick();
    check(!!(await card()), '译文块换了，小窗不收');
    // 改了没保存，点外面：收起，不弹确认；再打开改的字还在
    await page("(() => { const ta = document.querySelector('.tc textarea'); ta.value = '你好！这款假发有 24 寸的吗？'; ta.dispatchEvent(new Event('input')); return true; })()");
    check(JSON.stringify((await card()).btns) === JSON.stringify(['纠错', '保存']), '改了以后「保存」能点');
    await page("document.querySelectorAll('.lite-msg .text')[2].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))");
    check((await card()) === null, '点小窗外面收起');
    await tick(700);
    await page("document.querySelectorAll('.lite-msg')[0].querySelector('.lite-tr-edit').click()");
    await tick();
    check((await card())?.text === '你好！这款假发有 24 寸的吗？', '改了没保存收起后，再打开改的字还在');
    // 再点同一个铅笔：收起（按下时先收起，接着的点击不再打开）
    await page("(() => { const b = document.querySelectorAll('.lite-msg')[0].querySelector('.lite-tr-edit'); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); b.click(); return true; })()");
    await tick();
    check((await card()) === null, '再点同一个铅笔收起，不重开');
    await tick(700);
    // 选着原文时打开、收起小窗：选区还在
    await page(sel);
    await page("document.querySelectorAll('.lite-msg')[0].querySelector('.lite-tr-edit').click()");
    await tick();
    check(!!(await card()), '选着字时也能打开小窗');
    check((await page('getSelection().toString()')).startsWith('Hallo!'), '选着字时打开小窗：选区还在（不抢焦点）');
    await page("document.querySelector('.lite-msgs').dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))");
    check((await card()) === null && (await page('getSelection().toString()')).startsWith('Hallo!'), '收起小窗后选区还在');
    await page('getSelection().removeAllRanges()');
    await tick(700);
    await page("document.querySelectorAll('.lite-msg')[0].querySelector('.lite-tr-edit').click()");
    await tick();
    // 按 Enter 保存：交给主进程，收起
    await page("(() => { const ta = document.querySelector('.tc textarea'); ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()");
    await tick();
    const calls = await page('window.__calls');
    check(JSON.stringify(calls[0]) === JSON.stringify(['edit', H1, '你好！这款假发有 24 寸的吗？']), '按 Enter 保存（dockEdit）');
    check((await card()) === null, '保存后小窗收起');
    // 输入法选字时的回车不算保存
    await tick(700);
    await page("window.__calls = []; document.querySelectorAll('.lite-msg')[0].querySelector('.lite-tr-edit').click()");
    await tick();
    await page("(() => { const ta = document.querySelector('.tc textarea'); ta.value = 'x'; ta.dispatchEvent(new Event('input')); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })); return true; })()");
    await tick();
    check((await page('window.__calls.length')) === 0 && !!(await card()), '输入法选字时的回车不保存');
    // 纠错：框里改了先保存再纠错
    await page("[...document.querySelectorAll('.tc-foot button')].find((b) => b.textContent === '纠错').click()");
    await tick();
    check(JSON.stringify(await page('window.__calls')) === JSON.stringify([['edit', H1, 'x'], ['fix', H1]]), '改了再点纠错：先保存再纠错');
    // 纠错中：按钮位置显示「纠错中…」，框只读
    await page(`Object.assign(window.__entries[${JSON.stringify(H1)}], { state: 'running' }); window.__liteTr({ accountId: 'l1', list: ${JSON.stringify(list4)} })`);
    await tick();
    check(await page("document.querySelector('.tc-foot').textContent.includes('纠错中…') && document.querySelector('.tc textarea').readOnly"), '纠错中：显示「纠错中…」，框只读');
    // 改过的再纠错：出纠错建议，按钮换成「不用」「采用」；采用后收起
    await page(`Object.assign(window.__entries[${JSON.stringify(H1)}], { state: 'done', suggest: '你好！这款假发有 24 英寸的款式吗？' }); window.__liteTr({ accountId: 'l1', list: ${JSON.stringify(list4)} })`);
    await tick();
    c = await card();
    check(!!c && JSON.stringify(c.btns) === JSON.stringify(['不用', '采用']) && (await page("document.querySelector('.tc-sg').textContent")).includes('24 英寸的款式'), '出纠错建议，按钮是「不用」「采用」');
    if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, 'lite-tr-edit.png'), (await wc.capturePage()).toPNG());
    await page("[...document.querySelectorAll('.tc-foot button')].find((b) => b.textContent === '采用').click()");
    await tick();
    check(JSON.stringify((await page('window.__calls')).slice(-1)[0]) === JSON.stringify(['take', H1, true]) && (await card()) === null, '点「采用」交给主进程，小窗收起');
    // 纠错失败：只有红字，没有「去填密钥」
    await tick(700);
    await page(`Object.assign(window.__entries[${JSON.stringify(H1)}], { state: 'error', suggest: '', err: '团队登录失效，请重新登录' }); true`);
    await page("document.querySelectorAll('.lite-msg')[0].querySelector('.lite-tr-edit').click()");
    await tick();
    check(await page("document.querySelector('.tc-err').textContent === '团队登录失效，请重新登录' && !document.querySelector('.tc-err button')"), '纠错失败：小窗里只有红字');
    // 滚动聊天：收起
    await page("document.querySelector('.lite-msgs').dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))");
    check((await card()) === null, '滚动聊天收起小窗');
    // 这条消息的译文没了（这条不在了）：小窗收起
    await tick(700);
    await page("document.querySelectorAll('.lite-msg')[0].querySelector('.lite-tr-edit').click()");
    await tick();
    await page(`window.__liteTr({ accountId: 'l1', list: ${JSON.stringify(list4.filter((e) => e.id !== 'M1'))} })`);
    await tick();
    check((await card()) === null, '这条的译文没了，小窗收起');

    await page(`window.__liteTr({ accountId: 'l1', list: ${JSON.stringify(list4)} })`);
    await page("window.__liteTr({ accountId: 'other', list: [] })");
    check((await trs())[0] === '你好！这款假发有 24 英寸的吗？', '别的号的消息不影响这个号');
    await page("window.__liteTr({ accountId: '', list: [] })");
    check(JSON.stringify(await trs()) === JSON.stringify([null, null, null, null, null]), '换成右侧工作台（空列表）后全部拿掉');
    // 对话满 200 条后补进来一条更早的消息（条数和最后一条都没变）：也要重画出来
    const cap = await page(`(() => {
      const jid = 'cap@s.whatsapp.net';
      const base = Array.from({ length: 200 }, (_, i) => ({ id: 'C' + i, me: false, text: 'Message ' + i, ts: 1793370000 + i * 60 }));
      const acc = { id: 'l1', proxyLabel: 'DE 7891', direct: false };
      const chats = [{ jid, name: 'Lena Fischer', ts: 0, unread: 0, preview: 'Hi' }];
      litePage(acc, { id: 'l1', status: 'open', openJid: jid, view: { rev: 50, jid, title: 'Lena Fischer', chats, messages: base } });
      const before = document.querySelectorAll('.lite-msg').length;
      const more = [...base.slice(1, 100), { id: 'OLD', me: false, text: 'Older message from yesterday', ts: 1793370000 + 99 * 60 }, ...base.slice(100)];
      litePage(acc, { id: 'l1', status: 'open', openJid: jid, view: { rev: 51, jid, title: 'Lena Fischer', chats, messages: more } });
      const ids = [...document.querySelectorAll('.lite-msg')].map((m) => m.dataset.id);
      return { before, n: ids.length, old: ids.includes('OLD'), first: ids[0] };
    })()`);
    check(cap.before === 200 && cap.n === 200 && cap.old && cap.first === 'C1', `满 200 条后补进来的旧消息也画出来（${JSON.stringify(cap)}）`);
  } catch (e) {
    console.log(`失败：出错 ${e && e.stack}`);
    failures += 1;
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  app.exit(failures ? 1 : 0);
});
