// 聊天里的链接只允许这几种，用系统浏览器或系统程序打开；其他（file:、javascript: 等）一律不开。
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

function isSafeLink(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  try {
    return ALLOWED_SCHEMES.has(new URL(raw).protocol);
  } catch {
    return false;
  }
}

module.exports = { isSafeLink, ALLOWED_SCHEMES };
