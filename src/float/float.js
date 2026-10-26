// 悬浮翻译窗：显示当前对话里收到的消息和译文，下面可以写中文翻成外语。
// 所有文字都用文本节点显示，不当 HTML。只能通过 window.fl 的几个接口和主进程说话。
let s = null;
const ui = { text: '', out: '', warn: [], msg: '', bad: false, busy: false, outMode: '', pick: '' };
try { ui.outMode = localStorage.getItem('fl.outMode') || ''; } catch {}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $root = document.getElementById('root');
const say = (msg, bad = false) => { ui.msg = msg; ui.bad = bad; render(true); };

// 拖动标题栏移动窗口（按屏幕坐标算位移，窗口跟着动也不会抖）
function dragHandle(el) {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button, select')) return;
    let x = e.screenX;
    let y = e.screenY;
    let raf = 0;
    let dx = 0;
    let dy = 0;
    const move = (ev) => {
      dx += ev.screenX - x; dy += ev.screenY - y; x = ev.screenX; y = ev.screenY;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; window.fl.move(dx, dy); dx = 0; dy = 0; });
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.fl.moveEnd(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

async function insertOut() {
  const r = await window.fl.insert(s.accountId, ui.out);
  if (r === 'ok') say('已贴进聊天框，检查后自己按发送');
  else say(r === 'lite' ? '轻量模式请用面板插入' : '当前账号变了、已锁定或页面没打开，没有贴', true);
}
// insert=true：翻译完直接贴进聊天框（不发送）。翻译期间换了号或换了对话就不贴
async function runCompose(req, insert = false) {
  const title = s.title;
  ui.busy = true; ui.msg = ''; render(true);
  let r;
  try { r = await window.fl.compose(req); } catch { r = { error: '翻译失败' }; }
  ui.busy = false;
  if (req.accountId !== s.accountId) return render(true);
  if (r.error) return say(r.error, true);
  ui.out = r.text; ui.warn = r.warn || [];
  if (!insert) return say(`${r.provider} · ${(r.ms / 1000).toFixed(1)} 秒`);
  if (ui.warn.length) return say('译文里有原文没有的内容，先看一眼再点“放进输入框”', true);
  if (s.title !== title) return say('翻译时对话换了，没有贴。看一下再点“放进输入框”', true);
  return insertOut();
}

function itemRow(it) {
  const tr = it.state === 'done'
    ? h('div', { class: 'tr' }, it.tr)
    : it.state === 'queued' || it.state === 'running' ? h('div', { class: 'tr dim' }, '翻译中…')
      : it.state === 'error' ? h('div', { class: 'tr bad' }, it.err, ' ', h('button', { class: 'link', onclick: () => window.fl.translateItem(it.h) }, '重试'))
        : h('button', { class: 'link', onclick: () => window.fl.translateItem(it.h) }, it.note === 'long' ? '翻译（太长，不自动翻）' : '翻译');
  return h('div', { class: 'item' }, h('div', { class: 'orig' }, it.text), tr,
    it.warn && it.warn.length ? h('div', { class: 'warn' }, `注意：译文里有原文没有的内容：${it.warn.slice(0, 3).join('、')}`) : null);
}

function body() {
  if (!s.accountId) return [h('p', { class: 'hint pad' }, '先添加一个 WhatsApp 账号。')];
  if (!s.hasProvider) return [h('p', { class: 'hint pad' }, '还没设置翻译服务：去 设置 › 翻译 添加。')];
  const parts = [];
  if (s.lite) parts.push(h('p', { class: 'hint pad' }, '轻量模式的号请用右侧面板里的“翻译”。'));
  else if (s.readable === 'nochat') parts.push(h('p', { class: 'hint pad' }, '先在左边点开一个聊天，这里就会显示客户的消息。'));
  else if (s.readable === 'unreadable') parts.push(h('p', { class: 'hint pad bad' }, '打开的聊天里认不出消息（可能是 WhatsApp 改版了）。可以先复制客户的话，用面板里的“翻译剪贴板”。'));
  else if (!s.items.length) parts.push(h('p', { class: 'hint pad' }, '这个对话最近没有收到文字消息。'));
  else {
    const list = h('div', { class: 'list' }, s.items.map(itemRow));
    parts.push(list);
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
  if (s.paused === 'day') parts.push(h('p', { class: 'hint pad' }, `今天已经自动翻了 ${s.today} 条（上限 ${s.dailyCap}），自动翻译暂停到明天；可以手动点“翻译”。`));
  else if (s.paused === 'minute') parts.push(h('p', { class: 'hint pad' }, '一分钟内消息太多，暂时只翻前 20 条，其余可以手动点。'));
  return parts;
}

function compose() {
  const outModes = s.modes.out;
  const modeSel = h('select', { 'aria-label': '发出用的模式', onchange: (e) => { ui.outMode = e.target.value; try { localStorage.setItem('fl.outMode', ui.outMode); } catch {} } },
    outModes.map((m) => h('option', { value: m.id }, m.name)));
  modeSel.value = outModes.some((m) => m.id === ui.outMode) ? ui.outMode : (outModes[0] ? outModes[0].id : '');
  // 跟着客户的语言时，手动改只管当前对话；否则改的是这个号的默认语言
  const lang = h('select', { 'aria-label': '翻译成', onchange: (e) => {
    if (s.targetFrom) { ui.pick = e.target.value; render(true); } else window.fl.setLang(s.accountId, e.target.value);
  } }, s.langs.map((l) => h('option', { value: l }, l)));
  lang.value = ui.pick || s.target;
  const input = h('textarea', { rows: '2', maxlength: '4000', placeholder: '写中文。Ctrl+Enter 翻译，Ctrl+Shift+Enter 翻译并放进输入框', 'aria-label': '要翻译的文字' }, ui.text);
  input.addEventListener('input', () => { ui.text = input.value; });
  const go = (insert) => {
    if (!ui.text.trim()) return say('先写要发的话', true);
    runCompose({ text: ui.text, modeId: modeSel.value, target: ui.pick || s.target, accountId: s.accountId }, insert); // 用最新的目标语言（输入时对话可能换了）
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(e.shiftKey); } });
  const out = h('textarea', { rows: '2', 'aria-label': '译文（可以改）', placeholder: '译文' }, ui.out);
  out.addEventListener('input', () => { ui.out = out.value; });
  return h('div', { class: 'compose' },
    h('div', { class: 'row' }, modeSel, h('span', { class: 'hint' }, '→'), lang),
    s.targetFrom && !ui.pick ? h('span', { class: 'hint' }, `目标语言跟随客户「${s.targetFrom}」`) : null,
    input,
    h('div', { class: 'row' },
      ui.busy ? h('button', { class: 'btn', onclick: () => window.fl.cancel() }, '翻译中… 取消')
        : h('button', { class: 'btn primary', title: '翻译后直接贴进当前聊天框，不会发送（Ctrl+Shift+Enter）', onclick: () => go(true) }, '翻译并放进输入框'),
      ui.busy ? null : h('button', { class: 'btn', onclick: () => go(false) }, '只翻译'),
      ui.out ? h('button', { class: 'btn', title: '贴进当前聊天框（会覆盖剪贴板），不会自动发送', onclick: insertOut }, '放进输入框') : null,
      ui.out ? h('button', { class: 'btn', onclick: async () => { await window.fl.copy(ui.out); say('已复制'); } }, '复制') : null),
    ui.out ? out : null,
    ui.warn.length ? h('div', { class: 'warn' }, `注意：译文里有原文没有的内容，可能是模型编的：${ui.warn.slice(0, 3).join('、')}`) : null);
}

