// 读取 WhatsApp 页面状态用到的全部选择器都放在这里。WhatsApp 改版时只改这一个文件。
// MCP 第二层读取对话列表时也复用这里。
//
// 规则（经 shen 同意）：只在隔离环境（isolated world）里只读检查，不在页面自己的环境里运行脚本，
// 不修改页面。掉线检测不读聊天内容；MCP 第二层只在用户确认后读对话列表（预览默认不读）和当前打开对话的消息（read_messages）。

const ISOLATED_WORLD = 1001; // 固定的隔离环境编号，和页面自己的脚本互不可见

const SELECTORS = {
  // 登录后才有的左侧对话列表
  loggedIn: ['#pane-side', '#side'],
  // 登录页：二维码容器或二维码画布
  needsQr: ['div[data-ref]', 'canvas[aria-label*="QR" i]', 'canvas[aria-label*="scan" i]'],
  // MCP 第二层：左侧对话列表
  chatPane: ['#pane-side'],
  chatRow: ['[role="row"]', '[role="listitem"]'],
  // 对话名称和最后一条消息预览都是带 title 的 span：第一个是名称，后面的是预览
  titled: 'span[title]',
  pinned: '[data-icon*="pinned" i]',
  muted: '[data-icon*="muted" i]',
  // 头像位置的默认群组图标。头像是照片时认不出群/个人
  groupIcon: '[data-icon*="default-group" i], [data-icon="group" i]',
  personIcon: '[data-icon*="default-user" i], [data-icon*="default-contact" i]',
  // 列表上方的搜索框和“全部 / 未读 / 群组”筛选
  searchBox: ['#side div[contenteditable="true"]', '#side input[type="text"]'],
  filterTab: '#side [role="tab"], #side [role="tablist"] button',
  // 悬浮翻译：当前打开的对话（右侧 #main）
  chatMain: '#main',
  // 对话下方写消息的输入框。“放进输入框”只在焦点在这里时才粘贴
  composeBox: ['#main footer [contenteditable="true"]'],
  chatTitle: ['#main header span[title]', '#main header [title]', '#main header span[dir="auto"]'],
  // 每条消息的外层带 data-id（true_ 开头是自己发的，false_ 开头是收到的）
  message: '[data-id]',
  // 消息正文：带 data-pre-plain-text 的 copyable-text 里的 selectable-text。
  // data-pre-plain-text 本身含时间和群发送人，不读它
  messageBody: ['.copyable-text[data-pre-plain-text]', '[data-pre-plain-text]'],
  messageText: ['span.selectable-text', '[data-testid*="selectable-text"]', 'span[dir]'],
  // 没有 true_/false_ 前缀时，用气泡的 class 认方向
  messageIn: '.message-in',
  messageOut: '.message-out',
  // 认不出方向时再看：只有自己发的消息才带发送状态的勾（单勾、双勾、发送中的钟）
  messageTick: '[data-icon="msg-check"], [data-icon="msg-dblcheck"], [data-icon="msg-time"], [data-icon="msg-check-light"], [data-icon="msg-dblcheck-light"], [data-icon="tail-out"]',
  // 引用的消息、链接预览是可点的块，跳过里面的文字
  messageSkip: '[role="button"], .quoted-mention',
  // 语音气泡：播放按钮、语音图标或语音滑条（引用块里的不算）
  voiceMark: '[data-icon="audio-play"], [data-icon="audio-pause"], [data-icon*="ptt" i], [data-icon*="audio-download" i], [aria-label*="voice message" i], [aria-label*="语音"]',
};

// 返回 'logged_in' | 'needs_qr' | 'unknown'（页面还在加载或认不出来）
const CHECK_CODE = `(() => {
  const has = (list) => list.some((s) => document.querySelector(s));
  if (has(${JSON.stringify(SELECTORS.loggedIn)})) return 'logged_in';
  if (has(${JSON.stringify(SELECTORS.needsQr)})) return 'needs_qr';
  return 'unknown';
})()`;

async function loginState(wc) {
  if (wc.isDestroyed() || wc.isLoading()) return 'unknown';
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: CHECK_CODE }]);
    return ['logged_in', 'needs_qr'].includes(r) ? r : 'unknown';
  } catch {
    return 'unknown';
  }
}

