// 生成 src/phone-meta.js：国家码 → 国家、各国号码位数、欧美常见国家的分组写法（侧栏「开聊」认号码用，见 src/phone-parse.js）。
// 数据来自 libphonenumber 的 resources/PhoneNumberMetadata.xml（Apache License 2.0）。
// 用法：curl -o PhoneNumberMetadata.xml https://raw.githubusercontent.com/google/libphonenumber/master/resources/PhoneNumberMetadata.xml
//       node scripts/gen-phone-meta.js PhoneNumberMetadata.xml
//
// 只取要用的：
// - 每个国家码下有哪些国家；不是主国家的，号码开头怎么认（leadingDigits）。加拿大在源数据里没有开头规则，
//   这里把它的区域号（固话、手机能对上而美国对不上的那些）算出来写成开头规则。
// - 每个国家固话和手机的位数（不含国家码），手机位数单独记一份，提醒时说「一般 N 位」。
// - 本国写法开头要不要拨 0（意大利固话的 0 是号码的一部分，不能去掉）。
// - FORMAT_REGIONS 里的国家：国际写法怎么分组（numberFormat 的 pattern、最后一条 leadingDigits、format）。
const fs = require('fs');
const path = require('path');

// 欧美常见的国家，号码按当地习惯分组；别的国家只显示 +国家码 后面连着的数字
const FORMAT_REGIONS = 'US CA MX GB IE DE FR ES PT IT NL BE LU CH AT LI DK SE NO FI IS PL CZ SK HU RO BG GR HR SI EE LV LT CY MT AU NZ'.split(' ');

const src = process.argv[2];
if (!src) { console.error('用法：node scripts/gen-phone-meta.js PhoneNumberMetadata.xml'); process.exit(1); }
const xml = fs.readFileSync(src, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const squash = (s) => String(s || '').replace(/\s+/g, '');
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? m[1] : ''; };
const block = (body, name) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body); return m ? m[1] : ''; };
const lengths = (body, type) => {
  const m = new RegExp(`<${type}>[\\s\\S]*?<possibleLengths national="([^"]*)"`).exec(body);
  if (!m || block(body, type).includes('<nationalNumberPattern>NA</nationalNumberPattern>')) return [];
  const out = [];
  for (const part of m[1].split(',')) {
    const r = /^\[(\d+)-(\d+)\]$/.exec(part);
    if (r) for (let n = +r[1]; n <= +r[2]; n++) out.push(n);
    else if (/^\d+$/.test(part)) out.push(+part);
  }
  return out;
};
const pattern = (body, type) => squash(block(block(body, type), 'nationalNumberPattern'));

const territories = [];
for (const m of xml.matchAll(/<territory\b([^>]*)>([\s\S]*?)<\/territory>/g)) {
  const head = m[1];
  const body = m[2];
  const id = attr(head, 'id');
  if (!/^[A-Z]{2}$/.test(id)) continue; // 001：不属于哪个国家的号段（国际免费电话等）
  territories.push({
    id, body,
    cc: attr(head, 'countryCode'),
    main: attr(head, 'mainCountryForCode') === 'true',
    lead: attr(head, 'leadingDigits'),
    np: attr(head, 'nationalPrefix'),
  });
}

// 加拿大的区域号：固话或手机的规则能对上、美国的对不上
function canadaAreas() {
  const re = (t, type) => new RegExp(`^(?:${pattern(t.body, type)})$`);
  const ca = territories.find((t) => t.id === 'CA');
  const us = territories.find((t) => t.id === 'US');
  const caRe = [re(ca, 'fixedLine'), re(ca, 'mobile')];
  const usRe = [re(us, 'fixedLine'), re(us, 'mobile')];
  const out = [];
  for (let a = 200; a <= 999; a++) {
    let inCa = false; let inUs = false;
    for (let x = 200; x <= 999 && !(inCa && inUs); x++) {
      for (const tail of ['1234', '5678', '0000']) {
        const n = `${a}${x}${tail}`;
        if (!inCa && caRe.some((r) => r.test(n))) inCa = true;
        if (!inUs && usRe.some((r) => r.test(n))) inUs = true;
      }
    }
    if (inCa && !inUs) out.push(a);
  }
  return out.join('|');
}

