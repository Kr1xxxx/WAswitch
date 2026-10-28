// 左侧栏「翻译」页（shen 2026-10-28 选的方案 A）：左边原文，右边两个模型的译文上下对照，
// 每栏自己选模型，第二栏可以收起（收起后只翻第一栏）。不跟任何对话绑定，不读、不碰 WhatsApp 页面。
// 自动 = 中文翻成英语，别的语言翻成中文（和工作台回复同一套规则，见 reply-lang.js）。
// 页面元素只建一次，之后原地更新：按钮状态的过渡动画才能播出来，打字时也不会被重画打断。
// 用到 shell.js 的 h、icon、trOpenKey（运行时才调用，加载顺序没关系）。

const TP_KEY = 'trPage';
const TP_HIST_MAX = 10; // 最近记录最多留十条；记录区固定五行高，多的在区内滚动
const tp = {
  el: null,
  cfg: null, // tr:config 的 config
  src: '', // 手动选的原文语言，'' = 自动检测
  tgt: '', // 手动选的目标语言，'' = 自动选择
  detected: '', // 上次翻译认出来的原文语言（只显示）
  p1: '', p2: '', open2: true,
  autoFold: false, // 原文太长（超出输入框）：这一次自动收起对照栏，只翻一栏（不改记下的展开/收起）
  hist: [],
  busy: false,
  cancelled: false, // 这次翻译被取消了：第二栏不再翻
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

// 状态按钮用 shell.js 的 morphBtn（和设置里的保存、测试同一套）。_off = 不能点
function tpOff(btn, off) {
  if (btn._off === off) return;
  btn._off = off;
  morphPaint(btn);
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
    // 对照栏收着时上面可以选任何模型；和对照栏撞了，对照栏换成另一个，旧的对照译文清掉
    const p2 = tp.p2;
    tpFixPicks();
    if (tp.p2 !== p2) { tp.ui.o2.box.value = ''; tpShowOut(tp.ui.o2, null); }
    tpSavePrefs();
    tpRerun(which);
  } });
  return sel;
}
// taken：另一栏正在用的模型，在这里置灰不能选（两栏不对照同一个模型）
function tpFillModels(sel, cur, taken) {
  const provs = tpProviders();
  const want = `${taken}>` + provs.map((p) => `${p.id}=${tpProvName(p)}`).join('|');
  if (sel.dataset.list !== want) {
    sel.replaceChildren(...provs.map((p) => h('option', { value: p.id, disabled: p.id === taken && p.id !== cur }, tpProvName(p))));
    sel.dataset.list = want;
  }
  sel.value = cur;
  const free = provs.filter((p) => p.id !== taken).length;
  sel.classList.toggle('single', free < 2);
  sel.disabled = tp.busy || free < 2;
  tpFitSelect(sel);
}
// 纠错要能看懂改过的译文：混元 hy-mt 和 DeepL 只会照原文重翻，这两种不给纠错
function tpCanFix(id) {
  const p = tpProviders().find((x) => x.id === id);
  return !!p && p.preset !== 'deepl' && !/^hy-mt/i.test(p.model || '');
}
// 下拉框按选中的名字定宽（原生 select 会按最长的选项撑开，箭头离字很远）
// 用一个看不见的同字号文字量宽度（字号写在 CSS 的 .tp-measure 里）
let tpMeasure = null;
function tpFitSelect(sel) {
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !sel.isConnected) return;
  if (!tpMeasure || !tpMeasure.isConnected) { tpMeasure = h('span', { class: 'tp-measure', 'aria-hidden': 'true' }); tp.el.append(tpMeasure); }
  tpMeasure.textContent = opt.textContent;
  const cs = getComputedStyle(sel);
  const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2;
  sel.style.width = `${Math.ceil(tpMeasure.getBoundingClientRect().width + pad)}px`;
}

// 字符数：放在底栏按钮左边，灰色小字；没字时不显示
function tpCountEl() { return h('span', { class: 'tp-count', 'aria-live': 'off' }); }
function tpCount(el, text) {
  const n = [...String(text || '').trim()].length;
  el.textContent = n ? `${n} 字符` : '';
}

