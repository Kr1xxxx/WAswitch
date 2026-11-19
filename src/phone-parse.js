// 侧栏「开聊」认号码：用户粘贴来的各种写法整理成国际号码，认出国家，没写国家码的按所选账号自己的号码补上。
// 数据在 phone-meta.js（由 scripts/gen-phone-meta.js 从 libphonenumber 生成）。只在主进程用。
//
// 补国家码的规则（用户不用选）：
//   1. + 或 00 开头：按写的来，不猜。
//   2. 单个 0 开头：本国写法，去掉 0（意大利这类 0 是号码一部分的不去），补所选账号的国家码。
//   3. 不带 + 也不带 0：
//      所选账号是 +1 且正好 10 位：补 1；
//      整段是所选账号本国的手机号（欧美常见国家，见 phone-meta.js 的 MOB）：补本国区号；
//      开头能对上某个国家码、后面的位数也对：当成漏了 + 的完整号码；
//      否则补所选账号的国家码。
//   4. 所选账号自己没有号码（没登录过）：不补，要用户带上国家码。
// 位数对不上只提醒，不拦（数据万一不对，不挡真号码）。
// MCP 的 open_chat 不走这里（src/mcp/open-chat.js：不补国家码，单个 0 开头不认）。
const META = require('./phone-meta');

const NP0 = new Set(META.NP0);
const reCache = new Map();
const re = (src, whole) => {
  const key = `${whole ? '=' : '^'}${src}`;
  if (!reCache.has(key)) reCache.set(key, new RegExp(whole ? `^(?:${src})$` : `^(?:${src})`));
  return reCache.get(key);
};

// 国际号码（只有数字）拆成国家码 + 本国号码，认出是哪个国家。国家码认不出返回 null
function splitCc(digits) {
  for (let n = 1; n <= 3; n++) {
    const cc = digits.slice(0, n);
    const list = META.CC[cc];
    if (!list) continue;
    const national = digits.slice(n);
    const sub = list.slice(1).find(([, lead]) => re(lead).test(national));
    return { cc, region: sub ? sub[0] : list[0], national };
  }
  return null;
}

const lens = (s) => String(s || '').split(',').filter(Boolean).map(Number);
function lengthInfo(region, national) {
  const row = META.LEN[region];
  if (!row) return { lenOk: true, expect: [] };
  const all = lens(row[0]);
  const mob = lens(row[1]);
  return { lenOk: all.includes(national.length), expect: mob.length ? mob : all };
}
const fits = (p) => !!p && META.LEN[p.region] && lengthInfo(p.region, p.national).lenOk;

// 按当地习惯分组（只有 FMT 里的国家），别的国家只在国家码后面空一格
function format(cc, region, national) {
  for (const [pat, lead, out] of META.FMT[region] || []) {
    if (lead && !re(lead).test(national)) continue;
    if (!re(pat, true).test(national)) continue;
    return `+${cc} ${national.replace(new RegExp(pat), out)}`;
  }
  return `+${cc} ${national}`;
}

let names = null;
function countryName(region) {
  if (!region) return '';
  try {
    if (!names) names = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
    return names.of(region) || region;
  } catch {
    return region;
  }
}

// 写法整理：去掉链接、不换行空格、国家码后面的 (0)。认不出的字符返回 null
function clean(raw) {
  let s = String(raw || '').replace(/[  -‏ ⁠﻿]/g, ' ').trim();
  const link = s.match(/^(?:https?:\/\/)?(?:wa\.me\/|(?:api|web)\.whatsapp\.com\/send\/?\?(?:.*&)?phone=)\+?(\d+)/i);
  if (link) s = `+${link[1]}`;
  if (!/^[+\d\s()./-]+$/.test(s)) return null;
  return s.replace(/(?!^)\(\s*0\s*\)/g, ''); // 「+49 (0)151」「0049 (0)151」「(+49) (0)151」里的 (0) 不拨；单独 (0) 开头是本国写法
}

// 账号自己的号码（acc.phone，例如「+49 151 2345678」）的国家码；没有或认不出返回 ''
function ccOf(phone) {
  const s = clean(phone);
  if (!s) return '';
  const d = s.replace(/\D/g, '');
  // 手填的号码可能没写 +（「4915123456789」）：7 到 15 位、不是 0 开头的纯数字也当国际号码
  const intl = s.startsWith('+') ? d.replace(/^0+/, '') : d.startsWith('00') ? d.slice(2) : d.startsWith('0') ? '' : d;
  const p = intl.length >= 7 && intl.length <= 15 ? splitCc(intl) : null;
  return p ? p.cc : '';
}

// raw：用户填的号码；defaultCc：所选账号自己的国家码（ccOf(acc.phone)），没有传 ''。
// 返回 { digits: '' 表示认不出, err: 'bad' | 'need_cc' | '', cc, region, country, national, formatted,
//        added: 国家码是不是按账号补的, lenOk, expect: 这个国家一般几位（手机） }
function parsePhone(raw, defaultCc = '') {
  const fail = (err) => ({ digits: '', err, cc: '', region: '', country: '', national: '', formatted: '', added: false, lenOk: true, expect: [] });
  const s = clean(raw);
  if (s === null) return fail('bad');
  const d = s.replace(/\D/g, '');
  if (!d) return fail('bad');
  const own = /^\d{1,3}$/.test(String(defaultCc || '')) && META.CC[defaultCc] ? String(defaultCc) : '';
  let digits = '';
  let added = false;
  if (s.startsWith('+')) digits = d.replace(/^0+/, '');
  else if (d.startsWith('00')) digits = d.slice(2);
  else if (d.startsWith('0')) {
    if (!own) return fail('need_cc');
    digits = own + (NP0.has(META.CC[own][0]) ? d.replace(/^0/, '') : d);
    added = true;
  } else if (own === '1' && d.length === 10) {
    digits = `1${d}`;
    added = true;
  } else if (own && own !== '1' && META.MOB[META.CC[own][0]] && re(META.MOB[META.CC[own][0]], true).test(d)) {
    digits = own + d; // 本国手机号没写 0（德国「151 23456789」）：补本国区号，不当成漏了 + 的美国号
    added = true;
  } else if (d.length >= 7 && fits(splitCc(d))) {
    digits = d;
  } else if (own) {
    digits = own + d;
    added = true;
  } else return fail('need_cc');
  if (digits.length < 7 || digits.length > 15) return fail('bad');
  const p = splitCc(digits);
  if (!p) return { ...fail(''), digits, formatted: `+${digits}`, added };
  return {
    digits, err: '', cc: p.cc, region: p.region, country: countryName(p.region), national: p.national,
    formatted: format(p.cc, p.region, p.national), added, ...lengthInfo(p.region, p.national),
  };
}

module.exports = { parsePhone, ccOf, splitCc, countryName };
