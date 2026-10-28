// 左侧栏「翻译」页（shen 2026-10-28 选的方案 A）：左边原文，右边两个模型的译文上下对照，
// 每栏自己选模型，第二栏可以收起（收起后只翻第一栏）。不跟任何对话绑定，不读、不碰 WhatsApp 页面。
// 自动 = 中文翻成英语，别的语言翻成中文（和工作台回复同一套规则，见 reply-lang.js）。
// 页面元素只建一次，之后原地更新：按钮状态的过渡动画才能播出来，打字时也不会被重画打断。
// 用到 shell.js 的 h、icon、trOpenKey（运行时才调用，加载顺序没关系）。

const TP_KEY = 'trPage';
const TP_HIST_MAX = 20;
const TP_RESET_MS = 1800;
const tp = {
  el: null,
  cfg: null, // tr:config 的 config
  src: '', // 手动选的原文语言，'' = 自动检测
  tgt: '', // 手动选的目标语言，'' = 自动选择
  detected: '', // 上次翻译认出来的原文语言（只显示）
  p1: '', p2: '', open2: true,
  hist: [],
  busy: false,
  ui: null,
};

function tpLoadPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(TP_KEY) || '{}');
    if (typeof v.p1 === 'string') tp.p1 = v.p1;
    if (typeof v.p2 === 'string') tp.p2 = v.p2;
    if (typeof v.open2 === 'boolean') tp.open2 = v.open2;
    if (Array.isArray(v.hist)) tp.hist = v.hist.filter((x) => x && typeof x.src === 'string' && typeof x.out === 'string').slice(0, TP_HIST_MAX);
  } catch {}
}
function tpSavePrefs() {
  try { localStorage.setItem(TP_KEY, JSON.stringify({ p1: tp.p1, p2: tp.p2, open2: tp.open2, hist: tp.hist })); } catch {}
}

// 按钮原地变：空闲 → 进行中（不能点）→ 成功（1.8 秒后复原）/ 失败（停住等重试）。宽度固定，不挤动旁边
function tpMorph(cls, labels, onclick) {
  const layers = {};
  const btn = h('button', { class: `tp-morph ${cls}`, type: 'button', 'data-state': 'idle', onclick: () => { if (btn.dataset.state !== 'loading') onclick(); } },
    ...['idle', 'loading', 'success', 'error'].filter((k) => labels[k]).map((k) => {
      layers[k] = h('span', { class: `tp-layer tp-${k}` },
        k === 'loading' ? h('span', { class: 'tp-spin', 'aria-hidden': 'true' }) : k === 'success' ? icon('check', 14) : k === 'error' ? icon('warn', 14) : null,
        labels[k]);
      return layers[k];
    }));
  let timer = null;
  btn.setState = (st) => {
    clearTimeout(timer);
    btn.dataset.state = st;
    btn.disabled = st === 'loading';
    btn.setAttribute('aria-busy', String(st === 'loading'));
    btn.setAttribute('aria-label', labels[st] || labels.idle);
    if (st === 'success') timer = setTimeout(() => btn.setState('idle'), TP_RESET_MS);
  };
  btn.setState('idle');
  return btn;
}

function tpProviders() { return (tp.cfg && tp.cfg.providers) || []; }
function tpProvName(p) { return p.model ? `${p.name} ${p.model}` : p.name; }
// 选的模型被删了：第一栏回到默认服务商，第二栏用备用的或别的一个
function tpFixPicks() {
  const provs = tpProviders();
  const has = (id) => provs.some((p) => p.id === id);
  if (!has(tp.p1)) tp.p1 = (tp.cfg && has(tp.cfg.primaryId) ? tp.cfg.primaryId : provs[0] && provs[0].id) || '';
  if (!has(tp.p2) || tp.p2 === tp.p1) {
    const fb = tp.cfg && tp.cfg.fallbackId;
    tp.p2 = (has(fb) && fb !== tp.p1 ? fb : (provs.find((p) => p.id !== tp.p1) || {}).id) || '';
  }
}

function tpLangs() { return (tp.cfg && tp.cfg.langs) || ['英语', '中文']; }
function tpPick(text) { return ReplyLang.pick({ text, src: tp.src, manual: tp.tgt, autoTarget: '英语' }); }

