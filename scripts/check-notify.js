// 自检：新消息弹窗（不用系统通知）——挑哪些客户弹、写什么、什么时候不弹，以及弹窗队列的堆叠、合并、倒计时。
// 运行：node scripts/check-notify.js（不用 Electron，electron 模块用假的替掉）
const Module = require('module');

const fakeElectron = {
  app: { setBadgeCount() {}, setAppUserModelId() {} },
  Tray: class {},
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
  BrowserWindow: class {},
  screen: {},
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : load.call(this, req, ...rest); };

const { unreadNames, unreadBody, grownChats, cleanPreview } = require('../src/notify-text');
const { Notifier } = require('../src/notify');
const { PopupQueue } = require('../src/popup-queue');
const { initials, colorFor } = require('../src/popup');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const eq = (a, b, text) => check(a === b, `${text}（得到“${a}”）`);

// ---------- 读不到对话列表时的文案 ----------
eq(unreadBody(3, ['Emma Schneider', 'John Miller', 'Lucas Martin']), 'Emma Schneider、John Miller 等 3 个未读对话', '3 个未读、读到 3 个名字：写前两个 + 等 3 个');
eq(unreadBody(1, ['Emma Schneider']), 'Emma Schneider 发来新消息', '1 个未读');
eq(unreadBody(3, null), '有 3 个未读对话', '读不到（null）：有 N 个未读对话');
const names = unreadNames([{ name: 'Team Berlin', unread: 5, muted: true }, { name: '  Emma   Schneider ', unread: 1 }, { name: 'Anna Weber', unread: 0 }]);
check(names[0] === 'Emma Schneider' && names[1] === 'Team Berlin' && names.length === 2, `名字：没静音的在前、空格整理、没未读的不写（${names.join(' / ')}）`);

// ---------- 哪些客户要弹 ----------
const list1 = [
  { name: 'Emma Schneider', unread: 2, preview: 'Hallo!  Ist der\nLiefertermin noch der 12.11.?' },
  { name: 'John Miller', unread: 1, preview: 'Thanks!' },
  { name: 'Anna Weber', unread: 0, preview: 'ok' },
];
let g = grownChats(null, list1, 1);
check(g.fresh.length === 1 && g.fresh[0].name === 'Emma Schneider', '没记过：只弹列表最上面的（未读对话数涨了几个就弹几个）');
eq(g.fresh[0].preview, 'Hallo! Ist der Liefertermin noch der 12.11.?', '预览：空白和换行整理成一行');
check(g.seen.get('Emma Schneider') === 2 && g.seen.get('John Miller') === 1 && !g.seen.has('Anna Weber'), '记下每个客户弹过几条');
let g2 = grownChats(g.seen, [{ name: 'Emma Schneider', unread: 3, preview: 'Und noch eine Frage' }, { name: 'John Miller', unread: 1 }], 1);
check(g2.fresh.length === 1 && g2.fresh[0].name === 'Emma Schneider' && g2.fresh[0].unread === 3, '同一个客户又发一条（3 条）：只弹她');
g2 = grownChats(g2.seen, [{ name: 'Emma Schneider', unread: 3 }, { name: 'John Miller', unread: 1 }], 1);
check(g2.fresh.length === 0, '没有变化：不弹');
const g3 = grownChats(new Map(), [{ name: 'Team Berlin', unread: 4, muted: true }, { name: 'Lucas Martin', unread: 1 }], 1);
check(g3.fresh.length === 1 && g3.fresh[0].name === 'Lucas Martin', 'WhatsApp 里静音的群：有别的客户时不单独弹');
const g4 = grownChats(null, [{ jid: '491701234567@s.whatsapp.net', name: 'Emma', unread: 1, preview: 'Hi' }], 1);
check(g4.fresh[0].key === '491701234567@s.whatsapp.net' && g4.fresh[0].jid, '轻量号按 jid 区分客户，点打开能直接开这个对话');
check(cleanPreview('x'.repeat(300)).length === 161, '预览最多 160 字');
check(grownChats(null, undefined).fresh.length === 0, '列表不对时返回空，不出错');
eq(initials('Emma Schneider'), 'ES', '头像：名字首字母');
eq(initials('李华'), '李', '头像：中文名写第一个字');
check(colorFor('Emma Schneider') === colorFor('Emma Schneider'), '头像颜色按名字固定');

