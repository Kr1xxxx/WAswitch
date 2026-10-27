// MCP「打开对话」（open_chat）在主进程这边的做法：在某个账号里打开和某个号码的对话。
//
//   网页版：让账号页面跳到 WhatsApp 自己的 https://web.whatsapp.com/send?phone=号码（和点 wa.me 链接一样），
//          不往 WhatsApp 页面注入脚本、不模拟点击；网址里只有号码，永远不带要发的文字。
//          跳转会刷新这个号的页面，所以输入框里有没发的字时先在窗口顶部问用户。
//   轻量模式：对话列表在软件自己的界面里，直接选中这个对话。
//
// 打开后会切到这个账号（和 switch_account 一样不抢键盘焦点，窗口在托盘里就留在托盘里）。
// 用户正在打字或编辑账号时不直接开，改在窗口顶部问，用户点“打开”才开。
// 只打开，不发送、不标已读（用户自己看到对话时 WhatsApp 才会像平常一样标已读）。
// 由 main.js 的 mcpHooks.openChat 调用；MCP 的代码不直接引用这个文件。
const { chatMatches, jidNumber } = require('./draft-place');

const OPEN_ASK_MS = 60 * 1000; // 顶部横幅 1 分钟没人点就消失
const WEB_WAIT_MS = 40 * 1000; // 网页版跳转后最多等 40 秒对话出现
const WEB_STEP_MS = 500;
const LITE_WAIT_MS = 1500; // 轻量模式切过去后等对话列表推过来

const sendUrl = (digits) => `https://web.whatsapp.com/send?phone=${digits}`;

// 给 AI 的说明：为什么没直接打开
const WHY = {
  busy: '用户正在打字或编辑账号',
  not_empty: '这个号的输入框里有还没发的字，打开要刷新页面，可能会丢',
};

