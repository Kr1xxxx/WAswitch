// AGENTS.md 检查（给 Codex、Claude 看的界面规则）：
// 1. AGENTS.md 里写到的 CSS 变量（`--x` 或 var(--x)）在 src/ 或团队后台的样式里都有定义，规则和代码不脱节；
// 2. AGENTS.md 里写到的 npm run 命令在 package.json 里都有；
// 3. 不做深色模式（shen 2026-10-28）：除了下面几个老文件，界面代码里不许出现跟系统深色走的写法。
//    唯一例外（2026-11-02）：放进 WhatsApp 页面里的译文块跟 WhatsApp 的主题走，Radix 深色色阶（hexDark、.dark.）只许在 radix.js、translate-ipc.js 里取。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'server/public'];
const EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.css']);
const SKIP = new Set(['node_modules', 'emoji']);
const bad = [];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}
const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const doc = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');

// ---------- 1. 变量都有定义 ----------
const defined = new Set();
for (const f of files) {
  if (!/\.(css|html)$/.test(f)) continue;
  const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); // 注释里的不算定义
  for (const m of text.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)) defined.add(m[1]);
}
// 只认紧跟在反引号或 var( 后面的，命令行参数（--no-sandbox）不算；`--fs-*` 这种通配不算
const named = new Set([...doc.matchAll(/(?<=`|var\()(--[a-z][a-z0-9-]*)(?![a-z0-9*-])/g)].map((m) => m[1]));
if (named.size < 10) bad.push(`AGENTS.md 只找到 ${named.size} 个变量，规则是不是被删了`);
for (const v of named) if (!defined.has(v)) bad.push(`AGENTS.md 写了 ${v}，但 src/ 和 server/public/ 的样式里没有定义`);

// ---------- 2. 命令都存在 ----------
const scripts = require(path.join(ROOT, 'package.json')).scripts || {};
for (const m of doc.matchAll(/npm run ([\w:-]+)/g)) if (!scripts[m[1]]) bad.push(`AGENTS.md 写了 npm run ${m[1]}，package.json 里没有`);

// ---------- 3. 没有新的深色模式 ----------
const DARK = [/prefers-color-scheme\s*:\s*dark/i, /color-scheme\s*:\s*(?:light\s+)?dark/i, /data-theme/i, /themeSource\s*=\s*['"`](?:dark|system)/, /shouldUseDarkColors/, /radix-dark\.css/];
// Radix 深色色阶只给 WhatsApp 页面里的译文块用：radix.js 定义（admin 里是它的生成副本），translate-ipc.js 的 inlineLook 取
const DARK_OK = new Set(['src/colors/radix.js', 'server/public/admin/radix.js', 'src/translate-ipc.js']);
const RADIX_DARK = [/\bhexDark\b/, /\.dark\b\s*[.\[]/];
function darkProblems(name, text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (DARK.some((re) => re.test(line))) out.push(`${name}:${i + 1} 不做深色模式：${line.trim().slice(0, 100)}`);
    else if (!DARK_OK.has(name) && RADIX_DARK.some((re) => re.test(line))) out.push(`${name}:${i + 1} Radix 深色色阶只给 WhatsApp 页面里的译文块用（translate-ipc.js 的 inlineLook）：${line.trim().slice(0, 100)}`);
  });
  return out;
}
for (const f of files) bad.push(...darkProblems(rel(f), fs.readFileSync(f, 'utf8')));
// 故意违规的样例，确认抓得到
const sample = ["const c = RADIX.hexDark('slate', 11);", 'const d = RADIX.dark.slate[0];', '@media (prefers-color-scheme: dark) { a { b: c } }'];
for (const line of sample) if (!darkProblems('src/some-ui.js', line).length) bad.push(`深色检查漏掉了样例：${line}`);
if (darkProblems('src/translate-ipc.js', sample[0]).length) bad.push('translate-ipc.js 取 hexDark 不该报错');

if (bad.length) {
  console.error('AGENTS.md 检查没过：\n' + bad.map((b) => '  ' + b).join('\n'));
  process.exit(1);
}
console.log(`AGENTS.md 检查通过：${named.size} 个变量都有定义，没有新的深色模式写法`);
