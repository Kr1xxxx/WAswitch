// 顶栏“客户当地时间”：每 2 秒看一眼当前账号打开的是哪个对话，按客户号码算出时区告诉界面。
// 网页号在隔离环境里只读标题和对话编号（wa-page.js 的 readChatPeer），轻量号直接用打开的对话 jid。
// 只看当前账号、只在窗口看得见并且没锁时看。号码不出主进程，界面只拿到时区和城市名。
const waPage = require('./wa-page');
const { peerZone, customerPhone } = require('./customer-time');

const EVERY = 2000;

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

  async function read(acc) {
    if (isLite(acc)) {
      const lc = liteChat(acc.id);
      if (!lc.jid) return null;
      return { chat: lc.jid, title: lc.view && lc.view.jid === lc.jid ? lc.view.title || '' : '' };
    }
    const view = views.get(acc.id);
    if (!view || view.webContents.isDestroyed()) return null;
    return waPage.readChatPeer(view.webContents);
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
      send(acc.id, peerZone({ chat: r.chat, title: r.title, customerPhone: customerPhone(customers, acc.id, r.title) }));
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
