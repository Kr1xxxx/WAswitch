// 圆角和动效规则检查（shen 2026-10-28：圆角 6 / 10 / 14 / 圆形，动效统一 250ms ease-out）。
// 圆角只能写 0、inherit 或 var(--r-s|m|l|full)；动画时长只能用 var(--fx)（或 0s），曲线只能用 var(--fx-ease)。
// 例外：转圈的加载图标（spin … linear infinite）。变量本身在 src/tokens.css。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TOKENS = path.join(SRC, 'tokens.css');
const bad = [];

// 1. 变量本身
const tokens = fs.readFileSync(TOKENS, 'utf8');
const radii = Object.fromEntries([...tokens.matchAll(/--r-([a-z]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const wantRadii = { s: '6px', m: '10px', l: '14px', full: '999px' };
if (JSON.stringify(radii) !== JSON.stringify(wantRadii)) bad.push(`tokens.css 的圆角变量应为 ${JSON.stringify(wantRadii)}，现在是 ${JSON.stringify(radii)}`);
if (!/--fx\s*:\s*250ms\s*;/.test(tokens)) bad.push('tokens.css 里 --fx 应为 250ms');
if (!/--fx-ease\s*:\s*ease-out\s*;/.test(tokens)) bad.push('tokens.css 里 --fx-ease 应为 ease-out');

const R = 'var\\(--r-(?:s|m|l|full)\\)';
const okRadius = new RegExp(`^(?:0|inherit|${R})(?:\\s+(?:0|${R})){0,3}(?:\\s*!important)?$`);
const SPIN = /^spin\s+\.9s\s+linear\s+infinite$/;
const TIME = /(?<![\w.-])(\d*\.?\d+)(ms|s)(?![\w-])/g;
const CURVE = /(?<![\w-])(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|cubic-bezier\([^)]*\)|steps\([^)]*\))(?![\w-])/;

function checkMotion(prop, value) {
  const v = value.trim().replace(/\s*!important$/, '');
  if (!v || /^(none|inherit|initial|unset)$/.test(v)) return null;
  if (/^animation(-name)?$/.test(prop) && SPIN.test(v)) return null;
  if (prop === 'animation-name' || prop === 'transition-property') return null;
  // 不认识的变量（例如旧的 --fx-fast / --fx-slow / --fx-state）
  for (const m of v.matchAll(/var\((--[\w-]+)\)/g)) if (!['--fx', '--fx-ease'].includes(m[1])) return `用了 ${m[1]}，只能用 --fx / --fx-ease`;
  for (const m of v.matchAll(TIME)) if (parseFloat(m[1]) !== 0) return `写死了时长 ${m[0]}，改用 var(--fx)`;
  const c = v.match(CURVE);
  if (c) return `写死了曲线 ${c[0]}，改用 var(--fx-ease)`;
  return null;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'emoji', 'misans', 'inter'].includes(e.name)) walk(p, out); } else if (/\.(css|html|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

function checkText(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    const report = (what) => found.push({ line: i + 1, what: what.trim().slice(0, 90) });
    // CSS 写法（.css、<style>、style=""、JS 里拼的 CSS 字符串）
    for (const m of line.matchAll(/(?<![\w-])border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;}"'`]*)/gi)) if (!okRadius.test(m[1].trim())) report(m[0]);
    for (const m of line.matchAll(/(?<![\w-])(transition|animation)(-duration|-timing-function|-delay)?\s*:\s*([^;}"'`]*)/gi)) {
      const why = checkMotion(`${m[1]}${m[2] || ''}`.toLowerCase(), m[3]);
      if (why) report(`${m[0]}（${why}）`);
    }
    // JS 的 style 对象 / el.style.xxx = '…'
    for (const m of line.matchAll(/\b(border(?:Top|Bottom)?(?:Left|Right)?Radius)\s*[:=]\s*(['"`])([^'"`]*)\2/g)) if (!okRadius.test(m[3].trim())) report(m[0]);
    for (const m of line.matchAll(/\b(borderRadius)\s*[:=]\s*(\d[^,;})]*)/g)) report(m[0]);
    for (const m of line.matchAll(/\b(transition|animation)(Duration|TimingFunction|Delay)?\s*[:=]\s*(['"`])([^'"`]*)\3/g)) {
      const prop = `${m[1]}${m[2] ? '-' + m[2].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()).slice(1) : ''}`;
      const why = checkMotion(prop, m[4]);
      if (why) report(`${m[0]}（${why}）`);
    }
  });
  return found;
}

// 先自检这个脚本
const SAMPLES_BAD = [
  '.a { border-radius: 8px; }', '.b { border-radius: 50%; }', '.c { border-top-left-radius: 4px; }', ".d { border-radius: var(--r-xl); }",
  "h('i', { style: { borderRadius: '16px' } });", 'el.style.borderRadius = 4;',
  '.e { transition: opacity .12s; }', '.f { animation: x var(--fx-slow) ease; }', '.g { transition: left var(--fx) ease; }',
  '.h { animation: pop var(--fx) cubic-bezier(.2, .9, .3, 1.35); }', '.i { animation-duration: 300ms; }', "el.style.transition = 'opacity 200ms';",
  '.j { animation: spin 1s linear infinite; }',
];
const SAMPLES_OK = [
  '.a { border-radius: var(--r-m); border-radius: 0; border-radius: inherit; }', '.b { border-radius: var(--r-s) var(--r-s) 0 0; }',
  '.c { transition: background-color var(--fx) var(--fx-ease), color var(--fx) var(--fx-ease); }',
  '.d { transition: height var(--fx) var(--fx-ease), visibility 0s var(--fx); }', '.e { animation: spin .9s linear infinite; }',
  '.f { animation: none; transition: none; }', "h('i', { style: { borderRadius: 'var(--r-l)' } });",
];
for (const t of SAMPLES_BAD) if (!checkText(t).length) bad.push(`脚本自检：没抓到违规写法 ${t}`);
for (const t of SAMPLES_OK) if (checkText(t).length) bad.push(`脚本自检：误报了合规写法 ${t}`);

for (const file of walk(SRC)) {
  if (file === TOKENS) continue;
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8');
  for (const f of checkText(text)) bad.push(`${rel}:${f.line} ${f.what}`);
  // 加载了 fonts.css 的页面都要接着加载 tokens.css，不然变量是空的
  if (/\.html$/.test(file) && /fonts\/fonts\.css/.test(text) && !/href="\.\.\/tokens\.css"/.test(text)) bad.push(`${rel} 没有加载 ../tokens.css`);
}

if (bad.length) {
  console.error('圆角和动效检查没通过：\n' + bad.map((b) => '  ' + b).join('\n'));
  console.error('圆角只能写 0、inherit 或 var(--r-s) 6 / var(--r-m) 10 / var(--r-l) 14 / var(--r-full)；动效时长 var(--fx) 250ms，曲线 var(--fx-ease) ease-out（在 src/tokens.css）。');
  process.exit(1);
}
console.log('圆角和动效检查通过：圆角 6 / 10 / 14 / 圆形，动效 250ms ease-out');