function tpOutPane(which) {
  const box = h('textarea', { class: 'tp-text', 'aria-label': which === 1 ? '译文' : '对照译文', spellcheck: 'false' });
  const err = h('div', { class: 'tp-err', role: 'alert', hidden: true });
  const model = tpModelSel(which);
  const count = tpCountEl();
  box.addEventListener('input', () => tpUpdate());
  const copy = morphBtn(`tp-copy${which}`, { idle: '复制', ok: '已复制' }, async () => {
    if (!box.value.trim()) return {};
    await window.wa.panelCopy(box.value);
    return { ok: true };
  }, { class: 'tp-btn tp-copy primary' });
  const foot = h('div', { class: 'tp-foot' }, model, h('span', { class: 'grow' }), count);
  // 报错放在译文本来出现的位置（左上）
  const pane = h('div', { class: 'tp-pane tp-out' }, err, box, foot);
  const o = { pane, box, err, model, copy, foot, count };
  // 纠错只在翻成外文时有用（中文译文自己就能看懂），每栏用自己选的模型
  o.fix = morphBtn(`tp-fix${which}`, { idle: '纠错', busy: '纠错中', ok: '已纠错', err: '重试' }, () => tpFix(which), { class: 'tp-btn tp-fix primary' });
  foot.append(o.fix, copy);
  // 收起箭头放在最右边，贴着栏的右边缘（复制按钮没字时也不浮在中间）
  if (which === 2) {
    o.fold = h('button', { class: 'tp-icon tp-fold', type: 'button', 'aria-label': '收起对照', 'aria-expanded': 'true', onclick: (e) => tpSetOpen2(false, e) }, icon('up', 14));
    foot.append(o.fold);
  }
  return o;
}

function tpBuild() {
  tpLoadPrefs();
  const input = h('textarea', { class: 'tp-text', placeholder: '输入或粘贴文字', 'aria-label': '原文', spellcheck: 'false' });
  input.addEventListener('input', () => { tpIdle(); tpLabels(); tpUpdate(); });
  input.addEventListener('keydown', (e) => {
    // 输入法还在选字（Windows 上是 keyCode 229）时回车不算
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!go.disabled && !tp.busy) go.click();
    }
  });
  const clear = h('button', { class: 'tp-icon', type: 'button', 'aria-label': '清空', onclick: () => {
    input.value = '';
    for (const o of [ui.o1, ui.o2]) { o.box.value = ''; tpShowOut(o, null); }
    tp.detected = '';
    tp.autoFold = false;
    tpIdle(); tpLabels(); tpUpdate(); input.focus();
  } }, icon('close', 14));
  const inCount = tpCountEl();
  const go = morphBtn('tp-go', { idle: '翻译', busy: '翻译中', ok: '已翻译', err: '重试' }, () => tpRun(), { class: 'tp-btn tp-go primary' });
  // 翻译中再点一下 = 取消（捕获阶段先看状态，morphBtn 自己的点击会忽略转圈时的点击）
  go.addEventListener('click', () => { if (go.dataset.st === 'busy' && tp.busy) { tp.cancelled = true; window.wa.trCancel(); } }, true);
  const src = h('select', { class: 'tp-lang', 'aria-label': '原文语言', onchange: (e) => { tp.src = e.target.value === '__auto' ? '' : e.target.value; tpLabels(); } });
  const tgt = h('select', { class: 'tp-lang', 'aria-label': '目标语言', onchange: (e) => { tp.tgt = e.target.value === '__auto' ? '' : e.target.value; tpLabels(); } });
  const swap = h('button', { class: 'tp-icon tp-swap', type: 'button', 'aria-label': '对调语言', onclick: () => tpSwap() }, icon('swap', 16));
  const o1 = tpOutPane(1);
  const o2 = tpOutPane(2);
  const open2 = h('button', { class: 'tp-open2', type: 'button', 'aria-expanded': 'false', onclick: (e) => tpSetOpen2(true, e) },
    h('span', null, '对照'), h('span', { class: 'tp-open2-model' }), h('span', { class: 'grow' }), icon('down', 14));
  const histList = h('div', { class: 'tp-hist-list' });
  const hist = h('div', { class: 'tp-hist' },
    h('div', { class: 'tp-hist-head' }, h('span', null, '最近记录'),
      h('button', { class: 'tp-link', type: 'button', onclick: () => tpClearHist() }, '清空')),
    histList);
  const provs = h('div', { class: 'tp-provs' });
  const ui = { input, inCount, clear, go, src, tgt, swap, o1, o2, open2, hist, histList, provs };
  tp.ui = ui;
  tp.el = h('div', { class: 'tp' },
    h('div', { class: 'tp-head' }, h('h1', null, '翻译'), ui.provs),
    h('div', { class: 'tp-body' },
      h('div', { class: 'tp-bar' }, src, swap, tgt),
      h('div', { class: 'tp-grid' },
        h('div', { class: 'tp-pane tp-in' }, input, h('div', { class: 'tp-foot' }, h('span', { class: 'grow' }), inCount, clear, go)),
        h('div', { class: 'tp-outs' }, o1.pane, o2.pane, open2)),
      hist));
  tpHist();
  return tp.el;
}

