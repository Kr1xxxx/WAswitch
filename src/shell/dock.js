// 右侧面板的“翻译”页（shen 2026-10-25 选的方案 C 指挥舱侧栏，风格先沿用软件现有的）。
// 上：当前对话收到的消息和译文（只读页面，和悬浮窗同一套）；
// 下：写中文回复，选语气，翻好的译文可以直接改，改过就不会被自动覆盖。只“放进输入框”，永远不按发送。
// 这个文件在 shell.js 之前加载，里面用到的 h、icon、kids、s、pn、tr、panelInsert 等都在 shell.js 里，运行时才调用。

const TONE_LIST = [['biz', '商务'], ['casual', '口语'], ['short', '简短']];
const dk = {
  st: null, // 主进程推来的：当前对话收到的消息、目标语言、额度
  text: '', // 写的中文
  out: '', // 译文（可以手动改）
  src: '', // 译文是从哪段中文翻的
  edited: false, // 译文手动改过
  fixed: false, // 译文是纠错后的
  suggest: '', // 手动改过之后再纠错：结果只当建议
  forTitle: null, // 译文是给哪个对话翻的
  warn: [],
  tone: '',
  busy: false,
  msg: '',
  bad: false,
  consent: null, // { kind: 'auto' | 'provider', list }
  pending: null,
  clip: null, // 翻译剪贴板的结果 { text, tr }
  editing: null, // 正在手动改哪条收到消息的译文（hash）
  editText: '',
  seen: new Set(), // 看过的收到消息（给顶栏“翻译”算未读）
  seenTitle: null,
  unread: 0,
  acc: null,
};
try { dk.tone = localStorage.getItem('dk.tone') || 'biz'; } catch { dk.tone = 'biz'; }

const dockVisible = () => !!(s && s.panelOpen && s.panelTab === 'translate' && !s.locked && s.page === 'account');

// 未读：打开这个对话以后新收到、还没在翻译页看过的
function dockCountUnread() {
  const st = dk.st;
  if (!st) { dk.unread = 0; return; }
  if (st.title !== dk.seenTitle) {
    dk.seenTitle = st.title;
    for (const it of st.items) dk.seen.add(it.h); // 刚打开的对话：屏幕上已有的不算
  }
  if (dockVisible()) for (const it of st.items) dk.seen.add(it.h);
  if (dk.seen.size > 2000) dk.seen = new Set(st.items.map((it) => it.h));
  dk.unread = st.items.filter((it) => !dk.seen.has(it.h)).length;
}

function dockReset() {
  Object.assign(dk, { text: '', out: '', src: '', edited: false, fixed: false, suggest: '', forTitle: null, warn: [], msg: '', bad: false, consent: null, pending: null, clip: null, unread: 0, seenTitle: null });
  dk.seen.clear();
}

function dockSay(msg, bad = false) { dk.msg = msg; dk.bad = bad; dockRender(true); }

window.wa.onDock((st) => {
  if (dk.acc !== st.accountId) { dockReset(); dk.acc = st.accountId; }
  dk.st = st;
  const before = dk.unread;
  dockCountUnread();
  if (dockVisible()) dockRender(false);
  if (before !== dk.unread && s) refreshPanelHead();
});
async function dockFetch() {
  try { const st = await window.wa.dockGet(); if (st) { if (dk.acc !== st.accountId) { dockReset(); dk.acc = st.accountId; } dk.st = st; dockCountUnread(); } } catch {}
  dockRender(true);
}