// 读左侧对话列表里当前已经显示出来的对话。只用 querySelector 读文字和属性：
// 不点击、不滚动、不改 DOM、不触发任何事件。
// 返回 { ok: true, chats, filtered } 或 { ok: false, reason }。
const LIST_CODE = (opts) => `((S, opts) => {
  const pick = (list) => { for (const s of list) { const el = document.querySelector(s); if (el) return el; } return null; };
  const pane = pick(S.chatPane);
  if (!pane) return { ok: false, reason: 'no_list' };
  let rows = [];
  for (const s of S.chatRow) { rows = [...pane.querySelectorAll(s)]; if (rows.length) break; }
  if (!rows.length) {
    return { ok: false, reason: (pane.innerText || '').trim() ? 'unrecognized' : 'empty' };
  }
  const leafTexts = (row) => [...row.querySelectorAll('span, div')]
    .filter((el) => el.children.length === 0)
    .map((el) => (el.textContent || '').trim())
    .filter(Boolean);
  const TIME = /^(\\d{1,2}[:.]\\d{2}(\\s?[ap]\\.?m\\.?)?|[ap]m\\s?\\d{1,2}[:.]\\d{2}|(上午|下午|晚上|凌晨)\\s?\\d{1,2}[:.]\\d{2}|\\d{1,4}[\\/.-]\\d{1,2}[\\/.-]\\d{1,4}|\\d{1,2}月\\d{1,2}日|昨天|前天|今天|yesterday|today|(星期|周)[一二三四五六日天]|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
  const chats = [];
  let unrecognized = 0;
  for (const row of rows) {
    const titled = [...row.querySelectorAll(S.titled)].map((el) => el.getAttribute('title') || '').filter(Boolean);
    const name = titled[0];
    if (!name) { unrecognized += 1; continue; }
    const texts = leafTexts(row);
    const badge = [...row.querySelectorAll('[aria-label]')].find((el) => /^\\d{1,4}$/.test((el.textContent || '').trim()));
    const time = texts.find((t) => t !== name && t.length <= 16 && TIME.test(t)) || '';
    let isGroup = null;
    if (row.querySelector(S.groupIcon)) isGroup = true;
    else if (row.querySelector(S.personIcon)) isGroup = false;
    const chat = {
      name,
      unread: badge ? Number(badge.textContent.trim()) : 0,
      time,
      pinned: !!row.querySelector(S.pinned),
      muted: !!row.querySelector(S.muted),
      is_group: isGroup,
    };
    if (opts.includePreview) {
      const preview = titled.slice(1).find((t) => t !== name) || '';
      chat.preview = preview.length > 100 ? preview.slice(0, 100) + '…' : preview;
    }
    chats.push(chat);
  }
  if (!chats.length) return { ok: false, reason: 'unrecognized' };
  const search = pick(S.searchBox);
  const searching = !!(search && ((search.value || search.textContent || '').trim()));
  const tabs = [...document.querySelectorAll(S.filterTab)];
  const selected = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true' || t.getAttribute('aria-pressed') === 'true');
  return { ok: true, chats, filtered: searching || selected > 0, unrecognized, total: rows.length };
})(${JSON.stringify(SELECTORS)}, ${JSON.stringify(opts)})`;

async function readChatList(wc, { includePreview = false } = {}) {
  if (wc.isDestroyed() || wc.isLoading()) return { ok: false, reason: 'loading' };
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: LIST_CODE({ includePreview: !!includePreview }) }]);
    return r && typeof r === 'object' ? r : { ok: false, reason: 'unrecognized' };
  } catch {
    return { ok: false, reason: 'unrecognized' };
  }
}

// 从 data-pre-plain-text（形如 "[10:31, 2026/10/24] 名字: "）里只取出时间，名字不出隔离环境。
// 在账号页面自己的时区里转成绝对时间；主进程的系统时区不能用来解释页面时间。
// ambig = 日 / 月顺序拿不准，altAt 是另一种解释；认不出返回 null。
// 这个函数会被原样放进页面的隔离环境里运行（见 READ_CHAT_CODE），所以不能用外面的变量。
function parsePre(raw) {
  const m = /^\[([^\]]{3,60})\]/.exec(String(raw || ''));
  if (!m) return null;
  const inner = m[1];
  const tm = /(上午|下午|凌晨|早上|中午|晚上)?\s*(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*(AM|PM|am|pm|a\.\s?m\.|p\.\s?m\.)?/.exec(inner);
  const cn = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(inner);
  const dm = cn ? [cn[0], cn[1], cn[2], cn[3]] : /(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})/.exec(inner);
  if (!tm || !dm) return null;
  let h = Number(tm[2]);
  const mi = Number(tm[3]);
  const pm = (tm[4] && /p/i.test(tm[4])) || (tm[1] && /下午|晚上/.test(tm[1]));
  const am = (tm[4] && /a/i.test(tm[4])) || (tm[1] && /上午|凌晨|早上/.test(tm[1]));
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  const a = Number(dm[1]);
  const b = Number(dm[2]);
  const c = Number(dm[3]);
  let y;
  let mo;
  let d;
  let ambig = false;
  if (dm[1].length === 4) { y = a; mo = b; d = c; } else if (dm[3].length === 2 || dm[3].length === 4) {
    y = c < 100 ? 2000 + c : c;
    if (a > 12) { d = a; mo = b; } else if (b > 12) { mo = a; d = b; } else { d = a; mo = b; ambig = a !== b; }
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const make = (month, day) => {
    const v = new Date(y, month - 1, day, h, mi);
    // 拒绝不存在的日期和夏令时跳过的本地时间，不让 Date 自动进位。
    return v.getFullYear() === y && v.getMonth() === month - 1 && v.getDate() === day
      && v.getHours() === h && v.getMinutes() === mi ? v.getTime() : null;
  };
  const at = make(mo, d);
  const altAt = ambig ? make(d, mo) : null;
  if (at === null && altAt === null) return null;
  return { y, mo, d, h, mi, ambig, at, altAt };
}