// ---------- Notifier：弹什么、什么时候不弹 ----------
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function fakePopup() {
  return {
    cards: [], dropped: [], dnd: false,
    show(c) { if (this.dnd) return false; this.cards.push(c); return true; },
    dropAccount(id, keep) { this.dropped.push({ id, keep: !!keep }); },
  };
}
const acc = { id: 'a1', name: '销售 DE' };
const acc2 = { id: 'a2', name: '售后 US' };
function make(readChats, { win = null, laterMs } = {}) {
  const popup = fakePopup();
  const logs = [];
  const n = new Notifier({ getAccounts: () => [acc, acc2], getWindow: () => win, activate() {}, quit() {}, readChats, popup, onNew: (e) => logs.push(e) }, { laterMs });
  n.refresh = () => {};
  return { n, popup, logs };
}

(async () => {
  let { n, popup, logs } = make(async () => list1);
  n.update(acc, 1, { isActive: false });
  await tick(10);
  check(popup.cards.length === 1 && popup.cards[0].chat === 'Emma Schneider' && popup.cards[0].text.startsWith('Hallo!'), `新消息：一张客户卡，写名字和最后一条（${popup.cards[0] && popup.cards[0].text}）`);
  check(popup.cards[0].accId === 'a1' && popup.cards[0].count === 2 && popup.cards[0].key === 'm:a1:Emma Schneider', '卡片带上是哪个号、几条，按客户合并');
  check(logs.length === 1 && logs[0].popped === true, '通知记录照常记一条');

  // 同一个客户又发一条：未读对话数没变，定时看一眼列表时弹，key 一样（弹窗里合并成一张）
  let current = [{ name: 'Emma Schneider', unread: 3, preview: 'Und noch eine Frage: gibt es das Modell auch in Anthrazit?' }, { name: 'John Miller', unread: 1 }];
  ({ n, popup } = make(async () => current));
  n.update(acc, 2, { isActive: false });
  await tick(10);
  popup.cards.length = 0;
  current = [{ name: 'Emma Schneider', unread: 4, preview: 'Hallo?' }, { name: 'John Miller', unread: 1 }];
  n.recheck(acc, { isActive: false });
  await tick(10);
  check(popup.cards.length === 1 && popup.cards[0].key === 'm:a1:Emma Schneider' && popup.cards[0].count === 4, '同一个客户又发：同一个 key、4 条');

  // 第一次定时看：只记下来，不弹以前的未读
  ({ n, popup } = make(async () => list1));
  n.unread.set('a1', 2);
  n.recheck(acc, { isActive: false });
  await tick(10);
  check(popup.cards.length === 0, '第一次定时看列表：只记下，不把以前的未读弹出来');

  // 读不到列表：一张号的卡
  ({ n, popup } = make(async () => null));
  n.update(acc, 2, { isActive: false });
  await tick(10);
  check(popup.cards.length === 1 && popup.cards[0].text === '有 2 个未读对话' && popup.cards[0].chat === '', '读不到列表（聊天锁着、页面在加载）：号的卡写“有 2 个未读对话”');

  ({ n, popup } = make(async () => { throw new Error('页面没了'); }));
  n.update(acc, 1, { isActive: false });
  await tick(10);
  check(popup.cards.length === 1 && popup.cards[0].text === '有 1 个未读对话', '读列表出错：照样弹号的卡');

  ({ n, popup } = make(() => new Promise(() => {})));
  n.update(acc, 2, { isActive: false });
  await tick(2200);
  check(popup.cards.length === 1 && popup.cards[0].text === '有 2 个未读对话', '读列表一直不返回：2 秒后弹号的卡');

  // 读的期间又来新消息：只用最新的
  let calls = 0;
  ({ n, popup } = make(async () => { calls += 1; await tick(50); return calls === 1 ? [{ name: 'Emma Schneider', unread: 1 }] : [{ name: 'John Miller', unread: 1 }, { name: 'Emma Schneider', unread: 1 }]; }));
  n.update(acc, 1, { isActive: false });
  await tick(5);
  n.update(acc, 2, { isActive: false });
  await tick(120);
  check(popup.cards.length === 1 && popup.cards[0].chat === 'John Miller', `连着来两条只按最新的列表弹（弹了 ${popup.cards.length} 张）`);

  // 读的期间已经看过（未读清零）：不弹，并收起这个号的卡
  ({ n, popup } = make(async () => { await tick(30); return [{ name: 'Emma Schneider', unread: 1 }]; }));
  n.update(acc, 1, { isActive: false });
  n.update(acc, 0, { isActive: false });
  await tick(60);
  check(popup.cards.length === 0 && popup.dropped.some((d) => d.id === 'a1'), '未读清零：不弹，这个号的卡收起');

  // 静音的号：不读列表也不弹
  let asked = 0;
  ({ n, popup, logs } = make(async () => { asked += 1; return list1; }));
  n.update({ ...acc, muted: true }, 2, { isActive: false });
  await tick(10);
  check(popup.cards.length === 0 && asked === 0 && logs[0].popped === false, '关了通知的号：不读、不弹，记录写“没弹”');

  // 正看着这个号（WAswitch 在前台、开着这个号）：不弹；看着别的号时，这个号的消息照弹
  const focusedWin = { isVisible: () => true, isFocused: () => true };
  ({ n, popup } = make(async () => list1, { win: focusedWin }));
  n.update(acc, 1, { isActive: true });
  await tick(10);
  check(popup.cards.length === 0, 'WAswitch 在前台、正开着这个号：不弹');
  n.update(acc2, 1, { isActive: false });
  await tick(10);
  check(popup.cards.length === 1 && popup.cards[0].accId === 'a2', 'WAswitch 在前台、消息是别的号的：照弹');
  const bgWin = { isVisible: () => true, isFocused: () => false };
  ({ n, popup } = make(async () => list1, { win: bgWin }));
  n.update(acc, 1, { isActive: true });
  await tick(10);
  check(popup.cards.length === 1, 'WAswitch 在后台（开着这个号但没在前台）：照弹');

  // 勿扰
  ({ n, popup, logs } = make(async () => list1));
  popup.dnd = true;
  n.update(acc, 1, { isActive: false });
  await tick(10);
  check(popup.cards.length === 0 && logs[0].popped === false, '勿扰：不弹，记录写“没弹”');

  // 稍后：10 分钟后（这里用 30 毫秒）还没读再弹一次；读了就不弹
  current = [{ name: 'Emma Schneider', unread: 1, preview: 'Hallo' }];
  ({ n, popup } = make(async () => current, { laterMs: 30 }));
  n.update(acc, 1, { isActive: false });
  await tick(10);
  const first = popup.cards[0];
  popup.cards.length = 0;
  n.later(first);
  await tick(60);
  check(popup.cards.length === 1 && popup.cards[0].again === true && popup.cards[0].chat === 'Emma Schneider', '稍后：到时间还没读，再弹一次，标“稍后提醒”');
  popup.cards.length = 0;
  n.later(first);
  current = [{ name: 'Emma Schneider', unread: 0 }, { name: 'John Miller', unread: 1 }];
  await tick(60);
  check(popup.cards.length === 0, '稍后：到时间这个客户已经读了，不再弹');
  popup.cards.length = 0;
  n.later(first);
  n.update(acc, 0, { isActive: false });
  await tick(60);
  check(popup.cards.length === 0, '稍后：期间号的未读清零，不再弹');

  // 号自己的提醒和软件提醒也走弹窗
  ({ n, popup } = make(async () => null));
  n.notify(acc, '已退出登录，需要重新扫码。点这里打开这个号。');
  n.notifyApp('跟进提醒', 'Emma Schneider', () => {}, { sensitive: true });
  check(popup.cards.length === 2 && popup.cards[0].kind === 'notice' && popup.cards[1].kind === 'app' && popup.cards[1].sensitive, '退出登录、跟进提醒等也走自带弹窗（跟进提醒带客户名，锁着时遮住）');

  // 正看着这个号：不弹，但记下每个客户的未读；切走后定时看列表，不会把早看过的弹出来
  current = [{ name: 'Emma Schneider', unread: 2, preview: 'Hallo' }, { name: 'John Miller', unread: 1 }];
  ({ n, popup } = make(async () => current, { win: focusedWin }));
  n.update(acc, 2, { isActive: true });
  await tick(10);
  check(popup.cards.length === 0 && n.seen.get('a1') && n.seen.get('a1').get('Emma Schneider') === 2, '正看着这个号：不弹，但记下 Emma 已有 2 条');
  n.recheck(acc, { isActive: false });
  await tick(10);
  check(popup.cards.length === 0, '切走后定时看列表：没新消息就不把看过的弹出来');
  current = [{ name: 'Emma Schneider', unread: 3, preview: 'Noch was' }, { name: 'John Miller', unread: 1 }];
  n.recheck(acc, { isActive: false });
  await tick(10);
  check(popup.cards.length === 1 && popup.cards[0].count === 3, '切走后 Emma 真的又发一条：弹');

  // 定时看列表弹出来的也记进通知记录
  ({ n, popup, logs } = make(async () => current));
  n.update(acc, 2, { isActive: false });
  await tick(10);
  current = [{ name: 'Emma Schneider', unread: 4, preview: 'Hallo?' }, { name: 'John Miller', unread: 1 }];
  n.recheck(acc, { isActive: false });
  await tick(10);
  check(logs.length === 2 && logs[1].popped === true, '定时看列表弹的也记一条通知记录');

  // 先读不到列表弹了号的卡，后来读到客户：号的卡收掉
  let readable = null;
  ({ n, popup } = make(async () => readable));
  popup.droppedKeys = [];
  popup.dropKey = (k) => popup.droppedKeys.push(k);
  n.update(acc, 1, { isActive: false });
  await tick(10);
  check(popup.cards.length === 1 && popup.cards[0].key === 'm:a1:*', '读不到：先弹号的卡');
  readable = [{ name: 'Emma Schneider', unread: 1, preview: 'Hi' }];
  n.update(acc, 2, { isActive: false });
  await tick(10);
  check(popup.droppedKeys.includes('m:a1:*') && popup.cards[1].chat === 'Emma Schneider', '读到客户后把“有 N 个未读对话”那张收掉');

  // 稍后：列表读不到（锁着、页面在加载）就不确定读没读，不弹；用现在的预览而不是旧的；正看着不弹
  current = [{ name: 'Emma Schneider', unread: 2, preview: 'Neu' }];
  ({ n, popup } = make(async () => current, { laterMs: 30 }));
  n.update(acc, 1, { isActive: false });
  await tick(10);
  const laterCard = popup.cards[0];
  popup.cards.length = 0;
  n.later(laterCard);
  await tick(60);
  check(popup.cards.length === 1 && popup.cards[0].text === 'Neu' && popup.cards[0].count === 2 && popup.cards[0].again, `稍后：用现在列表里的预览和条数（${popup.cards[0] && popup.cards[0].text}）`);
  popup.cards.length = 0;
  current = null;
  n.later(laterCard);
  await tick(60);
  check(popup.cards.length === 0, '稍后：到时间列表读不到（锁着/加载中）：不弹旧内容');
  current = [{ name: 'Emma Schneider', unread: 2, preview: 'Neu' }];
  ({ n, popup } = make(async () => current, { laterMs: 30, win: focusedWin }));
  n.hooks.isActive = () => true;
  n.update(acc, 1, { isActive: false });
  await tick(10);
  popup.cards.length = 0;
  n.later(laterCard);
  await tick(60);
  check(popup.cards.length === 0, '稍后：到时间正看着这个号：不弹');
  // 号的卡的稍后：这个号还有未读就弹，写现在的未读数
  ({ n, popup } = make(async () => null, { laterMs: 30 }));
  n.update(acc, 3, { isActive: false });
  await tick(10);
  const accCard = popup.cards[0];
  popup.cards.length = 0;
  n.later(accCard);
  n.update(acc, 2, { isActive: false });
  await tick(60);
  check(popup.cards.length === 1 && popup.cards[0].text === '有 2 个未读对话', '稍后（号的卡）：写现在的未读数');

  // ---------- 同一条消息只弹一次（按 号 + 客户 + 这条消息 去重） ----------
  // 置顶的老客户 Emma 弹过；读掉 John 后（记下的条数清掉）新客户 Lucas 来了：只弹 Lucas，不把 Emma 那条再弹一遍
  current = [{ name: 'Emma Schneider', unread: 2, preview: 'Liefertermin?' }];
  ({ n, popup } = make(async () => current));
  n.update(acc, 1, { isActive: false });
  await tick(10);
  current = [{ name: 'Emma Schneider', unread: 2, preview: 'Liefertermin?' }, { name: 'John Miller', unread: 1, preview: 'Thanks' }];
  n.update(acc, 2, { isActive: false });
  await tick(10);
  check(popup.cards.length === 2 && popup.cards[1].chat === 'John Miller', '先弹 Emma，再弹 John');
  current = [{ name: 'Emma Schneider', unread: 2, preview: 'Liefertermin?' }, { name: 'John Miller', unread: 0, preview: 'Thanks' }];
  n.update(acc, 1, { isActive: false });
  await tick(10);
  current = [{ name: 'Emma Schneider', unread: 2, preview: 'Liefertermin?' }, { name: 'Lucas Martin', unread: 1, preview: 'Bonjour' }];
  popup.cards.length = 0;
  n.update(acc, 2, { isActive: false });
  await tick(10);
  check(popup.cards.length === 1 && popup.cards[0].chat === 'Lucas Martin', `读掉一个对话后来了新客户：只弹新客户，置顶的 Emma 不再弹（弹了 ${popup.cards.map((c) => c.chat).join('、')}）`);

  // 标题里的数字掉到 0 又回来（页面重连、刷新）：弹过的不再弹，也不补“有 N 个未读对话”
  popup.cards.length = 0;
  popup.dropped.length = 0;
  n.update(acc, 0, { isActive: false });
  await tick(10);
  n.update(acc, 2, { isActive: false });
  await tick(10);
  check(popup.cards.length === 0, `数字掉了又回来：弹过的两条都不再弹（弹了 ${popup.cards.length} 张）`);
  // 数字掉的那一刻列表里两个客户还显示有未读：不算读过，记录不清掉
  check(n.popped.get('a1') && n.popped.get('a1').has('Emma Schneider') && n.popped.get('a1').has('Lucas Martin'), '弹过的记录还在');

  // 软件重启：记录从磁盘读回来；轻量号也按上次的未读数当原数，涨回原数不弹
  let saved = null;
  const mk2 = (readChats) => {
    const p2 = fakePopup();
    const n2 = new Notifier({ getAccounts: () => [acc, acc2], getWindow: () => null, activate() {}, quit() {}, readChats, popup: p2, loadPopped: () => saved, savePopped: (d) => { saved = JSON.parse(JSON.stringify(d)); } });
    n2.refresh = () => {};
    return { n: n2, popup: p2 };
  };
  current = [{ jid: '491701234567@s.whatsapp.net', name: 'Emma', unread: 1, ts: 1700000000, preview: 'Hallo' }, { jid: '15551234567@s.whatsapp.net', name: 'John', unread: 1, ts: 1700000100, preview: 'Hi' }];
  ({ n, popup } = mk2(async () => current));
  n.update(acc2, 2, { isActive: false });
  await tick(10);
  check(popup.cards.length === 2 && saved && saved.a2 && Object.keys(saved.a2).length === 2, '两个新客户弹两张，记录写进磁盘（只存指纹）');
  check(!JSON.stringify(saved).includes('Hallo') && !JSON.stringify(saved).includes('Hi"'), '磁盘上的记录不含消息内容');
  ({ n, popup } = mk2(async () => current));
  n.update(acc2, 2, { isActive: false, baseline: 2 });
  await tick(10);
  check(popup.cards.length === 0, '重启后未读数涨回原数：不弹');
  ({ n, popup } = mk2(async () => current));
  n.update(acc2, 2, { isActive: false });
  await tick(10);
  check(popup.cards.length === 0, '重启后就算没有原数，弹过的那条也不再弹，不补号的卡');
  current = [{ jid: '4930123456@s.whatsapp.net', name: 'Anna', unread: 1, ts: 1700000200, preview: 'Guten Tag' }, ...current];
  n.update(acc2, 3, { isActive: false });
  await tick(10);
  check(popup.cards.length === 1 && popup.cards[0].chat === 'Anna', '重启后来了新客户：照弹');

  // 读掉以后客户又发一句一样的话（比如“ok”）：照弹
  current = [{ name: 'Emma Schneider', unread: 1, preview: 'ok' }];
  ({ n, popup } = make(async () => current));
  n.update(acc, 1, { isActive: false });
  await tick(10);
  current = [{ name: 'Emma Schneider', unread: 0, preview: 'ok' }];
  n.update(acc, 0, { isActive: false });
  await tick(10);
  current = [{ name: 'Emma Schneider', unread: 1, preview: 'ok' }];
  popup.cards.length = 0;
  n.update(acc, 1, { isActive: false });
  await tick(10);
  check(popup.cards.length === 1 && popup.cards[0].chat === 'Emma Schneider', '读掉后她又发了一样的“ok”：照弹');
  // 轻量号：带时间，读掉那一下没看到也能分出是新的一条
  current = [{ jid: '491701234567@s.whatsapp.net', name: 'Emma', unread: 1, ts: 100, preview: 'ok' }];
  ({ n, popup } = make(async () => current));
  n.update(acc2, 1, { isActive: false });
  await tick(10);
  current = []; // 轻量号推来的列表只有未读的，读掉后是空的
  n.update(acc2, 0, { isActive: false });
  await tick(10);
  current = [{ jid: '491701234567@s.whatsapp.net', name: 'Emma', unread: 1, ts: 200, preview: 'ok' }];
  popup.cards.length = 0;
  n.update(acc2, 1, { isActive: false });
  await tick(10);
  check(popup.cards.length === 1, '轻量号：同样的话、时间不同，算新的一条，照弹');

  // 勿扰期间同一个客户又发了几条：不弹；关掉勿扰后定时看列表也不补弹这些
  current = [{ name: 'Emma Schneider', unread: 1, preview: 'Hallo' }];
  ({ n, popup } = make(async () => current));
  n.update(acc, 1, { isActive: false });
  await tick(10);
  popup.dnd = true;
  current = [{ name: 'Emma Schneider', unread: 3, preview: 'Hallo???' }];
  n.recheck(acc, { isActive: false });
  await tick(10);
  popup.dnd = false;
  popup.cards.length = 0;
  n.recheck(acc, { isActive: false });
  await tick(10);
  check(popup.cards.length === 0, '勿扰期间来的：关掉勿扰后不补弹');
  current = [{ name: 'Emma Schneider', unread: 4, preview: 'Neu' }];
  n.recheck(acc, { isActive: false });
  await tick(10);
  check(popup.cards.length === 1 && popup.cards[0].count === 4, '关掉勿扰后真的又来一条：弹');
  // 正看着这个号时同一个客户又发：切走后不补弹
  ({ n, popup } = make(async () => current, { win: focusedWin }));
  n.update(acc, 1, { isActive: false });
  await tick(10);
  current = [{ name: 'Emma Schneider', unread: 6, preview: 'Noch eine' }];
  n.recheck(acc, { isActive: true });
  await tick(10);
  popup.cards.length = 0;
  n.recheck(acc, { isActive: false });
  await tick(10);
  check(popup.cards.length === 0, '正看着这个号时她又发的：切走后不补弹');

  // 删号：记录一起删
  n.forget('a1');
  check(!n.popped.has('a1'), '删号后弹过的记录一起删掉');

  // ---------- 弹窗队列 ----------
  let now = 1000;
  const q = new PopupQueue({ now: () => now, durationMs: 6000 });
  for (const who of ['Emma', 'Olivia', 'Lucas', 'Sofía', 'James']) q.push({ key: who });
  let v = q.view();
  check(v.shown.length === 3 && v.more === 2 && v.shown[0].key === 'James', '最多摆 3 张，最新的在最上面，其余“还有 2 条”');
  now += 2000;
  q.advance(2000);
  q.push({ key: 'Lucas', count: 2 });
  v = q.view();
  check(q.size === 5 && v.shown[0].key === 'Lucas' && v.shown[0].merged, '同一个客户再来：合并成一张，移到最上面');
  check(q.advance(3999) === 0, '6 秒内不收');
  q.setHover(true);
  check(q.advance(10000) === 0 && q.size === 5, '鼠标停在上面：不扣时间、不收');
  q.setHover(false);
  check(q.size === 5 && q.view().shown.every((x) => x.leftMs >= 1500), '移开后至少再留 1.5 秒，不会一下全收走');
  q.advance(1600);
  check(q.size === 3 && q.items[0].key === 'Lucas', `时间到的收走，后面补上来的两张（Olivia、Emma）还没开始倒计时（剩 ${q.size} 张）`);
  check(q.view().shown.slice(1).every((x) => x.leftMs === 6000), '藏在“还有 N 条”后面的那两张没被扣时间，露出来后从头算 6 秒');
  q.advance(6000);
  check(q.size === 0, '最后几张也到时间收走');
  q.setDuration(0);
  q.push({ key: 'Emma' });
  q.advance(3600 * 1000);
  check(q.size === 1 && !q.hasExpiring, '“不自动消失”：一直留着');
  q.setDuration(0);
  check(q.items[0].leftMs === Infinity, '时长没变时 setDuration 不动已有的卡');
  q.setDuration(4000);
  check(q.items[0].leftMs === 4000, '时长变了：按新时长从头算');
  check(q.remove(q.items[0].uid) && q.size === 0, '点了打开/稍后/关闭：收走这一张');

  console.log(failures ? `\n有 ${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})();