// ---- 发出 ----
const outModeId = () => {
  const list = (dk.st && dk.st.modes.out) || [];
  return (list.find((m) => m.id === tr.outMode) || list[0] || {}).id || '';
};
// 纠错：AI 对照中文原文和上下文校对现在的译文
function dockFix() {
  if (dk.busy || !dk.st || !dk.out.trim()) return;
  if (!dk.text.trim()) return dockSay('先写中文原文，纠错要对照它', true);
  return dockRun({ req: { text: dk.text, fix: true, draft: dk.out, target: dk.st.target, ctxAccount: dk.st.accountId }, insert: false, acc: dk.st.accountId, title: dk.st.title });
}
// insert=true：翻译完直接放进输入框（不发送）。对话在翻译期间换了就不放
async function dockTranslate(insert = false) {
  if (dk.busy || !dk.st) return;
  const text = dk.text.trim();
  if (!text) return dockSay('先写要发的话', true);
  const modeId = outModeId();
  if (!modeId) return dockSay('没有“发出”方向的模式，去设置 › 翻译里加一个', true);
  const req = { text: dk.text, modeId, target: dk.st.target, tone: dk.tone, ctxAccount: dk.st.accountId };
  return dockRun({ req, insert, acc: dk.st.accountId, title: dk.st.title });
}
async function dockRun(p) {
  dk.busy = true; dk.msg = ''; dockRender(true);
  let r;
  try { r = await window.wa.trRun(p.req); } catch { r = { error: '翻译失败' }; }
  dk.busy = false;
  if (!dk.st || p.acc !== dk.st.accountId) return dockRender(true); // 换号了：作废
  if (r.kind === 'consent') { dk.consent = { kind: 'provider', list: r.consent }; dk.pending = p; return dockRender(true); }
  if (r.error) return dockSay(r.error, true);
  if (p.req.fix && dk.edited) { dk.suggest = r.text; return dockSay(''); } // 改过的不直接覆盖，给用户选
  dk.out = r.text; dk.src = p.req.text; dk.edited = false; dk.fixed = !!p.req.fix; dk.suggest = ''; dk.warn = r.warn || []; dk.forTitle = p.title;
  if (!p.insert) return dockSay(r.fallback ? '默认的翻译服务连不上，这次用了备用的' : '');
  if (dk.warn.length) return dockSay('译文里有原文没有的内容，先看一眼再点“放进输入框”', true);
  return dockInsert();
}
async function dockInsert() {
  if (!dk.out.trim()) return dockSay('还没有译文', true);
  if (dk.st && dk.forTitle !== null && dk.st.title !== dk.forTitle) return dockSay('译文是给另一个对话翻的，没有放。看一下再点', true);
  await panelInsert(dk.out);
  dk.msg = pn.msg; dk.bad = pn.bad; pn.msg = '';
  dockRender(true);
}
// ⌃⇧↵ / 放进输入框：有译文就放（改过的就放改过的）；中文改了又没手动改译文，先重新翻
function dockInsertKey() {
  if (dk.out.trim() && (dk.edited || dk.src === dk.text)) return dockInsert();
  return dockTranslate(true);
}
async function dockClipboard() {
  const text = await window.wa.trClipboard();
  if (!text || !text.trim()) return dockSay('剪贴板是空的：先在聊天里复制一条消息', true);
  const list = (dk.st && dk.st.modes.in) || [];
  const m = list.find((x) => x.id === dk.st.inModeId) || list[0];
  if (!m) return dockSay('没有“收到”方向的模式，去设置 › 翻译里加一个', true);
  dk.busy = true; dockRender(true);
  let r;
  try { r = await window.wa.trRun({ text, modeId: m.id, target: '中文' }); } catch { r = { error: '翻译失败' }; }
  dk.busy = false;
  if (r.kind === 'consent') { dk.consent = { kind: 'provider', list: r.consent }; return dockRender(true); }
  if (r.error) return dockSay(r.error, true);
  dk.clip = { text, tr: r.text };
  dockSay('');
}

