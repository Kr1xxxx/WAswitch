// 重新生成安装界面用的图片（改了 build/art 里的 HTML 后运行一次，把结果一起提交）：
//   node scripts/make-installer-art.js
// 需要 Playwright（npx playwright）和 ImageMagick 的 convert（Windows 向导只认 24 位 BMP）。
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');

const art = path.join(__dirname, '..', 'build', 'art');
const out = path.join(__dirname, '..', 'build');
const jobs = [
  { page: 'sidebar.html', w: 164, h: 314, scale: 1, png: 'installerSidebar.png', bmp: 'installerSidebar.bmp' },
  { page: 'header.html', w: 150, h: 57, scale: 1, png: 'installerHeader.png', bmp: 'installerHeader.bmp' },
  { page: 'dmg.html', w: 540, h: 380, scale: 1, png: 'background.png' },
  { page: 'dmg.html', w: 540, h: 380, scale: 2, png: 'background@2x.png' },
];

(async () => {
  const browser = await chromium.launch();
  for (const j of jobs) {
    const page = await browser.newPage({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: j.scale });
    await page.goto(`file://${path.join(art, j.page)}`);
    await page.evaluate(() => document.fonts.ready);
    const png = path.join(j.bmp ? require('os').tmpdir() : out, j.png);
    await page.screenshot({ path: png });
    if (j.bmp) execFileSync('convert', [png, '-type', 'TrueColor', '-alpha', 'off', `BMP3:${path.join(out, j.bmp)}`]);
    await page.close();
    console.log(`✓ ${j.bmp || j.png}`);
  }
  await browser.close();
})();