const byCc = new Map();
for (const t of territories) {
  if (!byCc.has(t.cc)) byCc.set(t.cc, []);
  byCc.get(t.cc).push(t);
}
const CC = {}; // 国家码 -> [主国家, [别的国家, 开头规则]...]
for (const [cc, list] of byCc) {
  const main = list.find((t) => t.main) || list[0];
  const rest = list.filter((t) => t !== main).map((t) => [t.id, t.id === 'CA' ? canadaAreas() : t.lead]).filter((r) => r[1]);
  CC[cc] = [main.id, ...rest];
}

const LEN = {}; // 国家 -> [固话和手机的位数（去重排好）, 手机的位数]
const NP0 = []; // 本国写法开头拨 0、补国家码时去掉这个 0 的国家
for (const t of territories) {
  const mob = lengths(t.body, 'mobile');
  const all = [...new Set([...lengths(t.body, 'fixedLine'), ...mob])].sort((a, b) => a - b);
  if (all.length) LEN[t.id] = [all.join(','), [...new Set(mob)].sort((a, b) => a - b).join(',')];
  if (t.np === '0') NP0.push(t.id);
}

const FMT = {}; // 国家 -> [[pattern, leadingDigits, format]...]
for (const id of FORMAT_REGIONS) {
  const t = territories.find((x) => x.id === id);
  if (!t) throw new Error(`没有 ${id}`);
  // 和美国共用写法的（加拿大）、和意大利共用的……源数据里没有自己的 availableFormats，用主国家的
  const own = block(t.body, 'availableFormats') ? t : territories.find((x) => x.cc === t.cc && x.main);
  const list = [];
  for (const f of block(own.body, 'availableFormats').matchAll(/<numberFormat\b([^>]*)>([\s\S]*?)<\/numberFormat>/g)) {
    const intl = block(f[2], 'intlFormat');
    if (intl === 'NA') continue;
    const leads = [...f[2].matchAll(/<leadingDigits>([\s\S]*?)<\/leadingDigits>/g)].map((x) => squash(x[1]));
    list.push([attr(f[1], 'pattern'), leads.length ? leads[leads.length - 1] : '', intl || block(f[2], 'format')]);
  }
  if (list.length) FMT[id] = list;
}

const out = `// 号码数据（侧栏「开聊」认号码用，见 phone-parse.js）。由 scripts/gen-phone-meta.js 生成，不要手改。
// 数据来自 libphonenumber resources/PhoneNumberMetadata.xml，Copyright (C) 2009 The Libphonenumber Authors，Apache License 2.0。
// CC：国家码 -> [主国家, [别的国家, 号码开头（正则）]...]
// LEN：国家 -> [固话和手机的位数, 手机的位数]（不含国家码）
// NP0：本国写法开头拨 0 的国家（补国家码时去掉 0）
// FMT：欧美常见国家的分组写法 [pattern, 号码开头, 写法]
module.exports = {
${['CC', 'LEN', 'NP0', 'FMT'].map((k) => `  ${k}: ${JSON.stringify({ CC, LEN, NP0, FMT }[k]).replace(/\],"/g, '],\n    "').replace(/^\{/, '{\n    ').replace(/\}$/, ',\n  }')},`).join('\n')}
};
`;
fs.writeFileSync(path.join(__dirname, '..', 'src', 'phone-meta.js'), out);
console.log(`国家码 ${Object.keys(CC).length} 个，位数 ${Object.keys(LEN).length} 个国家，分组写法 ${Object.keys(FMT).length} 个国家`);