function tpModelSel(which) {
  const sel = h('select', { class: 'tp-model', 'aria-label': which === 1 ? '上面这栏的模型' : '下面这栏的模型', onchange: (e) => {
    if (which === 1) tp.p1 = e.target.value; else tp.p2 = e.target.value;
    tpSavePrefs();
    tpRerun(which);
  } });
  return sel;
}
function tpFillModels(sel, cur) {
  const provs = tpProviders();
  const want = provs.map((p) => `${p.id}=${tpProvName(p)}`).join('|');
  if (sel.dataset.list !== want) {
    sel.replaceChildren(...provs.map((p) => h('option', { value: p.id }, tpProvName(p))));
    sel.dataset.list = want;
  }
  sel.value = cur;
  sel.classList.toggle('single', provs.length < 2);
  sel.disabled = tp.busy || provs.length < 2;
  tpFitSelect(sel);
}
// 下拉框按选中的名字定宽（原生 select 会按最长的选项撑开，箭头离字很远）
let tpCanvas = null;
function tpFitSelect(sel) {
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !sel.isConnected) return;
  const cs = getComputedStyle(sel);
  tpCanvas = tpCanvas || document.createElement('canvas');
  const c = tpCanvas.getContext('2d');
  c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2;
  sel.style.width = `${Math.ceil(c.measureText(opt.textContent).width + pad)}px`;
}

function tpOutPane(which) {
  const box = h('textarea', { class: 'tp-text', 'aria-label': which === 1 ? '译文' : '对照译文', spellcheck: 'false' });
  const err = h('div', { class: 'tp-err', role: 'alert', hidden: true });
  const model = tpModelSel(which);
  const copy = tpMorph('tp-copy', { idle: '复制', success: '已复制' }, async () => {
    if (!box.value.trim()) return;
    await window.wa.panelCopy(box.value);
    copy.setState('success');
  });
  const foot = h('div', { class: 'tp-foot' }, model, h('span', { class: 'grow' }));
  // 报错放在译文本来出现的位置（左上）
  const pane = h('div', { class: 'tp-pane tp-out' }, err, box, foot);
  const o = { pane, box, err, model, copy, foot };
  if (which === 1) {
    // 纠错只在翻成外文时有用（中文译文自己就能看懂）
    o.fix = tpMorph('tp-fix', { idle: '纠错', loading: '纠错中', success: '已纠错', error: '重试' }, () => tpFix());
    foot.append(o.fix);
  } else {
    o.fold = h('button', { class: 'tp-icon tp-fold', type: 'button', 'aria-label': '收起对照', 'aria-expanded': 'true', onclick: () => tpSetOpen2(false) }, icon('up', 14));
    foot.append(o.fold);
  }
  foot.append(copy);
  return o;
}