// 悬浮翻译和 CRM 同步：只读当前打开的对话的最后 20 条消息。
// 只用 querySelector / getAttribute / textContent（不用 innerText，不触发排版），不滚动、不聚焦、不改页面。
// 不读群里的发送人、引用的消息和链接预览；时间只在隔离环境里解析成数字（t），发送人名字不带出来。每条最多 4000 字，总共最多 20000 字。
// MCP 的 read_messages 可以多读一些（最多 50 条，总共最多 40000 字），见 readOpenChat 的 max
const MAX_MSGS = 20;
const MAX_MSGS_LIMIT = 50;
// Shared read-only identity snapshot. Mixed/transitional DOMs fail closed.
function chatIdentity(main) {
  if (!main) return '';
  const ids = new Set();
  for (const el of main.querySelectorAll('[data-id]')) {
    if (el.parentElement?.closest('[data-id]')) continue;
    const id = /^(?:true|false)_([^_]+@(?:c\.us|s\.whatsapp\.net|g\.us|lid))_/.exec(el.getAttribute('data-id') || '');
    if (id) ids.add(id[1]);
  }
  return ids.size === 1 ? [...ids][0] : '';
}
const readChatCode = (max = MAX_MSGS) => `(() => {
  const parsePre = ${parsePre.toString()};
  const S = ${JSON.stringify({ main: SELECTORS.chatMain, title: SELECTORS.chatTitle, msg: SELECTORS.message, body: SELECTORS.messageBody, text: SELECTORS.messageText, skip: SELECTORS.messageSkip, mIn: SELECTORS.messageIn, mOut: SELECTORS.messageOut, tick: SELECTORS.messageTick, voice: SELECTORS.voiceMark, loggedIn: SELECTORS.loggedIn, qr: SELECTORS.needsQr })};
  const first = (root, list) => { for (const s of list) { const el = root.querySelector(s); if (el) return el; } return null; };
  const main = document.querySelector(S.main);
  const chat = (${chatIdentity.toString()})(main);
  // 没打开对话：还停在二维码页（没登录）时单独说，翻译页提示“扫码登录后可用”
  if (!main) return { ok: false, why: !first(document, S.loggedIn) && first(document, S.qr) ? 'qr' : 'nochat' };
  const t = first(main, S.title);
  const title = t ? String(t.getAttribute('title') || t.textContent || '').trim().slice(0, 100) : '';
  // 能读就读：方向先看编号前缀 true_/false_，再看气泡 class，都认不出就当成收到的
  const dirOf = (n, id) => {
    if (/^(true|false)_/.test(id)) return id.startsWith('true_');
    if (n.matches(S.mOut) || n.querySelector(S.mOut) || n.closest(S.mOut)) return true;
    if (n.matches(S.mIn) || n.querySelector(S.mIn) || n.closest(S.mIn)) return false;
    // 都没有：这一行里有发送状态的勾（不算引用块里的）就是自己发的
    const row = n.closest('[role="row"]') || n;
    for (const x of row.querySelectorAll(S.tick)) if (!x.closest(S.skip)) return true;
    return null;
  };
  // 正文：先找文字 span；找不到就拿正文块的文字（复制一份再去掉引用/链接预览，不碰页面）
  const textOf = (n) => {
    const body = first(n, S.body) || (n.matches('[data-pre-plain-text]') ? n : null);
    const t = body ? parsePre(body.getAttribute('data-pre-plain-text')) : null;
    const root = body || n;
    for (const sel of S.text) {
      for (const sp of root.querySelectorAll(sel)) {
        if (sp.closest(S.skip)) continue;
        const v = String(sp.textContent || '');
        if (v.trim()) return { text: v, t, pre: body ? body.getAttribute('data-pre-plain-text') || '' : '' };
      }
    }
    let text = '';
    if (body) {
      const c = body.cloneNode(true);
      for (const x of c.querySelectorAll(S.skip)) x.remove();
      text = String(c.textContent || '').trim();
    }
    return { text, t, pre: body ? body.getAttribute('data-pre-plain-text') || '' : '' };
  };
  const hash = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0; return h.toString(36); };
  const chatPart = 'chat:' + title.replace(/_/g, ' ');
  // 发送人名字（data-pre-plain-text 里冒号前那段）只在这里用来认方向，不带出隔离环境
  const norm = (v) => String(v || '').replace(/[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/g, '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const nameOf = (n) => {
    const b = first(n, S.body) || (n.matches('[data-pre-plain-text]') ? n : null);
    const m = b ? /^\\[[^\\]]*\\]\\s*(.*?):\\s*$/.exec(b.getAttribute('data-pre-plain-text') || '') : null;
    return m ? norm(m[1]) : '';
  };
  // 气泡靠右就是自己发的（从右到左的界面反过来）。只读位置，不改页面；读不出位置（不可见、没有样式）就返回 null
  const rtl = (document.documentElement.getAttribute('dir') || document.body.getAttribute('dir') || '') === 'rtl';
  const mr = main.getBoundingClientRect();
  const sideOf = (n) => {
    if (mr.width < 200) return null;
    const r = (first(n, S.body) || n).getBoundingClientRect();
    if (!r.width || r.width > mr.width - 48) return null;
    const left = r.left - mr.left;
    const right = mr.right - r.right;
    if (Math.abs(left - right) < 24) return null;
    return (left > right) !== rtl;
  };
  // 认不出方向的消息再看两样：气泡在哪一边；发送人名字和认得出的消息、对话标题对不对得上
  const resolve = (list) => {
    for (const e of list) if (e.out === null) e.out = sideOf(e.n);
    const dir = new Map();
    for (const e of list) {
      e.name = nameOf(e.n);
      if (!e.name || e.out === null) continue;
      dir.set(e.name, dir.has(e.name) && dir.get(e.name) !== e.out ? 'mixed' : e.out);
    }
    const tn = norm(title);
    // 有人的名字就是对话标题、而且是收到的：这是私聊，别的名字只能是自己
    const oneToOne = !!tn && (dir.get(tn) === false || (!dir.has(tn) && list.some((e) => e.name === tn)));
    for (const e of list) {
      if (e.out !== null || !e.name) continue;
      const d = dir.get(e.name);
      if (d === true || d === false) e.out = d;
      else if (e.name === tn) e.out = false;
      else if (oneToOne) e.out = true;
    }
  };
  const top = [];
  // 第一遍：带 data-id 的消息
  const all = main.querySelectorAll(S.msg);
  for (const n of all) {
    const id = n.getAttribute('data-id') || '';
    if (!id) continue;
    if (n.parentElement && n.parentElement.closest(S.msg)) continue; // 嵌在别的消息里（引用）
    const out = dirOf(n, id);
    if (out === null && !n.querySelector('[data-pre-plain-text]')) continue; // 既认不出方向也没有正文，多半不是消息
    top.push({ n, rawId: id, out });
  }
  resolve(top);
  for (const e of top) {
    if (e.out === null) e.out = false; // 实在认不出：当成收到的，客户的消息不能漏
    // 新格式编号没有 true_/false_ 前缀：补成同样的形状，悬浮窗靠中间那段认出换了对话
    e.id = /^(true|false)_/.test(e.rawId) ? e.rawId : (e.out ? 'true_' : 'false_') + chatPart + '_' + e.rawId;
  }
  // 第二遍：没有 data-id 时，按正文块或气泡读，编号用内容算出来（同样的话出现几次就加序号）
  if (!top.length) {
    for (const n of main.querySelectorAll('[data-pre-plain-text], ' + S.mIn + ', ' + S.mOut)) {
      if (n.parentElement && n.parentElement.closest('[data-pre-plain-text], ' + S.mIn + ', ' + S.mOut)) continue;
      top.push({ n, out: dirOf(n, '') });
    }
    resolve(top);
    const seen = new Map();
    for (const e of top) {
      const out = e.out === true;
      const { text, pre } = textOf(e.n);
      const key = (out ? 'o' : 'i') + pre + '|' + text;
      const k = (seen.get(key) || 0) + 1;
      seen.set(key, k);
      e.out = out;
      e.id = (out ? 'true_' : 'false_') + chatPart + '_h' + hash(key) + '.' + k;
    }
  }
  // 一条都没有：没有标题也没有消息行，多半是没点开对话（右边是空白页）；有标题就是空对话
  if (!top.length) {
    const rows = main.querySelectorAll('[role="row"]').length;
    if (!t && !rows) return { ok: false, why: 'nochat' };
    if (!rows) return { ok: true, title, chat, msgs: [] };
    return { ok: false, why: 'nomatch' };
  }
  const msgs = [];
  let size = 0;
  // 从最新的往前取，字数超了就丢掉更早的（要翻的是新消息）
  for (const { n, id: rawId, out } of top.slice(-${max}).reverse()) {
    const id = rawId.slice(0, 300);
    const r = textOf(n);
    const text = r.text.slice(0, 4000);
    if (size + text.length > ${max > MAX_MSGS ? 40000 : 20000}) break;
    size += text.length;
    // 客户发来的语音（编号带 true_/false_ 才算，下载要用它）：没有文字，带 voice（时长认不准，给 0，以 WhatsApp 存的为准）
    const voice = !out && /^(true|false)_/.test(rawId) && !/\\p{L}/u.test(text) && [...n.querySelectorAll(S.voice)].some((x) => !x.closest(S.skip));
    msgs.push(voice ? { id, out, text: '', t: r.t, voice: 0 } : { id, out, text, t: r.t });
  }
  msgs.reverse();
  // 是不是停在最下面：往上翻聊天记录时 WhatsApp 会把最下面的新消息从页面上拿掉，这时读到的最后几条不是最新的。
  // 找最后一条消息外面能滚动的那层，离底部还远就是 false；找不到（没排版、页面改版）是 null。只读位置，不滚动
  let bottom = null;
  const last = top[top.length - 1].n;
  for (let sc = last.parentElement; sc && sc !== main; sc = sc.parentElement) {
    if (sc.scrollHeight <= sc.clientHeight + 4) continue;
    const cs = getComputedStyle(sc);
    if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
    const dist = cs.flexDirection === 'column-reverse' ? Math.abs(sc.scrollTop) : sc.scrollHeight - sc.clientHeight - sc.scrollTop;
    const gap = last.getBoundingClientRect().bottom - sc.getBoundingClientRect().bottom;
    bottom = dist <= 120 && gap <= 120;
    break;
  }
  return { ok: true, title, chat, msgs, bottom };
})()`;
const READ_CHAT_CODE = readChatCode(MAX_MSGS);

