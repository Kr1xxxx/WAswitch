// 设置 › 翻译（#209：翻译只走来财，桌面端不存任何 AI 密钥）：
//   1. 没有密钥框、服务商、翻译网络；简单设置有「译文显示在」和行业词汇，详细设置还有自动翻译、每天上限、角色设定、翻译模式
//   2. 来财能用时顶上什么都不提示；没开通、额度用完、没登录团队时一行黄条（没登录时不问来财）
//   3. 快捷设置的「翻译」格子跟着变，没登录时「登录」打开登录页
//   4. 900×600 下文字不裁、不挤成一字一行（设置页不和右侧工作台同时显示）
// 用真的 shell 页面 + 假的主进程（fixtures/trsettings-fake-preload.js）。用法：xvfb-run -a npx electron --no-sandbox scripts/check-tr-settings.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: true, width: 900, height: 600, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'fixtures', 'trsettings-fake-preload.js'), contextIsolation: false, sandbox: false } });
  const errs = [];
  w.webContents.on('console-message', (e) => { if (e.level === 'error' || /Error/.test(e.message || '')) errs.push(e.message); });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(f)) return true; await wait(50); } return false; };
  const shot = async (name) => { if (!process.env.SHOT_DIR) return; await wait(400); fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
  const base = { accounts: [{ id: 'a1', name: 'Lukas Becker', color: '#3b82f6', mode: 'web' }, { id: 'a2', name: 'Chloé Martin', color: '#16a34a', mode: 'lite' }], groups: [], activeId: 'a1', platform: 'linux', collapsed: false, settings: {}, page: 'settings' };
  const go = (login, tab, advanced) => js((st, t, adv) => {
    settingsTab = t; trAdvanced = adv; trCloud.st = null; trCloud.at = 0; trCloud.login = '';
    window.__cbs.state(st);
  }, { ...base, team: { login, joined: login !== 'none', policy: 'optional' } }, tab, advanced);
  const warnText = () => js(() => { const n = document.querySelector('.tr-warn'); return n ? n.textContent : ''; });
  // 设置页里看得见的文字：不能被裁（超出自己或超出页面右边），按钮、标签、标题不能挤成好几行
  const clipped = () => js(() => {
    const out = [];
    const main = document.querySelector('.settings-body') || document.querySelector('main') || document.body;
    const right = main.getBoundingClientRect().right + 1;
    for (const el of main.querySelectorAll('h1, h2, b, button, label, .title, .desc, .hint, .tr-warn, select, .qk-k, .qk-v, .qk-s, .tab')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
      const text = (el.textContent || el.value || '').trim().slice(0, 30);
      if (r.right > right) out.push(`${text} 超出右边 ${Math.round(r.right - right)}px`);
      const cs = getComputedStyle(el);
      if (cs.overflow !== 'visible' && el.tagName !== 'SELECT' && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis') out.push(`${text} 被裁 ${el.scrollWidth - el.clientWidth}px`);
      if (['BUTTON', 'H1', 'H2', 'LABEL'].includes(el.tagName) || el.classList.contains('tab') || el.classList.contains('tr-warn')) {
        // 文字实际排成了几行（看每段文字的位置，不看框的高度）
        const rg = document.createRange(); rg.selectNodeContents(el);
        const lines = new Set([...rg.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top / 4))).size;
        if (el.tagName !== 'LABEL' && lines > 1 && text.length <= 16) out.push(`${text} 换成了 ${lines} 行`);
      }
    }
    return out;
  });
  const NO = /密钥|智谱|混元|DeepL|OpenRouter|服务商|翻译网络|代理/;

  try {
    await js(() => { localStorage.clear(); });
    // 1) 登录着、来财能用：简单设置
    await go('ok', 'translate', false);
    await until(() => !!document.querySelector('.tr-head') && window.__calls.some((c) => c[0] === 'status'));
    await wait(100);
    assert.strictEqual(await warnText(), '', '能用时不提示');
    let page = await js(() => document.querySelector('.tr-head').parentElement.innerText);
    assert(!NO.test(page), `简单设置里不该再有密钥、服务商：${page}`);
    assert(/收到的消息译文显示在/.test(page) && /行业词汇/.test(page) && /假发词汇/.test(page) && /睫毛词汇/.test(page), page);
    assert.strictEqual(await js(() => document.querySelectorAll('input[type=password]').length), 0, '没有密钥框');
    assert.deepStrictEqual(await clipped(), [], '简单设置 900×600 文字不裁');
    await shot('tr-settings-simple-900');

    // 2) 详细设置：自动翻译、每天上限、角色设定、翻译模式都在，仍没有密钥和服务商
    await go('ok', 'translate', true);
    await until(() => /翻译模式/.test(document.querySelector('.tr-head').parentElement.innerText));
    page = await js(() => document.querySelector('.tr-head').parentElement.innerText);
    for (const t of ['回到简单设置', '收到的消息译文显示在', '自动翻译收到的消息', '每个号每天最多自动翻译', '角色设定', '假发词汇', '翻译模式', '商务正式', '+ 新建模式']) assert(page.includes(t), `详细设置缺「${t}」`);
    assert(!NO.test(page), `详细设置里不该再有密钥、服务商：${page}`);
    assert.deepStrictEqual(await clipped(), [], '详细设置 900×600 文字不裁');
    await shot('tr-settings-advanced-900');
    await js(() => { document.querySelector('.tr-head').parentElement.scrollTop = 1e6; const m = document.querySelector('main'); if (m) m.scrollTop = 1e6; });
    await shot('tr-settings-advanced-900-bottom');

    // 3) 没开通：一行黄条
    await js(() => { window.__status = { ready: false, overBudget: false }; });
    await go('ok', 'translate', false);
    await until(() => !!document.querySelector('.tr-warn'));
    assert.strictEqual(await warnText(), '翻译还没开通，请找管理员');
    assert.deepStrictEqual(await clipped(), [], '黄条 900×600 不裁');
    await shot('tr-settings-notready-900');
    // 4) 额度用完
    await js(() => { window.__status = { ready: true, overBudget: true }; });
    await go('ok', 'translate', false);
    await until(() => !!document.querySelector('.tr-warn'));
    assert.strictEqual(await warnText(), '本月翻译额度用完了，请找管理员');
    // 5) 没登录团队：黄条说先登录，不问来财
    await js(() => { window.__calls.splice(0); window.__status = { ready: true, overBudget: false }; });
    await go('none', 'translate', false);
    await until(() => !!document.querySelector('.tr-warn'));
    assert.strictEqual(await warnText(), '先登录团队才能翻译');
    assert(!(await js(() => window.__calls.some((c) => c[0] === 'status'))), '没登录时不问来财');
    await shot('tr-settings-nologin-900');

    // 6) 快捷设置的「翻译」格子
    const tile = () => js(() => { const t = [...document.querySelectorAll('.qk-tile')].find((x) => x.querySelector('.qk-k').textContent === '翻译'); return t ? { v: t.querySelector('.qk-v').textContent, s: (t.querySelector('.qk-s') || {}).textContent || '', act: (t.querySelector('button') || {}).textContent || '' } : null; });
    await go('none', 'quick', false);
    await until(() => !!document.querySelector('.qk-tile'));
    assert.deepStrictEqual(await tile(), { v: '没登录团队', s: '', act: '登录' });
    await js(() => [...document.querySelectorAll('.qk-tile')].find((x) => x.querySelector('.qk-k').textContent === '翻译').querySelector('button').click());
    assert(await js(() => window.__calls.some((c) => c[0] === 'login')), '点「登录」打开登录页');
    assert.deepStrictEqual(await clipped(), [], '快捷设置 900×600 文字不裁');
    await shot('tr-quick-nologin-900');
    await go('ok', 'quick', false);
    await until(() => { const t = [...document.querySelectorAll('.qk-tile')].find((x) => x.querySelector('.qk-k').textContent === '翻译'); return t && t.querySelector('.qk-v').textContent === '可以用'; });
    assert.deepStrictEqual(await tile(), { v: '可以用', s: '来财', act: '查看' });
    await js(() => { window.__status = { ready: false, overBudget: false }; });
    await go('ok', 'quick', false);
    await until(() => { const t = [...document.querySelectorAll('.qk-tile')].find((x) => x.querySelector('.qk-k').textContent === '翻译'); return t && t.querySelector('.qk-v').textContent === '还没开通'; });
    assert.deepStrictEqual(await tile(), { v: '还没开通', s: '请找管理员', act: '查看' });
    await shot('tr-quick-notready-900');

    assert.deepStrictEqual(errs, [], `页面报错：${errs.join('\n')}`);
    console.log('设置 › 翻译自检通过（只走来财，没有密钥框；黄条；快捷设置；900×600 不裁）');
    app.exit(0);
  } catch (e) {
    console.error(e, errs);
    app.exit(1);
  }
});
