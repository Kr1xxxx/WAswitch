// 右侧面板的“翻译”页（shen 2026-10-25 选的方案 C 指挥舱侧栏，风格先沿用软件现有的）。
// 上：当前对话收到的消息和译文（只读页面，和悬浮窗同一套）；
// 下：写回复（自动：中文翻成客户的语言，英文等翻成中文），翻好的译文可以直接改，改过就不会被自动覆盖。只“放进输入框”，永远不按发送。
// 这个文件在 shell.js 之前加载，里面用到的 h、icon、kids、s、pn、tr、panelInsert 等都在 shell.js 里，运行时才调用。

const dk = {
  listKey: '', // 消息列表上次画的是哪个号的哪个对话（判断要不要保持滚动位置）
  stick: true, // 消息列表是不是停在最底下（用户自己滚动时更新）；在底下就跟着新消息滚
  st: null, // 主进程推来的：当前对话收到的消息、目标语言、额度
  text: '', // 写的回复（中文或外文）
  // 语言条的临时选择，只管当前这个对话（换对话、换号回到自动）：src 原文语言（'' = 自动检测），
  // tgt 按 ⇄ 对调出来的目标语言（'' = 用记下的/自动），swapped = 现在是对调过的状态（再按一次回到原样）
  lt: { title: null, src: '', tgt: '', swapped: false },
  out: '', // 译文（可以手动改）
  src: '', // 译文是从哪段中文翻的
  edited: false, // 译文手动改过
  fixed: false, // 译文是纠错后的
  suggest: '', // 手动改过之后再纠错：结果只当建议
  forTitle: null, // 译文是给哪个对话翻的
  warn: [],
  busy: false,
  msg: '',
  bad: false,
  msgPid: '', // 提示是“密钥没填/不对”时，是哪个服务商（显示“去填密钥”）
  editing: null, // 正在手动改哪条收到消息的译文（hash）
  editText: '',
  openOrig: new Set(), // 点开看原文的收到消息（hash）；默认原文完全隐藏
  seen: new Set(), // 看过的收到消息（给顶栏“翻译”算未读）
  seenTitle: null,
  unread: 0,
  acc: null,
};

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
  Object.assign(dk, { text: '', out: '', src: '', edited: false, fixed: false, suggest: '', forTitle: null, warn: [], msg: '', bad: false, msgPid: '', unread: 0, seenTitle: null });
  dk.seen.clear();
}