let lastAcc = null;
let lastTitle = null;
function render(force = false) {
  if (!s) return;
  // 换了号：清掉上一个号写的内容，免得贴错人
  if (lastAcc !== s.accountId) { ui.text = ''; ui.out = ''; ui.warn = []; ui.msg = ''; ui.pick = ''; lastAcc = s.accountId; force = true; }
  if (lastTitle !== s.title) { ui.pick = ''; lastTitle = s.title; } // 换了对话：手动选的语言不沿用
  const active = document.activeElement;
  if (!force && active && ['TEXTAREA', 'INPUT', 'SELECT'].includes(active.tagName)) {
    // 正在输入：只刷新消息列表
    const box = $root.querySelector('.body');
    if (box) box.replaceChildren(...body());
    return;
  }
  document.body.classList.toggle('collapsed', !!s.collapsed);
  if (s.collapsed) {
    const pill = h('div', { class: 'pill' }, h('span', null, '🌐 翻译'), s.auto ? h('span', { class: 'dot' }) : null,
      h('button', { class: 'icon', title: '展开', onclick: () => window.fl.collapse(false) }, '▢'));
    dragHandle(pill);
    $root.replaceChildren(pill);
    return;
  }
  const inSel = h('select', { class: 'mini', 'aria-label': '收到用的模式', onchange: (e) => window.fl.setInMode(e.target.value) }, s.modes.in.map((m) => h('option', { value: m.id }, m.name)));
  inSel.value = s.inModeId;
  const auto = h('label', { class: 'auto', title: '自动翻译这个号当前对话里新收到的消息' },
    h('input', { type: 'checkbox', checked: s.auto, disabled: s.lite || !s.hasProvider || !s.accountId, onchange: async (e) => {
      await window.fl.setAuto(e.target.checked);
    } }), '自动');
  const head = h('div', { class: 'head' },
    h('span', { class: 'title' }, `🌐 ${s.accountName || '翻译'}${s.title ? ` · ${s.title}` : ''}`),
    h('button', { class: 'icon', title: '缩小', onclick: () => window.fl.collapse(true) }, '—'),
    h('button', { class: 'icon', title: '关闭', onclick: () => window.fl.close() }, '✕'));
  dragHandle(head);
  $root.replaceChildren(...[head,
    h('div', { class: 'bar' }, auto, h('span', { class: 'hint' }, '收到用'), inSel),
    h('div', { class: 'body' }, body()),
    ui.msg ? h('div', { class: `msg${ui.bad ? ' bad' : ''}` }, ui.msg) : null,
    s.hasProvider && s.accountId ? compose() : null].filter(Boolean));
}

window.fl.onState((next) => { s = next; render(); });
window.fl.ready();
