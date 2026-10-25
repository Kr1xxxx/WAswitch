// 读取 WhatsApp 页面状态用到的全部选择器都放在这里。WhatsApp 改版时只改这一个文件。
// MCP 第二层读取对话列表时也复用这里。
//
// 规则（经 shen 同意）：只在隔离环境（isolated world）里只读检查，不在页面自己的环境里运行脚本，
// 不修改页面。掉线检测不读聊天内容；MCP 第二层只在用户确认后读对话列表（预览默认不读）。

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
  chatTitle: '#main header span[title]',
  // 每条消息的外层带 data-id（true_ 开头是自己发的，false_ 开头是收到的）
  message: '[data-id]',
  // 消息正文：带 data-pre-plain-text 的 copyable-text 里的 selectable-text。
  // data-pre-plain-text 本身含时间和群发送人，不读它
  messageBody: '.copyable-text[data-pre-plain-text]',
  messageText: 'span.selectable-text',
  // 引用的消息、链接预览是可点的块，跳过里面的文字
  messageSkip: '[role="button"], .quoted-mention',
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
const MAX_MSGS = 20;
const READ_CHAT_CODE = `(() => {
  const parsePre = ${parsePre.toString()};
  const S = ${JSON.stringify({ main: SELECTORS.chatMain, title: SELECTORS.chatTitle, msg: SELECTORS.message, body: SELECTORS.messageBody, text: SELECTORS.messageText, skip: SELECTORS.messageSkip })};
  const main = document.querySelector(S.main);
  if (!main) return { ok: false, why: 'nochat' };
  const t = main.querySelector(S.title);
  const title = t ? String(t.getAttribute('title') || '').slice(0, 100) : '';
  const all = main.querySelectorAll(S.msg);
  const top = [];
  for (const n of all) {
    const id = n.getAttribute('data-id') || '';
    if (!/^(true|false)_/.test(id)) continue;
    if (n.parentElement && n.parentElement.closest(S.msg)) continue; // 嵌在别的消息里（引用）
    top.push(n);
  }
  const msgs = [];
  let size = 0;
  // 从最新的往前取，字数超了就丢掉更早的（要翻的是新消息）
  for (const n of top.slice(-${MAX_MSGS}).reverse()) {
    const id = n.getAttribute('data-id').slice(0, 300);
    let text = '';
    const body = n.querySelector(S.body);
    const t = body ? parsePre(body.getAttribute('data-pre-plain-text')) : null;
    if (body) {
      for (const sp of body.querySelectorAll(S.text)) {
        if (sp.closest(S.skip)) continue;
        text = String(sp.textContent || '');
        break;
      }
    }
    text = text.slice(0, 4000);
    if (size + text.length > 20000) break;
    size += text.length;
    msgs.push({ id, out: id.startsWith('true_'), text, t });
  }
  msgs.reverse();
  return { ok: true, title, msgs };
})()`;

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

async function readOpenChat(wc) {
  if (wc.isDestroyed() || wc.isLoading()) return { ok: false, why: 'loading' };
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: READ_CHAT_CODE }]);
    if (!r || typeof r !== 'object' || !r.ok || !Array.isArray(r.msgs)) return { ok: false, why: (r && r.why) || 'bad' };
    const msgs = r.msgs.filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string').slice(-MAX_MSGS)
      .map((m) => ({ id: m.id.slice(0, 300), out: m.out === true, text: m.text.slice(0, 4000), t: cleanTime(m.t) }));
    return { ok: true, title: typeof r.title === 'string' ? r.title.slice(0, 100) : '', msgs };
  } catch {
    return { ok: false, why: 'error' };
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

module.exports = { SELECTORS, loginState, readChatList, readOpenChat, readOwnNumber, parseWid, READ_CHAT_CODE, parsePre };