function dockSay(msg, bad = false, pid = '', detail = '') { dk.msg = msg; dk.bad = bad; dk.msgPid = pid; dk.detail = detail || ''; dockRender(true); }

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
// 语气按钮去掉了（shen 2026-10-28），固定用第一个“发出”模式（默认是“标准”：忠实翻译）
const outModeId = () => (((dk.st && dk.st.modes.out) || [])[0] || {}).id || '';
// 语言条的临时选择：换了对话就清掉（不带到别的客户那里，Fable 审计 2026-10-28）
function dockLt() {
  const title = dk.st ? dk.st.title : null;
  if (dk.lt.title !== title || dk.lt.acc !== dk.acc) dk.lt = { title, acc: dk.acc, src: '', tgt: '', swapped: false };
  return dk.lt;
}
// 目标语言是不是手动选的（读不到对话的号，手动选的记在号上）
const dockManual = (st) => st.targetSrc === 'manual' || (!st.canRemember && !!st.accountLang);
// 这一句实际翻成什么：{ source, target }
// source 只在手动选了原文语言时才发给模型（自动认出来的中文不发，记下的译文还能对上）
function dockLangs(text = dk.text) {
  const st = dk.st;
  const lt = dockLt();
  const r = ReplyLang.pick({ text, src: lt.src, manual: lt.tgt || (dockManual(st) ? st.target : ''), autoTarget: st.autoTarget || st.target });
  return { source: lt.src, target: r.target };
}
// 纠错：AI 对照中文原文和上下文校对现在的译文
function dockFix() {
  if (dk.busy || !dk.st || !dk.out.trim()) return;
  if (!dk.text.trim()) return dockSay('先写原文，纠错要对照它', true);
  const { source, target } = dockLangs();
  return dockRun({ req: { text: dk.text, fix: true, draft: dk.out, target, source, ctxAccount: dk.st.accountId }, insert: false, acc: dk.st.accountId, title: dk.st.title });
}
// insert=true：翻译完直接放进输入框（不发送）。对话在翻译期间换了就不放
// 同一句中文、同一种语言、同一个模式翻过的，主进程直接给记下的译文，不调模型；fresh=true（点“重新翻译”）才重新翻
async function dockTranslate(insert = false, fresh = false) {
  if (dk.busy || !dk.st) return;
  const text = dk.text.trim();
  if (!text) return dockSay('先写要发的话', true);
  const modeId = outModeId();
  if (!modeId) return dockSay('没有“发出”方向的模式，去设置 › 翻译里加一个', true);
  const { source, target } = dockLangs();
  const req = { text: dk.text, modeId, target, source, ctxAccount: dk.st.accountId, fresh };
  return dockRun({ req, insert, acc: dk.st.accountId, title: dk.st.title });
}
async function dockRun(p) {
  dk.busy = true; dk.msg = ''; dk.msgPid = ''; dockRender(true);
  let r;
  try { r = await window.wa.trRun(p.req); } catch { r = { error: '翻译失败' }; }
  dk.busy = false;
  if (!dk.st || p.acc !== dk.st.accountId) return dockRender(true); // 换号了：作废
  if (r.error) return dockSay(r.error, true, r.kind === 'auth' ? r.providerId || '' : '', r.detail);
  if (p.req.fix && dk.edited) { dk.suggest = r.text; return dockSay(''); } // 改过的不直接覆盖，给用户选
  dk.out = r.text; dk.src = p.req.text; dk.edited = false; dk.fixed = !!p.req.fix; dk.suggest = ''; dk.warn = r.warn || []; dk.forTitle = p.title;
  if (!p.insert) return dockSay(r.cached ? '这句以前翻过，直接用了记下的译文（没再调模型）。要换一版点“重新翻译”' : r.fallback ? '默认的翻译服务连不上，这次用了备用的' : '');
  if (dk.warn.length) return dockSay('译文里有原文没有的内容，先看一眼再点“放进输入框”', true);
  return dockInsert();
}
async function dockInsert() {
  if (!dk.out.trim()) return dockSay('还没有译文', true);
  if (dk.st && dk.forTitle !== null && dk.st.title !== dk.forTitle) return dockSay('译文是给另一个对话翻的，没有放。看一下再点', true);
  await panelInsert(dk.out);
  dk.msg = pn.msg; dk.bad = pn.bad; dk.msgPid = ''; pn.msg = '';
  dockRender(true);
}
// 放进输入框：有译文就放（改过的就放改过的）；原文改了又没手动改译文，先重新翻
function dockInsertKey() {
  if (dk.out.trim() && (dk.edited || dk.src === dk.text)) return dockInsert();
  return dockTranslate(true);
}
// 换默认翻译模型（和 设置 › 翻译 的“设为默认”是同一个设置）。选的是现在的备用，就把两个对调
async function dockModel(id) {
  const st = dk.st;
  if (!st || !id || id === st.primaryId) return;
  let r;
  try { r = await window.wa.trRoles(id, st.fallbackId === id ? st.primaryId : undefined); } catch { r = null; }
  if (!r || !r.config) return dockSay('没换成，去设置 › 翻译里看一下', true);
  if (typeof tr !== 'undefined') { tr.cfg = r.config; tr.modes = r.modes; }
  const p = st.providers.find((x) => x.id === id);
  dockSay(p ? `翻译模型换成了 ${p.model ? `${p.name}（${p.model}）` : p.name}` : '');
}

