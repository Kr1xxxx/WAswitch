// 生成 src/phone-zones.js：号码前缀 → 时区（顶栏“客户当地时间”用）。
// 数据来自 libphonenumber 的 resources/timezones/map_data.txt（Apache License 2.0）。
// 用法：curl -o map_data.txt https://raw.githubusercontent.com/google/libphonenumber/master/resources/timezones/map_data.txt
//       node scripts/gen-phone-zones.js map_data.txt
//
// 规则：
// - 一个前缀只对应一个时区：照用。
// - 对应几个时区但钟点一样（比如英国的 London / Jersey / Guernsey）：当成一个，取这个国家最常见的那个。
// - 钟点不一样（美国、俄罗斯、巴西……整个国家码那一级）：取主要时区，标“约”（前缀前加 ~）。
// - 和上一级前缀结果一样的不写，查的时候按最长前缀往上找。
const fs = require('fs');
const path = require('path');

// 号码只认得出国家、认不出区号时用的主要时区
const MAIN = {
  1: 'America/New_York', 7: 'Europe/Moscow', 34: 'Europe/Madrid', 39: 'Europe/Rome', 44: 'Europe/London', 47: 'Europe/Oslo',
  52: 'America/Mexico_City', 55: 'America/Sao_Paulo', 61: 'Australia/Sydney', 62: 'Asia/Jakarta', 64: 'Pacific/Auckland',
  77: 'Asia/Almaty', 243: 'Africa/Kinshasa', 262: 'Indian/Reunion', 299: 'America/Nuuk', 351: 'Europe/Lisbon', 353: 'Europe/Dublin',
  358: 'Europe/Helsinki', 593: 'America/Guayaquil', 599: 'America/Curacao', 686: 'Pacific/Tarawa', 689: 'Pacific/Tahiti',
  691: 'Pacific/Pohnpei', 976: 'Asia/Ulaanbaatar',
};
// 源数据明显不对的：爱尔兰 353 写成了伦敦
const FORCE = { 353: 'Europe/Dublin' };
// 源数据把全国通用的手机号段写成了某一个城市，改成“约”；昆士兰（617）不过夏令时，单独写
const PATCH = { 614: '~Australia/Sydney', 617: 'Australia/Brisbane', 79: '~Europe/Moscow' };
// 旧名字换成现在的名字（Electron 认旧名，但显示的城市名用新的）
const RENAME = { 'America/Godthab': 'America/Nuuk', 'Pacific/Ponape': 'Pacific/Pohnpei', 'Pacific/Truk': 'Pacific/Chuuk', 'Pacific/Enderbury': 'Pacific/Kanton', 'Europe/Kiev': 'Europe/Kyiv', 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Rangoon': 'Asia/Yangon', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Atlantic/Faeroe': 'Atlantic/Faroe' };

const src = process.argv[2];
if (!src) { console.error('用法：node scripts/gen-phone-zones.js map_data.txt'); process.exit(1); }
const rows = fs.readFileSync(src, 'utf8').split('\n').filter((l) => /^\d+\|/.test(l)).map((l) => {
  const [p, z] = l.trim().split('|');
  return { p, zones: z.split('&').map((x) => RENAME[x] || x) };
});

const valid = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const offsets = (tz) => [Date.UTC(2026, 0, 15, 12), Date.UTC(2026, 6, 15, 12)].map((t) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
}).join(',');

// 国家码：源数据里最短、而且是别的前缀开头的那些（1、7、44、49、351……）
const ccs = rows.map((r) => r.p).filter((p, _, all) => !all.some((q) => q !== p && p.startsWith(q)));
const ccOf = (p) => ccs.find((c) => p.startsWith(c)) || p;
// 每个国家码下，单一时区出现最多的那个（同钟点的几个里挑它）
const freq = new Map();
for (const r of rows) if (r.zones.length === 1) { const k = `${ccOf(r.p)}|${r.zones[0]}`; freq.set(k, (freq.get(k) || 0) + 1); }
const pick = (cc, zones) => {
  if (zones.includes(MAIN[cc])) return MAIN[cc];
  return zones.slice().sort((a, b) => (freq.get(`${cc}|${b}`) || 0) - (freq.get(`${cc}|${a}`) || 0))[0];
};

const resolved = new Map(); // 前缀 -> { tz, approx }
for (const r of rows.sort((a, b) => a.p.length - b.p.length)) {
  const cc = ccOf(r.p);
  const zones = r.zones.filter(valid);
  if (!zones.length) { console.warn('跳过（时区名不认识）', r.p, r.zones.join('&')); continue; }
  if (FORCE[cc]) { if (r.p === cc) resolved.set(r.p, { tz: FORCE[cc], approx: false }); continue; }
  const same = new Set(zones.map(offsets)).size === 1;
  if (zones.length === 1 || same) resolved.set(r.p, { tz: zones.length === 1 ? zones[0] : (MAIN[cc] && zones.includes(MAIN[cc]) ? MAIN[cc] : pick(cc, zones)), approx: false });
  else resolved.set(r.p, { tz: pick(cc, zones), approx: true });
}
for (const [p, v] of Object.entries(PATCH)) resolved.set(p, { tz: v.replace(/^~/, ''), approx: v.startsWith('~') });
// 去掉和上一级一样的
const parentOf = (p) => { for (let n = p.length - 1; n > 0; n--) { const v = resolved.get(p.slice(0, n)); if (v) return v; } return null; };
const byZone = new Map();
let kept = 0;
for (const [p, v] of [...resolved].sort((a, b) => a[0].localeCompare(b[0]))) {
  const up = parentOf(p);
  if (up && up.tz === v.tz && up.approx === v.approx) continue;
  if (!byZone.has(v.tz)) byZone.set(v.tz, []);
  byZone.get(v.tz).push((v.approx ? '~' : '') + p);
  kept += 1;
}
const body = [...byZone].sort((a, b) => a[0].localeCompare(b[0])).map(([tz, list]) => `  '${tz}': '${list.join(' ')}',`).join('\n');
const out = `// 号码前缀 → 时区（顶栏“客户当地时间”用）。由 scripts/gen-phone-zones.js 生成，不要手改。
// 数据来自 libphonenumber resources/timezones/map_data.txt，Copyright (C) 2012 The Libphonenumber Authors，Apache License 2.0。
// 每个时区后面是号码前缀（含国家码）；前缀前带 ~ 表示这段号码跨了几个时区，这里取的是主要时区，显示时标“约”。
// 查的时候取最长的前缀。
module.exports = {
${body}
};
`;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'phone-zones.js'), out);
console.log(`写好 src/phone-zones.js：${kept} 个前缀，${byZone.size} 个时区，${out.length} 字节`);
