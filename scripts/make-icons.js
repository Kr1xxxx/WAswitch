// 从 assets/logo.svg 生成所有图标（改了 logo.svg 后运行一次，把结果一起提交）：
//   node scripts/make-icons.js
// 需要 Playwright。生成后再跑 scripts/make-installer-art.js 更新安装界面图片。
//
// - icon.png       1024，铺满（Windows 程序图标、通知、关于页、安装向导）
// - icon-mac.png   1024，按苹果图标网格：圆角方块 824 居中、四周留透明边、带轻阴影，
//                  这样在程序坞里和其他 App 一样大
// - tray*.png      托盘小图，去掉气泡里的三个点，小尺寸更清楚（Windows 用）
// - trayTemplate*.png / trayUnreadTemplate*.png
//                  Mac 菜单栏用的黑白模板图，系统按深浅色自动变白/变黑；
//                  Unread 版右上角多一个圆点，有未读时换上
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

// Mac 菜单栏黑白图：两个气泡，后面的半透明，前面的实心，中间留一圈空隙
const bubbles = `M32 20h28a12 12 0 0 1 12 12v16a12 12 0 0 1-12 12H30l-10 8V32a12 12 0 0 1 12-12z`;
const front = `M42 38h28a12 12 0 0 1 12 12v36l-10-8H42a12 12 0 0 1-12-12V50a12 12 0 0 1 12-12z`;
const macTray = (dot) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="14 17 72 72">
  <mask id="m"><rect x="0" y="0" width="100" height="100" fill="#fff"/>
    <path d="${front}" fill="#000" stroke="#000" stroke-width="10" stroke-linejoin="round"/>
    ${dot ? '<circle cx="73" cy="30" r="17" fill="#000"/>' : ''}</mask>
  <mask id="m2"><rect x="0" y="0" width="100" height="100" fill="#fff"/>
    ${dot ? '<circle cx="73" cy="30" r="17" fill="#000"/>' : ''}</mask>
  <path d="${bubbles}" fill="#000" fill-opacity=".55" mask="url(#m)"/>
  <path d="${front}" fill="#000" mask="url(#m2)"/>
  ${dot ? '<circle cx="73" cy="30" r="12" fill="#000"/>' : ''}
</svg>`;
for (const [name, dot] of [['trayTemplate', false], ['trayUnreadTemplate', true]]) {
  jobs.push({ out: `${name}.png`, size: 16, svg: macTray(dot) });
  jobs.push({ out: `${name}@2x.png`, size: 32, svg: macTray(dot) });
}

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
    await page.setContent(`<style>${css}</style><div class="wrap">${j.svg || svg}</div>`);
    await page.screenshot({ path: path.join(assets, j.out), omitBackground: true });
    await page.close();
    console.log(`✓ ${j.out}`);
  }
  await browser.close();
})();
