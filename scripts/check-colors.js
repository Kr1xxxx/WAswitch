// 颜色规则检查：全 app 只用 Radix UI Colors。
// 1. src/colors/radix.js 里的每个值都和 @radix-ui/colors 包里的一样（不许自己调色）；
// 2. radix.css / radix-dark.css 和团队后台那份是从 radix.js 生成的最新版（npm run make:colors）；
// 3. 除了 src/colors/ 和后台的 radix.*，界面代码里不许直接写颜色：#十六进制、rgb()/hsl() 这类、CSS 里的颜色名。
//    CSS 用 var(--slate-11) 这种变量，JS 用 RADIX.hex('slate', 11) / RADIX.WHITE。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const bad = [];

// ---------- 1. 值和 Radix 一致 ----------
const R = require(path.join(ROOT, 'src', 'colors', 'radix.js'));
const PKG = path.join(ROOT, 'node_modules', '@radix-ui', 'colors');
function pkgScale(file, name) {
  const p = path.join(PKG, file);
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8').split('@supports')[0];
  const sep = name.endsWith('-a') ? '' : '-';
  const vals = {};
  for (const m of text.matchAll(new RegExp(`--${name}${sep}(\\d+):\\s*([^;]+);`, 'g'))) vals[m[1]] = m[2].replace(/\s+/g, '').toLowerCase();
  return Array.from({ length: 12 }, (_, i) => vals[i + 1]);
}
if (!fs.existsSync(PKG)) bad.push('找不到 node_modules/@radix-ui/colors，先 npm ci');
else {
  for (const [theme, scales] of [['light', R.light], ['dark', R.dark]]) {
    for (const [name, steps] of Object.entries(scales)) {
      const base = name.endsWith('-a') ? name.slice(0, -2) : name;
      const file = `${base}${theme === 'dark' ? '-dark' : ''}${name.endsWith('-a') ? '-alpha' : ''}.css`;
      const want = pkgScale(file, name);
      if (!want) { bad.push(`@radix-ui/colors 里没有 ${file}`); continue; }
      steps.forEach((v, i) => { if (String(v).toLowerCase() !== want[i]) bad.push(`radix.js ${theme} ${name} ${i + 1} 是 ${v}，Radix 是 ${want[i]}`); });
    }
  }
}
// 旧账号颜色（0.5.12 以前存在配置和团队后台里）都要换成同位置的新颜色
Object.entries(R.LEGACY).forEach(([old, i]) => { if (R.accountColor(old.toUpperCase()) !== R.ACCOUNT_COLORS[i]) bad.push(`旧颜色 ${old} 没换成 ${R.ACCOUNT_COLORS[i]}`); });
if (R.accountColor('#123456') !== '' || R.accountFamily('') !== 'slate' || R.accountFamily(R.ACCOUNT_COLORS[0]) !== 'green') bad.push('accountColor / accountFamily 不对');
for (const c of [...R.ACCOUNT_COLORS, ...R.AVATAR_COLORS]) if (!Object.values(R.light).some((s) => s.includes(c))) bad.push(`颜色 ${c} 不在色阶里`);

// ---------- 2. 生成的文件是最新的 ----------
for (const [file, text] of Object.entries(require('./make-colors').build())) {
  const rel = path.relative(ROOT, file);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) bad.push(`${rel} 不是最新的，跑一下 npm run make:colors`);
}

// ---------- 3. 别处不许直接写颜色 ----------
const NAMED = 'aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen';
const COLOR_PROPS = '(?:color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|stop-color|flood-color|lighting-color|caret-color|accent-color|column-rule(?:-color)?|text-decoration(?:-color)?)';
const HEX = /(?<![\w&%-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const HEX_URI = /%23(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z])/gi; // data: 图片里的 #
const FUNC = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
const NAMED_DECL = new RegExp(`(?<![\\w-])${COLOR_PROPS}\\s*:[^;{}"'\`]*?(?<![\\w-])(${NAMED})(?![\\w-])`, 'gi');
const NAMED_JS = new RegExp(`\\b(?:color|background|backgroundColor|border\\w*|fill|stroke|outline\\w*)\\s*[:=]\\s*(['"\`])(?:[^'"\`]*\\s)?(${NAMED})(?![\\w-])`, 'gi');

const blank = (s) => s.replace(/[^\n]/g, ' '); // 去掉注释但保留行号
function stripComments(text, kind) {
  if (kind === 'js') {
    return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:\\'"`\w])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
  }
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/<!--[\s\S]*?-->/g, blank);
}