// ---- 界面 ----
// 语言条（照 shen 2026-10-28 的参考图）：左边原文语言「自动检测」，中间 ⇄ 对调，右边目标语言「自动选择」。
// 自动选择：中文翻成客户的语言（客户资料 > 从客户消息认出来的 > 英语），英文等别的语言翻成中文。
// 手动选的目标语言记在这个对话上（读不到对话时记在号上）；原文语言和 ⇄ 只管当前对话，不记
function dockLangBar() {
  const st = dk.st;
  const manual = dockManual(st);
  const lt = dockLt();
  const toCustomer = ReplyLang.pick({ text: '中', autoTarget: st.autoTarget || st.target }).target;
  const autoTip = { detected: '从客户发来的消息认出来的', customer: `客户资料里「${st.targetFrom}」填的`, default: '认不出客户的语言，先用英语' };
  const srcLangs = ['中文', ...st.langs.filter((l) => l !== '中文')];
  const src = h('select', { class: 'dk-lang dk-bar-sel', 'aria-label': '原文是哪种语言', title: '自动检测：写中文就当中文，写别的就交给模型认（只管这个对话）', onchange: (e) => {
    lt.src = e.target.value === '__auto' ? '' : e.target.value;
    lt.swapped = false;
    dockRender(true);
  } }, h('option', { value: '__auto' }, '自动检测'), srcLangs.map((l) => h('option', { value: l }, l)));
  src.value = lt.src || '__auto';
  const setTarget = async (lang) => {
    lt.tgt = ''; lt.swapped = false;
    dk.st = await window.wa.dockLang(st.accountId, st.title, lang);
    dockRender(true);
  };
  const tgt = h('select', { class: 'dk-lang dk-bar-sel', 'aria-label': '翻成哪种语言',
    title: lt.tgt ? '按 ⇄ 对调出来的，只管这个对话；再按一次 ⇄ 回到原样' : manual ? '你手动选的语言，已记在这个对话上；选“自动选择”就恢复中英互译'
      : `自动选择：中文翻成${toCustomer}（${autoTip[st.targetSrc] || '客户的语言'}），英文等别的语言翻成中文`,
    onchange: (e) => setTarget(e.target.value === '__auto' ? '' : e.target.value) },
  h('option', { value: '__auto' }, '自动选择'), st.langs.map((l) => h('option', { value: l }, l)));
  tgt.value = lt.tgt || (manual ? st.target : '__auto');
  const swapBtn = h('button', { class: 'dk-swap', title: '原文语言和目标语言对调（有译文就把译文换到上面）', 'aria-label': '对调语言', disabled: dk.busy, onclick: async () => {
    // 只改当前对话的临时选择，不写进对话/号的记录；对调过再按一次就回到原样
    if (lt.swapped) Object.assign(lt, { src: '', tgt: '', swapped: false });
    else {
      const next = ReplyLang.swap({ text: dk.text, src: lt.src, manual: lt.tgt || (manual ? st.target : ''), autoTarget: st.autoTarget || st.target });
      Object.assign(lt, { src: next.src, tgt: next.manual, swapped: true });
    }
    if (dk.out.trim()) Object.assign(dk, { text: dk.out, out: '', src: '', edited: false, fixed: false, suggest: '', warn: [], forTitle: null });
    dockRender(true);
  } }, icon('swap', 18));
  swapBtn.setAttribute('aria-pressed', String(lt.swapped));
  return h('div', { class: 'dk-bar' }, src, swapBtn, tgt);
}