// ---- 界面 ----
function dockConsentBox() {
  const c = dk.consent;
  const st = dk.st;
  const lines = c.kind === 'auto'
    ? [`打开后，这个号当前对话里收到的消息会自动发到「${st.providerName}」翻译。客户的消息里可能有姓名、地址、电话等个人信息，服务商可能会记录这些文字。`,
      `翻译时会带上这个对话最近几条消息作参考，翻得更准。只发消息文字，不发对话名、号码和群成员名字。每分钟最多 20 条，每天最多 ${st.dailyCap} 条。`]
    : c.list.map((p) => `要翻译的文字（和当前对话最近几条消息，作上下文参考）会发到「${p.name}」（${p.host}）的服务器，对方可能会记录这些文字。${p.openrouter ? 'OpenRouter 会把文字转给第三方模型服务商处理（已要求只用不拿数据训练的服务商）。' : ''}`);
  return h('div', { class: 'pn-form', style: { paddingTop: '10px' } },
    h('div', { class: 'pn-item' },
      h('span', { class: 't' }, c.kind === 'auto' ? '打开自动翻译' : '第一次用这个翻译服务'),
      lines.map((t) => h('span', { class: 'x' }, t))),
    h('div', { class: 'acts', style: { display: 'flex', gap: '4px' } },
      h('button', { class: 'pn-btn primary', onclick: async () => {
        if (c.kind === 'auto') { await window.wa.dockConsent('auto'); await window.wa.dockAuto(true); }
        else await window.wa.dockConsent('provider', c.list.map((p) => p.id));
        const again = dk.pending;
        dk.consent = null; dk.pending = null;
        if (again && again.item) await window.wa.dockItem(again.item, again.fix === true);
        else if (again) return dockRun(again);
        dockRender(true);
      } }, '同意'),
      h('button', { class: 'pn-btn', onclick: () => { dk.consent = null; dk.pending = null; dockRender(true); } }, '取消')));
}

// 发出时翻成哪种语言：认出来或选过的会记在这个对话上
function dockLangSel() {
  const st = dk.st;
  const lang = h('select', { class: 'dk-lang', 'aria-label': '翻成哪种语言', title: { manual: '你给这个对话选的语言，已记住', detected: '从客户发来的消息认出来的，已记住', customer: `客户资料里「${st.targetFrom}」填的语言`, default: '这个号的默认语言' }[st.targetSrc] || null, onchange: async (e) => {
    const v = e.target.value;
    dk.st = await window.wa.dockLang(st.accountId, st.title, v === '__auto' ? '' : v);
    dockRender(true);
  } },
    st.canRemember && st.targetSrc === 'manual' ? h('option', { value: '__auto' }, '自动识别') : null,
    st.langs.map((l) => h('option', { value: l }, l)));
  lang.value = st.target;
  return lang;
}

// 收到消息的译文：纠错（用仔细校对的提示词重翻这一条）、编辑（直接改，改过的保留，不会被自动覆盖）
function dockItemEdit(it) {
  const box = h('textarea', { class: 'dk-out', rows: '2', 'aria-label': '改译文' }, dk.editText);
  box.addEventListener('input', () => { dk.editText = box.value; });
  const save = async () => {
    const ok = await window.wa.dockEdit(dk.st.accountId, it.h, dk.editText);
    dk.editing = null;
    if (!ok) return dockSay('没有保存（这条正在翻译或已经不在了）', true);
    dockRender(true);
  };
  box.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { dk.editing = null; dockRender(true); }
  });
  requestAnimationFrame(() => { if (box.isConnected && document.activeElement !== box) { box.focus(); box.selectionStart = box.selectionEnd = box.value.length; } });
  return h('div', { class: 'dk-edit' }, box,
    h('div', { class: 'dk-row' },
      h('button', { class: 'pn-btn primary', onclick: save }, '保存'),
      h('button', { class: 'pn-btn', onclick: () => { dk.editing = null; dockRender(true); } }, '取消'),
      h('span', { class: 'dk-dim' }, 'Enter 保存，Esc 取消')));
}
function dockSuggestBox(text, take, drop) {
  return h('div', { class: 'dk-suggest' },
    h('span', { class: 'dk-label' }, '纠错建议（你改过这条，没有直接替换）'),
    h('span', { class: 'dk-tr' }, text),
    h('span', { class: 'dk-row' }, h('button', { class: 'pn-btn primary', onclick: take }, '采用'), h('button', { class: 'pn-btn', onclick: drop }, '不用')));
}
function dockItemActs(it) {
  return h('span', { class: 'dk-acts-mini' },
    it.edited ? h('span', { class: 'dk-edited' }, '已手动修改') : it.fixed ? h('span', { class: 'dk-fixed' }, '已纠错') : null,
    h('button', { class: 'dk-link', title: '用更仔细的校对方式重新翻这一条（会替换现在的译文）', onclick: async () => {
      const r = await window.wa.dockItem(it.h, true);
      if (r && r.consent) { dk.consent = { kind: 'provider', list: r.consent }; dk.pending = { item: it.h, fix: true }; dockRender(true); }
    } }, '纠错'),
    h('button', { class: 'dk-link', title: '直接改译文，改过的不会被自动覆盖', onclick: () => { dk.editing = it.h; dk.editText = it.tr; dockRender(true); } }, '编辑'));
}