const cleanTime = (t) => {
  if (!t || typeof t !== 'object') return null;
  const n = (k, lo, hi) => (Number.isInteger(t[k]) && t[k] >= lo && t[k] <= hi ? t[k] : NaN);
  const v = { y: n('y', 2000, 2100), mo: n('mo', 1, 12), d: n('d', 1, 31), h: n('h', 0, 23), mi: n('mi', 0, 59) };
  if (Object.values(v).some(Number.isNaN)) return null;
  const stamp = (n) => Number.isSafeInteger(n) && n >= Date.UTC(1999, 0, 1) && n < Date.UTC(2102, 0, 1) ? n : null;
  const at = stamp(t.at);
  const altAt = t.ambig === true ? stamp(t.altAt) : null;
  if (at === null && altAt === null) return null;
  return { ...v, ambig: t.ambig === true, at, altAt };
};

// max：最多读几条（默认 20，最多 50）。只读页面上已经显示出来的消息，不滚动
async function readOpenChat(wc, { max = MAX_MSGS } = {}) {
  if (wc.isDestroyed() || wc.isLoading()) return { ok: false, why: 'loading' };
  const n = Number.isInteger(max) ? Math.min(Math.max(max, 1), MAX_MSGS_LIMIT) : MAX_MSGS;
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: n === MAX_MSGS ? READ_CHAT_CODE : readChatCode(n) }]);
    if (!r || typeof r !== 'object' || !r.ok || !Array.isArray(r.msgs)) return { ok: false, why: (r && r.why) || 'bad' };
    const msgs = r.msgs.filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string').slice(-n)
      .map((m) => ({ id: m.id.slice(0, 300), out: m.out === true, text: m.text.slice(0, 4000), t: cleanTime(m.t), ...(m.voice === 0 && m.out !== true ? { voice: 0 } : {}) }));
    return { ok: true, title: typeof r.title === 'string' ? r.title.slice(0, 100) : '', chat: typeof r.chat === 'string' ? r.chat.slice(0, 100) : '', msgs, bottom: typeof r.bottom === 'boolean' ? r.bottom : null };
  } catch {
    return { ok: false, why: 'error' };
  }
}

