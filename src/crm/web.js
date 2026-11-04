// 网页版号的 CRM 采集：把 readOpenChat 读到的一条消息变成队列里的一条。
// 消息编号形如 "false_8613800000000@c.us_3EB0..."：前缀是方向，中间是对方。
// 新版 WhatsApp 网页的编号没有前缀，readOpenChat 按气泡补成 "false_chat:<对话标题>_<原编号>"，中间不再有对方。
// 对方是隐私编号（@lid）或编号里没有对方时，用主进程查到的这个对话的号码（peer）；查不到就跳过并计数。
// 群（@g.us）、频道、状态等不收。

// 绝对时间已经在账号页面的时区里算好，不能在主进程再用系统时区重建。
// 日 / 月拿不准时，取不晚于现在、离现在最近的候选；没有可靠时间就不采集。
function timeOf(t, now) {
  if (!t) return null;
  const soon = now + 5 * 60 * 1000; // 电脑时钟差几分钟也算
  const options = (t.ambig ? [t.at, t.altAt] : [t.at]).filter((x) => Number.isSafeInteger(x) && x <= soon);
  if (!options.length) return null;
  return { at: Math.max(...options), approx: t.ambig === true };
}

// 消息编号拆成 { out, jid }：jid 是中间那段（"号码@c.us"、"…@lid"、"chat:标题"）。
// 没有 true_/false_ 前缀时看 readOpenChat 按气泡认出的方向（out），jid 为空。认不出返回 null
function partsOf(msg) {
  if (!msg || typeof msg.id !== 'string' || !msg.id) return null;
  const m = /^(true|false)_([^_]+)_./.exec(msg.id);
  if (m) return { out: m[1] === 'true', jid: m[2] };
  if (/^(true|false)_/.test(msg.id) || typeof msg.out !== 'boolean') return null;
  return { out: msg.out, jid: '' };
}

const PHONE_JID = /^(\d{6,20})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/;
// 对话编号里的号码（"号码@c.us"），没有是 ''
const phoneOfChat = (chat) => { const m = PHONE_JID.exec(String(chat || '')); return m ? m[1] : ''; };

// 编号里没有号码时，这条消息是谁的：只用主进程给的、和这个对话对得上的号码。
// peer：{ chat, title, digits, group }（readOpenChat 读到的对话编号和标题 + 查到的号码）。
// 返回号码、'' (单聊但查不到号码) 或 null（群、或者对不上这个对话）
function peerOf(jid, name, peer) {
  if (jid.endsWith('@lid')) {
    if (!peer || peer.chat !== jid) return '';
    return /^\d{7,15}$/.test(String(peer.digits || '')) ? peer.digits : '';
  }
  if (jid && !jid.startsWith('chat:')) return null; // 群、频道、状态等
  // 新版编号：对话只认标题，标题要和读到的对话一致；对话编号认不出（新版页面没有）才用查到的号码
  if (peer && peer.group === true) return null;
  if (!peer || peer.chat) return '';
  const title = String(peer.title || '');
  if (!title || title !== name || (jid && jid !== `chat:${title.replace(/_/g, ' ')}`)) return '';
  return /^\d{7,15}$/.test(String(peer.digits || '')) ? peer.digits : '';
}

// 返回 null（不收）、{ skip: 'nonumber' | 'notime' } 或 { item }。
// name：打开的对话的标题（对方在 WhatsApp 里的名字，queue.js 会去掉像号码的）
// peer：见 peerOf；不给就只收编号里带号码的
function webItem(msg, since, now, name = '', peer = null) {
  const p = partsOf(msg);
  if (!p) return null;
  const pn = PHONE_JID.exec(p.jid);
  const digits = pn ? pn[1] : peerOf(p.jid, name, peer);
  if (digits === null) return null;
  const time = timeOf(msg.t, now);
  if (!time) return { skip: 'notime' };
  const { at, approx } = time;
  if (at < since) return null;
  if (!digits) return { skip: 'nonumber' }; // @lid 或新版编号：拿不到真实号码
  const text = typeof msg.text === 'string' && msg.text ? msg.text : '[非文字消息]';
  const item = { mid: msg.id.slice(0, 300), peer: digits, out: p.out, at, approx, text };
  if (typeof name === 'string' && name) item.name = name.slice(0, 100);
  return { item };
}

// 记住这次运行里每个对话读到过哪些消息（只在内存里）。
// 读不出时间的消息一律跳过：第一次显示也可能是滚动加载的历史，不能当作新收到。
// 已见编号只用来避免重复累计跳过计数，不参与判断消息是否新收到。
const MAX_IDS = 400;
class WebReader {
  constructor() { this.chats = new Map(); } // "账号|对话" -> Set(消息编号)

  // 返回 { items, nonumber, notime }；nonumber / notime 只算第一次见到的
  // peer：这个对话查到的号码，见 peerOf
  collect(accId, msgs, since, now, name = '', peer = null) {
    const out = { items: [], nonumber: 0, notime: 0 };
    for (const m of msgs) {
      const p = partsOf(m);
      if (!p) continue;
      const key = `${accId}|${p.jid || `chat:${String(name).replace(/_/g, ' ')}`}`;
      let seen = this.chats.get(key);
      if (!seen) { seen = new Set(); this.chats.set(key, seen); }
      const isNew = !seen.has(m.id);
      seen.add(m.id);
      if (seen.size > MAX_IDS) this.chats.set(key, new Set([...seen].slice(-MAX_IDS / 2)));
      const x = webItem(m, since, now, name, peer);
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

module.exports = { webItem, timeOf, phoneOfChat, WebReader };

