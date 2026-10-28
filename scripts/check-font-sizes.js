// 字号规则检查：全软件最多四种字号、最小 12px，只能用 fonts.css 里的 --fs-* 变量。
// 扫 src 下的 CSS、HTML 和界面 JS，发现写死的 px 字号（或新加的字号变量）就失败。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const FONTS = path.join(SRC, 'fonts', 'fonts.css');
const bad = [];

// 1. 字号变量本身：不超过 4 个，都不小于 12px
const fontsCss = fs.readFileSync(FONTS, 'utf8');
const scale = [...fontsCss.matchAll(/--fs-([a-z0-9]+)\s*:\s*([\d.]+)px/g)].map((m) => ({ name: m[1], px: Number(m[2]) }));
if (!scale.length) bad.push('fonts.css 里没找到 --fs-* 字号变量');
if (scale.length > 4) bad.push(`字号变量有 ${scale.length} 个，最多 4 个`);
for (const s of scale) if (s.px < 12) bad.push(`--fs-${s.name} 是 ${s.px}px，最小 12px`);
const names = new Set(scale.map((s) => s.name));

// 2. 其它文件：字号只能写 var(--fs-*)、inherit 这类，不能写死数字
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (/\.(css|html|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const RULES = [
  // CSS: font-size: 13px / 1em / small 等
  { re: /font-size\s*:\s*([^;}"'`]+)/g, val: (m) => m[1] },
  // CSS 简写：font: 600 13px/1.4 ...
  { re: /(?<![-\w])font\s*:\s*([^;}"'`]+)/g, val: (m) => m[1] },
  // JS 行内样式：fontSize: '13px'
  { re: /fontSize\s*[:=]\s*['"`]([^'"`]+)['"`]/g, val: (m) => m[1] },
];
const okValue = (v) => {
  v = v.trim();
  if (/^(inherit|initial|unset)$/.test(v)) return true;
  const vars = [...v.matchAll(/var\(--fs-([a-z0-9]+)\)/g)].map((m) => m[1]);
  const rest = v.replace(/var\(--[\w-]+\)/g, '');
  if (/\d(px|em|rem|pt|%)|\b(x-small|small|smaller|larger|medium|large)\b/.test(rest.split('/')[0])) return false;
  return vars.every((n) => names.has(n));
};
for (const file of walk(SRC)) {
  if (file === FONTS) continue;
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8');
  // 只看界面代码：JS 里只查写了 fontSize 的行内样式和 CSS 字符串
  text.split('\n').forEach((line, i) => {
    for (const r of RULES) {
      if (/\.(m?js)$/.test(file) && r.re.source.startsWith('(?<!') && !/['"`][^'"`]*font\s*:/.test(line)) continue;
      for (const m of line.matchAll(r.re)) {
        if (!okValue(r.val(m))) bad.push(`${rel}:${i + 1} 写死了字号：${m[0].trim().slice(0, 60)}`);
      }
    }
  });
}

if (bad.length) {
  console.error('字号检查没通过：\n' + bad.map((b) => '  ' + b).join('\n'));
  console.error('请改用 fonts.css 里的 var(--fs-s) 12px / var(--fs-m) 14px / var(--fs-l) 16px / var(--fs-xl) 20px。');
  process.exit(1);
}
console.log(`字号检查通过：${scale.map((s) => s.px + 'px').join(' / ')}`);