// 顶栏“客户当地时间”用：当前打开的对话是谁。只读标题和消息 data-id 中间一致的对话编号，
// 私聊是“号码@c.us”，群是“…@g.us”），不读消息内容。号码只留在主进程，见 customer-time.js
const READ_PEER_CODE = `(() => {
  const S = ${JSON.stringify({ main: SELECTORS.chatMain, title: SELECTORS.chatTitle })};
  const main = document.querySelector(S.main);
  if (!main) return null;
  let title = '';
  for (const sel of S.title) { const el = main.querySelector(sel); if (el) { title = String(el.getAttribute('title') || el.textContent || '').trim().slice(0, 100); break; } }
  return { title, chat: (${chatIdentity.toString()})(main) };
})()`;

async function readChatPeer(wc) {
  if (wc.isDestroyed() || wc.isLoading()) return null;
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: READ_PEER_CODE }]);
    if (!r || typeof r !== 'object') return null;
    return { title: typeof r.title === 'string' ? r.title.slice(0, 100) : '', chat: typeof r.chat === 'string' ? r.chat.slice(0, 100) : '' };
  } catch {
    return null;
  }
}

// 新版 WhatsApp 的私聊编号很多是隐私编号（123…@lid），存了名字的联系人标题又是名字，顶栏就认不出号码。
// 这时到 WhatsApp 自己的本地数据库（IndexedDB 的 model-storage）里只读查一下：
//   1. 名字里带 lid / pn / contact 的表，按隐私编号取那一条，找里面的手机号（phoneNumber 等字段）
//   2. 还没有：在联系人表里找名字和标题一样的联系人，只有一个号码对得上才用
// 只读：不带版本号打开（不会建库、不会升级），只开 readonly 事务，读完马上关；WhatsApp 要升级数据库时让开。
// 库不存在就不打开（不先查一下的话 open 会建一个空库）。号码只回到主进程，不写日志。
const LOOKUP_DB = 'model-storage';
const LOOKUP_CODE = (lid, title) => `(async () => {
  const LID = ${JSON.stringify(lid)};
  const TITLE = ${JSON.stringify(title)};
  const out = { pn: '', why: '', stores: [] };
  const PN = /^(\\d{7,15})(?::\\d+)?@(?:c\\.us|s\\.whatsapp\\.net)$/;
  const wid = (v) => {
    if (!v) return '';
    if (typeof v === 'string') { const m = PN.exec(v.trim()); return m ? m[1] : ''; }
    if (typeof v === 'object') {
      if (typeof v._serialized === 'string') return wid(v._serialized);
      if (typeof v.user === 'string' && typeof v.server === 'string') return wid(v.user + '@' + v.server);
    }
    return '';
  };
  // 一条记录里的手机号：先看常见字段名，再看其它字段（只认“号码@c.us / @s.whatsapp.net”这种写法）
  const pnOf = (rec, withId) => {
    if (!rec || typeof rec !== 'object') return '';
    for (const k of ['phoneNumber', 'pn', 'phone', 'pnJid', 'phoneNumberJid', 'phoneJid']) { const d = wid(rec[k]); if (d) return d; }
    for (const [k, v] of Object.entries(rec)) { if (k === 'id' && !withId) continue; const d = wid(v); if (d) return d; }
    return '';
  };
  const norm = (s) => String(s || '').normalize('NFKC').replace(/\\s+/g, ' ').trim().toLowerCase();
  const req = (r) => new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB.databases) { out.why = 'noidb'; return out; }
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d && d.name === ${JSON.stringify(LOOKUP_DB)})) { out.why = 'nodb'; return out; }
    const db = await new Promise((ok, bad) => {
      const r = indexedDB.open(${JSON.stringify(LOOKUP_DB)});
      r.onupgradeneeded = () => { try { r.transaction.abort(); } catch {} };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
      r.onblocked = () => bad(new Error('blocked'));
    });
    db.onversionchange = () => db.close();
    try {
      const names = Array.from(db.objectStoreNames);
      out.stores = names.slice(0, 60);
      const byLid = names.filter((n) => /lid|pn|contact/i.test(n) && !/message|msg/i.test(n));
      if (LID) {
        for (const n of byLid) {
          const st = db.transaction(n, 'readonly').objectStore(n);
          let rec = null;
          try { rec = await req(st.get(LID)); } catch {}
          let d = pnOf(rec, false);
          if (!d) {
            for (const ix of Array.from(st.indexNames).filter((x) => /lid/i.test(x))) {
              try { d = pnOf(await req(st.index(ix).get(LID)), true); } catch {}
              if (d) break;
            }
          }
          if (d) { out.pn = d; out.why = 'lid:' + n; return out; }
        }
      }
      const t = norm(TITLE);
      const contact = names.find((n) => n === 'contact') || names.find((n) => /^contacts?$/i.test(n));
      if (t && contact) {
        const found = new Set();
        let seen = 0;
        await new Promise((ok) => {
          const c = db.transaction(contact, 'readonly').objectStore(contact).openCursor();
          c.onerror = () => ok();
          c.onsuccess = () => {
            const cur = c.result;
            if (!cur || seen++ > 20000 || found.size > 1) return ok();
            const v = cur.value;
            if (v && typeof v === 'object' && [v.name, v.shortName, v.verifiedName, v.pushname].some((x) => x && norm(x) === t)) {
              const d = pnOf(v, true);
              if (d) found.add(d);
            }
            cur.continue();
          };
        });
        if (found.size === 1) { out.pn = [...found][0]; out.why = 'name'; return out; }
        out.why = found.size > 1 ? 'samename' : 'notfound';
        return out;
      }
      out.why = 'notfound';
      return out;
    } finally { db.close(); }
  } catch (e) {
    out.why = 'error:' + String((e && e.name) || e).slice(0, 40);
    return out;
  }
})()`;

