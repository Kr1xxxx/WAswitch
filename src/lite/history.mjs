// 轻量模式：给 MCP 的 read_messages 用，从本机聊天缓存里找对话、读最近的消息。
// 只读：不标已读、不发回执、不改缓存。不引用 Baileys，方便单独测试。

export const MAX_LIMIT = 50;
const MAX_TOTAL = 40000; // 一次最多返回这么多字，超了丢掉更早的

const isGroup = (jid) => String(jid).endsWith('@g.us');
// 名称和号码的比较和 draft-place.js 的 chatMatches 一样（起草回复和读消息认对话的方式一致）
const normName = (v) => String(v || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const digits = (v) => String(v || '').replace(/\D/g, '');
const looksLikePhone = (v) => /^[+\d\s().-]+$/.test(String(v || '').trim()) && digits(v).length >= 6;
const jidNumber = (jid) => (/@(?:s\.whatsapp\.net|c\.us)$/.test(String(jid || '')) ? digits(String(jid).split('@')[0].split(':')[0]) : '');
const numberOf = (jid) => { const n = jidNumber(jid); return n ? `+${n}` : ''; };

function matches(query, title, jid) {
  if (looksLikePhone(query)) {
    // 去掉开头的 0，允许少写或多写国家码：号码末尾相同、重合至少 8 位
    const want = digits(query).replace(/^0+/, '');
    const same = (raw) => {
      const n = String(raw || '').replace(/^0+/, '');
      return n.length >= 6 && (n === want || (Math.min(n.length, want.length) >= 8 && (n.endsWith(want) || want.endsWith(n))));
    };
    return same(jidNumber(jid)) || (looksLikePhone(title) && same(digits(title)));
  }
  const want = normName(query);
  return !!want && want === normName(title);
}

// 按对话名称或手机号找已有的对话（不新建、不模糊匹配）。
// store：ChatStore（chats、nameOf、msgs）。返回 { ok, jid, title } 或 { ok: false, reason: 'notfound' | 'ambiguous', count? }
export function findChat(store, query) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, reason: 'notfound' };
  const titleOf = (jid) => store.nameOf(jid) || numberOf(jid) || (isGroup(jid) ? '群聊' : String(jid).split('@')[0]);
  const hits = [...store.chats.values()]
    .filter((c) => c && c.jid && (c.ts || c.preview || (store.msgs && store.msgs.get(c.jid)?.length)))
    .filter((c) => matches(q, titleOf(c.jid), c.jid));
  if (hits.length === 1) return { ok: true, jid: hits[0].jid, title: titleOf(hits[0].jid) };
  if (hits.length > 1) return { ok: false, reason: 'ambiguous', count: hits.length };
  return { ok: false, reason: 'notfound' };
}

// 本机时间，形如 2026-10-27 14:05
const stamp = (sec) => {
  if (!sec) return null;
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 读某个对话最近 limit 条（最多 50 条），从旧到新。返回 { ok, jid, title, group, messages } 或 { ok: false, reason: 'notfound' }
export function readHistory(store, jid, limit) {
  if (!store.chats.has(jid)) return { ok: false, reason: 'notfound' };
  const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_LIMIT) : 20;
  const group = isGroup(jid);
  const out = [];
  let size = 0;
  const list = store.messages(jid, n);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    const text = String(m.text || '').slice(0, 4000);
    if (size + text.length > MAX_TOTAL) break;
    size += text.length;
    const item = { from_me: !!m.me, time: stamp(m.ts), text };
    if (group && !m.me && m.from) item.sender = String(m.from).slice(0, 80);
    out.push(item);
  }
  out.reverse();
  return { ok: true, jid, title: store.nameOf(jid) || numberOf(jid) || (group ? '群聊' : ''), group, messages: out };
}
