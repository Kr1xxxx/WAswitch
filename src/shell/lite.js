// 轻量模式的聊天页：扫码、对话列表、收发文字。
// 每个账号的页面只建一次，之后只更新变化的部分，免得打字时输入框被清空、滚动位置乱跳。
// 聊天内容一律用 textContent 显示，不拼 HTML；链接只交给主进程按白名单打开。
// 用到 shell.js 里的 h()、icon()（这两个文件共用全局作用域）。

const litePages = new Map(); // 账号 id -> 页面
const LITE_TR_HOLD_MS = 15000; // 用户选着字时，译文更新最多压这么久

// 秒级时间戳 → 今天显示“14:05”，更早显示“10-21”
function liteTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 文字里的链接变成可点的（只认 http、https、mailto、tel，主进程还会再检查一次）
const LINK_RE = /((?:https?:\/\/|mailto:|tel:)[^\s<>"'，。！？、）)\]]+)/gi;
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const url = m[0];
    out.push(h('a', { href: '#', title: url, onclick: (e) => { e.preventDefault(); window.wa.openLink(url); } }, url));
    last = m.index + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function makeLitePage(id) {
  const status = h('div', { class: 'lite-status' });
  const search = h('input', { type: 'search', placeholder: '搜索对话', 'aria-label': '搜索对话' });
  const list = h('div', { class: 'lite-list', role: 'list' });
  const title = h('div', { class: 'lite-head' });
  const msgs = h('div', { class: 'lite-msgs', role: 'log' });
  const input = h('textarea', { rows: '1', maxlength: '4000', placeholder: '输入消息', 'aria-label': '输入消息', 'aria-description': 'Enter 发送，Shift + Enter 换行' });
  const sendBtn = h('button', { class: 'btn primary', type: 'button' }, '发送');
  const err = h('div', { class: 'lite-err', role: 'alert' });
  const conv = h('div', { class: 'lite-conv' }, title, msgs, err, h('div', { class: 'lite-compose' }, input, sendBtn));
  const empty = h('div', { class: 'lite-empty' }, '在左边选一个对话。图片、语音等只显示类型，内容请在手机上看。');
  const main = h('div', { class: 'lite-main' }, h('div', { class: 'lite-side' }, h('div', { class: 'lite-search' }, search), list), conv, empty);
  const el = h('div', { class: 'lite' }, status, main);

  let chats = [];
  let openJid = null;
  let lastRev = -1;
  let lastMsgKey = '';
  let statusKey = '';
  let sending = false;
  const drafts = new Map();
  // 收到的消息下面显示的译文（主进程 lite:tr 发来，按消息编号）；设置里选了「右侧工作台」时是空的
  let trs = new Map();
  let trKey = '';
  let lastView = null;
  // 译文只换变了的那几条（不重建整列，免得用户选着的字没了）。painted：每条消息现在画着什么；
  // clicked：点过「重试」「翻译」、按钮还灰着的消息编号，主进程下次来信时一定要换回能点的；
  // trHold：用户选着消息里的字，译文更新先压着：压了多久（开始压的时间，0 = 没压）
  const painted = new Map();
  const clicked = new Set();
  let trHold = 0;
  let trHoldTimer = null;
  let trMain = false; // 压着的这段时间里主进程来过信（点过的灰按钮要换回能点的）

  function rememberDraft() {
    if (openJid) drafts.set(openJid, { text: input.value });
  }

  function switchChat(jid) {
    if (jid === openJid) return;
    openJid = jid;
    input.value = drafts.get(jid)?.text || '';
    input.style.height = '';
    err.textContent = '';
  }

  function drawList() {
    const q = search.value.trim().toLowerCase();
    const shown = q ? chats.filter((c) => c.name.toLowerCase().includes(q) || (c.preview || '').toLowerCase().includes(q)) : chats;
    const top = list.scrollTop;
    list.replaceChildren(...shown.map((c) => h('button', {
      class: `lite-chat${c.jid === openJid ? ' on' : ''}`, role: 'listitem', title: c.name,
      onclick: () => { switchChat(c.jid); drawList(); window.wa.liteOpen(id, c.jid); },
    },
    h('span', { class: 'lite-chat-top' }, h('b', null, c.name), h('small', null, liteTime(c.ts))),
    h('span', { class: 'lite-chat-bottom' }, h('span', { class: 'lite-preview' }, c.preview || ''), c.unread ? h('span', { class: 'pill' }, c.unread > 99 ? '99+' : c.unread) : null))));
    if (!shown.length) list.append(h('div', { class: 'lite-none' }, q ? '没有找到' : '还没有对话。新消息到了会出现在这里。'));
    list.scrollTop = top;
  }

  // 一条消息下面的译文：done 译文；busy 翻译中；error 原因 + 重试；key「去填密钥」；manual「翻译」按钮（点了和工作台里点一样）
  const trSig = (e) => (e ? [e.k, e.t, e.b, e.p].join('\u0001') : '');
  function trLine(id, me) {
    const e = !me && trs.get(String(id));
    if (!e) return null;
    const btn = (label) => h('button', {
      class: 'lite-tr-btn', type: 'button',
      onclick: (ev) => { ev.currentTarget.disabled = true; clicked.add(String(id)); window.wa.dockItem(e.h); },
    }, label);
    if (e.k === 'done') return h('div', { class: 'lite-tr' }, e.t);
    if (e.k === 'busy') return h('div', { class: 'lite-tr' }, e.t);
    if (e.k === 'error') return h('div', { class: 'lite-tr' }, h('span', { class: 'bad' }, e.t), ' ', btn(e.b));
    // 密钥没填或不对：重试没用，直接去填（打开 设置 › 翻译 里这个服务商的表单）
    if (e.k === 'key') return h('div', { class: 'lite-tr' }, h('button', { class: 'lite-tr-btn', type: 'button', onclick: () => trOpenKey(e.p) }, e.b));
    return h('div', { class: 'lite-tr' }, btn(e.b));
  }

  // 用户在消息里选着字：重画会把选区弄没（Ctrl+C 复制不到），这次先不画；选区没了（selectionchange）再补
  function msgsSelected() {
    const sel = document.getSelection();
    return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && msgs.contains(sel.anchorNode) && msgs.contains(sel.focusNode);
  }

  // 只换变了的译文：消息没变时不重建整列，原文、选区、滚动位置都不动
  function patchTrs(fromMain = false) {
    if (fromMain) trMain = true; // 对话没开着也记下，下次画的时候点过的灰按钮才会换回能点
    if (!lastView || !openJid || lastView.jid !== openJid || conv.hidden) return;
    if (msgsSelected()) {
      if (!trHold) {
        trHold = Date.now();
        // 压到时间就画一次，不用等下一次来信（选着不放也一样）
        trHoldTimer = setTimeout(() => { trHoldTimer = null; patchTrs(); }, LITE_TR_HOLD_MS);
      }
      if (Date.now() - trHold < LITE_TR_HOLD_MS) return;
    }
    trHold = 0;
    clearTimeout(trHoldTimer);
    trHoldTimer = null;
    fromMain = trMain;
    trMain = false;
    const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
    for (const el of msgs.querySelectorAll(':scope > .lite-msg[data-id]')) {
      const id = el.dataset.id;
      const me = el.classList.contains('me');
      const sig = me ? '' : trSig(trs.get(id));
      if (sig === painted.get(id) && !(fromMain && clicked.has(id))) continue;
      painted.set(id, sig);
      const old = el.querySelector(':scope > .lite-tr');
      const next = trLine(id, me);
      if (old && next) old.replaceWith(next);
      else if (old) old.remove();
      else if (next) el.insertBefore(next, el.querySelector(':scope > .time'));
    }
    if (fromMain) clicked.clear();
    if (nearBottom) msgs.scrollTop = msgs.scrollHeight;
  }
  const trFlush = () => { if (trHold && !msgsSelected()) patchTrs(); };

  function drawMessages(view) {
    lastView = view;
    const items = view.messages || [];
    const key = `${view.jid}:${items.length}:${items.length ? items[items.length - 1].id : ''}`;
    if (key === lastMsgKey) { patchTrs(); return; } // 消息没变，最多是译文变了
    const switched = !lastMsgKey.startsWith(`${view.jid}:`);
    lastMsgKey = key;
    const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
    // 本机还没聊过的号码（AI 用 open_chat 打开的）没有名字，显示号码
    const bare = /@s\.whatsapp\.net$/.test(view.jid || '') ? `+${view.jid.split('@')[0]}` : '';
    const name = view.title || (chats.find((c) => c.jid === view.jid) || {}).name || bare;
    title.replaceChildren(h('b', { title: name }, name));
    painted.clear();
    clicked.clear();
    trHold = 0;
    clearTimeout(trHoldTimer);
    trHoldTimer = null;
    trMain = false;
    msgs.replaceChildren(...items.map((m) => {
      painted.set(String(m.id), m.me ? '' : trSig(trs.get(String(m.id))));
      return h('div', { class: `lite-msg${m.me ? ' me' : ''}`, 'data-id': String(m.id) },
        m.from ? h('small', { class: 'from' }, m.from) : null,
        h('span', { class: 'text' }, linkify(m.text)),
        trLine(m.id, m.me),
        h('small', { class: 'time' }, liteTime(m.ts)));
    }));
    if (!items.length) msgs.append(h('div', { class: 'lite-none' }, '这个对话在本机还没有消息记录。'));
    if (switched || nearBottom) msgs.scrollTop = msgs.scrollHeight;
  }

  async function send() {
    const text = input.value;
    if (sending || !text.trim() || !openJid) return;
    const jid = openJid;
    // 提交就清空输入框（和 WhatsApp 一样），发送期间接着打的字不会和已发出的话混在一起
    drafts.delete(jid);
    input.value = '';
    input.style.height = '';
    sending = true;
    sendBtn.disabled = true;
    err.textContent = '';
    // 没发出去：原文放回去。用户这期间在这个对话里又写了别的就不覆盖
    const restore = () => {
      if (drafts.get(jid)?.text) return;
      drafts.set(jid, { text });
      if (openJid === jid) { input.value = text; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; }
    };
    try {
      const res = await window.wa.liteSend(id, jid, text);
      if (res && res.error) {
        restore();
        if (openJid === jid) err.replaceChildren(res.error, ...(res.detail ? [rawDetail(res.detail)] : []));
        return;
      }
      if (openJid === jid) input.focus();
    } catch {
      restore();
      if (openJid === jid) err.textContent = '发送失败，请重试';
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  }
  sendBtn.onclick = send;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => { rememberDraft(); input.style.height = ''; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; });
  search.addEventListener('input', drawList);
  // 选中消息里的文字：旁边出现「翻译」小按钮，点了弹译文窗（和网页号一样，见 sel-translate.js）
  msgs.addEventListener('mouseup', (e) => { if (e.button === 0) setTimeout(() => liteSelCheck(id, msgs), 0); });
  msgs.addEventListener('scroll', liteSelHide, { passive: true });

  // 没连上时盖在聊天页上面的提示（连接中、扫码、二维码过期）
  function drawStatus(acc, lite) {
    const st = lite.status;
    const key = `${st}:${st === 'qr' ? lite.qr : ''}:${acc.proxyLabel}:${lite.fresh}`;
    if (key === statusKey) return;
    statusKey = key;
    if (st === 'qr' && lite.qr) {
      status.replaceChildren(h('div', { class: 'lite-qr' },
        h('img', { src: lite.qr, alt: '登录二维码', width: '264', height: '264' }),
        h('div', { class: 'col', style: { gap: '12px' } },
          h('h2', null, '用手机扫码登录'),
          h('ol', null, h('li', null, '手机打开 WhatsApp'), h('li', null, '设置 › 已关联的设备'), h('li', null, '关联新设备，扫这个二维码')),
          h('p', { class: 'hint' }, `${acc.direct ? '直连（这台电脑的真实 IP）' : `通过 ${acc.proxyLabel} 连接`}`),
          h('div', { class: 'note bad' }, '轻量模式不是官方客户端，这个号有被封的风险。请先用不重要的号试用两周。'))));
    } else if (st === 'qrExpired') {
      status.replaceChildren(h('div', { class: 'panel' },
        h('h2', null, '二维码已过期'),
        h('p', null, '一段时间没有扫码，已停止刷新二维码。'),
        h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: () => window.wa.retry(id) }, '重新获取二维码'))));
    } else {
      // 这次启动后连上过才算“断开”；新加的号、刚打开软件时都写“正在连接”
      const reconnecting = st === 'reconnecting' && lite.fresh === false;
      status.replaceChildren(h('div', { class: 'panel' },
        h('div', { class: 'spinner', 'aria-hidden': 'true' }),
        h('h2', null, reconnecting ? '连接断开，正在重新连接…' : '正在连接…'),
        h('p', null, ...segs('轻量模式', acc.direct ? '直连' : `通过 ${acc.proxyLabel}`))));
    }
  }

  function update(acc, lite) {
    if (!lite) return;
    const open = lite.status === 'open';
    status.hidden = open;
    main.hidden = !open;
    if (!open) { drawStatus(acc, lite); return; }
    statusKey = '';
    const openChanged = lite.openJid !== openJid;
    switchChat(lite.openJid);
    const view = lite.view;
    if (view && view.rev !== lastRev) {
      lastRev = view.rev;
      chats = view.chats || [];
      drawList();
    } else if (openChanged) {
      drawList();
    }
    const showConv = !!openJid;
    conv.hidden = !showConv;
    empty.hidden = showConv;
    if (showConv && view && view.jid === openJid) drawMessages(view);
  }

  // MCP 起草回复：把草稿填进输入框，不发送。jid 必须是正开着的对话。
  // force=false 时输入框里有字就不填；返回 'ok' | 'not_empty' | 'chat'
  function fill(jid, text, { force = false, focus = false } = {}) {
    if (!openJid || jid !== openJid || conv.hidden || main.hidden) return 'chat';
    if (!force && input.value.trim()) return 'not_empty';
    const at = input.selectionStart ?? input.value.length;
    input.value = (input.value.slice(0, at) + text + input.value.slice(input.selectionEnd ?? at)).slice(0, 4000);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (focus) input.focus();
    return 'ok';
  }

  // 主进程发来这个号当前对话的译文（list 为空 = 拿掉）。内容没变不重画
  function setTr(list) {
    const next = new Map((Array.isArray(list) ? list : []).filter((e) => e && typeof e.id === 'string').map((e) => [e.id, e]));
    const key = [...next.values()].map((e) => [e.id, e.k, e.t, e.b, e.p].join('\u0001')).join('\u0002');
    // 内容没变也要往下走一次的情况：点过的按钮还灰着（马上失败的重试，译文和之前一样），要换回能点的
    if (key === trKey && !clicked.size) return;
    trs = next;
    trKey = key;
    patchTrs(true);
  }

  return { el, update, fill, setTr, trFlush };
}