// 返回 { digits, why, stores }；digits 是查到的号码（只有数字，含国家码），查不到是 ''
async function lookupPeerPhone(wc, { chat = '', title = '' } = {}) {
  if (wc.isDestroyed() || wc.isLoading()) return { digits: '', why: 'loading', stores: [] };
  const lid = /^\d{5,25}@lid$/.test(String(chat)) ? String(chat) : '';
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: LOOKUP_CODE(lid, String(title || '').slice(0, 100)) }]);
    const digits = r && typeof r.pn === 'string' && /^\d{7,15}$/.test(r.pn) ? r.pn : '';
    const stores = r && Array.isArray(r.stores) ? r.stores.filter((s) => typeof s === 'string').map((s) => s.slice(0, 40)) : [];
    return { digits, why: r && typeof r.why === 'string' ? r.why.slice(0, 60) : 'bad', stores };
  } catch {
    return { digits: '', why: 'error', stores: [] };
  }
}

// 自己的手机号：WhatsApp Web 登录后把本机账号的 id（如 "8613800000000:12@c.us"）存在 localStorage 里。
// 只读这两个键，不读别的、不写任何东西。读不到就返回空，用户可以在编辑账号里自己填。
const OWN_NUMBER_KEYS = ['last-wid-md', 'last-wid'];
const OWN_NUMBER_CODE = `(() => {
  try {
    for (const k of ${JSON.stringify(OWN_NUMBER_KEYS)}) {
      const v = window.localStorage.getItem(k);
      if (v) return String(v).slice(0, 100);
    }
  } catch {}
  return '';
})()`;

