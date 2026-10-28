// 界面文字不用中点「·」当分隔符（shen 2026-10-28）：几段并排用间距（shell.js 的 segs()）、换行或标点。
// 扫 src 和团队后台的代码，连注释一起查，出现就报出文件和行号。字体文件不查。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'server/src', 'server/public'];
const EXT = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.json']);
const SKIP = new Set(['node_modules', 'fonts']);
// 中点和长得像中点的字：U+00B7、U+30FB、U+FF65、U+2027、U+22C5、U+2219。U+2022 不算，遮密钥要用
const DOTS = /[\u00B7\u30FB\uFF65\u2027\u22C5\u2219]/;

const bad = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (EXT.has(path.extname(e.name))) {
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (DOTS.test(line)) bad.push(`${path.relative(ROOT, p)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
}
for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));

if (bad.length) {
  console.error(`界面代码里还有 ${bad.length} 处中点「·」，改成间距（segs()）、换行或标点：`);
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.log('没有中点分隔符：通过');
