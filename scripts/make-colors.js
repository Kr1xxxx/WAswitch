// 从 src/colors/radix.js 生成颜色变量文件：npm run make:colors
// 生成 src/colors/radix.css，团队后台 server/public/admin/ 里同样一份。
// scripts/check-colors.js 会比对这些文件是不是最新的，改了 radix.js 记得重新生成。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RADIX_JS = path.join(ROOT, 'src', 'colors', 'radix.js');

function load() {
  delete require.cache[require.resolve(RADIX_JS)];
  return require(RADIX_JS);
}

const enc = (v) => v.replace('#', '%23');
// 下拉箭头（细线 ⌄）和勾选框里的对勾：CSS 变量进不了 data: 图片，颜色只能写死在图里，所以在这里拿色阶值生成
const icons = (R) => ({
  'icon-chevron': `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='${enc(R.light.slate[10])}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
  'icon-check': `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.2l2.3 2.3 4.7-4.9' fill='none' stroke='${enc(R.WHITE)}' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
});

function vars(scales, indent) {
  const out = [];
  for (const [name, steps] of Object.entries(scales)) {
    const sep = name.endsWith('-a') ? '' : '-';
    steps.forEach((v, i) => out.push(`${indent}--${name}${sep}${i + 1}: ${v};`));
  }
  return out.join('\n');
}

const HEAD = '/* 由 scripts/make-colors.js 从 src/colors/radix.js 生成，不要手改。颜色来自 Radix UI Colors 3.0.0 */\n';

function build() {
  const R = load();
  const light = HEAD +
    ':root {\n' + vars(R.light, '  ') + '\n' +
    `  --white: ${R.WHITE};\n` +
    Object.entries(icons(R)).map(([k, v]) => `  --${k}: ${v};`).join('\n') + '\n}\n';
  const radixJs = fs.readFileSync(RADIX_JS, 'utf8');
  const admin = path.join(ROOT, 'server', 'public', 'admin');
  return {
    [path.join(ROOT, 'src', 'colors', 'radix.css')]: light,
    [path.join(admin, 'radix.css')]: light,
    [path.join(admin, 'radix.js')]: radixJs,
  };
}

module.exports = { build };

if (require.main === module) {
  for (const [file, text] of Object.entries(build())) {
    fs.writeFileSync(file, text);
    console.log('写好了', path.relative(ROOT, file));
  }
}
