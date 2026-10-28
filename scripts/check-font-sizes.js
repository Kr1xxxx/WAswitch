// 字号规则检查：全软件最多四种字号、最小 12px，只能用 fonts.css 里的 --fs-* 变量。
// 白名单：字号只能写 inherit 或 var(--fs-*)，其它写法（px、em、vw、数字、拼出来的字符串……）一律失败。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const FONTS = path.join(SRC, 'fonts', 'fonts.css');
const bad = [];

// 1. 字号变量本身：不超过 4 个，都不小于 12px
const fontsCss = fs.readFileSync(FONTS, 'utf8');
const scale = [...fontsCss.matchAll(/--fs-([a-z0-9]+)\s*:\s*([^;]+);/g)].map((m) => ({ name: m[1], raw: m[2].trim(), px: /^\d+(\.\d+)?px$/.test(m[2].trim()) ? parseFloat(m[2]) : NaN }));
if (!scale.length) bad.push('fonts.css 里没找到 --fs-* 字号变量');
if (scale.length > 4) bad.push(`字号变量有 ${scale.length} 个，最多 4 个`);
for (const s of scale) {
  if (Number.isNaN(s.px)) bad.push(`--fs-${s.name} 要写成 px：${s.raw}`);
  else if (s.px < 12) bad.push(`--fs-${s.name} 是 ${s.px}px，最小 12px`);
}
const VAR = `var\\(--fs-(?:${scale.map((s) => s.name).join('|') || 'none'})\\)`;
const IMPORTANT = '(?:\\s*!important)?';
// font-size 的值
const okSize = new RegExp(`^(?:inherit|${VAR})${IMPORTANT}$`, 'i');
// font 简写：inherit，或「[斜体] [粗细] var(--fs-*)[/行高] 字体」
const okFont = new RegExp(`^(?:inherit|(?:(?:italic|normal|bold|[1-9]00)\\s+)*${VAR}(?:\\s*/\\s*[\\d.]+(?:px)?)?\\s+[^\\s].*?)${IMPORTANT}$`, 'i');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (/\.(css|html|js|mjs|svg)$/.test(e.name)) out.push(p);
  }
  return out;
}

// JS 里的值：只认一个完整的字符串字面量（'…' "…" 或不带 ${} 的 `…`），数字、变量、拼接都算违规
function jsLiteral(rest) {
  const m = rest.match(/^\s*(['"`])((?:(?!\1)[^\\$]|\\.)*)\1\s*(?=[,;})\]\n]|$)/);
  return m ? m[2] : null;
}

// 查一段文字，返回不合规的地方
function checkText(text, kind) {
  const isJs = kind === 'js';
  const isCss = !isJs;
  const found = [];
  const report = (i, what) => found.push({ line: i + 1, what: what.trim().slice(0, 70) });
  text.split('\n').forEach((line, i) => {
    // CSS 写法（.css / .html 的 <style> 和 style="" / JS 里的 CSS 字符串都会出现）
    for (const m of line.matchAll(/font-size\s*:\s*([^;}"'`]*)/gi)) if (!okSize.test(m[1].trim())) report(i, m[0]);
    for (const m of line.matchAll(/(?<![-\w.])font\s*:\s*([^;}"'`]*)/gi)) {
      const before = line.slice(0, m.index);
      if (isJs && (!/['"`]/.test(before) || /[{,]\s*$/.test(before))) continue; // JS 对象的 font: 键另外按值判（下面）
      if (!okFont.test(m[1].trim())) report(i, m[0]);
    }
    if (isCss && /(?<![-\w])zoom\s*:/i.test(line)) report(i, line.match(/zoom\s*:[^;}"]*/i)[0]);
    // SVG / HTML 属性 font-size="10"
    for (const m of line.matchAll(/\sfont-size\s*=\s*["']?([^"'\s>]*)/gi)) report(i, m[0]);
    if (!isJs) return;
    // fontSize: … / fontSize = … / .font = … / font: …（对象键）
    for (const m of line.matchAll(/\b(fontSize|font)\s*([:=])(?!=)/g)) {
      if (m[1] === 'font' && m[2] === ':' && !/[{,]\s*$/.test(line.slice(0, m.index))) continue; // 不是对象键，交给上面的 CSS 规则
      const v = jsLiteral(line.slice(m.index + m[0].length));
      const ok = v !== null && (m[1] === 'fontSize' ? okSize : okFont).test(v.trim());
      if (!ok) report(i, line.slice(m.index, m.index + 60));
    }
    // setProperty('font-size', …) / setProperty('font', …)
    for (const m of line.matchAll(/setProperty\(\s*(['"`])(font-size|font)\1\s*,/g)) {
      const v = jsLiteral(line.slice(m.index + m[0].length));
      if (v === null || !(m[2] === 'font' ? okFont : okSize).test(v.trim())) report(i, line.slice(m.index, m.index + 60));
    }
    // setAttribute('font-size', …)：SVG 文字也要用 CSS 变量，不写属性
    for (const m of line.matchAll(/setAttribute\(\s*['"`]font-size['"`]/g)) report(i, line.slice(m.index, m.index + 60));
  });
  return found;
}

// 先自检这个脚本：下面每条违规写法都必须被抓到，合规写法都必须放过
const SAMPLES_BAD = {
  js: [
    "el.style.setProperty('font-size','13px');", 'el.style.fontSize = `${n}px`;', "el.style.fontSize = 13 + 'px';",
    "h('b', { style: { fontSize: 13 } });", "ctx.font = '11px sans-serif';", "el.style.font = '600 11px/1 var(--font-ui)';",
    "svg.setAttribute('font-size', 10);", 'const css = `.x { font-size: 10vw; }`;', "const css2 = '.y { font-size: 13PX }';",
    "h('b', { style: { fontSize: 'var(--fs-xxl)' } });", "h('b', { style: { font: '12px a' } });",
  ],
  css: ['.a { zoom: .8; }', '.b { font-size: 1.2em; }', '.c { font: 13px/1 x; }', '.d { font-size: small; }', '<text font-size="10">x</text>'],
};
const SAMPLES_OK = {
  js: ["h('b', { style: { fontSize: 'var(--fs-s)' } });", "el.style.font = '600 var(--fs-s)/1 var(--font-ui)';", "el.style.setProperty('font-size', 'var(--fs-m)');"],
  css: ['.ok { font-size: var(--fs-l) !important; font: inherit; }', 'body { font: var(--fs-m)/1.5 var(--font-ui); }'],
};
for (const [kind, list] of Object.entries(SAMPLES_BAD)) for (const t of list) if (!checkText(t, kind).length) bad.push(`脚本自检：没抓到违规写法 ${t}`);
for (const [kind, list] of Object.entries(SAMPLES_OK)) for (const t of list) if (checkText(t, kind).length) bad.push(`脚本自检：误报了合规写法 ${t}`);

for (const file of walk(SRC)) {
  if (file === FONTS) continue;
  const rel = path.relative(ROOT, file);
  const kind = /\.m?js$/.test(file) ? 'js' : 'css';
  for (const f of checkText(fs.readFileSync(file, 'utf8'), kind)) bad.push(`${rel}:${f.line} 字号不合规：${f.what}`);
}

if (bad.length) {
  console.error('字号检查没通过：\n' + bad.map((b) => '  ' + b).join('\n'));
  console.error(`字号只能写 inherit 或 ${scale.map((s) => `var(--fs-${s.name}) ${s.raw}`).join(' / ')}（在 src/fonts/fonts.css）。`);
  process.exit(1);
}
console.log(`字号检查通过：${scale.map((s) => s.raw).join(' / ')}`);
