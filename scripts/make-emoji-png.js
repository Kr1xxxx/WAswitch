// 把 src/emoji/svg 里的图转成托盘菜单用的 PNG（16px 和 @2x 32px）。换了 emoji 后跑一次：node scripts/make-emoji-png.js
// 需要 Playwright（开发机上有就行，打包不用）
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const DIR = path.join(__dirname, '..', 'src', 'emoji');
const { IDS } = require(path.join(DIR, 'list.js'));
(async () => {
  const browser = await chromium.launch();
  for (const [size, suffix] of [[16, ''], [32, '@2x']]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    for (const id of IDS) {
      const svg = fs.readFileSync(path.join(DIR, 'svg', `${id}.svg`), 'utf8');
      await page.setContent(`<style>html,body{margin:0;background:transparent}img{display:block}</style><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`);
      await page.waitForFunction(() => document.images[0].complete);
      await page.screenshot({ path: path.join(DIR, 'png', `${id}${suffix}.png`), omitBackground: true });
    }
    await page.close();
  }
  await browser.close();
})();