// 返回 [{ line, what }]
function checkText(text, kind) {
  const found = [];
  const src = stripComments(text, kind);
  const lineAt = (i) => src.slice(0, i).split('\n').length;
  const add = (i, what) => found.push({ line: lineAt(i), what });
  // CSS 里选择器可以有 #id（比如 #add），只看花括号里的声明；HTML 里看 <style> 和属性值；JS 看字符串里的值
  for (const m of src.matchAll(HEX)) {
    const i = m.index;
    if (kind === 'css') {
      const open = src.lastIndexOf('{', i), close = src.lastIndexOf('}', i);
      if (open <= close) continue; // 在选择器里
      // 选择器嵌在 @media 里时：这一段从 { 到这里如果又出现 { 之前的选择器，lastIndexOf 已经处理
      add(i, m[0]);
      continue;
    }
    const before = src.slice(Math.max(0, i - 40), i);
    if (/\b(?:href|id|for)\s*[:=]\s*["'`]?$|url\(\s*$/i.test(before)) continue; // 锚点、SVG 引用
    if (/(?:[:,(='"`>]|\b(?:solid|dashed|dotted|double|inset|none|transparent|px|em|rem|%)|\))\s*$/i.test(before)) add(i, m[0]);
  }
  for (const m of src.matchAll(HEX_URI)) add(m.index, m[0]);
  for (const m of src.matchAll(FUNC)) add(m.index, m[0]);
  if (kind !== 'js') for (const m of src.matchAll(NAMED_DECL)) add(m.index, m[0].slice(0, 60));
  else {
    for (const m of src.matchAll(NAMED_JS)) add(m.index, m[0].slice(0, 60));
    for (const m of src.matchAll(NAMED_DECL)) { const pre = src.slice(Math.max(0, m.index - 1), m.index); if (/['"`;\s{]/.test(pre)) add(m.index, m[0].slice(0, 60)); }
  }
  return found;
}

// 脚本自检：违规写法都要抓到，合规写法都要放过
const SAMPLES_BAD = {
  css: ['.a { color: #fff; }', '.b { border: 1px solid #E3E6EA; }', '.c { background: rgba(0,0,0,.06); }', '.d { color: white; }',
    '.e { background: #fff url("data:image/svg+xml,%3Csvg stroke=\'%234a505a\'/%3E"); }', '.f { box-shadow: 0 1px 2px hsl(0 0% 0% / .1); }',
    '@media (x) { .g { outline-color: #2563eb; } }', '.h { background: color-mix(in srgb, var(--a) 20%, #eef0f3); }'],
  html: ['<rect fill="#fff"/>', '<div style="color: red">', '<stop stop-color="#26282C"/>'],
  js: ["const C = ['#16A34A'];", "el.style.background = '#E6E9ED';", "h('i', { style: { color: '#4A505A' } });", "x = { boxShadow: '0 4px 12px rgba(0,0,0,.25)' };",
    "el.style.border = '1px solid #ccc';", "el.style.color = 'red';", 'const s = `.x { color: white; }`;', "win.setBackgroundColor('#00000000');"],
};
const SAMPLES_OK = {
  css: ['#add, #side { color: var(--slate-11); }', '.a { background: var(--white) var(--icon-chevron); }', '/* #161 加的 */ .b { color: currentColor; border-color: transparent; }',
    '.c { white-space: nowrap; background: color-mix(in srgb, var(--green-9) 20%, var(--slate-2)); }'],
  html: ['<a href="#bad">x</a>', '<path fill="url(#lg)"/>', '<p>订单 #4471</p>'],
  js: ["text: 'Bestellung #4471 noch'", '// #216 那版', "el.style.color = 'var(--slate-11)';", "const k = 'white-space';", "h('a', { href: '#add' });", "const green = R.hex('green', 9);"],
};
for (const [kind, list] of Object.entries(SAMPLES_BAD)) for (const t of list) if (!checkText(t, kind).length) bad.push(`脚本自检：没抓到违规写法 ${t}`);
for (const [kind, list] of Object.entries(SAMPLES_OK)) for (const t of list) { const f = checkText(t, kind); if (f.length) bad.push(`脚本自检：误报了合规写法 ${t}（${f[0].what}）`); }

// 要扫的地方：软件界面（src）、团队后台网页（server/public）。
// 不扫的：App 图标和安装器背景图（assets/、build/art，黑金品牌色，和 logo 一套），账号头像 emoji 图（src/emoji）
const SKIP = new Set([
  path.join(ROOT, 'src', 'colors', 'radix.js'),
  path.join(ROOT, 'src', 'colors', 'radix.css'),
  path.join(ROOT, 'src', 'colors', 'radix-dark.css'),
  path.join(ROOT, 'server', 'public', 'admin', 'radix.js'),
  path.join(ROOT, 'server', 'public', 'admin', 'radix.css'),
  path.join(ROOT, 'server', 'public', 'admin', 'radix-dark.css'),
]);
const SKIP_DIRS = [path.join(ROOT, 'src', 'emoji')];
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (/\.(css|html|js|mjs|svg)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = [path.join(ROOT, 'src'), path.join(ROOT, 'server', 'public')].flatMap((d) => walk(d));
let scanned = 0;
for (const file of files) {
  if (SKIP.has(file) || SKIP_DIRS.some((d) => file.startsWith(d + path.sep))) continue;
  scanned++;
  const rel = path.relative(ROOT, file);
  const ext = path.extname(file);
  let text = fs.readFileSync(file, 'utf8');
  let found;
  if (ext === '.html' || ext === '.svg') {
    // <style> 当 CSS 查，其余当 HTML 查（<script> 里的当 JS）
    const styles = [], scripts = [];
    text = text.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, b, c) => { styles.push([text.indexOf(m) + a.length, b]); return a + blank(b) + c; });
    text = text.replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, a, b, c) => { scripts.push([text.indexOf(m) + a.length, b]); return a + blank(b) + c; });
    found = checkText(text, 'html');
    const orig = fs.readFileSync(file, 'utf8');
    for (const [kind, parts] of [['css', styles], ['js', scripts]]) for (const [at, body] of parts) {
      const base = orig.slice(0, orig.indexOf(body, Math.max(0, at - 200))).split('\n').length - 1;
      for (const f of checkText(body, kind)) found.push({ line: f.line + base, what: f.what });
    }
  } else found = checkText(text, ext === '.css' ? 'css' : 'js');
  for (const f of found) bad.push(`${rel}:${f.line} 直接写了颜色：${f.what}`);
}

if (bad.length) {
  console.error('颜色检查没通过：\n' + bad.map((b) => '  ' + b).join('\n'));
  console.error('颜色只能用 src/colors/radix.css 里的 Radix 变量（CSS: var(--slate-11)），JS 里用 RADIX.hex(\'slate\', 11)。');
  process.exit(1);
}
console.log(`颜色检查通过：${Object.keys(R.light).length} 组 Radix 色阶，扫了 ${scanned} 个文件`);