window.wa.onLiteTr(({ accountId, list } = {}) => {
  for (const [id, p] of litePages) if (!accountId || id === accountId) p.setTr(accountId ? list : []);
});

// ---- 选中文字后的「翻译」小按钮和悬浮译文窗（轻量号的聊天页是软件自己的界面，直接画在这里；样子和网页号的一样，共用 seltr/card.js） ----
// 放在选区最后一行下面，下面放不下就放到第一行上面；按钮右边和选区末尾对齐，译文窗左边和最后一行开头对齐
let liteSelBox = null; // { wrap, card }
let liteSel = null; // { id, text, mode, first, last, area }
function liteSelHide() {
  liteSel = null;
  if (liteSelBox) liteSelBox.wrap.hidden = true;
}
function liteSelPlace() {
  if (!liteSel || !liteSelBox) return;
  const { wrap } = liteSelBox;
  const { area, first, last } = liteSel;
  const bw = wrap.offsetWidth;
  const bh = wrap.offsetHeight;
  let top = last.bottom + 4;
  if (top + bh > area.bottom) top = first.top - 4 - bh;
  top = Math.max(area.top, Math.min(area.bottom - bh, top));
  const left = Math.max(area.left, Math.min(area.right - bw, liteSel.mode === 'card' ? last.left : last.right - bw));
  Object.assign(wrap.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
}
async function liteSelGo() {
  const cur = liteSel;
  if (!cur || !liteSelBox) return;
  cur.mode = 'card';
  liteSelBox.card.set({ mode: 'card', busy: true });
  liteSelPlace();
  let r;
  try { r = await window.wa.selTranslate(cur.id, cur.text); } catch { r = { error: '翻译失败' }; }
  if (liteSel !== cur) return; // 期间收起了或换了别的选区
  liteSelBox.card.set(r && typeof r.text === 'string' && r.text.trim() ? { mode: 'card', text: r.text } : { mode: 'card', error: (r && r.error) || '翻译失败' });
  liteSelPlace();
}
// 只取消息正文（.text）里被选中的部分：拖选整条消息时不带上发送人和时间
function liteSelText(r) {
  const parts = [];
  let last = null;
  for (const t of document.querySelectorAll('.lite-msgs .lite-msg .text')) {
    if (!r.intersectsNode(t)) continue;
    const part = document.createRange();
    part.selectNodeContents(t);
    if (r.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(r.startContainer, r.startOffset);
    if (r.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(r.endContainer, r.endOffset);
    if (last) parts.push('\n');
    parts.push(part.toString());
    last = t;
  }
  return parts.join('').trim();
}
function liteSelCheck(id, box) {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return liteSelHide();
  const r = sel.getRangeAt(0);
  const inside = (n) => !!n && box.contains(n.nodeType === 1 ? n : n.parentElement);
  if (!inside(r.startContainer) || !inside(r.endContainer)) return liteSelHide();
  const text = liteSelText(r) || String(sel.toString() || '').trim();
  if (!text) return liteSelHide();
  const rects = [...r.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
  if (!rects.length) return liteSelHide();
  if (!liteSelBox) {
    const card = window.SelCard({ go: liteSelGo, retry: liteSelGo, copy: (t) => window.wa.panelCopy(t) });
    const wrap = h('div', { class: 'sel-pop', hidden: true }, card.root);
    document.body.append(wrap);
    liteSelBox = { wrap, card };
  }
  liteSel = { id, text: text.slice(0, 4000), mode: 'button', first: rects[0], last: rects[rects.length - 1], area: box.getBoundingClientRect() };
  liteSelBox.card.set({ mode: 'button' });
  liteSelBox.wrap.hidden = false;
  liteSelPlace();
}
// 点到按钮和译文窗外面、按键（Ctrl/Cmd 组合键除外，好让 Ctrl+C 复制）、选区没了（按钮状态时）、
// 改窗口大小、换号、锁定、离开账号页就收起
document.addEventListener('mousedown', (e) => { if (liteSel && !liteSelBox.wrap.contains(e.target)) liteSelHide(); }, true);
document.addEventListener('keydown', (e) => {
  if (!liteSel || liteSelBox.wrap.contains(e.target) || e.ctrlKey || e.metaKey || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  liteSelHide();
}, true);
window.addEventListener('resize', () => { if (liteSel) liteSelHide(); });
if (window.wa.onState) window.wa.onState((st) => { if (liteSel && (!st || st.locked || st.page !== 'account' || st.activeId !== liteSel.id)) liteSelHide(); });
document.addEventListener('selectionchange', () => {
  for (const p of litePages.values()) p.trFlush(); // 选区没了，补上压着没画的译文
  if (!liteSel || liteSel.mode !== 'button') return;
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) liteSelHide();
});

// shell.js 调用：返回这个账号的聊天页（同一个元素），并更新内容
function litePage(acc, lite) {
  let p = litePages.get(acc.id);
  if (!p) { p = makeLitePage(acc.id); litePages.set(acc.id, p); }
  p.update(acc, lite && lite.id === acc.id ? lite : null);
  return p.el;
}

// 主进程请求填草稿（MCP 起草回复）。刚打开的对话可能还没画出来，最多等 1.5 秒
async function liteFillDraft({ id, jid, text, force, focus }) {
  for (let i = 0; i < 15; i += 1) {
    const p = litePages.get(id);
    const r = p && typeof text === 'string' ? p.fill(jid, text, { force, focus }) : 'none';
    if (r !== 'chat' && r !== 'none') return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  return litePages.has(id) ? 'chat' : 'none';
}
if (window.wa.onLiteFill) window.wa.onLiteFill(async (req) => window.wa.liteFilled(req.n, await liteFillDraft(req)));

// 账号删掉后释放页面
function liteForget(ids) {
  for (const id of litePages.keys()) if (!ids.includes(id)) litePages.delete(id);
}
