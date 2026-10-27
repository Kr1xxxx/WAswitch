// 自检：自带通知弹窗窗口（真的 Electron 窗口 + 真的弹窗页面）。
// 检查：右上角、不抢焦点、最多 3 张 + “还有 N 条”、同一客户合并、聊天锁遮住名字和内容、
// 点“打开”回到主进程、到时间自动收走、空闲后窗口关掉、勿扰时不弹。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-popup.js
//      加 SHOT_DIR=目录 会把弹窗截图存下来（PR 里贴图用）
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { app, ipcMain, screen } = require('electron');
const { PopupWindow } = require('../src/popup');

app.disableHardwareAcceleration(); // xvfb 下没有显卡，透明窗口截图要走软件渲染

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT_DIR = process.env.SHOT_DIR || '';
const ACC = { de: { name: '销售 DE', color: '#7C3AED' }, us: { name: '售后 US', color: '#EA580C' }, fr: { name: '销售 FR', color: '#2563EB' }, es: { name: '销售 ES', color: '#16A34A' } };
const MSGS = [
  ['us', 'James O’Connor', 'Perfect, I’ll confirm the order by Friday. Thanks for the quick reply!', 1],
  ['es', 'Sofía García', 'Hola, ¿el precio incluye el envío a Valencia?', 1],
  ['fr', 'Lucas Martin', 'Bonjour, pouvez-vous m’envoyer le devis mis à jour avec la remise de 8 % ?', 1],
  ['us', 'Olivia Bennett', 'Hi, the replacement part arrived but the box was damaged. Can you send me the return label?', 1],
  ['de', 'Emma Schneider', 'Hallo! Ist der Liefertermin für Bestellung #4471 noch der 12.11.? Wir planen die Montage am 14.', 2],
];

const settings = { popupSeconds: 0, popupSound: true, popupDnd: false };
let locked = false;
const opened = [];
const later = [];
const popup = new PopupWindow({
  getWindow: () => null,
  account: (id) => ACC[id] || null,
  locked: () => locked,
  settings: () => settings,
  onOpen: (c) => opened.push(c),
  onLater: (c) => later.push(c),
}, { idleCloseMs: 1500 });
ipcMain.on('popup:ready', (e) => popup.onReady(e.sender));
ipcMain.on('popup:hover', (e, on) => popup.onHover(e.sender, on === true));
ipcMain.on('popup:act', (e, { uid, action } = {}) => popup.onAction(e.sender, Number(uid), action));

const page = (js) => popup.win.webContents.executeJavaScript(js);
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await wait(50); }
  return false;
}
async function shot(name) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await wait(400); // 等滑入动画走完
  const img = await popup.win.webContents.capturePage();
  fs.writeFileSync(path.join(SHOT_DIR, name), img.toPNG());
}

app.whenReady().then(async () => {
  for (const [acc, who, text, count] of MSGS) popup.show({ key: `m:${acc}:${who}`, kind: 'msg', accId: acc, chat: who, text, count });
  assert(await until(() => popup.win && popup.ready && popup.win.isVisible()), '弹窗窗口建出来并显示了');
  const w = popup.win;
  assert.strictEqual(w.isFocusable(), false, '弹窗不能获得焦点（不打断打字）');
  assert.strictEqual(w.isAlwaysOnTop(), true, '弹窗在最上层');
  const wa = screen.getPrimaryDisplay().workArea;
  const b = w.getBounds();
  assert.strictEqual(b.x + 24 + 344, wa.x + wa.width - (process.platform === 'darwin' ? 10 : 12), `卡片贴着屏幕右边 ${JSON.stringify(b)} ${JSON.stringify(wa)}`);
  assert(b.y <= wa.y + 12, `在屏幕顶部 ${JSON.stringify(b)}`);

  assert(await until(async () => (await page('document.querySelectorAll(".nt").length')) === 3), '同时摆 3 张');
  const first = await page('document.querySelector(".nt .who").textContent');
  assert.strictEqual(first, 'Emma Schneider', '最新的在最上面');
  assert.match(await page('document.querySelector(".more").textContent'), /还有 2 条/, '多出来的写“还有 2 条”');
  assert.match(await page('document.querySelector(".nt .cnt").textContent'), /2 条/, '同一客户 2 条');
  assert.match(await page('document.querySelector(".nt .acc").textContent'), /销售 DE/, '写哪个号收到的');
  assert.match(await page('document.querySelector(".nt .txt").textContent'), /Liefertermin/, '写最后一条消息');
  await shot('popup-stack.png');

  // 同一个客户又发一条：合并，不多一张
  popup.show({ key: 'm:de:Emma Schneider', kind: 'msg', accId: 'de', chat: 'Emma Schneider', text: 'Und noch eine Frage: gibt es das Modell auch in Anthrazit?', count: 3 });
  assert(await until(async () => /3 条/.test(await page('document.querySelector(".nt .cnt") && document.querySelector(".nt .cnt").textContent'))), '合并成一张，3 条');
  assert.strictEqual(popup.queue.size, 5, '合并后还是 5 张');

  // 聊天锁：不显示名字、头像和内容
  locked = true;
  popup.refresh();
  assert(await until(async () => !(await page('document.body.innerText')).includes('Emma')), '锁着时看不到客户名字');
  const body = await page('document.body.innerText');
  assert(!/Liefertermin|Anthrazit|Valencia/.test(body), '锁着时看不到消息内容');
  assert(/解锁后查看/.test(body), '锁着时写“解锁后查看”');
  assert.strictEqual(await page('document.querySelectorAll(".av.lock").length'), 3, '头像换成锁');
  await shot('popup-locked.png');
  locked = false;
  popup.refresh();

  // 点“打开”：收走这一张，主进程收到是哪个号哪个客户
  await page('document.querySelector(".nt .btn.pri").click()');
  assert(await until(() => opened.length === 1), '点打开传回主进程');
  assert.strictEqual(opened[0].chat, 'Emma Schneider');
  assert.strictEqual(popup.queue.size, 4, '打开后收走这一张');
  await page('document.querySelector(".nt .btn:not(.pri)").click()');
  assert(await until(() => later.length === 1), '点稍后传回主进程');

  // 自动消失
  settings.popupSeconds = 1;
  popup.refresh();
  assert(await until(() => popup.queue.size === 0, 3000), '到时间自动收走');
  assert(await until(() => !w.isDestroyed() && !w.isVisible(), 1000), '都收走后窗口藏起来');
  // 空闲后关掉窗口（正式是 1 分钟，这里 1.5 秒）
  assert(await until(() => popup.win === null && w.isDestroyed(), 4000), '空闲后窗口关掉，不常驻');

  // 勿扰
  settings.popupDnd = true;
  assert.strictEqual(popup.show({ key: 'x', kind: 'msg', accId: 'de', chat: 'Emma Schneider', text: 'Hallo', count: 1 }), false, '勿扰：不弹');
  assert.strictEqual(popup.win, null, '勿扰：不建窗口');

  // 再来一条：窗口重新建出来
  settings.popupDnd = false;
  settings.popupSeconds = 6;
  popup.show({ key: 'n', kind: 'notice', accId: 'us', text: '已退出登录，需要重新扫码。点这里打开这个号。' });
  assert(await until(() => popup.win && popup.ready && popup.win.isVisible()), '关掉后来新提醒：重新建窗口');
  assert.match(await page('document.querySelector(".nt .who").textContent'), /售后 US/, '号自己的提醒：标题是账号名');

  console.log('通知弹窗自检通过');
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