// "8613800000000:12@c.us"、"\\"8613800000000@c.us\\"" → "+8613800000000"；认不出返回 ''
function parseWid(raw) {
  const m = /^"?(\d{6,15})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)"?$/.exec(String(raw || '').trim());
  return m ? `+${m[1]}` : '';
}

async function readOwnNumber(wc) {
  if (wc.isDestroyed() || wc.isLoading()) return '';
  try {
    return parseWid(await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: OWN_NUMBER_CODE }]));
  } catch {
    return '';
  }
}

// 页面里当前的焦点是不是聊天输入框。只读 document.activeElement，不移动焦点、不改页面。
// 返回 'compose'（在输入框里）| 'other'（在搜索框等别处，或哪里都不在）| 'unknown'（页面在加载或读不到）
const FOCUS_CODE = `(() => {
  const el = document.activeElement;
  if (!el || !el.isContentEditable) return 'other';
  return ${JSON.stringify(SELECTORS.composeBox)}.some((s) => el.closest(s)) ? 'compose' : 'other';
})()`;

async function composeFocus(wc) {
  if (wc.isDestroyed() || wc.isLoading()) return 'unknown';
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: FOCUS_CODE }]);
    return ['compose', 'other'].includes(r) ? r : 'unknown';
  } catch {
    return 'unknown';
  }
}

