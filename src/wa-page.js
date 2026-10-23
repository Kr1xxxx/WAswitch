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

module.exports = { SELECTORS, loginState, readChatList };