function dockItemRow(it, last) {
  if (dk.editing === it.h && it.state === 'done') {
    return h('div', { class: `dk-item${last ? ' last' : ''}` }, h('span', { class: 'dk-time' }, it.t || ''),
      h('div', { class: 'dk-texts' }, h('span', { class: 'dk-orig' }, it.text), dockItemEdit(it)));
  }
  const tr = it.state === 'done' ? [h('span', { class: 'dk-tr' }, it.tr), dockItemActs(it),
    it.suggest ? dockSuggestBox(it.suggest, () => window.wa.dockSuggest(dk.st.accountId, it.h, true), () => window.wa.dockSuggest(dk.st.accountId, it.h, false)) : null]
    : it.state === 'queued' || it.state === 'running' ? h('span', { class: 'dk-tr dk-dim' }, '翻译中…')
      : it.state === 'error' ? h('span', { class: 'dk-tr bad' }, it.err, ' ', h('button', { class: 'dk-link', onclick: () => window.wa.dockItem(it.h) }, '重试'))
        : h('button', { class: 'dk-link', onclick: async () => {
          const r = await window.wa.dockItem(it.h);
          if (r && r.consent) { dk.consent = { kind: 'provider', list: r.consent }; dk.pending = { item: it.h }; dockRender(true); }
        } }, it.note === 'long' ? '翻译（太长，不自动翻）' : '翻译');
  return h('div', { class: `dk-item${last ? ' last' : ''}` },
    h('span', { class: 'dk-time' }, it.t || ''),
    h('div', { class: 'dk-texts' },
      h('span', { class: 'dk-orig' }, it.text),
      tr,
      it.warn && it.warn.length ? h('span', { class: 'tr-warn' }, `注意：译文里有原文没有的内容：${it.warn.slice(0, 3).join('、')}`) : null));
}

function dockIncoming() {
  const st = dk.st;
  const list = h('div', { class: 'dk-list' });
  const add = (...x) => list.append(...kids(x));
  if (dk.clip) {
    add(h('div', { class: 'dk-item clip' }, h('span', { class: 'dk-time' }, '剪贴板'),
      h('div', { class: 'dk-texts' }, h('span', { class: 'dk-orig' }, dk.clip.text), h('span', { class: 'dk-tr' }, dk.clip.tr),
        h('button', { class: 'dk-link', onclick: () => { dk.clip = null; dockRender(true); } }, '收起'))));
  }
  const hint = (t, bad) => h('p', { class: `hint dk-hint${bad ? ' bad' : ''}` }, t);
  if (st.lite) add(hint('轻量模式的号读不到网页里的消息：在聊天里复制客户的话，再点上面的“翻译剪贴板”。'));
  else if (st.readable === 'nochat') add(hint('先在左边点开一个聊天，这里就会显示客户的消息。'));
  else if (st.readable === 'loading') add(hint('正在读当前对话…'));
  else if (st.readable === 'unreadable') add(hint('打开的聊天里认不出消息（可能是 WhatsApp 改版了）。可以先复制客户的话，点上面的“翻译剪贴板”。', true));
  else if (!st.items.length) add(hint('这个对话最近没有收到文字消息。'));
  else st.items.forEach((it, i) => add(dockItemRow(it, i === st.items.length - 1)));
  if (st.paused === 'day') add(hint(`今天已经自动翻了 ${st.today} 条（上限 ${st.dailyCap}），自动翻译暂停到明天；可以手动点“翻译”。`));
  else if (st.paused === 'minute') add(hint('一分钟内消息太多，暂时只翻前 20 条，其余可以手动点。'));
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  return list;
}