// MCP 起草回复用：输入框的状态。只读，不移动焦点、不改页面。
// probe 是草稿开头的一小段（空白已合并），用来确认粘贴已经生效，再把剪贴板换回去。
// 返回 { focus: 'compose' | 'other', box, empty, has } | null（页面在加载或读不到）
const COMPOSE_CODE = (probe) => `(() => {
  const chat = (${chatIdentity.toString()})(document.querySelector(${JSON.stringify(SELECTORS.chatMain)}));
  const S = ${JSON.stringify(SELECTORS.composeBox)};
  const el = document.activeElement;
  const focus = el && el.isContentEditable && S.some((s) => el.closest(s)) ? 'compose' : 'other';
  let box = null;
  for (const s of S) { box = document.querySelector(s); if (box) break; }
  if (!box) return { chat, focus, box: false, empty: true, has: false };
  const norm = (x) => String(x || '').replace(/\\s+/g, ' ').trim();
  const t = norm(box.innerText || box.textContent);
  const probe = ${JSON.stringify(String(probe || ''))};
  return { chat, focus, box: true, empty: !t, has: !!probe && t.includes(probe) };
})()`;

async function composeState(wc, probe = '') {
  if (wc.isDestroyed() || wc.isLoading()) return null;
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: COMPOSE_CODE(probe) }]);
    if (!r || typeof r !== 'object') return null;
    return { chat: typeof r.chat === 'string' ? r.chat.slice(0, 100) : '', focus: r.focus === 'compose' ? 'compose' : 'other', box: r.box === true, empty: r.empty === true, has: r.has === true };
  } catch {
    return null;
  }
}

// 选中文字一键翻译：读当前选中的文字和它在页面上的位置。只读 getSelection()，不改选区、不改页面、不留监听。
// 只认右侧聊天区（#main）里消息上的选区，输入框和左边对话列表里的不算。
// 文字只取消息正文（selectable-text）里被选中的部分：拖选整条消息时不带上时间、已读勾这些；认不出正文就用整个选区的文字。
// 返回 { text, x, y, w, h, top, vw, vh }（位置是页面 CSS 像素：最后一行的矩形 + 第一行的顶边）| null
const SELECTION_CODE = `(() => {
  const S = ${JSON.stringify({ main: SELECTORS.chatMain, body: 'span.selectable-text, [data-testid*="selectable-text"]' })};
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const main = document.querySelector(S.main);
  const r = sel.getRangeAt(0);
  const inMain = (n) => { const el = n && (n.nodeType === 1 ? n : n.parentElement); return !!el && !!main && main.contains(el) && !el.closest('footer') && !el.isContentEditable; };
  if (!inMain(r.startContainer) || !inMain(r.endContainer)) return null;
  let rootNode = r.commonAncestorContainer;
  if (rootNode.nodeType !== 1) rootNode = rootNode.parentElement;
  const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
  const parts = [];
  let lastBody = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!r.intersectsNode(n)) continue;
    const body = n.parentElement && n.parentElement.closest(S.body);
    if (!body) continue;
    let t = n.data;
    const from = n === r.startContainer ? r.startOffset : 0;
    const to = n === r.endContainer ? r.endOffset : t.length;
    t = t.slice(from, to);
    if (lastBody && body !== lastBody) parts.push('\\n');
    parts.push(t);
    lastBody = body;
  }
  const text = (parts.join('').trim() || String(sel.toString() || '').trim());
  if (!text) return null;
  const rects = [...r.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
  if (!rects.length) return null;
  const last = rects[rects.length - 1];
  return { text: text.slice(0, 4000), x: last.left, y: last.top, w: last.width, h: last.height, top: rects[0].top, vw: innerWidth, vh: innerHeight };
})()`;

async function readSelection(wc) {
  if (wc.isDestroyed() || wc.isLoading()) return null;
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: SELECTION_CODE }]);
    if (!r || typeof r !== 'object' || typeof r.text !== 'string' || !r.text.trim()) return null;
    const n = (v) => (Number.isFinite(v) ? v : 0);
    return { text: r.text.slice(0, 4000), x: n(r.x), y: n(r.y), w: n(r.w), h: n(r.h), top: n(r.top), vw: n(r.vw), vh: n(r.vh) };
  } catch {
    return null;
  }
}

module.exports = { SELECTORS, loginState, readChatList, readOpenChat, readChatPeer, lookupPeerPhone, readOwnNumber, composeFocus, composeState, readSelection, parseWid, READ_CHAT_CODE, READ_PEER_CODE, SELECTION_CODE, parsePre };