function tpBuild() {
  tpLoadPrefs();
  const input = h('textarea', { class: 'tp-text', placeholder: '输入或粘贴文字', 'aria-label': '原文', spellcheck: 'false' });
  input.addEventListener('input', () => { tpIdle(); tpLabels(); tpUpdate(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); tpRun(); }
  });
  const clear = h('button', { class: 'tp-icon', type: 'button', 'aria-label': '清空', onclick: () => {
    input.value = '';
    for (const o of [ui.o1, ui.o2]) { o.box.value = ''; tpShowOut(o, null); }
    tp.detected = '';
    tpIdle(); tpLabels(); tpUpdate(); input.focus();
  } }, icon('close', 14));
  const go = tpMorph('tp-go', { idle: '翻译', loading: '翻译中', success: '已翻译', error: '重试' }, () => tpRun());
  const src = h('select', { class: 'tp-lang', 'aria-label': '原文语言', onchange: (e) => { tp.src = e.target.value === '__auto' ? '' : e.target.value; tpLabels(); } });
  const tgt = h('select', { class: 'tp-lang', 'aria-label': '目标语言', onchange: (e) => { tp.tgt = e.target.value === '__auto' ? '' : e.target.value; tpLabels(); } });
  const swap = h('button', { class: 'tp-icon tp-swap', type: 'button', 'aria-label': '对调语言', onclick: () => tpSwap() }, icon('swap', 16));
  const o1 = tpOutPane(1);
  const o2 = tpOutPane(2);
  const open2 = h('button', { class: 'tp-open2', type: 'button', 'aria-expanded': 'false', onclick: () => tpSetOpen2(true) },
    h('span', null, '对照'), h('span', { class: 'tp-open2-model' }), h('span', { class: 'grow' }), icon('down', 14));
  const histList = h('div', { class: 'tp-hist-list' });
  const hist = h('div', { class: 'tp-hist' },
    h('div', { class: 'tp-hist-head' }, h('span', null, '最近记录'),
      h('button', { class: 'tp-link', type: 'button', onclick: () => tpClearHist() }, '清空')),
    histList);
  const undo = h('div', { class: 'tp-undo', role: 'status', hidden: true }, h('span', null, '已清空最近记录'),
    h('button', { class: 'tp-undo-btn', type: 'button', onclick: () => tpUndoHist() }, '撤销'));
  const ui = { input, go, src, tgt, swap, o1, o2, open2, hist, histList, undo };
  tp.ui = ui;
  tp.el = h('div', { class: 'tp' },
    h('div', { class: 'tp-head' }, h('h1', null, '翻译')),
    h('div', { class: 'tp-body' },
      h('div', { class: 'tp-bar' }, src, swap, tgt),
      h('div', { class: 'tp-grid' },
        h('div', { class: 'tp-pane tp-in' }, input, h('div', { class: 'tp-foot' }, h('span', { class: 'grow' }), clear, go)),
        h('div', { class: 'tp-outs' }, o1.pane, o2.pane, open2)),
      hist, undo));
  tpHist();
  return tp.el;
}

// 改了原文或清空：主按钮回到「翻译」（不留着上一次的已翻译 / 重试）
function tpIdle() {
  const go = tp.ui.go;
  if (go.dataset.state !== 'loading' && go.dataset.state !== 'idle') go.setState('idle');
}

// 清空最近记录：直接清，8 秒内可以撤销
let tpUndoTimer = null;
let tpUndoList = null;
function tpClearHist() {
  if (!tp.hist.length) return;
  tpUndoList = tp.hist;
  tp.hist = [];
  tpSavePrefs();
  tpHist();
  tp.ui.undo.hidden = false;
  clearTimeout(tpUndoTimer);
  tpUndoTimer = setTimeout(() => { tp.ui.undo.hidden = true; tpUndoList = null; }, 8000);
}
function tpUndoHist() {
  clearTimeout(tpUndoTimer);
  tp.ui.undo.hidden = true;
  if (!tpUndoList) return;
  // 撤销期间又翻了新的：新的在前，旧的接在后面
  tp.hist = [...tp.hist, ...tpUndoList.filter((x) => !tp.hist.some((y) => y.src === x.src))].slice(0, TP_HIST_MAX);
  tpUndoList = null;
  tpSavePrefs();
  tpHist();
}

// 语言下拉的“自动”那一项带上现在的结果：自动检测（英语）、自动选择（中文）
function tpLabels() {
  const ui = tp.ui;
  const text = ui.input.value;
  const r = tpPick(text);
  const srcAuto = text.trim() ? (r.source || tp.detected) : '';
  const fill = (sel, autoLabel, list, cur) => {
    const want = ['__auto', ...list].join('|');
    if (sel.dataset.list !== want) {
      sel.replaceChildren(h('option', { value: '__auto' }), ...list.map((l) => h('option', { value: l }, l)));
      sel.dataset.list = want;
    }
    sel.options[0].textContent = autoLabel;
    sel.value = cur || '__auto';
  };
  const langs = tpLangs();
  fill(ui.src, srcAuto ? `自动检测（${srcAuto}）` : '自动检测', ['中文', ...langs.filter((l) => l !== '中文')], tp.src);
  fill(ui.tgt, text.trim() || tp.tgt ? `自动选择（${r.target}）` : '自动选择', langs, tp.tgt);
}

function tpSetOpen2(on) {
  tp.open2 = on;
  tpSavePrefs();
  tpUpdate();
  (on ? tp.ui.o2.fold : tp.ui.open2).focus();
  if (on) tpFillCompare();
}

