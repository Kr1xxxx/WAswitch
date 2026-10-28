// 组件总览页（scripts/visual/components.html）像素回归：1 倍和 2 倍缩放各截一遍，和仓库里的基准图比。
// 用法：xvfb-run -a -s "-screen 0 1920x2000x24" npm run check:visual
//       改了样式、确认新样子是对的：npm run check:visual -- --update，再把 scripts/visual/baseline 里的图一起提交
// 不一样时实际图、基准图、差异图（红点）写到 VISUAL_OUT（默认 visual-diff/），CI 会把这个文件夹传成附件。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const electron = require('electron');

// 基准图是在 Ubuntu（和 CI 一样的 ubuntu-latest）上截的；Mac、Windows 的字体渲染不同，比了也必然不一样
if (process.platform !== 'linux') {
  console.log('跳过：组件总览页的基准图在 Ubuntu 上生成，只在 Linux 上比（CI 会跑）');
  process.exit(0);
}
// 兜底字体（见 scripts/visual/fonts.conf）
if (!['DejaVuSans.ttf', 'DejaVuSansMono.ttf'].every((f) => fs.existsSync(`/usr/share/fonts/truetype/dejavu/${f}`))) {
  console.error('缺 DejaVu 字体：sudo apt-get install -y fonts-dejavu-core fonts-dejavu-mono');
  process.exit(1);
}

const update = process.argv.includes('--update');
const out = path.resolve(process.env.VISUAL_OUT || 'visual-diff');
// 上一次留下的差异图先清掉，免得这次通过了还看到旧图
fs.rmSync(out, { recursive: true, force: true });
let failed = 0;
for (const dsf of [1, 2]) {
  const r = spawnSync(electron, ['--no-sandbox', path.join(__dirname, 'visual', 'shoot.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // 只用内置字体、固定渲染参数，本机和 CI 出的图才一样
      FONTCONFIG_FILE: path.join(__dirname, 'visual', 'fonts.conf'),
      VISUAL_DSF: String(dsf),
      VISUAL_UPDATE: update ? '1' : '',
      VISUAL_OUT: out,
    },
    timeout: 120000,
  });
  process.stdout.write(r.stdout || '');
  const lines = (r.stderr || '').split('\n');
  const err = lines.filter((l) => /^(✗|VISUAL|\s+at |Error)/.test(l)).join('\n');
  if (err) process.stderr.write(`${err}\n`);
  // Electron 没走到最后（崩溃、超时）就没有 VISUAL 那行：把最后几行原样打出来，不然只看到「失败」不知道为什么
  if (!/VISUAL (PASS|FAIL)/.test(r.stderr || '')) {
    process.stderr.write(`✗ ${dsf} 倍：Electron 没跑完（退出码 ${r.status}${r.signal ? `，信号 ${r.signal}` : ''}${r.error ? `，${r.error.message}` : ''}）\n${lines.filter(Boolean).slice(-15).join('\n')}\n`);
  }
  if (r.status !== 0 || !/VISUAL PASS/.test(r.stderr || '')) failed++;
}
if (failed) {
  console.error(update ? '更新基准图失败' : `组件样子和基准图不一样。差异图在 ${path.relative(process.cwd(), out)}/。确认是有意改的：npm run check:visual -- --update`);
  process.exit(1);
}
console.log(update ? '基准图已更新' : '组件总览页和基准图一致');