// 改了原文或清空：主按钮回到「翻译」（不留着上一次的已翻译 / 重试）
function tpIdle() {
  const m = morphState['tp-go'];
  if (!m || m.st === 'idle' || m.st === 'busy') return;
  clearTimeout(m.timer);
  morphState['tp-go'] = { st: 'idle' };
  morphPaint(tp.ui.go);
}

// 清空最近记录：直接清，撤销条在的时候可以撤销
let tpUndoList = null;
function tpClearHist() {
  if (!tp.hist.length) return;
  // 记录区固定五行高，清空后那块空白还在，撤销条就放在它中间
  tpUndoList = tp.hist;
  tp.hist = [];
  tpSavePrefs();
  tpHist();
  showUndo('已清空最近记录', 'tp-hist', tpUndoHist, tpUndoGone);
}
function tpUndoGone() {
  tpUndoList = null;
  tpHist();
}
function tpUndoHist() {
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
  // “自动”那一项显示的是选自动时会得到什么，不受另一边手动选的影响
  const srcAuto = text.trim() ? (ReplyLang.isChinese(text) ? '中文' : tp.detected) : '';
  const r = ReplyLang.pick({ text, src: tp.src, manual: '', autoTarget: '英语' });
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

function tpOpen2() { return tp.open2 && !tp.autoFold; }
function tpSetOpen2(on, e) {
  const was = tpOpen2();
  tp.open2 = on;
  tp.autoFold = false;
  tpSavePrefs();
  if (was !== on) tpFoldFx(on);
  else tpUpdate();
  // 点的按钮藏起来了，焦点挪到换出来的那个按钮上；只在键盘按的时候挪（detail 为 0），鼠标点不出焦点框
  if (!e || e.detail === 0) (on ? tp.ui.o2.fold : tp.ui.open2).focus();
  if (on) tpFillCompare();
}

// ---------- 动效：只用 250ms ease-out（--fx-state），系统开了「减少动态效果」就不播 ----------
const tpCalm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// 重新播一次某个 CSS 动画（class 在 shell.css 的 .tp-fx*）
function tpFx(el, cls = 'tp-fx') {
  if (!el || tpCalm()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}
// 对照栏收起 / 展开：栏的高度在「整栏」和「对照」那一条之间过渡，上面一栏跟着平滑变高变矮
function tpFoldFx(on) {
  const ui = tp.ui;
  const pane = ui.o2.pane;
  const bar = ui.open2;
  const from = (on ? bar : pane).offsetHeight;
  tpUpdate();
  if (tpCalm() || !from || pane.hidden === bar.hidden) return;
  const el = on ? pane : bar;
  const to = el.offsetHeight;
  const duration = parseFloat(getComputedStyle(el).getPropertyValue('--fx-state')) || 250;
  if (on) {
    // 展开：从对照条的高度长到整栏，里面的字等长开再淡入
    pane.animate([{ flex: 'none', height: `${from}px`, overflow: 'hidden' }, { flex: 'none', height: `${to}px`, overflow: 'hidden' }], { duration, easing: 'ease-out' });
    for (const c of pane.children) c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], { duration, easing: 'ease-out' });
  } else {
    // 收起：整栏缩成对照条，字先淡掉
    bar.animate([{ height: `${from}px`, background: 'var(--s2)' }, { height: `${to}px` }], { duration, easing: 'ease-out' });
    for (const c of bar.children) c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], { duration, easing: 'ease-out' });
  }
}