function dockInHead() {
  const st = dk.st;
  const sw = h('input', { type: 'checkbox', class: 'dk-switch', role: 'switch', 'aria-label': '自动翻译收到的消息', checked: st.auto, disabled: st.lite || !st.accountId,
    onchange: async (e) => {
      if (e.target.checked && !st.autoConsented) { e.target.checked = false; dk.consent = { kind: 'auto' }; return dockRender(true); }
      await window.wa.dockAuto(e.target.checked);
    } });
  const inModes = st.modes.in;
  const inSel = inModes.length > 1 ? h('select', { class: 'dk-mini', 'aria-label': '收到用的模式', onchange: (e) => window.wa.dockInMode(e.target.value) }, inModes.map((m) => h('option', { value: m.id }, m.name))) : null;
  if (inSel) inSel.value = st.inModeId;
  return h('div', { class: 'dk-head' },
    h('span', { class: 'dk-label' }, '收到的消息'),
    h('span', { class: 'grow' }),
    inSel,
    h('button', { class: 'pn-btn', disabled: dk.busy, title: '先在聊天里复制客户的消息，再点这里翻成中文', onclick: dockClipboard }, '翻译剪贴板'),
    h('label', { class: 'dk-auto', title: '自动翻译这个号当前对话里新收到的消息' }, '自动翻译', sw));
}

function dockCompose() {
  const st = dk.st;
  const tones = TONE_LIST.map(([id, label]) => h('button', { class: `dk-chip${dk.tone === id ? ' on' : ''}`, 'aria-pressed': String(dk.tone === id), onclick: () => {
    if (dk.tone === id) return;
    dk.tone = id;
    try { localStorage.setItem('dk.tone', id); } catch {}
    // 换语气：没手动改过译文就按新语气重翻
    if (dk.out && !dk.edited && dk.text.trim()) return dockTranslate(false);
    dockRender(true);
  } }, label));
  const outModes = st.modes.out;
  const modeSel = outModes.length > 1 ? h('select', { class: 'dk-mini', 'aria-label': '发出用的模式', onchange: (e) => { tr.outMode = e.target.value; LS('tr.outMode', e.target.value); } }, outModes.map((m) => h('option', { value: m.id }, m.name))) : null;
  if (modeSel) modeSel.value = outModeId();
  const input = h('textarea', { class: 'dk-in', maxlength: '4000', rows: '3', placeholder: '用中文写要回的话。Enter 翻译，Shift+Enter 换行', 'aria-label': '要回的话（中文）' }, dk.text);
  input.addEventListener('input', () => { dk.text = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return; // 输入法选字时的回车不算
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey) { e.preventDefault(); dockInsertKey(); return; }
    if (e.shiftKey && !mod) return; // 换行
    e.preventDefault();
    if (dk.out && dk.edited) return dockSay('译文手动改过，不会自动覆盖。要按新内容翻，点“重新翻译”', true);
    dockTranslate(false);
  });
  const out = h('textarea', { class: 'dk-out', rows: '3', 'aria-label': '译文（可以直接改）', placeholder: '译文会显示在这里，可以直接改' }, dk.out);
  out.addEventListener('input', () => {
    dk.out = out.value;
    if (!dk.edited) { dk.edited = true; const tag = $panel.querySelector('.dk-edited'); if (tag) tag.hidden = false; }
  });
  out.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.isComposing) { e.preventDefault(); dockInsertKey(); } });
  const stale = dk.out && !dk.edited && dk.src !== dk.text;
  const mac = s.platform === 'darwin';
  return h('div', { class: 'dk-compose' },
    h('div', { class: 'dk-head' }, h('span', { class: 'dk-label' }, '回复'), h('span', { class: 'grow' }), modeSel, ...tones),
    input,
    h('div', { class: 'dk-outhead' },
      h('span', { class: 'dk-label' }, '→'), dockLangSel(),
      h('span', { class: 'dk-edited', hidden: !dk.edited }, '已手动修改'),
      dk.fixed && !dk.edited ? h('span', { class: 'dk-fixed' }, '已纠错') : null,
      stale ? h('span', { class: 'dk-dim' }, '中文改过了') : null,
      h('span', { class: 'grow' }),
      dk.busy ? h('button', { class: 'dk-link', onclick: () => window.wa.trCancel() }, '翻译中… 取消')
        : h('span', { class: 'dk-row' },
          dk.out ? h('button', { class: 'dk-link', title: 'AI 对照中文原文和聊天上下文校对下面的译文（改过的只给建议）', onclick: dockFix }, '纠错') : null,
          h('button', { class: 'dk-link', title: '按现在的中文和语气重新翻，会替换下面的译文', onclick: () => dockTranslate(false) }, dk.out ? '重新翻译' : '翻译'))),
    out,
    dk.suggest ? dockSuggestBox(dk.suggest, () => { dk.out = dk.suggest; dk.suggest = ''; dk.edited = false; dk.fixed = true; dockRender(true); }, () => { dk.suggest = ''; dockRender(true); }) : null,
    dk.warn.length ? h('div', { class: 'tr-warn' }, `注意：译文里有原文没有的内容，可能是模型编的：${dk.warn.slice(0, 3).join('、')}`) : null,
    h('div', { class: 'dk-acts' },
      h('button', { class: 'btn primary dk-insert', disabled: dk.busy, title: '放进当前聊天框（会占用剪贴板），不会发送，发送自己按', onclick: dockInsertKey },
        '放进输入框', h('span', { class: 'dk-key' }, mac ? '⌘ ⇧ ↵' : 'Ctrl+Shift+Enter')),
      h('button', { class: 'btn', disabled: !dk.out, onclick: async () => { await window.wa.panelCopy(dk.out); dockSay('已复制'); } }, '复制')));
}

