// 回车处理都要先判断输入法是不是还在选字（e.isComposing || e.keyCode === 229）。
// 打中文时按回车是把拼音上屏，不能当成「改完了」「发送」（分组改名就踩过：没打完就提交了）。
// 扫 src 和团队后台的代码：凡是判断回车键的地方，从它所在的 keydown/keyup/keypress 处理开始
// 到这一行为止，必须同时出现 isComposing 和 229，否则报出文件和行号。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'server/src', 'server/public', 'build/art'];
const EXT = new Set(['.js', '.mjs', '.cjs', '.html']);
const SKIP = new Set(['node_modules', 'fonts']);
// e.key === 'Enter'、e.code === 'NumpadEnter'、keyCode/which === 13、switch 里的 case 'Enter'
const ENTER = /\.(?:key|code)\s*[!=]==?\s*(['"`])(?:Numpad)?Enter\1|(?:\.keyCode|\.which)\s*[!=]==?\s*13\b|case\s+(['"`])(?:Numpad)?Enter\2/g;
const HANDLER = /key(?:down|up|press)/gi;
const BACK = 2000; // 往回最多找这么多字去找处理函数的开头

function findBad(text) {
  const bad = [];
  for (const m of text.matchAll(ENTER)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    let lineEnd = text.indexOf('\n', m.index);
    if (lineEnd < 0) lineEnd = text.length;
    const from = Math.max(0, m.index - BACK);
    let start = lineStart;
    for (const h of text.slice(from, m.index).matchAll(HANDLER)) start = Math.min(lineStart, from + h.index);
    const region = text.slice(start, lineEnd);
    if (!/isComposing/.test(region) || !/\b229\b/.test(region)) {
      bad.push({ line: text.slice(0, m.index).split('\n').length, code: text.slice(lineStart, lineEnd).trim() });
    }
  }
  return bad;
}

// 先自测一下：没保护的要报，有保护的不报
const selfTest = [
  ["el.onkeydown = (e) => { if (e.key === 'Enter') go(); };", 1],
  ["box.addEventListener('keydown', (e) => { if (e.keyCode === 13) go(); });", 1],
  ["el.addEventListener('keydown', (e) => {\n  if (e.isComposing) return;\n  if (e.key === 'Enter') go();\n});", 1],
  ["el.addEventListener('keydown', (e) => {\n  if (e.isComposing || e.keyCode === 229) return;\n  if (e.key === 'Enter') go();\n});", 0],
  ["onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) go(); },", 0],
  ["el.onkeydown = (e) => { switch (e.key) { case 'Enter': go(); } };", 1],
];
for (const [code, want] of selfTest) {
  const got = findBad(code).length;
  if (got !== want) {
    console.error(`check-ime-enter 自测没过：应该报 ${want} 处，实际 ${got} 处\n${code}`);
    process.exit(1);
  }
}

const bad = [];
let n = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (EXT.has(path.extname(e.name))) {
      const text = fs.readFileSync(p, 'utf8');
      n += (text.match(ENTER) || []).length;
      for (const b of findBad(text)) bad.push(`${path.relative(ROOT, p)}:${b.line}: ${b.code.slice(0, 120)}`);
    }
  }
}
for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));

if (bad.length) {
  console.error(`有 ${bad.length} 处回车处理没判断输入法选字，在处理开头加 if (e.isComposing || e.keyCode === 229) return;`);
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.log(`回车处理都判断了输入法选字（${n} 处）：通过`);
