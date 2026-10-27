// 轻量模式的聊天页：扫码、对话列表、收发文字。
// 每个账号的页面只建一次，之后只更新变化的部分，免得打字时输入框被清空、滚动位置乱跳。
// 聊天内容一律用 textContent 显示，不拼 HTML；链接只交给主进程按白名单打开。
// 用到 shell.js 里的 h()、icon()（这两个文件共用全局作用域）。

const litePages = new Map(); // 账号 id -> 页面

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
  const input = h('textarea', { rows: '1', maxlength: '4000', placeholder: '输入消息，Enter 发送，Shift + Enter 换行', 'aria-label': '输入消息' });
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

  function drawList() {
    const q = search.value.trim().toLowerCase();
    const shown = q ? chats.filter((c) => c.name.toLowerCase().includes(q) || (c.preview || '').toLowerCase().includes(q)) : chats;
    const top = list.scrollTop;
    list.replaceChildren(...shown.map((c) => h('button', {
      class: `lite-chat${c.jid === openJid ? ' on' : ''}`, role: 'listitem', title: c.name,
      onclick: () => { openJid = c.jid; drawList(); window.wa.liteOpen(id, c.jid); },
    },
    h('span', { class: 'lite-chat-top' }, h('b', null, c.name), h('small', null, liteTime(c.ts))),
    h('span', { class: 'lite-chat-bottom' }, h('span', { class: 'lite-preview' }, c.preview || ''), c.unread ? h('span', { class: 'pill' }, c.unread > 99 ? '99+' : c.unread) : null))));
    if (!shown.length) list.append(h('div', { class: 'lite-none' }, q ? '没有找到' : '还没有对话。新消息到了会出现在这里。'));
    list.scrollTop = top;
  }

  function drawMessages(view) {
    const items = view.messages || [];
    const key = `${view.jid}:${items.length}:${items.length ? items[items.length - 1].id : ''}`;
    if (key === lastMsgKey) return;
    const switched = !lastMsgKey.startsWith(`${view.jid}:`);
    lastMsgKey = key;
    const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
    title.replaceChildren(h('b', null, view.title || (chats.find((c) => c.jid === view.jid) || {}).name || ''));
    msgs.replaceChildren(...items.map((m) => h('div', { class: `lite-msg${m.me ? ' me' : ''}` },
      m.from ? h('small', { class: 'from' }, m.from) : null,
      h('span', { class: 'text' }, linkify(m.text)),
      h('small', { class: 'time' }, liteTime(m.ts)))));
    if (!items.length) msgs.append(h('div', { class: 'lite-none' }, '这个对话在本机还没有消息记录。'));
    if (switched || nearBottom) msgs.scrollTop = msgs.scrollHeight;
  }

  async function send() {
    const text = input.value;
    if (sending || !text.trim() || !openJid) return;
    sending = true;
    sendBtn.disabled = true;
    err.textContent = '';
    const res = await window.wa.liteSend(id, openJid, text);
    sending = false;
    sendBtn.disabled = false;
    if (res && res.error) { err.replaceChildren(res.error, ...(res.detail ? [rawDetail(res.detail)] : [])); return; }
    input.value = '';
    input.style.height = '';
    input.focus();
  }
  sendBtn.onclick = send;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = `${Math.min(input.scrollHeight, 140)}px`; });
  search.addEventListener('input', drawList);

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
          h('ol', null, h('li', null, '手机打开 WhatsApp'), h('li', null, '设置 › 已关联的设备'), h('li', null, '关联新设备，扫左边的二维码')),
          h('p', { class: 'hint' }, `${acc.direct ? '直连（这台电脑的真实 IP）' : `通过 ${acc.proxyLabel} 连接`}。二维码每隔一会儿自动更新。`),
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
        h('p', null, `轻量模式 · ${acc.direct ? '直连' : `通过 ${acc.proxyLabel}`}`)));
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
    openJid = lite.openJid;
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

  return { el, update, fill };
}

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