// force=false：只刷新状态条和消息列表，正在写的回复不动
function dockRender(force = false) {
  if (!dockVisible()) return;
  const host = $panel.querySelector('.dk-host');
  if (!host) return;
  if (!dk.st || dk.st.accountId !== s.activeId) { if (!dk.fetching) { dk.fetching = true; dockFetch().finally(() => { dk.fetching = false; }); } if (!dk.st) { host.replaceChildren(h('div', { class: 'hint dk-hint' }, '加载中…')); return; } }
  const st = dk.st;
  if (!st.accountId) { host.replaceChildren(h('p', { class: 'hint dk-hint' }, '先添加一个 WhatsApp 账号。')); return; }
  if (!st.hasProvider) {
    host.replaceChildren(h('div', { class: 'pn-form', style: { paddingTop: '12px' } },
      h('span', { class: 'hint' }, '还没设置翻译服务。支持腾讯混元、智谱、OpenRouter 和其他 OpenAI 兼容接口。'),
      h('button', { class: 'pn-btn primary', onclick: () => { settingsTab = 'translate'; window.wa.showPage('settings'); } }, '去设置')));
    return;
  }
  if (dk.consent) { host.replaceChildren(dockConsentBox()); return; }
  const root = host.querySelector('.dk');
  const msg = dk.msg ? h('div', { class: `pn-msg dk-msg${dk.bad ? ' bad' : ''}` }, dk.msg) : null;
  const typing = root && root.contains(document.activeElement) && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
  if (root && !force && typing) {
    // 正在写或在选：只换上面几块
    const keep = root.querySelector('.dk-compose');
    const list = dk.editing ? root.querySelector('.dk-list') : null; // 正在改译文：消息列表先不动
    root.replaceChildren(...kids(dockInHead(), list || dockIncoming(), msg, keep));
    return;
  }
  const el = h('div', { class: 'dk' }, ...kids(dockInHead(), dockIncoming(), msg, dockCompose()));
  const focusIn = root && document.activeElement && document.activeElement.classList.contains('dk-in');
  host.replaceChildren(el);
  if (focusIn) { const box = el.querySelector('.dk-in'); box.focus(); box.selectionStart = box.selectionEnd = box.value.length; }
}
