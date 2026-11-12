// MCP 起草回复（draft_reply）自检：草稿真的放进输入框，而且没有发送。
//   A. draft-place.js 的判断（假的主进程）：什么时候直接放、什么时候在顶部问、一次一条、用户点按钮后怎么放
//   B. 网页版：仿 WhatsApp 的本地页 + 真的剪贴板和 paste。草稿出现在输入框里，没有任何按键、Enter、发送点击，剪贴板换回原样
//   C. 轻量模式：真的 src/shell/lite.js 聊天页。草稿填进输入框，liteSend 没被调用
//   D. 翻译页的「放进输入框」、话术的「插入」：新版 WhatsApp 结构的页面 + 旁边的工作台视图。焦点不在输入框时也放进去
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-draft.js（窗口要显示出来，xvfb 下看不见）
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, BaseWindow, WebContentsView, clipboard, ClipboardItem } = require('electron');
const waPage = require('../src/wa-page');
const { createDraftPlacer, chatMatches, jidNumber } = require('../src/draft-place');
const { pasteToCompose } = require('../src/compose-insert');
const { makeCopyText } = require('../src/copy-text');

let failures = 0;
const out = (line) => fs.writeSync(1, `${line}\n`);
const check = (ok, text) => { out(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 假的主进程状态，默认：这个号正显示着、可以直接放
function fakeDeps(over = {}) {
  const st = { request: null, ms: 0, block: '', shown: true, activated: [], liteOpened: [], liteFills: [] };
  const deps = {
    findAcc: (id) => (['w1', 'l1'].includes(id) ? { id, mode: id === 'l1' ? 'lite' : 'web' } : null),
    isLite: (acc) => acc.mode === 'lite',
    autoBlock: () => st.block,
    stillShown: () => st.shown,
    webContents: () => null,
    waPage,
    clipboard,
    ClipboardItem,
    liteOpenChat: () => st.liteOpen || null,
    liteChats: () => st.liteChats || [],
    liteOpen: (id, jid) => { st.liteOpened.push(jid); st.liteOpen = { jid, title: (st.liteChats || []).find((c) => c.jid === jid)?.name || '' }; },
    liteFill: async (id, jid, text, opts) => { st.liteFills.push({ id, jid, text, ...opts }); return st.liteFillAnswer || 'ok'; },
    request: () => st.request,
    setRequest: (req, ms) => { st.request = req; st.ms = ms; },
    clearRequest: () => { st.request = null; },
    activateForUser: async (id) => { st.activated.push(id); },
    wait: (ms) => wait(Math.min(ms, 20)),
    ...over,
  };
  return { st, placer: createDraftPlacer(deps) };
}

async function partA() {
  // 对话名称 / 号码匹配
  check(chatMatches('anna  müller', { title: 'Anna Müller', number: '' }), '名称匹配忽略大小写和多余空格');
  check(!chatMatches('Anna', { title: 'Anna Müller', number: '' }), '名称只认完全一样，不认一部分');
  check(chatMatches('+49 151 99999999', { title: 'Anna', number: '4915123456789' }) === false, '号码不一样不算');
  check(chatMatches('+49 1512 3456789', { title: 'Anna', number: '4915123456789' }), '号码按数字比，空格和 + 不影响');
  check(chatMatches('015123456789', { title: '+49 1512 3456789', number: '' }), '没存名字的联系人：标题就是号码，少写国家码也认');
  check(!chatMatches('123456', { title: 'x', number: '99123456' }), '号码少于 8 位重合不认');
  check(jidNumber('4915123456789@s.whatsapp.net') === '4915123456789' && jidNumber('120363@g.us') === '', 'jidNumber：个人号码认出来，群不算号码');

  // 可以直接放：轻量模式，要回的对话正开着
  let { st, placer } = fakeDeps();
  st.liteOpen = { jid: '4915123456789@s.whatsapp.net', title: 'Anna Müller' };
  let r = await placer.place({ accountId: 'l1', chat: 'Anna Müller', text: 'Hi Anna', client: 'test' });
  check(r.result === 'placed' && st.liteFills.length === 1 && st.liteFills[0].force === false && st.liteFills[0].focus === false && !st.request,
    '轻量模式：对话正开着就直接填，不强填（输入框有字就不填）、不抢焦点、不弹横幅');

  // 对话没开着：不自己打开，顶部问
  st.liteOpen = { jid: '111@s.whatsapp.net', title: 'Someone' };
  r = await placer.place({ accountId: 'l1', chat: 'Anna Müller', text: 'Hi Anna', client: 'test' });
  check(r.result === 'pending' && /没打开/.test(r.why) && st.request && st.request.kind === 'draft' && st.liteOpened.length === 0 && st.ms === 5 * 60 * 1000,
    '轻量模式：对话没开着时不自己打开，在顶部问（横幅留 5 分钟）');

  // 一次一条
  const fills = st.liteFills.length;
  r = await placer.place({ accountId: 'l1', chat: 'Bob', text: 'second', client: 'test' });
  check(r.result === 'busy' && st.liteFills.length === fills && st.request.chat === 'Anna Müller', '上一条还在顶部等着时，新的被拒绝，原来那条不变');

  // 用户点“放进输入框”：切过去、打开那个对话、强填并给焦点
  st.liteChats = [{ jid: '4915123456789@s.whatsapp.net', name: 'Anna Müller' }, { jid: '222@s.whatsapp.net', name: 'Bob' }];
  await placer.answer(true);
  check(st.activated[0] === 'l1' && st.liteOpened[0] === '4915123456789@s.whatsapp.net', '用户点按钮后切到这个号，并打开那个对话');
  const last = st.liteFills.at(-1);
  check(last.text === 'Hi Anna' && last.force === true && last.focus === true && !st.request, '用户点按钮后填进去、给焦点，横幅消失');

  // 用户点了按钮但对话认不出来：横幅留着，写明原因
  st.liteOpen = null;
  st.liteChats = [{ jid: '1@s.whatsapp.net', name: 'Anna Müller' }, { jid: '2@s.whatsapp.net', name: 'anna müller' }];
  r = await placer.place({ accountId: 'l1', chat: 'Anna Müller', text: 'x', client: 'test' });
  await placer.answer(true);
  check(st.request && /没找到|重名/.test(st.request.note), '轻量模式有重名对话时不猜，横幅上写明没有放');
  await placer.answer(false);
  check(!st.request, '点“忽略”后横幅消失，草稿丢掉');

  // 不能直接放的各种情况：原因原样告诉 AI，一律走横幅
  for (const [block, re] of [['hidden', /托盘/], ['locked', /锁定/], ['not_shown', /没显示/], ['busy', /打字/]]) {
    ({ st, placer } = fakeDeps());
    st.block = block;
    st.liteOpen = { jid: '4915123456789@s.whatsapp.net', title: 'Anna Müller' };
    r = await placer.place({ accountId: 'l1', chat: 'Anna Müller', text: 'x', client: 'test' });
    check(r.result === 'pending' && re.test(r.why) && st.liteFills.length === 0, `${block}：不直接放，在顶部问（${r.why}）`);
  }
  ({ st, placer } = fakeDeps());
  r = await placer.place({ accountId: 'nope', chat: 'x', text: 'x' });
  check(r.result === 'gone' && !st.request, '账号不存在：不放、不弹横幅');
}

async function partB(win) {
  const wc = win.webContents;
  await win.loadFile(path.join(__dirname, 'fixtures', 'wa-compose.html'));
  const page = (code) => wc.executeJavaScript(code);
  const { st, placer } = fakeDeps({ webContents: () => wc });
  const focusCompose = () => page("document.getElementById('compose').focus(); true");
  const compose = () => page("document.getElementById('compose').innerText");
  const draft = 'Hi Anna,\nyes, size M is in stock. Shipping to Berlin takes 2–3 days.\nBest regards';

  await clipboard.writeText('ORIGINAL clipboard 原来的剪贴板');
  await focusCompose();
  let r = await placer.place({ accountId: 'w1', chat: 'Anna Müller', text: draft, client: 'test' });
  const text = await compose();
  check(r.result === 'placed' && !r.unconfirmed, `网页版：对话正开着、输入框空着时直接放（${r.result}${r.unconfirmed ? '，未确认' : ''}）`);
  check(text.replace(/\s+/g, ' ').trim() === draft.replace(/\s+/g, ' ').trim(), '网页版：输入框里是完整草稿（含换行）');
  let ev = await page('window.__ev');
  check(ev.keys === 0 && ev.enter === 0 && ev.sendClicks === 0 && ev.sent.length === 0, '网页版：没有任何按键、没按 Enter、没点发送，消息没发出去');
  check((await clipboard.readText()) === 'ORIGINAL clipboard 原来的剪贴板', '网页版：放完后剪贴板换回原来的内容');
  check(!st.request, '网页版：直接放时不弹横幅');

  // 输入框里已经有字：不往里加，改为在顶部问
  r = await placer.place({ accountId: 'w1', chat: 'Anna Müller', text: 'second draft', client: 'test' });
  check(r.result === 'pending' && /已经有文字/.test(r.why) && !(await compose()).includes('second draft'), '网页版：输入框里有字时不放，在顶部问');
  st.request = null;

  // 打开的是别的对话
  await page("document.getElementById('compose').textContent = ''; document.querySelector('#main header span').setAttribute('title', 'Lukas Becker'); document.querySelector('#main header span').textContent = 'Lukas Becker'; document.querySelector('[data-id]').setAttribute('data-id', 'false_4917000000000@c.us_B')");
  await focusCompose();
  r = await placer.place({ accountId: 'w1', chat: 'Anna Müller', text: 'wrong chat?', client: 'test' });
  check(r.result === 'pending' && /没打开/.test(r.why) && (await compose()) === '', '网页版：开着的是别的对话时不放，在顶部问');

  // 用户点了按钮，但还没打开 Anna 的对话：横幅留着，告诉用户先打开
  await placer.answer(true);
  check(st.request && /先在 WhatsApp 里打开和「Anna Müller」的对话/.test(st.request.note) && (await compose()) === '', '网页版：用户点按钮时对话不对，横幅写明先打开那个对话，不放');

  // 用户打开了 Anna 的对话（这里用号码起草），光标在搜索框：用户点了按钮，就先把光标放进输入框再放
  await page("document.querySelector('#main header span').setAttribute('title', 'Anna Müller'); document.querySelector('[data-id]').setAttribute('data-id', 'false_4915123456789@c.us_C'); document.getElementById('search').focus(); true");
  st.request = { ...st.request, chat: '+49 1512 3456789', note: '' };
  await clipboard.writeText('second original');
  await placer.answer(true);
  ev = await page('window.__ev');
  check(!st.request && (await compose()).includes('wrong chat?'), '网页版：光标在搜索框时用户点按钮，先把光标放进输入框再放（按号码认对话），横幅消失');
  check((await page("document.getElementById('search').textContent")) === '', '网页版：搜索框里没被写进去');
  check(ev.keys === 0 && ev.enter === 0 && ev.sendClicks === 0 && ev.sent.length === 0, '网页版：用户点按钮放进去，也没有按键、没发送');
  check((await clipboard.readText()) === 'second original', '网页版：用户点按钮放完后剪贴板也换回去');

  // 自动放时不动用户的焦点：光标在搜索框就不放，在顶部问
  await page("document.getElementById('compose').textContent = ''; document.getElementById('search').focus(); true");
  r = await placer.place({ accountId: 'w1', chat: 'Anna Müller', text: 'auto draft', client: 'test' });
  check(r.result === 'pending' && /光标不在/.test(r.why) && (await compose()) === '' && (await page('document.activeElement.id')) === 'search',
    `网页版：自动放时光标在搜索框，不放、不动焦点，在顶部问（${r.result} ${r.why}）`);
  st.request = null;
}

// 翻译页的「放进输入框」、话术的「插入」（compose-insert.js + wa-page.js 的 focusCompose）：
// 新版 WhatsApp 结构的页面在一个视图里，工作台在旁边另一个视图里（用户刚在工作台里打完字，焦点在工作台）。
// WhatsApp 页面里的焦点在消息上、搜索框里、哪里都不在时，都要放进对话下方的输入框，不用用户先点输入框（shen 2026-11-12「这个没有用」）
async function partD() {
  const win = new BaseWindow({ width: 1000, height: 600, show: true });
  const wa = new WebContentsView({ webPreferences: { sandbox: true } });
  const dock = new WebContentsView({ webPreferences: { sandbox: true } });
  win.contentView.addChildView(wa);
  win.contentView.addChildView(dock);
  wa.setBounds({ x: 0, y: 0, width: 620, height: 600 });
  dock.setBounds({ x: 620, y: 0, width: 380, height: 600 });
  const wc = wa.webContents;
  await wc.loadFile(path.join(__dirname, 'fixtures', 'wa-compose-new.html'));
  await dock.webContents.loadURL('data:text/html;charset=utf-8,<textarea id="in">你的 logo 可以发给我</textarea>');
  win.focus();
  const page = (code) => wc.executeJavaScript(code);
  const compose = () => page("document.getElementById('compose').innerText.replace(/\\n+$/, '')");
  const active = () => page("(() => { const a = document.activeElement; return a ? (a.id || a.getAttribute('data-id') || a.tagName) : ''; })()");
  // 用户在 WhatsApp 里点了某处（或什么都没点），然后在右边工作台里打字
  const userAt = async (code) => {
    wc.focus();
    await page(`(() => { ${code} })(); true`);
    dock.webContents.focus();
    await dock.webContents.executeJavaScript("document.getElementById('in').focus(); true");
    await wait(30);
  };
  let blocked = '';
  let copyOk = true;
  const realCopy = makeCopyText(clipboard);
  const insert = (text) => pasteToCompose(text, {
    blocked: () => blocked, wc: () => wc, focusCompose: waPage.focusCompose,
    copyText: (t) => (copyOk ? realCopy(t) : Promise.resolve(false)),
  });
  const settle = () => wait(150);
  const reset = (html = '<p class="selectable-text copyable-text" dir="auto"><br></p>') => page(`document.getElementById('compose').innerHTML = ${JSON.stringify(html)}; true`);
  const en = 'You can send me your logo and I\'ll help you with the design.';

  // 1. 用户点过一条消息（焦点在消息那一行上）
  await userAt("document.querySelector('[data-id]').focus()");
  check((await active()) === '3EB0C4A1F2D3E4B5A6978869504A3B2C', '准备：WhatsApp 页面里的焦点在消息上，工作台在打字');
  let r = await insert(en);
  await settle();
  check(r === 'ok' && (await compose()) === en, `焦点在消息上：放进了输入框（${r}，${JSON.stringify(await compose())}）`);
  check((await active()) === 'compose' && wc.isFocused(), '放完光标在 WhatsApp 的输入框里，可以接着改');
  check((await clipboard.readText()) === en, '剪贴板换成了这段（和以前一样，界面上写明了）');

  // 2. 光标在左上角搜索框里
  await reset();
  await userAt("document.getElementById('search').focus()");
  r = await insert('Hello Emma');
  await settle();
  check(r === 'ok' && (await compose()) === 'Hello Emma' && (await page("document.getElementById('search').value")) === '', `焦点在搜索框：放进输入框，搜索框里没有（${r}）`);

  // 3. 页面里哪里都没有焦点
  await reset();
  await userAt('document.activeElement && document.activeElement.blur()');
  check((await active()) === 'BODY', '准备：页面里没有焦点');
  r = await insert('Guten Tag');
  await settle();
  check(r === 'ok' && (await compose()) === 'Guten Tag', `哪里都没有焦点：放进输入框（${r}）`);

  // 4. 输入框里已经有字、焦点在别处：接在后面，不插到前面
  await reset('<p class="selectable-text copyable-text" dir="auto"><span data-lexical-text="true">Hi Emma, </span></p>');
  await userAt("document.querySelector('[data-id]').focus()");
  r = await insert('the samples ship today.');
  await settle();
  check(r === 'ok' && (await compose()) === 'Hi Emma, the samples ship today.', `输入框里已有字：接在后面（${JSON.stringify(await compose())}）`);

  // 5. 光标本来就在输入框中间：贴在光标处，不挪到最后
  await reset('<p class="selectable-text copyable-text" dir="auto"><span data-lexical-text="true">AB</span></p>');
  await userAt("const t = document.querySelector('#compose span').firstChild; document.getElementById('compose').focus(); const g = document.createRange(); g.setStart(t, 1); g.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(g)");
  r = await insert('-');
  await settle();
  check(r === 'ok' && (await compose()) === 'A-B', `光标已在输入框中间：贴在光标处（${JSON.stringify(await compose())}）`);

  // 6. 整个过程没有按键、没按 Enter、没点发送
  let ev = await page('window.__ev');
  check(ev.keys === 0 && ev.enter === 0 && ev.sendClicks === 0 && ev.sent.length === 0, '整个过程没有按键、没按 Enter、没点发送');

  // 7. 弹窗挡着（焦点被拉回弹窗）：不贴，返回 focus
  await reset();
  await page("document.getElementById('dialog').hidden = false; true");
  await userAt("document.getElementById('dialog-ok').focus()");
  await clipboard.writeText('ORIGINAL');
  r = await insert('blocked by dialog');
  await settle();
  check(r === 'focus' && (await compose()) === '' && (await clipboard.readText()) === 'ORIGINAL', `弹窗挡着放不进输入框：不贴、不碰剪贴板（${r}）`);
  await page("document.getElementById('dialog').hidden = true; true");

  // 8. 剪贴板没写上：不贴
  copyOk = false;
  await userAt("document.querySelector('[data-id]').focus()");
  r = await insert('clipboard busy');
  await settle();
  check(r === 'clip' && (await compose()) === '', `剪贴板没写上：不贴（${r}）`);
  copyOk = true;

  // 9. 写剪贴板期间换了号：不贴
  let calls = 0;
  r = await pasteToCompose('switched', {
    blocked: () => (calls++ >= 2 ? 'changed' : ''), wc: () => wc, focusCompose: waPage.focusCompose, copyText: realCopy,
  });
  await settle();
  check(r === 'changed' && (await compose()) === '', `写剪贴板期间换了号：不贴（${r}）`);

  // 10. 输入框不在 footer 里（以防 WhatsApp 再改）：按 data-testid 也认
  await page("const f = document.querySelector('footer'); f.replaceWith(...f.childNodes); true");
  await userAt("document.getElementById('search').focus()");
  r = await insert('testid');
  await settle();
  check(r === 'ok' && (await compose()) === 'testid', `输入框不在 footer 里：按 data-testid 找到（${r}）`);

  // 11. 没打开对话（右边是空白页）：不贴、不碰剪贴板，告诉用户先打开对话
  await page("document.getElementById('main').remove(); true");
  await userAt("document.getElementById('search').focus()");
  await clipboard.writeText('ORIGINAL');
  r = await insert('no chat');
  await settle();
  check(r === 'no_chat' && (await page("document.getElementById('search').value")) === '' && (await clipboard.readText()) === 'ORIGINAL', `没打开对话：不贴、不碰剪贴板（${r}）`);
  ev = await page('window.__ev');
  check(ev.keys === 0 && ev.enter === 0 && ev.sendClicks === 0, '后面几种情况也没有按键、没发送');
  win.destroy();
}

async function partC(win) {
  const wc = win.webContents;
  await win.loadFile(path.join(__dirname, 'fixtures', 'lite-draft.html'));
  const page = (code) => wc.executeJavaScript(code);
  await page(`(() => {
    const acc = { id: 'l1', proxyLabel: 'DE 7891', direct: false };
    const view = { rev: 1, jid: '4915123456789@s.whatsapp.net', title: 'Anna Müller', chats: [{ jid: '4915123456789@s.whatsapp.net', name: 'Anna Müller', ts: 0, unread: 1, preview: 'Hi' }], messages: [] };
    document.body.append(litePage(acc, { id: 'l1', status: 'open', openJid: view.jid, view }));
    return true;
  })()`);
  const box = () => page("document.querySelector('.lite-compose textarea').value");
  const fill = (req) => page(`window.__fill(${JSON.stringify(req)}).then(() => window.__filled.at(-1))`);

  let r = await fill({ n: 1, id: 'l1', jid: '4915123456789@s.whatsapp.net', text: 'Hallo Anna,\nGröße M ist da.', force: false, focus: false });
  check(r.n === 1 && r.r === 'ok' && (await box()) === 'Hallo Anna,\nGröße M ist da.', '轻量模式：草稿填进软件里的输入框（含换行）');
  check((await page('window.__sent.length')) === 0, '轻量模式：没有调用发送');
  r = await fill({ n: 2, id: 'l1', jid: '4915123456789@s.whatsapp.net', text: 'more', force: false, focus: false });
  check(r.r === 'not_empty' && (await box()) === 'Hallo Anna,\nGröße M ist da.', '轻量模式：输入框里有字时不填（直接放的情况）');
  r = await fill({ n: 3, id: 'l1', jid: '999@s.whatsapp.net', text: 'x', force: true, focus: false });
  check(r.r === 'chat', '轻量模式：要填的对话不是开着的那个时不填');
  check((await page('window.__sent.length')) === 0, '轻量模式：整个过程没有发送');
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 900, height: 600, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await partA();
    await partB(win);
    await partC(win);
    await partD();
  } catch (e) {
    out(`失败：出错 ${e && e.stack}`);
    failures += 1;
  }
  out(failures ? `\n${failures} 项失败` : '\n全部通过');
  app.exit(failures ? 1 : 0);
}).catch((e) => { out(`失败：${e && e.stack}`); app.exit(1); });
