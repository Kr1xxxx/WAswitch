// 自检：自带通知弹窗窗口（真的 Electron 窗口 + 真的弹窗页面）。
// 检查：右上角、不抢焦点、最多 3 张 + “还有 N 条”、同一客户合并、聊天锁遮住名字和内容、
// 点“打开”回到主进程、到时间自动收走、空闲后窗口关掉、勿扰时不弹、
// 拔掉接上显示器和改缩放后重新摆到该在的屏幕右上角（假的几块屏幕）、
// 鼠标不在卡片上时窗口一定点穿（页面没报“移开了”也一样：窗口被挪走、卡片收走、鼠标跳到透明处）。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-popup.js
//      加 SHOT_DIR=目录 会把弹窗截图存下来（PR 里贴图用）
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { EventEmitter } = require('events');
const { app, ipcMain, screen } = require('electron');
const { PopupWindow, pickDisplay, spotOn, WIN_W, WIN_H } = require('../src/popup');

app.disableHardwareAcceleration(); // xvfb 下没有显卡，透明窗口截图要走软件渲染
// 弹窗窗口空闲后会被关掉，这是测试里唯一的窗口；不接这个事件 Electron 会在窗口全关时直接退出（exit 0），后半段就不会跑
app.on('window-all-closed', () => {});

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
let idleSeconds = 0; // 假的“系统多久没输入”：0 = 正在用电脑
const opened = [];
const later = [];
const popup = new PopupWindow({
  getWindow: () => null,
  account: (id) => ACC[id] || null,
  locked: () => locked,
  settings: () => settings,
  onOpen: (c) => opened.push(c),
  onLater: (c) => later.push(c),
  idleSeconds: () => idleSeconds,
}, { idleCloseMs: 1500 });
const popups = [popup]; // 后面“显示器插拔”那段另建一个，事件按页面分给各自的窗口
ipcMain.on('popup:ready', (e) => popups.forEach((p) => p.onReady(e.sender)));
ipcMain.on('popup:hover', (e, on) => popups.forEach((p) => p.onHover(e.sender, on === true)));
ipcMain.on('popup:layout', (e, rects) => popups.forEach((p) => p.onLayout(e.sender, rects)));
ipcMain.on('popup:act', (e, { uid, action } = {}) => popups.forEach((p) => p.onAction(e.sender, Number(uid), action)));

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

  // 关闭按钮（Mac 在卡片左上角往外伸）和它的阴影要整个在窗口里；卡片在屏幕上的位置不因此挪动
  const gap = process.platform === 'darwin' ? 10 : 12;
  const geo = await page('(() => { const c = document.querySelector(".nt").getBoundingClientRect(); const x = document.querySelector(".nt .x").getBoundingClientRect(); return { cardTop: c.top, xTop: x.top, xLeft: x.left }; })()');
  assert.strictEqual(b.y + geo.cardTop, wa.y + gap, `卡片位置不变（贴着屏幕上边留 ${gap}px）${JSON.stringify(geo)}`);
  assert(geo.xTop >= 2 && geo.xLeft >= 2, `关闭按钮在窗口里，上方留得下阴影 ${JSON.stringify(geo)}`);
  await page('(() => { const st = document.createElement("style"); st.id = "force-x"; st.textContent = ".nt:first-child .x { opacity: 1 !important; }"; document.head.append(st); })()');
  await shot('popup-close-button.png');
  await page('document.getElementById("force-x").remove()');

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

  // 页面说“鼠标停在卡上”，但鼠标其实不在窗口里（xvfb 下光标在屏幕中间）：不信，不暂停倒计时、不关点穿
  popup.onHover(w.webContents, true);
  assert.strictEqual(popup.queue.hoverSince, 0, '鼠标不在窗口里时不接受“悬停”（窗口藏过再显示时页面记的旧位置不可信）');

  // 自动消失：只在用户在用电脑时倒计时（此时还剩 3 张，再加一张凑成 3 张 + “还有 1 条”）
  popup.show({ key: 'm:fr:Chloé Dubois', kind: 'msg', accId: 'fr', chat: 'Chloé Dubois', text: 'Merci, à bientôt !', count: 1 });
  assert.strictEqual(popup.queue.size, 4);
  settings.popupSeconds = 1;
  popup.refresh();
  idleSeconds = 30; // 没动鼠标、没按键
  await wait(2500);
  assert.strictEqual(popup.queue.size, 4, '没在用电脑：卡片不消失');
  assert(popup.queue.items.every((x) => x.leftMs !== Infinity), '只是暂停，回来接着算');
  idleSeconds = 0;
  // 前 3 张先走完；藏在“还有 1 条”后面的那张露出来才开始算，所以不会同时全没
  assert(await until(() => popup.queue.size === 1, 3000), '在用电脑：到时间前 3 张收走');
  assert(await until(() => popup.queue.size === 0, 3000), '补上来的那张从头算 1 秒再收走');

  // 离开电脑超过 5 分钟：期间的卡片不再自动消失，回来后要手动一张一张点掉；没有“全部收起”
  popup.show({ key: 'm:de:Emma Schneider', kind: 'msg', accId: 'de', chat: 'Emma Schneider', text: 'Sind Sie noch da?', count: 1 });
  idleSeconds = 6 * 60;
  popup.show({ key: 'm:us:Olivia Bennett', kind: 'msg', accId: 'us', chat: 'Olivia Bennett', text: 'Any update on the return label?', count: 1 });
  await wait(1200);
  idleSeconds = 0; // 人回来了
  await wait(2500);
  assert.strictEqual(popup.queue.size, 2, '离开超过 5 分钟：回来后卡片还在，不自动消失');
  assert(popup.queue.items.every((x) => x.sticky), '两张都标成要手动点');
  assert.strictEqual(await page('document.querySelectorAll("[data-act=clear]").length'), 0, '没有“全部收起”');
  await page('document.querySelector(".nt .x").click()');
  assert(await until(() => popup.queue.size === 1), '点一张收一张');
  await page('document.querySelector(".nt .x").click()');
  assert(await until(() => popup.queue.size === 0), '再点一张收一张');
  assert(await until(() => !w.isDestroyed() && !w.isVisible(), 1000), '都收走后窗口藏起来');
  // 空闲后关掉窗口（正式是 1 分钟，这里 1.5 秒）
  assert(await until(() => popup.win === null && w.isDestroyed(), 4000), '空闲后窗口关掉，不常驻');

  // 勿扰：新消息不弹；号自己的提醒（退出登录、断线）照弹，不响
  settings.popupDnd = true;
  assert.strictEqual(popup.show({ key: 'x', kind: 'msg', accId: 'de', chat: 'Emma Schneider', text: 'Hallo', count: 1 }), false, '勿扰：新消息不弹');
  assert.strictEqual(popup.win, null, '勿扰：不建窗口');
  assert.strictEqual(popup.show({ key: 'n0', kind: 'notice', accId: 'de', text: '已退出登录，需要重新扫码。' }), true, '勿扰：退出登录这类提醒照弹');
  assert.strictEqual(popup.pendingSound, false, '勿扰：照弹但不响');
  assert(await until(() => popup.win && popup.ready && popup.win.isVisible()), '勿扰下提醒的窗口建出来了');
  popup.onAction(popup.win.webContents, popup.queue.items[0].uid, 'close');
  assert(await until(() => popup.win === null, 4000), '收走后窗口关掉');

  // 再来一条：窗口重新建出来
  settings.popupDnd = false;
  settings.popupSeconds = 6;
  popup.show({ key: 'n', kind: 'notice', accId: 'us', text: '已退出登录，需要重新扫码。点这里打开这个号。' });
  assert(await until(() => popup.win && popup.ready && popup.win.isVisible()), '关掉后来新提醒：重新建窗口');
  assert.match(await page('document.querySelector(".nt .who").textContent'), /售后 US/, '号自己的提醒：标题是账号名');

  await checkDisplays();
  await checkHoverRelease();

  fs.writeSync(2, '通知弹窗自检通过\n'); // 写到 stderr：app.exit 会把还没刷出去的 stdout 丢掉
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });

// 拔掉、接上显示器，改缩放，任务栏挪位置：弹窗要回到该在的那块屏幕右上角。
// 用假的屏幕（两块并排放在 xvfb 的大屏里），主窗口位置也是假的
async function checkDisplays() {
  // 主窗口在哪块屏幕就放哪块；主窗口不在任何屏幕上（那块刚被拔掉、窗口藏在托盘里还记着旧位置）就放主屏
  const L = { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 640, height: 1024 }, workArea: { x: 0, y: 0, width: 640, height: 984 } };
  const R = { id: 2, scaleFactor: 2, bounds: { x: 640, y: 0, width: 640, height: 1024 }, workArea: { x: 640, y: 0, width: 640, height: 1024 } };
  assert.strictEqual(pickDisplay([L, R], L, { x: 700, y: 100, width: 500, height: 600 }), R, '主窗口在右边那块：放右边');
  assert.strictEqual(pickDisplay([L, R], L, { x: 400, y: 100, width: 500, height: 600 }), R, '跨两块：放占得多的那块');
  assert.strictEqual(pickDisplay([L], L, { x: 1900, y: 100, width: 500, height: 600 }), L, '主窗口在拔掉的屏幕上：放主屏');
  assert.strictEqual(pickDisplay([L, R], R, null), R, '没有主窗口：放主屏');
  assert.notStrictEqual(spotOn(L, 'win32').key, spotOn({ ...L, scaleFactor: 1.5 }, 'win32').key, '缩放变了要重建');
  assert.strictEqual(spotOn(L, 'win32').key, spotOn({ ...R, scaleFactor: 1 }, 'win32').key, '缩放一样的另一块屏幕：只挪不重建');

  // Windows 上跨缩放挪窗口第一次摆不对：读回来不对就再设一次
  const sets = [];
  const fakeWin = {
    b: null,
    wrongOnce: true, // 像 Windows 那样：从另一种缩放的屏幕挪过来，第一次大小按旧缩放换算错了
    setBounds(b) { sets.push(b); this.b = this.wrongOnce ? { ...b, width: b.width * 1.5, height: b.height * 1.5 } : { ...b }; this.wrongOnce = false; },
    getBounds() { return this.b; },
  };
  popup.place(fakeWin, spotOn(L, process.platform));
  assert.strictEqual(sets.length, 2, '第一次大小不对：再设一次');
  const sL = spotOn(L, process.platform);
  assert.deepStrictEqual(fakeWin.b, { x: sL.x, y: sL.y, width: WIN_W, height: WIN_H }, '再设一次后位置大小都对');
  sets.length = 0;
  popup.place(fakeWin, sL);
  assert.strictEqual(sets.length, 1, '摆对了就只设一次');

  class FakeScreen extends EventEmitter {
    constructor(displays) { super(); this.displays = displays; }
    getAllDisplays() { return this.displays; }
    getPrimaryDisplay() { return this.displays[0]; }
    getCursorScreenPoint() { return screen.getCursorScreenPoint(); }
  }
  const fake = new FakeScreen([L, R]);
  let mainBounds = { x: 700, y: 100, width: 500, height: 600 }; // WAswitch 主窗口在外接屏（右边）上
  const p = new PopupWindow({
    getWindow: () => ({ isDestroyed: () => false, getBounds: () => mainBounds }),
    account: (id) => ACC[id] || null,
    locked: () => false,
    settings: () => ({ popupSeconds: 0, popupSound: false, popupDnd: false }),
    onOpen: () => {},
    onLater: () => {},
    idleSeconds: () => 0,
  }, { idleCloseMs: 60 * 1000, screen: fake });
  popups.push(p);
  const at = (d) => { const s = spotOn(d, process.platform); return { x: s.x, y: s.y, width: WIN_W, height: WIN_H }; };
  const on = async (d) => {
    const w = p.win;
    return !!(w && !w.isDestroyed() && p.ready && w.isVisible()) && JSON.stringify(w.getBounds()) === JSON.stringify(at(d));
  };
  const shows = async (who) => (await p.win.webContents.executeJavaScript('document.querySelector(".nt .who") && document.querySelector(".nt .who").textContent')) === who;

  p.show({ key: 'm:de:Emma Schneider', kind: 'msg', accId: 'de', chat: 'Emma Schneider', text: 'Hallo! Ist der Liefertermin noch der 12.11.?', count: 1 });
  assert(await until(() => on(R)), `先弹在外接屏右上角 ${p.win && JSON.stringify(p.win.getBounds())}`);
  const w1 = p.win;

  // 拔掉外接屏：主窗口藏在托盘里，系统没挪它，还记着外接屏上的位置
  fake.displays = [L];
  fake.emit('display-removed', {}, R);
  assert(await until(() => p.win !== w1 && on(L), 3000), `拔掉后回到剩下那块屏幕的右上角 ${p.win && JSON.stringify(p.win.getBounds())}`);
  assert(w1.isDestroyed(), '旧窗口（按外接屏的缩放建的）换掉了');
  assert(await until(() => shows('Emma Schneider')), '卡片还在，内容照样显示');
  const w2 = p.win;

  // 接上外接屏：系统过一会儿才把主窗口挪回去，第二次检查时跟过去
  mainBounds = { x: 50, y: 100, width: 500, height: 600 }; // 拔掉时系统把主窗口挪到了笔记本屏上
  fake.displays = [L, R];
  fake.emit('display-added', {}, R);
  fake.emit('display-metrics-changed', {}, L, ['workArea']);
  await wait(800);
  assert.strictEqual(p.win, w2, '主窗口还在笔记本屏上：弹窗不动');
  assert(await on(L), '还在笔记本屏右上角');
  mainBounds = { x: 700, y: 100, width: 500, height: 600 };
  assert(await until(() => p.win !== w2 && on(R), 4000), `主窗口被挪回外接屏后，弹窗也回到外接屏右上角 ${p.win && JSON.stringify(p.win.getBounds())}`);
  assert(await until(() => shows('Emma Schneider')), '回去以后卡片照样显示');
  const w3 = p.win;

  // 同一块屏幕，任务栏挪到上边（工作区变了，缩放没变）：只挪位置，不重建
  const R2 = { ...R, workArea: { x: 640, y: 40, width: 640, height: 984 } };
  fake.displays = [L, R2];
  fake.emit('display-metrics-changed', {}, R2, ['workArea']);
  assert(await until(() => on(R2), 3000), `工作区变了：挪到新的右上角 ${JSON.stringify(p.win.getBounds())}`);
  assert.strictEqual(p.win, w3, '屏幕和缩放没变：不重建窗口');

  // 改了缩放：重建
  const R3 = { ...R2, scaleFactor: 1.5 };
  fake.displays = [L, R3];
  fake.emit('display-metrics-changed', {}, R3, ['scaleFactor']);
  assert(await until(() => p.win !== w3 && on(R3), 3000), '缩放变了：按新缩放重建窗口');
  const w4 = p.win;

  // 两块屏幕缩放一样时，主窗口被挪到另一块：弹窗只挪过去，不重建（卡片不会空一下再出现）
  const L2 = { ...L, scaleFactor: R3.scaleFactor };
  fake.displays = [L2, R3];
  mainBounds = { x: 50, y: 100, width: 500, height: 600 };
  fake.emit('display-metrics-changed', {}, L2, ['scaleFactor']);
  assert(await until(() => on(L2), 3000), `缩放一样：挪到另一块屏幕的右上角 ${JSON.stringify(p.win.getBounds())}`);
  assert.strictEqual(p.win, w4, '缩放一样：不重建窗口');

  // 卡片都收走了、窗口藏着时拔掉显示器：直接关掉，下次按新的屏幕建
  p.onAction(p.win.webContents, p.queue.items[0].uid, 'close');
  assert(await until(() => p.win && !p.win.isVisible(), 2000), '收走后窗口藏起来');
  fake.displays = [L];
  fake.emit('display-removed', {}, R3);
  assert(await until(() => p.win === null, 2000), '藏着的窗口在屏幕变了以后关掉');
  p.show({ key: 'm:us:James O’Connor', kind: 'msg', accId: 'us', chat: 'James O’Connor', text: 'Thanks!', count: 1 });
  assert(await until(() => on(L), 5000), '再来一条：建在剩下那块屏幕的右上角');
  p.onAction(p.win.webContents, p.queue.items[0].uid, 'close');
}