// 栏里的报错：服务商名在底栏已经有了，这里只说缺什么，后面跟一个去处理的链接
function tpShowOut(o, r) {
  const err = r && r.error && r.kind !== 'cancel' ? r : null;
  o.err.replaceChildren();
  o.err.hidden = !err;
  o.box.hidden = !!err;
  if (!err) return;
  tpFx(o.err);
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
  // 只有一个模型时没东西可对照，第二栏整个不显示
  const canCompare = provs.length > 1;
  const open = tpOpen2();
  tpFillModels(ui.o1.model, tp.p1, canCompare && open ? tp.p2 : '');
  tpFillModels(ui.o2.model, tp.p2, tp.p1);
  ui.o2.pane.hidden = !canCompare || !open;
  ui.open2.hidden = !canCompare || open;
  const p2 = provs.find((p) => p.id === tp.p2);
  ui.open2.querySelector('.tp-open2-model').textContent = p2 ? tpProvName(p2) : '';
  tpOff(ui.go, !tp.busy && !ui.input.value.trim());
  ui.clear.style.visibility = ui.input.value ? '' : 'hidden';
  tpCount(ui.inCount, ui.input.value);
  for (const o of [ui.o1, ui.o2]) tpCount(o.count, o.box.hidden ? '' : o.box.value);
  ui.swap.disabled = tp.busy;
  const toForeign = tpPick(ui.input.value).target !== '中文';
  for (const [o, pid] of [[ui.o1, tp.p1], [ui.o2, tp.p2]]) {
    o.fix.hidden = !toForeign || !tpCanFix(pid) || !o.box.value.trim() || !ui.input.value.trim();
    tpOff(o.fix, tp.busy && o.fix.dataset.st !== 'busy');
  }
  // 没译文时「复制」先藏起来（位置留着，有了译文不跳）
  for (const o of [ui.o1, ui.o2]) o.copy.classList.toggle('tp-empty', !o.box.value.trim());
  tpFitSelect(ui.o1.model); tpFitSelect(ui.o2.model);
  tpQuota();
}

// 右上角：三个翻译服务商，填了密钥才算已启用。智谱、混元免费不限量；DeepL 每个使用者每月 10 万字符（换密钥也接着算，每月 1 号清零）
const TP_PROVS = [['zhipu', '智谱'], ['hunyuan', '腾讯混元'], ['deepl', 'DeepL']];
function tpWan(n) {
  if (n < 1000) return String(n);
  return `${(Math.floor(n / 1000) / 10).toString()}万`;
}
function tpQuota() {
  const ui = tp.ui;
  const provs = tpProviders();
  const rows = TP_PROVS.map(([preset, name]) => {
    const list = provs.filter((p) => p.preset === preset);
    const p = list.find((x) => x.hasKey) || list[0];
    return { preset, name, id: p ? p.id : '', on: !!(p && p.hasKey), used: (p && p.usage && p.usage.used) || 0, cap: (p && p.usage && p.usage.cap) || 100000 };
  });
  const want = JSON.stringify(rows);
  if (ui.provs.dataset.v === want) return;
  ui.provs.dataset.v = want;
  ui.provs.replaceChildren(...rows.map(({ preset, name, id, on, used, cap }) => {
    let quota;
    if (preset === 'deepl') {
      const pct = Math.min(100, (used / cap) * 100);
      quota = h('span', { class: 'tp-prov-quota' },
        h('span', { class: `tp-meter${pct >= 100 ? ' full' : pct >= 90 ? ' near' : ''}`, role: 'progressbar', 'aria-label': 'DeepL 本月已用字符', 'aria-valuemin': '0', 'aria-valuemax': String(cap), 'aria-valuenow': String(used) },
          h('span', { class: 'tp-meter-fill', style: { width: `${pct}%` } })),
        h('span', null, `${tpWan(used)} / ${tpWan(cap)}`));
    } else quota = h('span', { class: 'tp-prov-quota' }, '无限免费');
    // 点一下去填（或改）这个服务商的密钥；列表里没有这个服务商就打开翻译设置
    return h('button', { class: 'tp-prov', type: 'button', title: on ? false : '填写密钥', onclick: () => {
      if (id) trOpenKey(id);
      else { settingsTab = 'translate'; window.wa.showPage('settings'); render(true); }
    } },
    h('span', { class: 'tp-prov-top' }, h('span', { class: 'tp-prov-name' }, name), h('span', { class: `tp-prov-on${on ? ' on' : ''}` }, on ? '已启用' : '未启用')),
    quota);
  }));
}