// 翻译模型：选中就设为默认翻译服务商（和 设置 › 翻译 的默认服务商是同一个设置）
function dockModelSel(cls, short = false) {
  const st = dk.st;
  const provs = st.providers || [];
  if (!provs.length) return null;
  const sel = h('select', { class: `${cls} dk-model`, 'aria-label': '翻译模型', title: '换翻译模型（和 设置 › 翻译 的默认服务商同步）', disabled: dk.busy || provs.length < 2,
    onchange: (e) => dockModel(e.target.value) }, provs.map((p) => h('option', { value: p.id }, p.model ? (short ? p.model : `${p.name} ${p.model}`) : p.name)));
  sel.value = st.primaryId;
  return sel;
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
  requestAnimationFrame(() => { if (box.isConnected && document.activeElement !== box) { box.focus({ preventScroll: true }); box.selectionStart = box.selectionEnd = box.value.length; } });
  return h('div', { class: 'dk-edit' }, box,
    h('div', { class: 'dk-row' },
      h('button', { class: 'pn-btn primary', onclick: save }, '保存'),
      h('button', { class: 'pn-btn', onclick: () => { dk.editing = null; dockRender(true); } }, '取消'),
      h('span', { class: 'dk-dim' }, 'Enter 保存，Esc 取消')));
}
function dockSuggestBox(text, take, drop) {
  return h('div', { class: 'dk-suggest' },
    h('span', { class: 'dk-label' }, '纠错建议'),
    h('span', { class: 'dk-tr' }, text),
    h('span', { class: 'dk-row' }, h('button', { class: 'pn-btn primary', onclick: take }, '采用'), h('button', { class: 'pn-btn', onclick: drop }, '不用')));
}
// 重新打开对话时补回来的旧译文没有原文（磁盘上只存译文）：不能纠错，也没有原文可展开
function dockItemActs(it) {
  return h('span', { class: 'dk-acts-mini' },
    it.text ? h('button', { class: 'dk-link', title: '用更仔细的校对方式重新翻这一条（会替换现在的译文）', onclick: () => window.wa.dockItem(it.h, true) }, '纠错') : null,
    h('button', { class: 'dk-link', title: '直接改译文，改过的不会被自动覆盖', onclick: () => { dk.editing = it.h; dk.editText = it.tr; dockRender(true); } }, '编辑'));
}

// 像 WhatsApp 的收到消息气泡：原文、译文，时间（和“已纠错/已手动修改”）在右下角；纠错/编辑悬停或聚焦时才出现在右上角
function dockSpacer() { return h('span', { class: 'dk-spacer', 'aria-hidden': 'true' }); }
function dockMeta(it) {
  return h('span', { class: 'dk-meta' },
    it.edited ? h('span', { class: 'dk-edited' }, '已手动修改') : it.fixed ? h('span', { class: 'dk-fixed' }, '已纠错') : null,
    h('span', { class: 'dk-time' }, it.t || ''));
}

// 有译文时原文默认完全隐藏，折叠箭头放在中文译文左边：点箭头在译文上面展开原文，再点收起（shen 2026-10-27）。
// 没译文就直接显示原文。原地切换 class，不重画列表：高度平滑过渡，被点的这条上沿不动，列表不跳
// 返回 { box, btn }：box 是原文（放在译文上面），btn 是箭头（放在译文左边）
function dockOrig(key, text, hasTr) {
  if (!hasTr) return { box: h('span', { class: 'dk-orig' }, text), btn: null };
  const btn = h('button', { class: 'dk-fold-btn' });
  const body = h('span', { class: 'dk-orig dk-fold-text' }, text);
  const box = h('span', { class: 'dk-fold' }, body);
  const set = (o) => {
    box.classList.toggle('open', o);
    box.setAttribute('aria-hidden', String(!o));
    btn.setAttribute('aria-expanded', String(o));
    btn.setAttribute('aria-label', o ? '收起原文' : '展开原文');
    btn.title = o ? '收起原文' : '展开原文';
  };
  btn.addEventListener('click', () => {
    const o = !dk.openOrig.has(key);
    if (o) dk.openOrig.add(key); else dk.openOrig.delete(key);
    dockHoldScroll(box);
    set(o);
  });
  set(dk.openOrig.has(key));
  return { box, btn };
}
// 展开/收起的那一下先关掉浏览器的滚动锚定：不然它可能拿这条下面的译文当锚点，把整列往上推
function dockHoldScroll(el) {
  const list = el.closest('.dk-list');
  if (!list) return;
  list.style.overflowAnchor = 'none';
  clearTimeout(list._foldT);
  list._foldT = setTimeout(() => { list.style.overflowAnchor = ''; }, 400);
}

