// 发出翻译的目标语言跟着当前对话走：对话标题（WhatsApp 显示的名字或号码）对上客户名单里的某个客户，
// 并且这个客户填了“语言”，就用客户的语言。只比对名字和号码数字，不读别的。对不上返回 null。
const digits = (s) => String(s || '').replace(/\D/g, '');
const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

function matchChatCustomer(customers, accountId, title) {
  const t = norm(title);
  if (!t || !Array.isArray(customers)) return null;
  const td = digits(title);
  // 标题本身像号码（只有数字和 + - 空格括号）才按号码比
  const titleIsNumber = td.length >= 6 && /^[\d\s+\-()]+$/.test(String(title).trim());
  const mine = customers.filter((c) => c && c.lang && (!c.accountId || c.accountId === accountId));
  // 同一个号下的客户优先，其次是没绑号的
  mine.sort((a, b) => (b.accountId === accountId) - (a.accountId === accountId));
  for (const c of mine) {
    if (c.name && norm(c.name) === t) return { lang: c.lang, name: c.name };
  }
  if (titleIsNumber) {
    for (const c of mine) {
      const cd = digits(c.phone);
      // 号码可能带或不带国家码：比较后 8 位以上的结尾
      if (cd.length >= 6 && (cd === td || (Math.min(cd.length, td.length) >= 8 && (cd.endsWith(td) || td.endsWith(cd))))) {
        return { lang: c.lang, name: c.name || c.phone };
      }
    }
  }
  return null;
}

module.exports = { matchChatCustomer };