// deps（main.js 提供）：
//   findAcc(id), isLite(acc)
//   userBusy() -> boolean                 窗口在前台且 30 秒内打过字，或者正在编辑账号
//   problem(id) -> boolean                这个号的页面有问题（代理连不上等）
//   activate(id)                          切到这个号，不抢焦点（MCP 直接开时）
//   activateForUser(id) -> Promise        切到这个号并把窗口拿到前台（用户点了“打开”）
//   webContents(id) -> wc | null          网页版账号的页面（还没加载好时 null）
//   waPage: { readChatPeer, composeState }
//   navigate(id, url) -> boolean          让网页版账号的页面跳到这个网址
//   liteChats(id) -> [{ jid, name }]
//   liteOpen(id, jid)                     轻量模式选中这个对话
//   request() / setRequest(req, ms) / clearRequest()   窗口顶部的横幅（和切换账号、起草回复共用）
//   wait(ms), now()
function createChatOpener(deps) {
  let inFlight = false;
  let nonce = 0;
  const now = deps.now || Date.now;

  const peerOf = (p) => (p ? { title: p.title, number: jidNumber(p.chat) } : null);

  // 网页版：已经开着就不刷新；否则跳转，等对话出现
  async function openWeb(acc, digits, { checkCompose, activate }) {
    const wc = deps.webContents(acc.id);
    if (!wc) return { result: 'failed', reason: 'not_loaded' };
    const peer = await deps.waPage.readChatPeer(wc);
    if (peer && chatMatches(digits, peerOf(peer))) {
      activate();
      return { result: 'already' };
    }
    if (checkCompose) {
      const st = await deps.waPage.composeState(wc, '');
      if (st && st.box && !st.empty) return { result: 'ask', why: 'not_empty' };
    }
    activate();
    if (!deps.navigate(acc.id, sendUrl(digits))) return { result: 'failed', reason: 'not_loaded' };
    // 跳转后页面从头加载，加载完 WhatsApp 会打开这个号码的对话。号码对上算确认；
    // 开了一个对话但看不出号码（已存成联系人、新版的隐藏号码 id）也算打开了，只是没确认
    const until = now() + WEB_WAIT_MS;
    await deps.wait(WEB_STEP_MS);
    while (now() < until) {
      const cur = deps.webContents(acc.id);
      if (!cur || !deps.findAcc(acc.id)) return { result: 'failed', reason: 'gone' };
      const p = await deps.waPage.readChatPeer(cur);
      if (p && chatMatches(digits, peerOf(p))) return { result: 'opened' };
      if (p && (p.title || p.chat)) return { result: 'opened', unconfirmed: true, title: p.title };
      await deps.wait(WEB_STEP_MS);
    }
    return { result: 'failed', reason: 'no_chat' };
  }

  // 轻量模式：本机有这个号码的对话就选中它，没有就开一个空对话（发不发由用户决定）
  async function openLite(acc, digits, { activate }) {
    activate();
    let chats = deps.liteChats(acc.id);
    for (let t = 0; !chats.length && t < LITE_WAIT_MS; t += 100) {
      await deps.wait(100);
      chats = deps.liteChats(acc.id);
    }
    const found = chats.filter((c) => !/@g\.us$/.test(c.jid) && jidNumber(c.jid) === digits);
    const jid = found.length ? found[0].jid : `${digits}@s.whatsapp.net`;
    deps.liteOpen(acc.id, jid);
    return { result: 'opened', found: found.length > 0, title: found.length ? found[0].name || '' : '' };
  }

  const ask = (req, why) => {
    nonce += 1;
    deps.setRequest({ kind: 'open', nonce, id: req.id, phone: req.phone, client: req.client || '', warn: why === 'not_empty' }, OPEN_ASK_MS);
    return { result: 'pending', why: WHY[why] || '' };
  };

  // phone：只有数字的国际号码（不带 +），MCP 那边已经整理好。
  // 返回 { result: 'opened' | 'already' | 'pending' | 'busy' | 'gone' | 'failed', why?, reason?, unconfirmed?, found?, title? }
  async function open({ accountId, phone, client }) {
    const cur = deps.request();
    if (inFlight || (cur && (cur.kind === 'open' || cur.kind === 'draft'))) return { result: 'busy' };
    const acc = deps.findAcc(accountId);
    if (!acc) return { result: 'gone' };
    if (!/^\d{7,15}$/.test(String(phone))) return { result: 'failed', reason: 'bad_phone' }; // MCP 那边已经整理过，这里再守一道
    if (deps.problem(accountId)) return { result: 'failed', reason: 'problem' };
    const req = { id: accountId, phone, client };
    if (deps.userBusy()) return ask(req, 'busy');
    inFlight = true;
    try {
      const activate = () => deps.activate(accountId);
      const r = deps.isLite(acc)
        ? await openLite(acc, phone, { activate })
        : await openWeb(acc, phone, { checkCompose: true, activate });
      if (r.result === 'ask') return ask(req, r.why);
      return r;
    } finally {
      inFlight = false;
    }
  }

  // 用户在横幅里点了“忽略”（yes=false）或“打开”（yes=true）
  async function answer(yes) {
    const req = deps.request();
    if (!req || req.kind !== 'open' || inFlight) return;
    const acc = deps.findAcc(req.id);
    deps.clearRequest();
    if (!yes || !acc) return;
    inFlight = true;
    try {
      await deps.activateForUser(req.id);
      await deps.wait(300); // 等切过去的页面显示出来
      if (deps.isLite(acc)) { await openLite(acc, req.phone, { activate: () => {} }); return; }
      // 用户点“打开”之前没被提醒过会丢字（当时是因为在打字才问的），现在输入框有字就再问一次
      const r = await openWeb(acc, req.phone, { checkCompose: !req.warn, activate: () => {} });
      if (r.result === 'ask') {
        nonce += 1;
        deps.setRequest({ ...req, nonce, warn: true }, OPEN_ASK_MS);
      }
    } finally {
      inFlight = false;
    }
  }

  return { open, answer };
}

module.exports = { createChatOpener, sendUrl, OPEN_ASK_MS, WEB_WAIT_MS };