function dockItemRow(it, last) {
  const cls = `dk-item${last ? ' last' : ''}`;
  if (dk.editing === it.h && it.state === 'done') {
    return h('div', { class: `${cls} wide foot`, 'data-h': it.h }, it.text ? h('span', { class: 'dk-orig' }, it.text) : null, fx('dk-edit', it.h, dockItemEdit(it), 'fx-fade'), dockMeta(it));
  }
  const warn = it.warn && it.warn.length ? h('span', { class: 'tr-warn' }, `注意：译文里有原文没有的内容：${it.warn.slice(0, 3).join('、')}`) : null;
  const foot = !!(warn || (it.state === 'done' && it.suggest));
  const sp = foot ? null : dockSpacer();
  // 译文出来（翻译中 → 完成）淡入；纠错建议出现时淡入
  const trFx = fxChanged(`dk-tr:${it.h}`, it.state === 'done' ? `done|${it.tr}` : it.state, false);
  const orig = it.text ? dockOrig(it.h, it.text, it.state === 'done' && !!it.tr) : { box: null, btn: null };
  const trText = trFx ? fxPlay(h('span', { class: 'dk-tr' }, it.tr, sp), 'fx-fade') : h('span', { class: 'dk-tr' }, it.tr, sp);
  const tr = it.state === 'done' ? [orig.btn ? h('span', { class: 'dk-trline' }, orig.btn, trText) : trText, dockItemActs(it),
    it.suggest ? fx(`dk-sg:${it.h}`, it.suggest, dockSuggestBox(it.suggest, () => window.wa.dockSuggest(dk.st.accountId, it.h, true), () => window.wa.dockSuggest(dk.st.accountId, it.h, false))) : null]
    : it.state === 'skip' ? h('span', { class: 'dk-tr' }, it.text, sp) // 时间、数字、表情这类不用翻：原文当译文显示
    : it.state === 'queued' || it.state === 'running' ? h('span', { class: 'dk-tr dk-dim' }, '翻译中…', sp)
      : it.state === 'error' ? h('span', { class: 'dk-tr bad' }, it.err, ' ',
        it.errPid ? h('button', { class: 'dk-link', onclick: () => trOpenKey(it.errPid) }, '去填密钥') : null, it.errPid ? ' ' : null,
        h('button', { class: 'dk-link', onclick: () => window.wa.dockItem(it.h) }, '重试'), sp)
        : h('span', null, h('button', { class: 'dk-link', onclick: () => window.wa.dockItem(it.h) }, it.note === 'long' ? '翻译（太长，不自动翻）' : '翻译'), sp);
  return h('div', { class: `${cls}${foot ? ' foot' : ''}`, 'data-h': it.h },
    it.state === 'skip' ? null : orig.box,
    tr,
    warn,
    dockMeta(it));
}

function dockIncoming() {
  const st = dk.st;
  const list = h('div', { class: 'dk-list' });
  // 只看用户滚到了哪：内容自己变高（字体加载、展开原文）不会触发 scroll，不会把“在底下”误判成“在中间”
  // 程序自己设的滚动（恢复位置）也会触发 scroll：滚动距离没变就不算用户滚的
  list.addEventListener('scroll', () => {
    if (!list.isConnected || list.scrollTop === list._setTop) return;
    dk.stick = list.scrollHeight - list.scrollTop - list.clientHeight <= 24;
  }, { passive: true });
  if (!dk.editing) fxLast.delete('dk-edit'); // 下次点“编辑”还放淡入
  const add = (...x) => list.append(...kids(x));
  const hint = (t, bad) => h('p', { class: `hint dk-hint${bad ? ' bad' : ''}` }, t);
  if (st.readable === 'qr') add(hint('扫码登录后可用。'));
  else if (st.readable === 'nochat') add(hint('先在左边点开一个聊天。'));
  else if (st.readable === 'loading') add(hint('正在读当前对话…'));
  else if (st.readable === 'unreadable') add(hint('打开的聊天里认不出消息（可能是 WhatsApp 改版了）。', true));
  else if (!st.items.length) add(hint('这个对话最近没有收到文字消息。'));
  else st.items.forEach((it, i) => {
    const last = i === st.items.length - 1;
    const row = dockItemRow(it, last);
    // 同一个对话里来了新消息：最后一条从下面浮上来（刚打开或换对话时不放）
    if (last) fx(`dk-last:${st.accountId}|${st.title || ''}`, it.h, row, 'fx-in', false);
    add(row);
  });
  if (st.paused === 'day') add(hint(`今天已经自动翻了 ${st.today} 条（上限 ${st.dailyCap}），自动翻译暂停到明天；可以手动点“翻译”。`));
  else if (st.paused === 'minute') add(hint('一分钟内消息太多，暂时只翻前 20 条，其余可以手动点。'));
  return list;
}

