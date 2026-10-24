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

// 返回 null（不收）、{ skip: 'nonumber' } 或 { item }
function webItem(msg, since, now) {
  if (!msg || typeof msg.id !== 'string') return null;
  const m = /^(true|false)_([^_]+)_/.exec(msg.id);
  if (!m) return null;
  const jid = m[2];
  const pn = /^(\d{6,20})@c\.us$/.exec(jid);
  if (!pn && !jid.endsWith('@lid')) return null; // 群、频道、状态等
  const { at, approx } = timeOf(msg.t, now);
  if (at < since) return null;
  if (!pn) return { skip: 'nonumber' }; // @lid：拿不到真实号码
  const text = typeof msg.text === 'string' && msg.text ? msg.text : '[非文字消息]';
  return { item: { mid: msg.id.slice(0, 300), peer: pn[1], out: m[1] === 'true', at, approx, text } };
}

module.exports = { webItem, timeOf };
