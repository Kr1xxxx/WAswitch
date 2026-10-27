// 新消息通知的正文：能读到有未读的对话名字时写“Emma Schneider、John Miller 等 3 个未读对话”，
// 读不到（页面在加载、结构认不出、聊天已锁定）就退回原来的“有 N 个未读对话”。
// 只用对话名字，不用消息内容。

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

module.exports = { unreadNames, unreadBody, MAX_NAMES, MAX_LEN };
