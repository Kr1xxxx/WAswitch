// 自检：切换网络 / 重连之后，弹过的消息不再弹（网页号 + 轻量号）。
// 模拟软件在切网后做的事（main.js 的 onNetworkChange、网页号刷新/重试、轻量号重连），
// 每一步都按 main.js 的写法调 Notifier；轻量号的未读用真的 ChatStore，按 Baileys 的事件顺序喂消息。
// 运行：node scripts/check-notify-reconnect.js（不用 Electron，electron 模块用假的替掉）
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const fakeElectron = {
  app: { setBadgeCount() {}, setAppUserModelId() {} },
  Tray: class {},
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : load.call(this, req, ...rest); };

// 时间往前拨（切网通常发生在弹完几分钟之后；15 秒内刚弹过就不补号的卡，测试里要跳过这段）
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const advance = (ms) => { skew += ms; };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const MIN = 60 * 1000;

const { Notifier } = require('../src/notify');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };

function fakePopup() {
  return {
    cards: [],
    dnd: false,
    show(c) { this.cards.push(c); return true; },
    dropAccount() {},
    dropKey() {},
  };
}
const desc = (cards) => cards.map((c) => c.chat || c.text).join(' / ') || '没弹';

// 磁盘上的“弹过的记录”（notify-popped.json），软件重启后还在
function makeDisk() {
  let saved = null;
  return { load: () => (saved ? JSON.parse(saved) : null), save: (d) => { saved = JSON.stringify(d); } };
}

function makeNotifier(acc, readChats, disk = makeDisk()) {
  const popup = fakePopup();
  const n = new Notifier({
    getAccounts: () => [acc],
    getWindow: () => null,
    activate() {},
    quit() {},
    readChats: async () => readChats(),
    popup,
    loadPopped: disk.load,
    savePopped: disk.save,
  });
  n.refresh = () => {};
  return { n, popup, disk };
}

// ---------- 网页号：对话列表在页面里，未读数在标题里 ----------
// 照搬 main.js createView 里标题 / 加载的处理（baseline、quietUntil），和 onNetworkChange 里对每个号做的事
class WebAccount {
  constructor(disk) {
    this.acc = { id: 'web1', name: '销售 DE' };
    this.chats = [];
    this.readable = true; // 列表读得出来（页面在加载、聊天锁着时读不出）
    this.badges = true; // 列表里的未读角标在（重连时会跟标题一起清零）
    this.saved = 0; // unread-last.json
    this.quietUntil = 0;
    this.baseline = 0;
    const r = makeNotifier(this.acc, () => this.list(), disk);
    this.n = r.n;
    this.popup = r.popup;
  }

  list() {
    if (!this.readable) return null;
    return this.chats.map((c) => ({ ...c, unread: this.badges ? c.unread : 0 }));
  }

  count() { return this.chats.filter((c) => c.unread > 0).length; }

  // page-title-updated
  title(count = this.count()) {
    const restoring = Date.now() < this.quietUntil;
    this.n.update(this.acc, count, { isActive: false, baseline: restoring ? this.baseline : 0 });
    if (restoring && count > 0) this.quietUntil = 0;
    if (!restoring || count > 0) this.saved = count;
  }

  // did-start-loading（刷新、重试、软件刚打开）
  startLoading() {
    if (Date.now() >= this.quietUntil) this.baseline = this.n.unread.has(this.acc.id) ? this.n.unread.get(this.acc.id) : this.saved;
    this.quietUntil = Date.now() + 2 * MIN;
    if (this.n.hold) this.n.hold(this.acc.id, this.baseline);
  }

  // did-fail-load（线路不通）：页面变成错误页，标题里没有数字
  failLoad() {
    this.title(0);
    if (this.n.hold) this.n.hold(this.acc.id);
  }

  // onNetworkChange
  networkChange() { if (this.n.hold) this.n.hold(this.acc.id); }

  // 定时看一眼列表（recheckUnread，每 10 秒）
  poll() { this.n.recheck(this.acc, { isActive: false }); }

  receive(name, preview, time) {
    const c = this.chats.find((x) => x.name === name);
    if (c) { c.unread += 1; c.preview = preview; c.time = time; this.chats = [c, ...this.chats.filter((x) => x !== c)]; } else this.chats.unshift({ name, unread: 1, preview, time });
  }

  read(name) { const c = this.chats.find((x) => x.name === name); if (c) c.unread = 0; }
}