// 栏里的报错：服务商名在底栏已经有了，这里只说缺什么，后面跟一个去处理的链接
function tpShowOut(o, r) {
  const err = r && r.error ? r : null;
  o.err.replaceChildren();
  o.err.hidden = !err;
  o.box.hidden = !!err;
  if (!err) return;
  if (err.kind === 'auth' && err.providerId) {
    const p = tpProviders().find((x) => x.id === err.providerId);
    o.err.append(h('span', null, p && !p.hasKey ? '密钥未填写' : '密钥无效'),
      h('button', { class: 'tp-link', type: 'button', onclick: () => trOpenKey(err.providerId) }, p && !p.hasKey ? '填写' : '修改'));
  } else if (err.kind === 'config') {
    o.err.append(h('span', null, err.error),
      h('button', { class: 'tp-link', type: 'button', onclick: () => { settingsTab = 'translate'; window.wa.showPage('settings'); render(true); } }, '设置'));
  } else o.err.append(h('span', null, err.error));
}
// 只有网络、超时、服务商忙这类重试可能有用的失败，主按钮才变「重试」
const TP_RETRY = ['network', 'timeout', 'overload', 'server', 'busy', 'empty', 'other'];

function tpUpdate() {
  const ui = tp.ui;
  if (!ui) return;
  const provs = tpProviders();
  tpFillModels(ui.o1.model, tp.p1);
  tpFillModels(ui.o2.model, tp.p2);
  // 只有一个模型时没东西可对照，第二栏整个不显示
  const canCompare = provs.length > 1;
  ui.o2.pane.hidden = !canCompare || !tp.open2;
  ui.open2.hidden = !canCompare || tp.open2;
  const p2 = provs.find((p) => p.id === tp.p2);
  ui.open2.querySelector('.tp-open2-model').textContent = p2 ? tpProvName(p2) : '';
  ui.go.disabled = tp.busy || !ui.input.value.trim();
  ui.swap.disabled = tp.busy;
  const toForeign = tpPick(ui.input.value).target !== '中文';
  ui.o1.fix.hidden = !toForeign || !ui.o1.box.value.trim() || !ui.input.value.trim();
  ui.o1.fix.disabled = tp.busy;
  // 没译文时「复制」先藏起来（位置留着，有了译文不跳）
  for (const o of [ui.o1, ui.o2]) o.copy.style.visibility = o.box.value.trim() ? '' : 'hidden';
  tpFitSelect(ui.o1.model); tpFitSelect(ui.o2.model);
}