// 窗口不点穿时整块（连透明的地方）都挡点击。鼠标一离开卡片就要恢复点穿，不能等页面报“移开了”：
// 窗口被挪走、鼠标一下跳出去时页面收不到（Windows 上用真鼠标测出来，拔掉显示器后主窗口右上角要点两下才响应）。
// 这里用假的鼠标位置，页面不知道鼠标动了，只看主进程自己能不能发现
async function checkHoverRelease() {
  class CursorScreen extends EventEmitter {
    constructor() { super(); this.cursor = { x: 0, y: 0 }; }
    getAllDisplays() { return screen.getAllDisplays(); }
    getPrimaryDisplay() { return screen.getPrimaryDisplay(); }
    getCursorScreenPoint() { return this.cursor; }
  }
  const fake = new CursorScreen();
  const p = new PopupWindow({
    getWindow: () => null,
    account: (id) => ACC[id] || null,
    locked: () => false,
    settings: () => ({ popupSeconds: 0, popupSound: false, popupDnd: false }), // 不自动消失：倒计时不走，像离开电脑后回来时那样
    onOpen: () => {},
    onLater: () => {},
    idleSeconds: () => 0,
  }, { idleCloseMs: 60 * 1000, screen: fake });
  popups.push(p);
  p.show({ key: 'm:de:Emma Schneider', kind: 'msg', accId: 'de', chat: 'Emma Schneider', text: 'Hallo! Ist der Liefertermin noch der 12.11.?', count: 1 });
  p.show({ key: 'm:fr:Lucas Martin', kind: 'msg', accId: 'fr', chat: 'Lucas Martin', text: 'Bonjour, pouvez-vous m’envoyer le devis ?', count: 1 });
  const cardsDrawn = async () => !!(p.win && p.ready && p.win.isVisible() && p.cardRects && p.cardRects.length) &&
    (await p.win.webContents.executeJavaScript('document.querySelectorAll(".nt").length')) === p.queue.size;
  assert(await until(cardsDrawn), '弹窗显示出来，页面报了卡片位置');
  assert.strictEqual(p.ticker, null, '卡片不自动消失：倒计时没在走（悬停兜底不能靠它）');
  const w = p.win;
  let ignoring = true;
  const setIgnore = w.setIgnoreMouseEvents.bind(w);
  w.setIgnoreMouseEvents = (ig, o) => { ignoring = ig; return setIgnore(ig, o); };
  const cards = async () => (await p.win.webContents.executeJavaScript('[...document.querySelectorAll(".nt")].map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })'));
  const onCard = (r) => { const b = w.getBounds(); return { x: Math.round(b.x + r.x + r.width / 2), y: Math.round(b.y + r.y + r.height / 2) }; };
  const below = (r) => { const b = w.getBounds(); return { x: Math.round(b.x + r.x + r.width / 2), y: Math.round(b.y + r.y + r.height + 40) }; };
  const hover = () => { p.onHover(w.webContents, true); return !!p.queue.hoverSince && ignoring === false; };
  const released = () => !p.queue.hoverSince && ignoring === true;

  let [top, second] = await cards();
  fake.cursor = onCard(top);
  assert(hover(), '鼠标在卡片上：窗口接收点击');
  await wait(400);
  assert(!released(), '鼠标一直在卡片上：一直接收点击');

  // 鼠标跳到最下面那张卡片下方的透明处，页面没报“移开了”
  fake.cursor = below(second);
  assert(await until(released, 500), '鼠标到了透明处：0.5 秒内恢复点穿');
  let resets = 0;
  const send = p.send.bind(p);
  p.send = (st) => { if (st && st.resetHover) resets += 1; return send(st); };
  assert(!hover(), '鼠标在透明处时页面说“停在卡上”：不信');
  assert.strictEqual(ignoring, true, '还是点穿');
  assert.strictEqual(resets, 1, '不信时让页面也忘掉“停在卡上”，之后真停到卡上还会再报');
  p.send = send;

  // 鼠标停在卡片上时窗口被挪走（拔掉显示器时系统会挪它），鼠标没动
  fake.cursor = onCard(top);
  assert(hover(), '回到卡片上：接收点击');
  const b0 = w.getBounds();
  w.setPosition(b0.x - 400, b0.y + 300);
  assert(await until(released, 500), `窗口被挪走、鼠标留在原地：恢复点穿 ${JSON.stringify(w.getBounds())}`);
  p.render(); // 摆回右上角
  assert(await until(() => JSON.stringify(w.getBounds()) === JSON.stringify(b0), 1000), '摆回右上角');

  // 鼠标停在第二张卡上时这张被收走：底下变成透明处
  [top, second] = await cards();
  fake.cursor = onCard(second);
  assert(hover(), '在第二张卡上：接收点击');
  p.dropKey('m:de:Emma Schneider'); // 收走的是上面那张（最新的在上），第二张挪上去，鼠标底下空了
  assert(await until(async () => (await cards()).length === 1, 2000), '收走了一张');
  assert(await until(released, 500), '鼠标底下的卡片挪走了：恢复点穿');

  // 窗口不点穿时主进程每 0.1 秒核对一次；点穿以后就不再核对
  fake.cursor = onCard((await cards())[0]);
  assert(hover(), '接收点击');
  assert(p.hoverTimer, '不点穿期间在核对鼠标位置');
  p.onHover(w.webContents, false);
  assert(released() && !p.hoverTimer, '页面报“移开了”：恢复点穿，停止核对');

  p.onAction(w.webContents, p.queue.items[0].uid, 'close');
  assert(await until(() => !w.isVisible(), 2000), '收走后窗口藏起来');
}