async function webWithThree(disk) {
  const w = new WebAccount(disk);
  w.receive('Lucas Martin', 'Can you send the invoice?', '09:55'); w.title(); await tick(5);
  w.receive('John Miller', 'Thanks!', '10:28'); w.title(); await tick(5);
  w.receive('Emma Schneider', 'Hallo! Ist der Liefertermin noch der 12.11.?', '10:31'); w.title(); await tick(5);
  w.receive('Emma Schneider', 'Und noch eine Frage', '10:32'); w.poll(); await tick(5);
  const first = desc(w.popup.cards);
  w.popup.cards = [];
  advance(5 * MIN);
  w.poll(); await tick(5); // 平时每 10 秒看一眼
  return { w, first };
}

// ---------- 轻量号：真的 ChatStore，按 Baileys 的顺序喂事件 ----------
// 照搬 session.mjs emitNow（推给主进程的 unread）和 main.js 里 liteHost.on('unread') 的处理
class LiteAccount {
  constructor(ChatStore, dir, key, disk) {
    this.acc = { id: 'lite1', name: '售后 US' };
    this.ChatStore = ChatStore;
    this.dir = dir;
    this.key = key;
    this.store = new ChatStore(dir, key, () => {});
    this.saved = 0;
    this.pushed = null; // liteUnreadChats
    this.lastSig = null;
    this.status = 'open';
    const r = makeNotifier(this.acc, () => (this.status === 'open' ? this.pushed : null), disk);
    this.n = r.n;
    this.popup = r.popup;
    this.msgId = 0;
    this.ts = 1793000000;
  }