// 重画时保持滚动位置（翻译中、点纠错/编辑都不跳）。
// 记下屏幕上第一条看得见的消息离列表顶部多远，重画后把同一条放回原处：上面的消息变高变矮（翻译中 → 译文）也不会把它挤走。
// 原来就在最底下（或换了对话、第一次画）就滚到底，新消息照样跟上。
// 必须在新列表放进页面后马上调（不等下一帧）：两次重画挨得近时，等下一帧会读到还没恢复的 0，列表就被打回顶部。
function dockScrollMark() {
  const st = dk.st;
  const key = st ? `${st.accountId}|${st.title || ''}` : '';
  const prev = $panel.querySelector('.dk-host .dk-list');
  const same = dk.listKey === key;
  dk.listKey = key;
  if (!same || !prev || !prev.isConnected) dk.stick = true;
  if (dk.stick) return { bottom: true };
  // 用 offsetTop（列表是 position: relative）：不受淡入、上浮这些动画的位移影响
  const top = prev.scrollTop;
  const row = [...prev.querySelectorAll('.dk-item[data-h]')].find((r) => r.offsetTop + r.offsetHeight > top + 1);
  return { bottom: false, h: row ? row.dataset.h : '', off: row ? row.offsetTop - top : 0, scrollTop: top };
}
function dockScrollRestore(mark) {
  const list = $panel.querySelector('.dk-host .dk-list');
  if (!list || !mark) return;
  const row = !mark.bottom && mark.h ? [...list.querySelectorAll('.dk-item[data-h]')].find((r) => r.dataset.h === mark.h) : null;
  if (mark.bottom) list.scrollTop = list.scrollHeight;
  else if (row) list.scrollTop = row.offsetTop - mark.off;
  else list.scrollTop = mark.scrollTop; // 那条已经不在了：退回原来的滚动距离
  list._setTop = list.scrollTop;
}

// 自动翻译开关（和收到用的模式，有两个以上才显示）放在工作台标签栏右边，翻译页没有单独的一行（shen 2026-10-27）
function dockTabTools() {
  const box = h('span', { class: 'wb-tools' });
  const st = dk.st;
  if (!st || !st.hasProvider || !st.accountId) return box;
  const sw = h('input', { type: 'checkbox', class: 'dk-switch', role: 'switch', 'aria-label': '自动翻译收到的消息', checked: st.auto,
    onchange: async (e) => {
      await window.wa.dockAuto(e.target.checked);
    } });
  const inModes = st.modes.in;
  const inSel = inModes.length > 1 ? h('select', { class: 'dk-mini', 'aria-label': '收到用的模式', title: '翻收到的消息用哪个模式', onchange: (e) => window.wa.dockInMode(e.target.value) }, inModes.map((m) => h('option', { value: m.id }, m.name))) : null;
  if (inSel) inSel.value = st.inModeId;
  box.append(...kids(inSel, h('label', { class: 'dk-auto', title: '自动翻译这个号当前对话里新收到的消息' }, '自动翻译', sw)));
  return box;
}
// 状态变了就换标签栏右边的开关；焦点正在开关或下拉上时只改状态，不换元素（不然键盘焦点会丢）
function dockSyncTabTools() {
  const old = $panel.querySelector('.wb-tabs .wb-tools');
  if (!old) return;
  if (old.contains(document.activeElement) && dk.st) {
    const sw = old.querySelector('.dk-switch');
    if (sw) sw.checked = !!dk.st.auto;
    const sel = old.querySelector('.dk-mini');
    if (sel) sel.value = dk.st.inModeId;
    return;
  }
  old.replaceWith(dockTabTools());
}

