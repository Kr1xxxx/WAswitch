// 从 assets/logo.svg 生成所有图标（改了 logo.svg 后运行一次，把结果一起提交）：
//   node scripts/make-icons.js
// 需要 Playwright。生成后再跑 scripts/make-installer-art.js 更新安装界面图片。
//
// - icon.png       1024，铺满（Windows 程序图标、通知、关于页、安装向导）
// - icon-mac.png   1024，按苹果图标网格：圆角方块 824 居中、四周留透明边、带轻阴影，
//                  这样在程序坞里和其他 App 一样大
// - tray*.png      托盘小图，去掉气泡里的三个点，小尺寸更清楚
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const assets = path.join(__dirname, '..', 'assets');
const svg = fs.readFileSync(path.join(assets, 'logo.svg'), 'utf8');

const jobs = [
  { out: 'icon.png', size: 1024 },
  { out: 'icon-mac.png', size: 1024, mac: true },
  { out: 'tray.png', size: 32, tray: true },
  { out: 'tray16.png', size: 16, tray: true },
  { out: 'tray16@2x.png', size: 32, tray: true },
];

(async () => {
  const browser = await chromium.launch();
  for (const j of jobs) {
    const page = await browser.newPage({ viewport: { width: j.size, height: j.size } });
    const body = j.mac ? 824 / 1024 : 1; // 苹果网格：824/1024
    const top = j.mac ? 0.094 : 0; // 稍微偏上，给下方阴影留位置
    const css = `html,body{margin:0;background:transparent}
      .wrap{position:absolute;left:${((1 - body) / 2) * 100}%;top:${top * 100}%;width:${body * 100}%;height:${body * 100}%}
      svg{width:100%;height:100%;display:block}
      ${j.mac ? '.wrap{filter:drop-shadow(0 10px 14px rgba(0,0,0,.28))}' : ''}
      ${j.tray ? '.dots{display:none}' : ''}`;
    await page.setContent(`<style>${css}</style><div class="wrap">${svg}</div>`);
    await page.screenshot({ path: path.join(assets, j.out), omitBackground: true });
    await page.close();
    console.log(`✓ ${j.out}`);
  }
  await browser.close();
})();
