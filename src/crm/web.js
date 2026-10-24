// 网页版号的 CRM 采集：把 readOpenChat 读到的一条消息变成队列里的一条。
// 消息编号形如 "false_8613800000000@c.us_3EB0..."：前缀是方向，中间是对方。
// 只收单聊里有真实号码的（@c.us）；@lid 认不出号码，跳过并计数；群（@g.us）等不收。

// 页面时间（本机时区）→ 毫秒。日 / 月拿不准时，取不晚于现在、离现在最近的那个，并标成“时间是大概”
function timeOf(t, now) {
  if (!t) return { at: now, approx: true };
  const make = (mo, d) => new Date(t.y, mo - 1, d, t.h, t.mi).getTime();
  const soon = now + 5 * 60 * 1000; // 电脑时钟差几分钟也算
  const a = make(t.mo, t.d);
  if (!t.ambig) return Number.isFinite(a) ? { at: a, approx: false } : { at: now, approx: true };
  const options = [a, make(t.d, t.mo)].filter((x) => Number.isFinite(x) && x <= soon);
  if (!options.length) return { at: now, approx: true };
  return { at: Math.max(...options), approx: true };
}

// 返回 null（不收）、{ skip: 'nonumber' | 'notime' } 或 { item }
// allowUntimed：读不出时间的消息能不能收（只有在已经读过的对话里新出现的才能收，见 WebReader）
function webItem(msg, since, now, allowUntimed = false) {
  if (!msg || typeof msg.id !== 'string') return null;
  const m = /^(true|false)_([^_]+)_/.exec(msg.id);
  if (!m) return null;
  const jid = m[2];
  const pn = /^(\d{6,20})@c\.us$/.exec(jid);
  if (!pn && !jid.endsWith('@lid')) return null; // 群、频道、状态等
  if (!msg.t && !allowUntimed) return { skip: 'notime' };
  const { at, approx } = timeOf(msg.t, now);
  if (at < since) return null;
  if (!pn) return { skip: 'nonumber' }; // @lid：拿不到真实号码
  const text = typeof msg.text === 'string' && msg.text ? msg.text : '[非文字消息]';
  return { item: { mid: msg.id.slice(0, 300), peer: pn[1], out: m[1] === 'true', at, approx, text } };
}

// 记住这次运行里每个对话读到过哪些消息（只在内存里）。
// 读不出时间的消息（没有文字的图片、认不出的日期格式）：对话第一次被读到时屏幕上已有的算旧消息，不收；
// 之后新出现的才收（时间按读到的时刻，标成“大概”）。这样打开一个旧对话不会把旧消息当成新的灌进去。
const MAX_IDS = 400;
class WebReader {
  constructor() { this.chats = new Map(); } // "账号|对话" -> Set(消息编号)

  // 返回 { items, nonumber, notime }；nonumber / notime 只算第一次见到的
  collect(accId, msgs, since, now) {
    const out = { items: [], nonumber: 0, notime: 0 };
    const known = new Set(this.chats.keys()); // 这次读之前已经读过的对话
    for (const m of msgs) {
      const jid = /^(?:true|false)_([^_]+)_/.exec(String(m && m.id));
      if (!jid) continue;
      const key = `${accId}|${jid[1]}`;
      const first = !known.has(key);
      let seen = this.chats.get(key);
      if (!seen) { seen = new Set(); this.chats.set(key, seen); }
      const isNew = !seen.has(m.id);
      seen.add(m.id);
      if (seen.size > MAX_IDS) this.chats.set(key, new Set([...seen].slice(-MAX_IDS / 2)));
      const x = webItem(m, since, now, !first && isNew);
      if (!x) continue;
      if (x.item) out.items.push(x.item);
      else if (isNew) out[x.skip] += 1;
    }
    return out;
  }

  forget(accId) {
    for (const k of this.chats.keys()) if (k.startsWith(`${accId}|`)) this.chats.delete(k);
  }
}

module.exports = { webItem, timeOf, WebReader };
