// 自检：勿扰的时长菜单（1 / 3 / 8 / 24 小时，到时间自动关）。
// 菜单栏图标（托盘）、Dock 图标、侧栏右键账号用的是同一个菜单项（src/dnd.js）。
// 运行：node scripts/check-dnd.js（不用 Electron，electron 模块用假的替掉）
const Module = require('module');

let lastTemplate = null;
const fakeElectron = {
  app: { setBadgeCount() {}, setAppUserModelId() {} },
  Tray: class { constructor() { this.menu = null; } setImage() {} setTitle() {} setToolTip() {} setContextMenu(m) { this.menu = m; } on() {} },
  Menu: { buildFromTemplate: (t) => { lastTemplate = t; return { template: t }; } },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {}, isEmpty: () => true }) },
  BrowserWindow: class {},
  screen: {},
  powerMonitor: { getSystemIdleTime: () => 0 },
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : load.call(this, req, ...rest); };

const { untilText, dndExpired, dndMenuItem, dndPatch, DND_HOURS } = require('../src/dnd');
const { Notifier } = require('../src/notify');
const { PopupWindow } = require('../src/popup');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const eq = (a, b, text) => check(a === b, `${text}（得到“${a}”）`);

const H = 60 * 60 * 1000;
const at = (d, h, m) => new Date(2026, 10, d, h, m).getTime(); // 2026-11-d 本机时间

// ---------- 时长和到期 ----------
check(DND_HOURS.join(',') === '1,3,8,24', '可选 1、3、8、24 小时');
const now = at(26, 17, 30);
let st = { popupDnd: false, popupDndUntil: 0, ...dndPatch(3, now) };
check(st.popupDnd === true && st.popupDndUntil === now + 3 * H, '选 3 小时：开勿扰，记下到期时间');
check(!dndExpired(st, now + 3 * H - 1) && dndExpired(st, now + 3 * H), '到点之前不算到期，到点就到期');
check(!dndExpired({ popupDnd: true, popupDndUntil: 0 }, now + 1000 * H), '设置里打开的勿扰（不限时）永不到期');
check(!dndExpired({ popupDnd: false, popupDndUntil: now - 1 }, now), '没开勿扰不算到期');
const off = dndPatch(0, now);
check(off.popupDnd === false && off.popupDndUntil === 0, '关闭勿扰：两个值都清掉');

// ---------- 菜单上的字 ----------
eq(untilText(at(26, 20, 5), now), '20:05', '今天到期：只写钟点');
eq(untilText(at(27, 9, 30), now), '明天 09:30', '明天到期：写「明天」');
eq(untilText(at(28, 9, 30), now), '11月28日 09:30', '更晚：写日期');
const picked = [];
const set = (h) => picked.push(h);
let item = dndMenuItem({ settings: { popupDnd: false, popupDndUntil: 0 }, now, set });
eq(item.label, '勿扰', '没开：叫「勿扰」');
check(item.submenu.map((x) => x.label).join(',') === '1 小时,3 小时,8 小时,24 小时', `没开：只有四个时长（${item.submenu.map((x) => x.label || '—').join(',')}）`);
item.submenu[2].click();
check(picked[0] === 8, '点「8 小时」：按 8 小时开');
item = dndMenuItem({ settings: { popupDnd: true, popupDndUntil: at(26, 20, 30) }, now, set });
eq(item.label, '勿扰到 20:30', '开着：写到几点');
const last = item.submenu[item.submenu.length - 1];
check(last.label === '关闭勿扰' && item.submenu[4].type === 'separator', '开着：最后是「关闭勿扰」');
last.click();
check(picked[1] === 0, '点「关闭勿扰」：关掉');
eq(dndMenuItem({ settings: { popupDnd: true, popupDndUntil: 0 }, now, set }).label, '勿扰中', '设置里打开的（不限时）：写「勿扰中」');
item = dndMenuItem({ settings: { popupDnd: true, popupDndUntil: now - 1 }, now, set });
check(item.label === '勿扰' && item.submenu.length === 4, '已经到期还没来得及关：菜单当成没开');
const all = JSON.stringify([dndMenuItem({ settings: { popupDnd: true, popupDndUntil: at(27, 9, 30) }, now, set })]);
check(!all.includes('·'), '菜单里没有中点');

// ---------- 弹窗：限时勿扰过了时间就照常弹 ----------
let clock = now;
const settings = { popupSeconds: 6, popupSound: true, popupLater: true, ...dndPatch(1, now) };
const pw = new PopupWindow({ getWindow: () => null, account: () => null, locked: () => false, settings: () => settings, onOpen() {}, onLater() {} }, { now: () => clock, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) } });
check(pw.dnd === true, '勿扰 1 小时内：弹窗算勿扰');
clock = now + H + 1;
check(pw.dnd === false, '过了 1 小时（主进程还没来得及关）：弹窗已经不算勿扰');

// ---------- 托盘菜单（Mac 顶部菜单栏图标）里有勿扰 ----------
const nst = { popupDnd: false, popupDndUntil: 0 };
const n = new Notifier({ getAccounts: () => [{ id: 'a1', name: 'Sales DE' }], getWindow: () => null, activate() {}, quit() {}, popup: null, dndMenu: () => dndMenuItem({ settings: nst, set }) });
n.init();
let dndItem = lastTemplate.find((x) => x && Array.isArray(x.submenu) && /^勿扰/.test(x.label));
check(!!dndItem && dndItem.label === '勿扰', '托盘菜单里有「勿扰」子菜单');
Object.assign(nst, dndPatch(24, Date.now()));
n.refresh();
dndItem = lastTemplate.find((x) => x && Array.isArray(x.submenu) && /^勿扰/.test(x.label));
check(/^勿扰到 明天 \d\d:\d\d$/.test(dndItem.label), `勿扰 24 小时：托盘菜单写到明天几点（${dndItem.label}）`);

console.log(failures ? `\n有 ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
