// 设置里的翻译密钥：智谱、腾讯混元、DeepL 三个总有密钥框。
// 0.5.4 起新装的出厂只有智谱 + DeepL，简单设置里就找不到混元的密钥框，翻译页右上角的「腾讯混元 未启用」点了也没地方填（shen 2026-10-28「windows 为什么没有混元密钥」）。
// 用真的 shell 页面 + 假的主进程（fixtures/trkeys-fake-preload.js）。用法：xvfb-run -a npx electron --no-sandbox scripts/check-tr-keys.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: true, width: 1200, height: 800, webPreferences: { preload: path.join(__dirname, 'fixtures', 'trkeys-fake-preload.js'), contextIsolation: false, sandbox: false } });
  const errs = [];
  w.webContents.on('console-message', (e) => { if (e.level === 'error' || /Error/.test(e.message || '')) errs.push(e.message); });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const js = (f, ...a) => w.webContents.executeJavaScript(`(${f})(${a.map((x) => JSON.stringify(x)).join(',')})`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => { if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
  const base = { accounts: [{ id: 'a1', name: 'Lukas', color: '#3b82f6', mode: 'web' }], groups: [], activeId: 'a1', platform: 'linux', collapsed: false, settings: {} };
  const go = (page) => js((st) => window.__cbs.state(st), { ...base, page });
  // 密钥框那几行：名字、有没有角色标签、输入框是不是有焦点
  const rows = () => js(() => [...document.querySelectorAll('.tr-krow')].map((r) => ({
    name: r.querySelector('.title b').textContent,
    tags: [...r.querySelectorAll('.pn-tag')].map((t) => t.textContent),
    focused: document.activeElement === r.querySelector('input[type=password]'),
  })));

  try {
    await js(() => { localStorage.clear(); });
    // 1) 翻译页右上角：混元「未启用」，点它 → 设置里混元的密钥框，光标在里面
    await go('translate');
    await wait(400);
    const prov = await js(() => [...document.querySelectorAll('.tp-prov')].map((b) => b.textContent));
    assert(prov.some((t) => t.includes('腾讯混元') && t.includes('未启用')), `翻译页右上角应有「腾讯混元 未启用」 ${JSON.stringify(prov)}`);
    await js(() => [...document.querySelectorAll('.tp-prov')].find((b) => b.textContent.includes('腾讯混元')).click());
    await wait(100);
    let calls = await js(() => window.__calls.slice());
    assert(calls.some((c) => c[0] === 'page' && c[1] === 'settings'), `点混元应打开设置 ${JSON.stringify(calls)}`);
    await go('settings');
    await wait(300);
    let r = await rows();
    assert.deepStrictEqual(r.map((x) => x.name).sort(), ['DeepL', '智谱', '腾讯混元'].sort(), `简单设置应有三个密钥框 ${JSON.stringify(r)}`);
    const hy = r.find((x) => x.name === '腾讯混元');
    assert.deepStrictEqual(hy.tags, [], '还没加的混元不该带默认、备用、纠错标签');
    assert(hy.focused, '从翻译页点过来，光标应在混元的密钥框里');
    const hyDesc = await js(() => [...document.querySelectorAll('.tr-krow')].find((x) => x.querySelector('.title b').textContent === '腾讯混元').querySelector('.desc').textContent);
    assert.strictEqual(hyDesc, 'hy-mt2-plus');
    await shot('hunyuan-row');

    // 2) 填混元密钥、保存：新加一个混元服务商（不带 id），用出厂的地址和模型，保存后测试新加的那个
    await js(() => window.__calls.splice(0));
    await js(() => {
      const row = [...document.querySelectorAll('.tr-krow')].find((x) => x.querySelector('.title b').textContent === '腾讯混元');
      const inp = row.querySelector('input[type=password]');
      inp.value = 'sk-test-0000hyk1';
      row.querySelector('button').click();
    });
    await wait(400);
    calls = await js(() => window.__calls.slice());
    const save = calls.find((c) => c[0] === 'save');
    assert(save, `应调用保存 ${JSON.stringify(calls)}`);
    assert.strictEqual(save[1].id, undefined, '新加的服务商不带 id');
    assert.strictEqual(save[1].preset, 'hunyuan');
    assert.strictEqual(save[1].model, 'hy-mt2-plus');
    assert.strictEqual(save[1].baseUrl, 'https://tokenhub.tencentmaas.com/v1');
    assert(calls.some((c) => c[0] === 'test' && c[1] === 'new1'), `保存后应测试新加的混元 ${JSON.stringify(calls)}`);
    r = await rows();
    assert.strictEqual(r.filter((x) => x.name === '腾讯混元').length, 1, `保存后混元只剩一行 ${JSON.stringify(r)}`);
    const ph = await js(() => [...document.querySelectorAll('.tr-krow')].find((x) => x.querySelector('.title b').textContent === '腾讯混元').querySelector('input').placeholder);
    assert.strictEqual(ph, '已保存 ••hyk1');
    // 保存后这一行换成了新 id：按钮还要接着显示「已保存」（Fable 审计 #238 必修 1）
    const btnSt = await js(() => [...document.querySelectorAll('.tr-krow')].find((x) => x.querySelector('.title b').textContent === '腾讯混元').querySelector('button').dataset.st);
    assert.strictEqual(btnSt, 'ok', `保存并测试通过后混元的按钮应是「已保存」 ${btnSt}`);

    // 3) 智谱、DeepL 原来的行不变：智谱带默认、纠错，DeepL 带备用
    assert.deepStrictEqual(r.find((x) => x.name === '智谱').tags, ['默认', '纠错']);
    assert.deepStrictEqual(r.find((x) => x.name === 'DeepL').tags, ['备用']);

    // 4) 服务商都删光了：三个密钥框还在，都不带标签
    await js(() => { window.__cfg.providers = []; window.__cfg.primaryId = ''; window.__cfg.fallbackId = ''; window.__cfg.fixId = ''; });
    await js(() => { tr.cfg = null; });
    await go('translate');
    await wait(200);
    await go('settings');
    await js(() => trLoad());
    await wait(300);
    r = await rows();
    assert.deepStrictEqual(r.map((x) => x.name), ['智谱', '腾讯混元', 'DeepL'], `删光后应有三个空密钥框 ${JSON.stringify(r)}`);
    assert(r.every((x) => !x.tags.length), `空行不带标签 ${JSON.stringify(r)}`);

    assert.deepStrictEqual(errs, [], `页面报错：${errs.join('\n')}`);
    console.log('check-tr-keys: OK');
    app.exit(0);
  } catch (e) {
    console.error(e, errs);
    app.exit(1);
  }
});