  // Session.emitNow：未读对话数或某个对话的未读条数变了才推
  emit() {
    const unread = this.store.unreadChats();
    const chats = this.store.summary().filter((c) => c.unread > 0).slice(0, 5)
      .map((c) => ({ jid: c.jid, name: c.name, unread: c.unread, ts: c.ts, preview: String(c.preview || '').slice(0, 160) }));
    const sig = `${unread}|${chats.map((c) => `${c.jid}:${c.unread}`).join(',')}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    // main.js：liteHost.on('unread')
    this.pushed = chats;
    const grew = unread > (this.n.unread.get(this.acc.id) || 0);
    const baseline = this.n.unread.has(this.acc.id) ? 0 : this.saved;
    this.n.update(this.acc, unread, { isActive: false, baseline });
    this.saved = unread;
    if (!grew) this.n.recheck(this.acc, { isActive: false });
  }

  // main.js：liteHost.on('state')
  state(status) {
    this.status = status;
    if (['connecting', 'reconnecting', 'proxyDown', 'unreachable', 'crashed'].includes(status) && this.n.hold) this.n.hold(this.acc.id);
  }

  networkChange() { if (this.n.hold) this.n.hold(this.acc.id); }

  // 一条消息：Baileys 先发 chats.update（unreadCount 是这一批新增的条数），再发 messages.upsert
  // type：在线时 notify；断线期间收到、重连后补发的是 append
  message(jid, name, text, { type = 'notify', id = null, ts = null } = {}) {
    const mid = id || `M${(this.msgId += 1)}`;
    const t = ts || (this.ts += 60);
    this.store.updateChat({ id: jid, unreadCount: 1, conversationTimestamp: t });
    this.store.addMessage({ key: { remoteJid: jid, id: mid, fromMe: false }, message: { conversation: text }, messageTimestamp: t, pushName: name }, { countUnread: type === 'notify' });
    return mid;
  }

  // 后台进程重启这个号（切网后 startLite）：新的 Session 从磁盘读聊天缓存，上次推送的记录清空
  restartSession() {
    this.store.save.flush();
    this.store = new this.ChatStore(this.dir, this.key, () => {});
    this.lastSig = null;
  }
}

(async () => {
  const { ChatStore } = await import('../src/lite/store.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reconnect-'));

  // ======== 网页号 ========
  {
    const { w, first } = await webWithThree();
    check(first === 'Lucas Martin / John Miller / Emma Schneider / Emma Schneider', `网页号：先正常弹三个客户（${first}）`);

    // W1：切网，标题掉到 0 又回来，列表角标一直在
    w.networkChange();
    w.title(0); await tick(5);
    w.title(); await tick(5);
    check(w.popup.cards.length === 0, `网页号切网：标题掉到 0 又回到 3，同样三条不再弹（${desc(w.popup.cards)}）`);
  }
  for (const sw of [true, false]) {
    // W2：切网，重连时列表里的角标跟标题一起清零，回来后还是那三条
    // sw=false：换 Clash 节点这类软件看不出来的切换，WhatsApp 网页自己断线重连
    const { w } = await webWithThree();
    if (sw) w.networkChange();
    w.badges = false;
    w.title(0); await tick(5);
    advance(20 * 1000);
    w.badges = true;
    w.title(); await tick(5);
    w.poll(); await tick(5);
    check(w.popup.cards.length === 0, `网页号${sw ? '切网' : '自己断线重连'}：角标跟着清零再回来，不再弹（${desc(w.popup.cards)}）`);
  }
  for (const sw of [true, false]) {
    // W3：切网，标题回来时列表还读不出（页面还没排好、聊天锁着）
    const { w } = await webWithThree();
    if (sw) w.networkChange();
    w.title(0); await tick(5);
    advance(15 * 1000);
    w.readable = false;
    w.title(); await tick(5);
    check(w.popup.cards.length === 0, `网页号${sw ? '切网' : '自己断线重连'}：回来时列表读不出，也不补“有 3 个未读对话”（${desc(w.popup.cards)}）`);
  }
  {
    // W3b：只有 1 个未读对话时切网，角标清零、回来时列表读不出
    const w = new WebAccount();
    w.receive('Emma Schneider', 'Hallo!', '10:31'); w.title(); await tick(5);
    w.popup.cards = [];
    advance(5 * MIN); w.poll(); await tick(5);
    w.networkChange();
    w.badges = false; w.title(0); await tick(5);
    advance(10 * 1000);
    w.badges = true; w.readable = false; w.title(); await tick(5);
    w.readable = true; advance(10 * 1000); w.poll(); await tick(5);
    check(w.popup.cards.length === 0, `网页号只有 1 个未读时切网：回来后不再弹（${desc(w.popup.cards)}）`);
  }
  {
    // W3c：切网期间列表读不出，但未读对话数比切网前多了：真有新客户，弹号的卡
    const { w } = await webWithThree();
    w.networkChange();
    w.title(0); await tick(5);
    advance(15 * 1000);
    w.readable = false;
    w.receive('Anna Weber', 'Is the order shipped?', '10:42');
    w.title(); await tick(5);
    check(w.popup.cards.length === 1 && w.popup.cards[0].chat === '' && /4/.test(w.popup.cards[0].text), `网页号切网期间多了一个未读对话、列表读不出：弹号的卡（${desc(w.popup.cards)}）`);
  }
  {
    // W4：切网后线路断了好几分钟，页面一直重试加载，最后连上
    const { w } = await webWithThree();
    w.networkChange();
    w.startLoading(); w.failLoad(); await tick(5);
    for (let i = 0; i < 4; i += 1) { advance(MIN); w.startLoading(); w.failLoad(); await tick(5); }
    advance(MIN);
    w.startLoading(); await tick(5);
    w.badges = false; w.title(0); await tick(5);
    w.badges = true; w.title(); await tick(5);
    advance(10 * 1000); w.poll(); await tick(5);
    check(w.popup.cards.length === 0, `网页号切网后断了 5 分钟、页面重试加载：连上后不再弹（${desc(w.popup.cards)}）`);
  }
  {
    // W5：切网期间 Emma 又发了一条、来了新客户 Anna：只弹这两条
    const { w } = await webWithThree();
    w.networkChange();
    w.badges = false; w.title(0); await tick(5);
    w.receive('Emma Schneider', 'Bitte um Rückruf', '10:41');
    w.receive('Anna Weber', 'Is the order shipped?', '10:42');
    w.badges = true; w.title(); await tick(5);
    w.poll(); await tick(5);
    const got = desc(w.popup.cards.slice().sort((a, b) => a.chat.localeCompare(b.chat)));
    check(got === 'Anna Weber / Emma Schneider', `网页号切网期间真来了新消息：只弹新的两条（${got}）`);
  }
  {
    // W6：没切网，读掉 John 以后他过了几分钟又发了同样的“Thanks!”：照样弹
    const { w } = await webWithThree();
    w.read('John Miller'); w.title(); await tick(5);
    advance(3 * MIN);
    w.receive('John Miller', 'Thanks!', '10:40'); w.title(); await tick(5);
    check(desc(w.popup.cards) === 'John Miller', `网页号读掉后同一个客户又发同样的话：照样弹（${desc(w.popup.cards)}）`);
  }
  {
    // W7：一个个读完（不是切网），一分钟后来了新消息，列表读不出：照样弹号的卡
    const { w } = await webWithThree();
    for (const name of ['Emma Schneider', 'John Miller', 'Lucas Martin']) { w.read(name); w.title(); await tick(5); }
    advance(MIN);
    w.readable = false;
    w.receive('Anna Weber', 'Hello?', '10:45'); w.title(); await tick(5);
    check(w.popup.cards.length === 1 && w.popup.cards[0].chat === '', `网页号读完后真来新消息、列表读不出：照样弹号的卡（${desc(w.popup.cards)}）`);
  }
  {
    // W8：切网后软件被重启（或崩溃重开），回来同样三条
    const disk = makeDisk();
    const { w } = await webWithThree(disk);
    w.networkChange();
    const w2 = new WebAccount(disk);
    w2.chats = w.chats.map((c) => ({ ...c }));
    w2.saved = 0; // 重启前标题已经掉到 0 被记下
    w2.startLoading(); await tick(5);
    advance(3 * MIN); // 页面等了很久才出来，超过 2 分钟
    w2.title(); await tick(5);
    advance(10 * 1000); w2.poll(); await tick(5);
    check(w2.popup.cards.length === 0, `网页号切网后软件重开、页面很久才出来：不再弹（${desc(w2.popup.cards)}）`);
  }

  // ======== 轻量号 ========
  const EMMA = '491701234567@s.whatsapp.net';
  const JOHN = '12125550123@s.whatsapp.net';
  const LUCAS = '33612345678@s.whatsapp.net';
  const ANNA = '4915112345678@s.whatsapp.net';
  let dirN = 0;
  async function liteWithThree(disk) {
    const dir = path.join(tmp, `lite${(dirN += 1)}`);
    fs.mkdirSync(dir);
    const l = new LiteAccount(ChatStore, dir, crypto.randomBytes(32), disk);
    l.message(LUCAS, 'Lucas Martin', 'Can you send the invoice?'); l.emit(); await tick(5);
    l.message(JOHN, 'John Miller', 'Thanks!'); l.emit(); await tick(5);
    l.message(EMMA, 'Emma Schneider', 'Hallo! Ist der Liefertermin noch der 12.11.?'); l.emit(); await tick(5);
    const first = desc(l.popup.cards);
    l.popup.cards = [];
    advance(5 * MIN);
    return { l, first };
  }
  {
    const { l, first } = await liteWithThree();
    check(first === 'Lucas Martin / John Miller / Emma Schneider', `轻量号：先正常弹三个客户（${first}）`);
    // L1：切网 → 心跳断开 → 重连中 → 后台重启这个号 → 连上，推来同样的未读
    l.networkChange();
    l.state('reconnecting'); advance(30 * 1000);
    l.restartSession();
    l.state('connecting'); advance(5 * 1000);
    l.state('open'); l.emit(); await tick(5);
    check(l.popup.cards.length === 0, `轻量号切网重连：推来同样的未读，不再弹（${desc(l.popup.cards)}）`);
    // L2：重连时 WhatsApp 把断线前收到的消息又补发一遍（同一条消息 id）
    l.message(EMMA, 'Emma Schneider', 'Hallo! Ist der Liefertermin noch der 12.11.?', { type: 'append', id: 'M3', ts: l.ts }); l.emit(); await tick(5);
    check(l.popup.cards.length === 0, `轻量号重连后同一条消息补发一遍：不再弹（${desc(l.popup.cards)}）`);
  }
  {
    // L3：重连时未读对话数掉到 0 又回来（后台进程重启前推了个空的）
    const { l } = await liteWithThree();
    l.networkChange();
    l.state('reconnecting');
    for (const c of l.store.chats.values()) c.unreadSaved = c.unread;
    for (const c of l.store.chats.values()) c.unread = 0;
    l.emit(); await tick(5);
    advance(20 * 1000);
    for (const c of l.store.chats.values()) c.unread = c.unreadSaved;
    l.state('open'); l.emit(); await tick(5);
    check(l.popup.cards.length === 0, `轻量号重连时未读掉到 0 又回来：不再弹（${desc(l.popup.cards)}）`);
  }
  {
    // L4：断线期间来了新客户 Anna（重连后补发，type=append）：只弹她
    const { l } = await liteWithThree();
    l.networkChange();
    l.state('reconnecting');
    l.restartSession();
    l.state('open'); l.emit(); await tick(5);
    l.message(ANNA, 'Anna Weber', 'Is the order shipped?', { type: 'append' }); l.emit(); await tick(5);
    check(desc(l.popup.cards) === 'Anna Weber', `轻量号断线期间来的新客户：只弹她（${desc(l.popup.cards)}）`);
  }
  {
    // L5：切网后软件重开，轻量号连上推来同样的未读
    const disk = makeDisk();
    const { l } = await liteWithThree(disk);
    l.networkChange();
    l.restartSession();
    const l2 = new LiteAccount(ChatStore, l.dir, l.key, disk);
    l2.saved = 0; // 关掉前已经掉到 0 被记下
    l2.state('open'); l2.emit(); await tick(5);
    advance(10 * 1000); l2.n.recheck(l2.acc, { isActive: false }); await tick(5);
    check(l2.popup.cards.length === 0, `轻量号切网后软件重开：不再弹（${desc(l2.popup.cards)}）`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