// 参考样式：灰色圆角框，复制图标在框内左下角，和输入区同一块灰底（shen 2026-10-26 去掉朗读）
// hint：右下角的小字（字符串），或者直接给一个元素（译文框用来放“已手动修改”这类状态）
function dockField(box, getText, hint) {
  const copyBtn = h('button', { class: 'dk-tool', title: '复制', 'aria-label': '复制', onclick: async () => {
    const text = getText();
    if (!text) return;
    await window.wa.panelCopy(text);
    copyFlash(copyBtn);
  } }, icon('copy', 18));
  return h('div', { class: 'dk-card' }, h('div', { class: 'dk-field' }, box,
    h('div', { class: 'dk-tools' }, copyBtn, typeof hint === 'string' ? h('span', { class: 'dk-keyhint' }, hint) : hint || null)));
}

function dockCompose() {
  const st = dk.st;
  // 按键提示常驻在框内右下角，打了字也看得到；Mac 和 Windows 键盘上都有 Shift 和回车，用同一句（shen 2026-10-27）
  const keyHint = h('span', { class: 'dk-keyhint' }, ...segs('回车翻译', 'Shift + 回车换行'));
  const input = h('textarea', { class: 'dk-in', maxlength: '4000', rows: '3', 'aria-label': '要回的话（中文翻成客户的语言，英文翻成中文）', 'aria-description': '回车翻译，Shift + 回车换行' }, dk.text);
  input.addEventListener('input', () => { dk.text = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return; // 输入法选字时的回车不算
    if (e.shiftKey) return; // 换行
    e.preventDefault();
    if (dk.out && dk.edited) return dockSay('译文手动改过，不会自动覆盖。要按新内容翻，点“重新翻译”', true);
    dockTranslate(false);
  });
  const out = h('textarea', { class: 'dk-out', rows: '3', 'aria-label': '译文（可以直接改）' }, dk.out);
  out.addEventListener('input', () => {
    dk.out = out.value;
    if (!dk.edited) { dk.edited = true; editedTag.hidden = false; status.querySelectorAll('.dk-fixed, .dk-dim').forEach((x) => x.remove()); }
  });
  const stale = dk.out && !dk.edited && dk.src !== dk.text;
  // 译文的状态放在译文框右下角（像收到消息气泡那样），上面那行只留语言、模型和两个按钮，窄的时候不会把字挤成两行（shen 2026-10-27）
  const editedTag = h('span', { class: 'dk-edited', hidden: !dk.edited }, '已手动修改');
  const status = h('span', { class: 'dk-status' }, editedTag,
    dk.fixed && !dk.edited ? h('span', { class: 'dk-fixed' }, '已纠错') : null,
    stale ? h('span', { class: 'dk-dim' }, '原文改过了') : null);
  return h('div', { class: 'dk-compose' },
    // 模型选择放在“回复”后面（shen 2026-10-28）
    h('div', { class: 'dk-head' }, h('span', { class: 'dk-label' }, '回复'), dockModelSel('dk-lang', true)),
    dockField(input, () => input.value, keyHint),
    h('div', { class: 'dk-outhead' },
      dockLangBar(),
      dk.busy ? h('button', { class: 'dk-btn', onclick: () => window.wa.trCancel() }, '翻译中… 取消')
        : h('span', { class: 'dk-row' },
          dk.out ? h('button', { class: 'dk-btn', title: 'AI 对照原文和聊天上下文校对下面的译文（改过的只给建议）', onclick: dockFix }, '纠错') : null,
          h('button', { class: 'dk-btn', title: dk.out ? '按现在的原文重新调模型翻一版，会替换下面的译文和记下的译文' : '翻译（这句以前翻过就直接用记下的）', onclick: () => dockTranslate(false, !!dk.out && dk.src === dk.text) }, dk.out ? '重新翻译' : '翻译'))),
    dockField(out, () => out.value, status),
    dk.suggest ? dockSuggestBox(dk.suggest, () => { dk.out = dk.suggest; dk.suggest = ''; dk.edited = false; dk.fixed = true; dockRender(true); }, () => { dk.suggest = ''; dockRender(true); }) : null,
    dk.warn.length ? h('div', { class: 'tr-warn' }, `原文没有：${dk.warn.slice(0, 3).join('、')}`) : null,
    h('div', { class: 'dk-acts' },
      h('button', { class: 'btn primary dk-insert', disabled: dk.busy, title: '放进当前聊天框（会占用剪贴板），不会发送，发送自己按', onclick: dockInsertKey }, '放进输入框')));
}