// fresh：刚加了一条，新的那行淡入，列表回到最上面
function tpHist(fresh) {
  const ui = tp.ui;
  ui.hist.querySelector('.tp-hist-head .tp-link').style.visibility = tp.hist.length ? '' : 'hidden';
  ui.histList.replaceChildren(...tp.hist.map((x) => h('button', { class: 'tp-hrow', type: 'button', title: x.src, onclick: (e) => {
    // 原文框里有还没翻过的字：先问一下再替换（翻过的在记录里还找得到，直接换）
    const cur = ui.input.value.trim();
    if (cur && cur !== x.src.trim() && !tp.hist.some((y) => y.src.trim() === cur)) tpAsk(e.currentTarget, () => tpUseHist(x), e.detail === 0);
    else tpUseHist(x);
  } },
  h('span', { class: 'tp-hsrc' }, x.src),
  h('span', { class: 'tp-hout' }, h('span', { class: 'tp-hout-text' }, x.out), h('span', { class: 'tp-htime' }, tpTime(x.at))))));
  if (fresh && ui.histList.firstChild) {
    ui.histList.scrollTop = 0;
    tpFx(ui.histList.firstChild);
  }
}
function tpUseHist(x) {
  const ui = tp.ui;
  ui.input.value = x.src;
  tpShowOut(ui.o1, null); tpShowOut(ui.o2, null);
  tpSetOut(ui.o1, x.out);
  ui.o2.box.value = '';
  tp.detected = '';
  tpIdle(); tpLabels(); tpUpdate();
}

// 贴在记录行上方的小提示：「替换」「取消」。Esc、点别处、滚动记录区都算取消
let tpPop = null;
function tpAskClose() {
  if (!tpPop) return;
  const { el, off, row } = tpPop;
  tpPop = null;
  off();
  el.remove();
  if (row.isConnected && document.activeElement === document.body) row.focus();
}
function tpAsk(row, onYes, byKey) {
  tpAskClose();
  const no = h('button', { class: 'tp-btn tp-pop-no', type: 'button', onclick: () => tpAskClose() }, '取消');
  const yes = h('button', { class: 'tp-btn tp-pop-yes', type: 'button', onclick: () => { tpAskClose(); onYes(); } }, '替换');
  const el = h('div', { class: 'tp-pop', role: 'dialog', 'aria-label': '替换原文' },
    h('span', { class: 'tp-pop-text' }, '替换输入框里的文字？'), no, yes);
  tp.el.append(el);
  const r = row.getBoundingClientRect();
  const pr = el.getBoundingClientRect();
  const top = r.top - pr.height - 4 >= 8 ? r.top - pr.height - 4 : r.bottom + 4;
  el.style.left = `${Math.max(8, Math.min(r.left + 8, window.innerWidth - pr.width - 8))}px`;
  el.style.top = `${top}px`;
  tpFx(el);
  const away = (e) => { if (!el.contains(e.target)) tpAskClose(); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); tpAskClose(); } };
  const list = tp.ui.histList;
  // Tab 把焦点移出小提示也算取消
  el.addEventListener('focusout', (e) => { if (e.relatedTarget && !el.contains(e.relatedTarget)) tpAskClose(); });
  setTimeout(() => { if (tpPop && tpPop.el === el) document.addEventListener('pointerdown', away, true); }, 0);
  document.addEventListener('keydown', key, true);
  list.addEventListener('scroll', tpAskClose, { once: true });
  window.addEventListener('resize', tpAskClose, { once: true });
  tpPop = { el, row, off: () => {
    document.removeEventListener('pointerdown', away, true);
    document.removeEventListener('keydown', key, true);
    list.removeEventListener('scroll', tpAskClose);
    window.removeEventListener('resize', tpAskClose);
  } };
  // 键盘按的才把焦点放到「替换」上（回车确认）；鼠标点的不出焦点框
  if (byKey) yes.focus();
}

