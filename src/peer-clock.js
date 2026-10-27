// 顶栏“客户当地时间”：每 2 秒看一眼当前账号打开的是哪个对话，按客户号码算出时区告诉界面。
// 网页号在隔离环境里只读标题和对话编号（wa-page.js 的 readChatPeer），轻量号直接用打开的对话 jid。
// 新版 WhatsApp 的私聊编号常是隐私编号（@lid），存了名字的联系人标题又是名字：这时再查一次号码
// （网页号只读 WhatsApp 自己的本地数据，轻量号问后台进程的 lid 映射），查到的结果记一会儿，不每 2 秒都查。
// 只看当前账号、只在窗口看得见并且没锁时看。号码不出主进程，界面只拿到时区和城市名。
const waPage = require('./wa-page');
const { peerZone, customerPhone, fromChatId, fromText } = require('./customer-time');

const EVERY = 2000;
const FOUND_MS = 10 * 60 * 1000; // 查到的号码记 10 分钟
const MISS_MS = 60 * 1000; // 查不到的 1 分钟后再查（可能刚打开、本地数据还没写好）

function setupPeerClock(ctx) {
  const { findAcc, isLite, views, problems, liteChat, parkedCustomer } = ctx;
  let last = ''; // 上次发给界面的内容，没变就不发
  let busy = false;

  function send(accountId, zone) {
    const msg = { accountId, zone };
    const key = JSON.stringify(msg);
    if (key === last) return;
    last = key;
    const sv = ctx.shellView;
    if (sv && !sv.webContents.isDestroyed()) sv.webContents.send('peer:zone', msg);
  }

  // 编号和标题里都没有号码时查一次，结果按“账号|编号|标题”记住。号码只在这里用，不写日志
  const looked = new Map(); // key -> { digits, until }
  const logged = new Set(); // 查不到的原因每个对话只记一次日志（不带号码和名字）
  async function lookup(acc, r, wc) {
    const id = fromChatId(r.chat);
    if (id.group || id.digits || fromText(r.title)) return '';
    if (!r.chat && !r.title) return '';
    const key = `${acc.id}|${r.chat}|${r.title}`;
    const hit = looked.get(key);
    if (hit && hit.until > Date.now()) return hit.digits;
    let digits = '';
    let why = '';
    let stores = [];
    if (isLite(acc)) {
      try { digits = String((await ctx.liteHost?.peerNumber(acc.id, r.chat)) || ''); } catch { digits = ''; }
      if (!/^\d{7,15}$/.test(digits)) { digits = ''; why = 'lite'; }
    } else if (wc) {
      ({ digits, why, stores } = await waPage.lookupPeerPhone(wc, r));
    }
    if (looked.size > 300) looked.clear();
    looked.set(key, { digits, until: Date.now() + (digits ? FOUND_MS : MISS_MS) });
    const kind = /@lid$/.test(r.chat) ? 'lid' : r.chat ? 'other' : 'none';
    if (!digits && !logged.has(key)) {
      logged.add(key);
      if (logged.size > 300) logged.clear();
      console.log(`顶栏客户时间：认不出号码（编号 ${kind}，${why}${stores.length ? `，库表 ${stores.join(',')}` : ''}）`);
    }
    return digits;
  }

  async function read(acc) {
    if (isLite(acc)) {
      const lc = liteChat(acc.id);
      if (!lc.jid) return null;
      const r = { chat: lc.jid, title: lc.view && lc.view.jid === lc.jid ? lc.view.title || '' : '' };
      return { ...r, lookedUp: await lookup(acc, r, null) };
    }
    const view = views.get(acc.id);
    if (!view || view.webContents.isDestroyed()) return null;
    const r = await waPage.readChatPeer(view.webContents);
    if (!r) return null;
    return { ...r, lookedUp: await lookup(acc, r, view.webContents) };
  }

  async function tick() {
    if (busy || ctx.page !== 'account' || ctx.locked || !ctx.win || !ctx.win.isVisible() || ctx.win.isMinimized()) return;
    const acc = findAcc(ctx.activeId);
    if (!acc || problems.has(acc.id)) return;
    busy = true;
    try {
      const r = await read(acc);
      if (acc.id !== ctx.activeId) return;
      if (!r) { send(acc.id, null); return; }
      const customers = ctx.customerStore ? ctx.customerStore.list().filter((c) => !parkedCustomer(c)) : [];
      send(acc.id, peerZone({ chat: r.chat, title: r.title, lookedUp: r.lookedUp, customerPhone: customerPhone(customers, acc.id, r.title) }));
    } catch {
      // 读不到就保持上次的结果，下一轮再看
    } finally {
      busy = false;
    }
  }

  // 每半秒看一下换没换号：换了马上读，没换就 2 秒读一次
  let readAt = 0;
  let readFor = '';
  const timer = setInterval(() => {
    const now = Date.now();
    if (ctx.activeId === readFor && now - readAt < EVERY) return;
    readAt = now;
    readFor = ctx.activeId;
    tick();
  }, 500);
  return { tick, stop: () => clearInterval(timer) };
}

module.exports = { setupPeerClock };