// 默认翻译服务没填密钥：顶上一条黄条，点“去填密钥”直接打开它的表单
function dockKeyBar() {
  const k = dk.st && dk.st.needKey;
  if (!k) return null;
  return h('div', { class: 'tr-warn dk-keybar', role: 'status' },
    h('span', null, `默认翻译服务「${k.name}」还没填密钥。`),
    h('button', { class: 'pn-btn primary', onclick: () => trOpenKey(k.id) }, '去填密钥'));
}

// force=false：只刷新状态条和消息列表，正在写的回复不动
function dockRender(force = false) {
  if (!dockVisible()) return;
  dockSyncTabTools();
  const host = $panel.querySelector('.dk-host');
  if (!host) return;
  if (!dk.st || dk.st.accountId !== s.activeId) { if (!dk.fetching) { dk.fetching = true; dockFetch().finally(() => { dk.fetching = false; }); } if (!dk.st) { host.replaceChildren(h('div', { class: 'hint dk-hint' }, '加载中…')); return; } }
  const st = dk.st;
  if (!st.accountId) { host.replaceChildren(h('p', { class: 'hint dk-hint' }, '先添加一个 WhatsApp 账号。')); return; }
  // 账号出了问题（代理不通、退出登录等）：读不到对话，工作台只留一句，不显示「正在读当前对话…」和回复框
  const acc = s.accounts.find((a) => a.id === s.activeId);
  if (acc && acc.problem) { host.replaceChildren(h('p', { class: 'hint dk-hint' }, '账号连上后可用。')); return; }
  if (!st.hasProvider) {
    host.replaceChildren(h('div', { class: 'pn-form', style: { paddingTop: '12px' } },
      h('span', { class: 'hint' }, '还没设置翻译服务。'),
      h('button', { class: 'pn-btn primary', onclick: () => { settingsTab = 'translate'; window.wa.showPage('settings'); } }, '去设置')));
    return;
  }
  const root = host.querySelector('.dk');
  const keyBtn = dk.msg && dk.msgPid ? [' ', h('button', { class: 'dk-link', onclick: () => trOpenKey(dk.msgPid) }, '去填密钥')] : [];
  const msg = dk.msg ? fx('dk-msg', dk.msg, h('div', { class: `pn-msg dk-msg${dk.bad ? ' bad' : ''}` }, dk.msg, ...keyBtn, dk.bad ? rawDetail(dk.detail) : null)) : null;
  const typing = root && root.contains(document.activeElement) && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
  const mark = dockScrollMark();
  if (root && !force && typing) {
    // 正在写或在选：只换上面几块
    const keep = root.querySelector('.dk-compose');
    const list = dk.editing ? root.querySelector('.dk-list') : null; // 正在改译文：消息列表先不动
    root.replaceChildren(...kids(dockKeyBar(), list || dockIncoming(), msg, keep));
    dockScrollRestore(mark);
    return;
  }
  const el = h('div', { class: 'dk' }, ...kids(dockKeyBar(), dockIncoming(), msg, dockCompose()));
  const focusIn = root && document.activeElement && document.activeElement.classList.contains('dk-in');
  host.replaceChildren(el);
  dockScrollRestore(mark);
  if (focusIn) { const box = el.querySelector('.dk-in'); box.focus(); box.selectionStart = box.selectionEnd = box.value.length; }
}