function tpTime(at) {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

async function tpRun() {
  const ui = tp.ui;
  const text = ui.input.value;
  if (tp.busy || !text.trim()) return {};
  if (!tp.cfg) await tpLoadCfg();
  const { source, target } = tpPick(text);
  // 超长原文（输入框装不下要滚动）：默认只用第一栏的模型翻，对照栏收起，想看可以再展开
  tp.autoFold = ui.input.scrollHeight > ui.input.clientHeight + 2;
  const both = tpOpen2() && tpProviders().length > 1;
  tp.busy = true;
  tp.cancelled = false;
  for (const o of both ? [ui.o1, ui.o2] : [ui.o1]) { o.box.value = ''; tpShowOut(o, null); }
  // 收着的对照栏清掉旧译文，免得展开时看到上一句的
  if (!both) { ui.o2.box.value = ''; tpShowOut(ui.o2, null); }
  tpUpdate();
  let r1;
  try { r1 = await window.wa.trPage({ text, source, target, providerId: tp.p1 }); } catch { r1 = { error: '翻译失败' }; }
  if (r1 && !r1.error) tpSetOut(ui.o1, r1.text); else tpShowOut(ui.o1, r1);
  tp.detected = (r1 && r1.detected) || '';
  if (both && !tp.cancelled) await tpRunOne(ui.o2, { text, source, target, providerId: tp.p2 });
  tp.busy = false;
  const ok = r1 && !r1.error;
  // 只有重试可能有用的失败才显示「重试」；没填密钥、取消这些回到「翻译」
  const res = ok ? { ok: true } : TP_RETRY.includes(r1 && r1.kind) || !(r1 && r1.kind) ? { ok: false } : {};
  if (ok) {
    tp.hist = [{ src: text, out: r1.text, from: source || tp.detected, to: target, at: Date.now() }, ...tp.hist.filter((x) => x.src !== text)].slice(0, TP_HIST_MAX);
    tpSavePrefs();
    tpHist(true);
  }
  tpLabels();
  tpUpdate();
  tpLoadCfg(); // DeepL 用量变了
  return res;
}

async function tpRunOne(o, req) {
  let r;
  try { r = await window.wa.trPage(req); } catch { r = { error: '翻译失败' }; }
  if (r && !r.error) tpSetOut(o, r.text); else tpShowOut(o, r);
}
// 译文出来时淡入
function tpSetOut(o, text) {
  o.box.value = text;
  if (text) tpFx(o.box);
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
  tpLoadCfg();
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
  tpLoadCfg();
}

async function tpFix(which) {
  const ui = tp.ui;
  const o = which === 1 ? ui.o1 : ui.o2;
  const text = ui.input.value;
  const draft = o.box.value;
  if (tp.busy || !text.trim() || !draft.trim()) return {};
  const { source, target } = tpPick(text);
  tp.busy = true;
  tpUpdate();
  let r;
  // 纠错用这一栏选的模型（按钮就在模型旁边）
  try { r = await window.wa.trPage({ text, source, target, fix: true, draft, providerId: which === 1 ? tp.p1 : tp.p2 }); } catch { r = { error: '纠错失败' }; }
  tp.busy = false;
  const ok = r && !r.error;
  if (ok) { tpSetOut(o, r.text); tpShowOut(o, null); } else tpShowOut(o, r);
  tpUpdate();
  return ok ? { ok: true } : r && r.kind === 'cancel' ? {} : { ok: false };
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
  tpFx(ui.swap.firstChild, 'tp-fx-turn');
  tpFx(ui.input);
}

async function tpLoadCfg() {
  let r = null;
  try { r = await window.wa.trConfig(); } catch {}
  if (!r || !r.config) return;
  tp.cfg = r.config;
  const was = [tp.p1, tp.p2];
  tpFixPicks();
  // 服务商被删了、栏换了模型：那栏的旧译文不再对得上，清掉
  if (tp.ui) [[tp.ui.o1, was[0], tp.p1], [tp.ui.o2, was[1], tp.p2]].forEach(([o, a, b]) => { if (a !== b) { o.box.value = ''; tpShowOut(o, null); } });
  tpSavePrefs();
  if (tp.ui) { tpLabels(); tpUpdate(); }
}

// shell.js 的 render 每次显示翻译页时调用：返回同一个元素；刚切进来时重新读一次服务商（设置里可能改过）
function trPage(entering) {
  if (!tp.el) { tpBuild(); tpLabels(); tpUpdate(); }
  if (entering) {
    tpAskClose();
    tpLoadCfg();
    setTimeout(() => { if (tp.ui && document.contains(tp.ui.input)) tp.ui.input.focus(); }, 0);
  }
  return tp.el;
}
