// 左侧栏翻译页的 ⇄：还没翻过时也要先认出原文语言（Fable 审计 0.5.12 第 1 条）。
// 以前粘贴德语直接按 ⇄，会对调成 中文 → 英语；应该是 中文 → 德语。
// 用真的 shell 页面 + 假的主进程。用法：xvfb-run -a npx electron --no-sandbox scripts/check-tp-swap.js
const path = require('path');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

const scenario = async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__trcfg = { config: { langs: ['英语', '中文', '德语', '法语', '西班牙语'], providers: [{ id: 'z', name: '智谱', model: 'glm-4-flash' }], primaryId: 'z', fallbackId: '' } };
  window.__cbs.state({ accounts: [], groups: [], activeId: '', page: 'translate', panelOpen: false, platform: 'linux', collapsed: false });
  await wait(300);
  const input = document.querySelector('.tp-text');
  if (!input) return { error: '找不到翻译页的原文框 .tp-text' };
  const [src, tgt] = [...document.querySelectorAll('.tp-lang')];
  const swap = document.querySelector('.tp-swap');
  const reset = (text) => {
    tp.src = ''; tp.tgt = ''; tp.detected = '';
    for (const o of [tp.ui.o1, tp.ui.o2]) o.box.value = '';
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };
  const out = {};
  // 1) 德语，还没翻：中文 → 德语，原文留在左边
  const de = 'Hallo, ich möchte eine Perücke kaufen. Wie viel kostet das?';
  reset(de);
  out.deLabel = src.options[0].textContent;
  swap.click(); await wait(50);
  out.de = { src: src.value, tgt: tgt.value, text: input.value };
  // 再按一次：回到 德语 → 中文
  swap.click(); await wait(50);
  out.deBack = { src: src.value, tgt: tgt.value };
  // 2) 法语，还没翻
  reset('Bonjour, je voudrais savoir le prix avec livraison, merci'); swap.click(); await wait(50);
  out.fr = { src: src.value, tgt: tgt.value };
  // 3) 中文，还没翻：英语 → 中文（和以前一样）
  reset('这顶假发今天能发货吗？'); swap.click(); await wait(50);
  out.zh = { src: src.value, tgt: tgt.value };
  // 4) 认不出来的短句：按英语（和以前一样）
  reset('Guten Tag'); swap.click(); await wait(50);
  out.short = { src: src.value, tgt: tgt.value };
  // 5) 认出的语言不在下拉里：当认不出
  reset('Buongiorno, quanto costa la spedizione? Grazie'); swap.click(); await wait(50);
  out.notInList = { src: src.value, tgt: tgt.value };
  // 6) 翻过以后再按：译文换到左边，中文 → 德语
  window.__trPage = (a) => ({ text: '你好，我想买一顶假发。多少钱？', detected: a.source ? '' : '德语' });
  reset(de);
  document.querySelector('.tp-go').click();
  await wait(400);
  out.call = window.__trCalls[window.__trCalls.length - 1];
  swap.click(); await wait(50);
  out.after = { src: src.value, tgt: tgt.value, text: input.value };
  // 6b) 翻完德语不清空，直接换成法语再按：按法语对调，不用上次认出的德语
  window.__trPage = () => ({ text: '你好，我想买一顶假发。多少钱？', detected: '德语' });
  tp.src = ''; tp.tgt = ''; input.value = de; input.dispatchEvent(new Event('input'));
  document.querySelector('.tp-go').click();
  await wait(400);
  input.value = 'Bonjour, je voudrais savoir le prix avec livraison, merci'; input.dispatchEvent(new Event('input'));
  out.frLabel = src.options[0].textContent;
  swap.click(); await wait(50);
  out.frAfterDe = { src: src.value, tgt: tgt.value };
  // 7) 德语按 ⇄ 后再翻：发给主进程的是 中文 → 德语，不是 中文 → 英语
  reset(de); swap.click(); await wait(50);
  input.value = '这顶假发多少钱？'; input.dispatchEvent(new Event('input'));
  document.querySelector('.tp-go').click();
  await wait(400);
  out.call2 = window.__trCalls[window.__trCalls.length - 1];
  return out;
};

app.whenReady().then(async () => {
  const errs = [];
  const w = new BrowserWindow({ show: true, width: 1200, height: 760, webPreferences: { preload: path.join(__dirname, 'fixtures', 'dock-fake-preload.js'), contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  w.webContents.on('console-message', (e) => { const m = e.message || ''; if (e.level === 'error' || /Error/.test(m)) errs.push(m); });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const r = await w.webContents.executeJavaScript(`(${scenario})()`);
  assert(!r.error, r.error);
  assert.strictEqual(r.deLabel, '自动检测（德语）', '没翻过时下拉显示认出的语言');
  assert.deepStrictEqual(r.de, { src: '中文', tgt: '德语', text: 'Hallo, ich möchte eine Perücke kaufen. Wie viel kostet das?' }, '德语没翻过就按 ⇄');
  assert.deepStrictEqual(r.deBack, { src: '德语', tgt: '中文' }, '再按一次 ⇄');
  assert.deepStrictEqual(r.fr, { src: '中文', tgt: '法语' }, '法语没翻过就按 ⇄');
  assert.deepStrictEqual(r.zh, { src: '英语', tgt: '中文' }, '中文没翻过就按 ⇄');
  assert.deepStrictEqual(r.short, { src: '中文', tgt: '英语' }, '认不出的短句按英语');
  assert.deepStrictEqual(r.notInList, { src: '中文', tgt: '英语' }, '下拉里没有的语言当认不出');
  assert.deepStrictEqual({ source: r.call.source, target: r.call.target }, { source: '', target: '中文' }, '德语自动翻成中文');
  assert.deepStrictEqual(r.after, { src: '中文', tgt: '德语', text: '你好，我想买一顶假发。多少钱？' }, '翻过以后按 ⇄');
  assert.strictEqual(r.frLabel, '自动检测（法语）', '原文换了，下拉跟着换');
  assert.deepStrictEqual(r.frAfterDe, { src: '中文', tgt: '法语' }, '翻完德语换成法语再按 ⇄');
  assert.deepStrictEqual({ source: r.call2.source, target: r.call2.target }, { source: '中文', target: '德语' }, '对调后再翻');
  assert.deepStrictEqual(errs, [], '页面没有报错');
  console.log('翻译页 ⇄ 自检通过（没翻过：德语 → 中文 ⇄ 中文 → 德语；翻过：译文换到左边）');
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