function tpHist() {
  const ui = tp.ui;
  ui.hist.hidden = !tp.hist.length;
  ui.histList.replaceChildren(...tp.hist.map((x) => h('button', { class: 'tp-hrow', type: 'button', title: x.src, onclick: () => {
    ui.input.value = x.src;
    ui.o1.box.value = x.out;
    ui.o2.box.value = '';
    tp.detected = '';
    tpShowOut(ui.o1, null); tpShowOut(ui.o2, null);
    tpIdle(); tpLabels(); tpUpdate();
  } },
  h('span', { class: 'tp-hsrc' }, x.src),
  h('span', { class: 'tp-hout' }, h('span', { class: 'tp-hout-text' }, x.out), h('span', { class: 'tp-htime' }, tpTime(x.at))))));
}
function tpTime(at) {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

async function tpRun() {
  const ui = tp.ui;
  const text = ui.input.value;
  if (tp.busy || !text.trim()) return;
  if (!tp.cfg) await tpLoadCfg();
  const { source, target } = tpPick(text);
  const both = tp.open2 && tpProviders().length > 1;
  tp.busy = true;
  ui.go.setState('loading');
  for (const o of both ? [ui.o1, ui.o2] : [ui.o1]) { o.box.value = ''; tpShowOut(o, null); }
  // 收着的对照栏清掉旧译文，免得展开时看到上一句的
  if (!both) { ui.o2.box.value = ''; tpShowOut(ui.o2, null); }
  tpUpdate();
  let r1;
  try { r1 = await window.wa.trPage({ text, source, target, providerId: tp.p1 }); } catch { r1 = { error: '翻译失败' }; }
  if (r1 && !r1.error) ui.o1.box.value = r1.text; else tpShowOut(ui.o1, r1);
  tp.detected = (r1 && r1.detected) || '';
  if (both) await tpRunOne(ui.o2, { text, source, target, providerId: tp.p2 });
  tp.busy = false;
  const ok = r1 && !r1.error;
  ui.go.setState(ok ? 'success' : TP_RETRY.includes(r1 && r1.kind) || !(r1 && r1.kind) ? 'error' : 'idle');
  if (ok) {
    tp.hist = [{ src: text, out: r1.text, from: source || tp.detected, to: target, at: Date.now() }, ...tp.hist.filter((x) => x.src !== text)].slice(0, TP_HIST_MAX);
    tpSavePrefs();
    tpHist();
  }
  tpLabels();
  tpUpdate();
}
async function tpRunOne(o, req) {
  let r;
  try { r = await window.wa.trPage(req); } catch { r = { error: '翻译失败' }; }
  if (r && !r.error) o.box.value = r.text; else tpShowOut(o, r);
}

// 换了某一栏的模型：这一栏有过译文（或报错）就用新模型重翻这一栏
async function tpRerun(which) {
  const ui = tp.ui;
  const o = which === 1 ? ui.o1 : ui.o2;
  const text = ui.input.value;
  if (tp.busy || !text.trim() || (!o.box.value.trim() && o.err.hidden)) return;
  const { source, target } = tpPick(text);
  tp.busy = true;
  o.box.value = ''; tpShowOut(o, null);
  tpUpdate();
  await tpRunOne(o, { text, source, target, providerId: which === 1 ? tp.p1 : tp.p2 });
  tp.busy = false;
  tpUpdate();
}

// 展开对照栏时：上面已经有译文、对照栏还空着，就只补翻对照这一栏
async function tpFillCompare() {
  const ui = tp.ui;
  const text = ui.input.value;
  if (tp.busy || !text.trim() || !ui.o1.box.value.trim() || ui.o2.box.value.trim()) return;
  const { source, target } = tpPick(text);
  tp.busy = true;
  tpUpdate();
  await tpRunOne(ui.o2, { text, source, target, providerId: tp.p2 });
  tp.busy = false;
  tpUpdate();
}

async function tpFix() {
  const ui = tp.ui;
  const text = ui.input.value;
  const draft = ui.o1.box.value;
  if (tp.busy || !text.trim() || !draft.trim()) return;
  const { source, target } = tpPick(text);
  tp.busy = true;
  ui.o1.fix.setState('loading');
  tpUpdate();
  let r;
  try { r = await window.wa.trPage({ text, source, target, fix: true, draft }); } catch { r = { error: '纠错失败' }; }
  tp.busy = false;
  if (r && !r.error) { ui.o1.box.value = r.text; tpShowOut(ui.o1, null); ui.o1.fix.setState('success'); } else { tpShowOut(ui.o1, r); ui.o1.fix.setState('error'); }
  tpUpdate();
}

// ⇄：原文语言和目标语言对调；有译文就把译文换到左边当原文
function tpSwap() {
  const ui = tp.ui;
  const next = ReplyLang.swap({ text: ui.input.value, src: tp.src || tp.detected, manual: tp.tgt, autoTarget: '英语' });
  tp.src = next.src;
  tp.tgt = next.manual;
  if (ui.o1.box.value.trim()) {
    ui.input.value = ui.o1.box.value;
    ui.o1.box.value = '';
    ui.o2.box.value = '';
    tpShowOut(ui.o1, null); tpShowOut(ui.o2, null);
  }
  tp.detected = '';
  tpLabels();
  tpUpdate();
}

async function tpLoadCfg() {
  let r = null;
  try { r = await window.wa.trConfig(); } catch {}
  if (!r || !r.config) return;
  tp.cfg = r.config;
  tpFixPicks();
  tpSavePrefs();
  if (tp.ui) { tpLabels(); tpUpdate(); }
}

// shell.js 的 render 每次显示翻译页时调用：返回同一个元素；刚切进来时重新读一次服务商（设置里可能改过）
function trPage(entering) {
  if (!tp.el) { tpBuild(); tpLabels(); tpUpdate(); }
  if (entering) {
    tpLoadCfg();
    setTimeout(() => { if (tp.ui && document.contains(tp.ui.input)) tp.ui.input.focus(); }, 0);
  }
  return tp.el;
}
