// 新消息弹窗的文字。
// - 能读到对话列表时：每个未读变多的客户一张卡，写客户名字和对话列表里的最后一条预览（grownChats）
// - 读不到（页面在加载、结构认不出、聊天已锁定）时：一张号的卡，写“Emma Schneider、John Miller 等 3 个未读对话”
//   或“有 N 个未读对话”（unreadBody）

const crypto = require('crypto');

const MAX_NAMES = 2; // 正文里最多写几个名字
const MAX_LEN = 30; // 每个名字最多多少字

// chats：对话列表里的项 { name, unread, muted }，顺序是列表顺序（最近的在前）。
// 返回要写进通知的名字：有未读的、没静音的排前面，去重、截短。
function unreadNames(chats) {
  if (!Array.isArray(chats)) return [];
  const withUnread = chats.filter((c) => c && c.unread > 0 && typeof c.name === 'string');
  const ordered = [...withUnread.filter((c) => !c.muted), ...withUnread.filter((c) => c.muted)];
  const out = [];
  for (const c of ordered) {
    let name = c.name.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    if ([...name].length > MAX_LEN) name = `${[...name].slice(0, MAX_LEN).join('')}…`;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// count：页面标题里的未读对话数；names：unreadNames() 的结果，可以是空的
function unreadBody(count, names) {
  const fallback = `有 ${count} 个未读对话`;
  const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n) : [];
  if (!list.length || !(count > 0)) return fallback;
  const shown = list.slice(0, Math.min(MAX_NAMES, count));
  const joined = shown.join('、');
  return count > shown.length ? `${joined} 等 ${count} 个未读对话` : `${joined} 发来新消息`;
}

const MAX_PREVIEW = 160; // 预览最多多少字（弹窗里最多显示 3 行）

const chatKey = (c) => (c && typeof c.jid === 'string' && c.jid) || (c && typeof c.name === 'string' ? c.name.replace(/\s+/g, ' ').trim() : '');

function cleanPreview(text) {
  if (typeof text !== 'string') return '';
  const t = text.replace(/\s+/g, ' ').trim();
  return [...t].length > MAX_PREVIEW ? `${[...t].slice(0, MAX_PREVIEW).join('')}…` : t;
}

// 一条消息的“指纹”：最后一条预览 + 时间（轻量号有，网页号没有）。只存短哈希，不把消息内容写到磁盘上
function popSig(c) {
  const ts = c && Number.isFinite(c.ts) && c.ts > 0 ? String(c.ts) : '';
  return crypto.createHash('sha1').update(`${cleanPreview(c && c.preview)}|${ts}`).digest('hex').slice(0, 12);
}

// 这个客户现在列表里显示的那条，是不是已经弹过（或用户已经看过）：同一个客户、同一条预览、未读条数没变多
function wasPopped(popped, key, c, n) {
  const rec = popped && popped.get(key);
  return !!(rec && n <= rec.unread && rec.sig === popSig(c));
}

// 对话列表里哪些客户的未读变多了（要弹卡片）。
// seen：上次记下的 key -> 未读数；null 表示这个号还没记过（刚启动、刚读过消息）
// chats：对话列表 { name, unread, preview?, muted?, jid?, ts? }，最近的在前
// firstLimit：没记过时最多挑几个（只挑列表最上面的，免得把以前的未读全弹一遍）
// popped：已经弹过的 key -> { sig, unread }（见 wasPopped），弹过的同一条不再弹
// 返回 { fresh: [{ key, name, unread, preview, jid, sig }], seen: 新的 Map, dup: 因为弹过而跳过了几个 }
function grownChats(seen, chats, firstLimit = 1, limit = 3, popped = null) {
  const next = new Map(seen || []);
  const list = Array.isArray(chats) ? chats.filter((c) => c && chatKey(c)) : [];
  const grown = [];
  let dup = 0;
  for (const c of list) {
    const key = chatKey(c);
    const n = Number.isInteger(c.unread) && c.unread > 0 ? c.unread : 0;
    if (n > 0 && n > (seen ? (seen.get(key) || 0) : 0)) {
      if (wasPopped(popped, key, c, n)) dup += 1; else grown.push({ key, c, n });
    }
    if (n > 0) next.set(key, n); else next.delete(key);
  }
  // 静音的对话（WhatsApp 里设了静音）不单独弹，除非只有它们
  const loud = grown.filter((g) => !g.c.muted);
  const pick = (loud.length ? loud : grown).slice(0, seen ? limit : Math.max(1, Math.min(firstLimit, limit)));
  const fresh = pick.map(({ key, c, n }) => {
    let name = (c.name || key).replace(/\s+/g, ' ').trim();
    if ([...name].length > MAX_LEN) name = `${[...name].slice(0, MAX_LEN).join('')}…`;
    return { key, name, unread: n, preview: cleanPreview(c.preview), jid: typeof c.jid === 'string' ? c.jid : '', sig: popSig(c) };
  });
  return { fresh, seen: next, dup };
}

module.exports = { unreadNames, unreadBody, grownChats, cleanPreview, chatKey, popSig, wasPopped, MAX_NAMES, MAX_LEN, MAX_PREVIEW };
