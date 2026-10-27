// 顶栏“客户当地时间”：从当前对话认出客户号码，按国家码和区号查时区（数据见 phone-zones.js）。
// 号码只在主进程用，送给界面的只有时区和城市名，不带号码。
// 认不出（没号码、群聊、隐私编号 @lid 又查不到号码）返回 null，顶栏显示伦敦、纽约、加州时间。
const ZONES = require('./phone-zones');

let table = null; // 前缀 -> { tz, approx }
function prefixes() {
  if (table) return table;
  table = new Map();
  for (const [tz, list] of Object.entries(ZONES)) {
    for (const raw of list.split(' ')) {
      const approx = raw.startsWith('~');
      table.set(approx ? raw.slice(1) : raw, { tz, approx });
    }
  }
  return table;
}

// 号码（只有数字，含国家码）→ { tz, place, approx }；国家码认不出返回 null
function zoneOfNumber(digits) {
  const d = String(digits || '');
  if (!/^\d{7,15}$/.test(d)) return null;
  const t = prefixes();
  for (let n = Math.min(d.length, 10); n > 0; n--) {
    const hit = t.get(d.slice(0, n));
    if (hit) return { tz: hit.tz, place: placeOf(hit.tz), approx: hit.approx };
  }
  return null;
}
// "America/New_York" → "New York"，"America/Indiana/Indianapolis" → "Indianapolis"
const placeOf = (tz) => String(tz).split('/').pop().replace(/_/g, ' ');

// 对话编号：网页版消息 data-id 中间那段（4915112345678@c.us），轻量号的 jid（4915112345678:3@s.whatsapp.net）。
// 群聊 @g.us；@lid 是隐私编号，不是号码
function fromChatId(chat) {
  const s = String(chat || '').trim();
  if (/@g\.us$|@broadcast$|@newsletter$/.test(s)) return { group: true, digits: '' };
  const m = /^(\d{7,15})(?::\d+)?@(?:c\.us|s\.whatsapp\.net)$/.exec(s);
  return { group: false, digits: m ? m[1] : '' };
}
// 号码写法：必须带国家码（+ 开头或 00 开头），“0151 …”这种本地写法认不出国家，不用
function fromText(text) {
  const s = String(text || '').normalize('NFKC').replace(/[‎‏‪-‮⁦-⁩]/g, '').trim();
  if (!/^(\+|00)[\d\s\-().]+$/.test(s)) return '';
  const d = s.replace(/\D/g, '').replace(/^00/, '');
  return /^\d{7,15}$/.test(d) ? d : '';
}

// 当前对话的客户在哪个时区。依次看：对话编号里的号码 → 标题本身是号码（没存名字的联系人）
// → 查到的号码（隐私编号 @lid 时从 WhatsApp 本地数据 / 轻量号的映射里查，只有数字）→ 客户名单里同名客户填的电话
// input: { chat, title, lookedUp, customerPhone }
function peerZone(input = {}) {
  const id = fromChatId(input.chat);
  if (id.group) return null;
  const looked = /^\d{7,15}$/.test(String(input.lookedUp || '')) ? String(input.lookedUp) : '';
  const digits = id.digits || fromText(input.title) || looked || fromText(input.customerPhone);
  return digits ? zoneOfNumber(digits) : null;
}

// 客户名单里和对话标题同名的客户的电话（同一个号下的优先）
const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
function customerPhone(customers, accountId, title) {
  const t = norm(title);
  if (!t || !Array.isArray(customers)) return '';
  const list = customers.filter((c) => c && c.phone && norm(c.name) === t && (!c.accountId || c.accountId === accountId));
  list.sort((a, b) => (b.accountId === accountId) - (a.accountId === accountId));
  return list.length ? String(list[0].phone) : '';
}

module.exports = { zoneOfNumber, peerZone, fromChatId, fromText, customerPhone, placeOf };
