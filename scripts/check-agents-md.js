// AGENTS.md 检查（给 Codex、Claude 看的界面规则）：
// 1. AGENTS.md 里写到的 CSS 变量（`--x` 或 var(--x)）在 src/ 或团队后台的样式里都有定义，规则和代码不脱节；
// 2. AGENTS.md 里写到的 npm run 命令在 package.json 里都有；
// 3. 不做深色模式（shen 2026-10-28）：除了下面几个老文件，界面代码里不许出现跟系统深色走的写法。
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
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)) defined.add(m[1]);
}
// 只认紧跟在反引号或 var( 后面的，命令行参数（--no-sandbox）不算；`--fs-*` 这种通配不算
const named = new Set([...doc.matchAll(/(?<=`|var\()(--[a-z][a-z0-9-]*)(?![a-z0-9*-])/g)].map((m) => m[1]));
if (named.size < 10) bad.push(`AGENTS.md 只找到 ${named.size} 个变量，规则是不是被删了`);
for (const v of named) if (!defined.has(v)) bad.push(`AGENTS.md 写了 ${v}，但 src/ 和 server/public/ 的样式里没有定义`);

// ---------- 2. 命令都存在 ----------
const scripts = require(path.join(ROOT, 'package.json')).scripts || {};
for (const m of doc.matchAll(/npm run ([\w:-]+)/g)) if (!scripts[m[1]]) bad.push(`AGENTS.md 写了 npm run ${m[1]}，package.json 里没有`);

// ---------- 3. 没有新的深色模式 ----------
// 老文件：新消息弹窗、团队后台还跟系统深色走，不再扩展；radix-dark.css 是生成的色阶
const LEGACY = new Set([
  'src/popup/popup.css', 'src/popup/index.html',
  'server/public/admin/admin.css', 'server/public/admin/index.html',
  'src/colors/radix-dark.css', 'server/public/admin/radix-dark.css',
]);
const DARK = [/prefers-color-scheme\s*:\s*dark/i, /color-scheme\s*:\s*(?:light\s+)?dark/i, /data-theme/i, /themeSource/, /shouldUseDarkColors/, /radix-dark\.css/];
for (const f of files) {
  if (LEGACY.has(rel(f))) continue;
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (DARK.some((re) => re.test(line))) bad.push(`${rel(f)}:${i + 1} 不做深色模式：${line.trim().slice(0, 100)}`);
  });
}

if (bad.length) {
  console.error('AGENTS.md 检查没过：\n' + bad.map((b) => '  ' + b).join('\n'));
  process.exit(1);
}
console.log(`AGENTS.md 检查通过：${named.size} 个变量都有定义，没有新的深色模式写法`);
