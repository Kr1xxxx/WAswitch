// MCP「起草回复」在主进程这边的做法：把 AI 写的草稿放进输入框，永远不发送。
//
//   网页版：和侧栏“插入”一样，等于帮用户按一次 Ctrl+V（剪贴板 + paste），不往 WhatsApp 页面注入脚本、
//          不模拟按键；放之前只读确认打开的对话就是要回的那个、焦点在输入框里，放完确认生效后把剪贴板换回去。
//   轻量模式：输入框在软件自己的界面里，直接填进去，不碰剪贴板。
//
// 什么时候直接放：这个号正显示着、窗口开着、没锁、用户 30 秒内没打字、要回的对话正开着、输入框是空的。
// 其他情况都在窗口顶部给用户看草稿，用户点“放进输入框”才放（这时会切到这个号；轻量模式还会打开那个对话）。
// 一次只有一条草稿：上一条还在顶部等着时，新的直接拒绝。
// 由 main.js 的 mcpHooks.placeDraft 调用；MCP 的代码不直接引用这个文件。

const DRAFT_ASK_MS = 5 * 60 * 1000; // 顶部草稿横幅 5 分钟没人点就消失
const CONFIRM_TRIES = 20; // 粘贴后最多等 2 秒确认草稿出现在输入框里
const CONFIRM_STEP_MS = 100;

const normName = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const digits = (s) => String(s || '').replace(/\D/g, '');
// 像手机号：只有数字、空格、+ - ( ) .，至少 6 位数字
const looksLikePhone = (s) => /^[+\d\s().-]+$/.test(String(s || '').trim()) && digits(s).length >= 6;
// "4915123456789@s.whatsapp.net" / "4915123456789@c.us" → "4915123456789"；群（@g.us）不算号码
const jidNumber = (jid) => (/@(?:s\.whatsapp\.net|c\.us)$/.test(String(jid || '')) ? digits(String(jid).split('@')[0].split(':')[0]) : '');

// chat：AI 给的对话名称或号码；open：当前打开的对话 { title, number }（number 只有数字）
function chatMatches(chat, open) {
  if (!open) return false;
  if (looksLikePhone(chat)) {
    // 去掉开头的 0（国内拨号的 0、国际拨号的 00），允许 AI 少写或多写国家码：号码末尾相同、重合至少 8 位
    const want = digits(chat).replace(/^0+/, '');
    const same = (raw) => {
      const n = String(raw || '').replace(/^0+/, '');
      return n.length >= 6 && (n === want || (Math.min(n.length, want.length) >= 8 && (n.endsWith(want) || want.endsWith(n))));
    };
    return same(open.number) || (looksLikePhone(open.title) && same(digits(open.title)));
  }
  const want = normName(chat);
  return !!want && want === normName(open.title);
}

// 草稿开头的一小段（空白合并），粘贴后用它确认输入框里真有这段
const probeOf = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 24);

// 剪贴板（Electron 的剪贴板接口是异步的）：放之前把每一项每种格式都存下来，放完原样写回去。
// 读不出来的格式只能丢掉（少见）
async function saveClipboard(cb) {
  try {
    const saved = [];
    for (const item of await cb.read()) {
      const data = {};
      for (const type of item.types) {
        try { data[type] = await item.getType(type); } catch { /* 这种格式读不出来 */ }
      }
      if (Object.keys(data).length) saved.push(data);
    }
    return saved;
  } catch {
    return [];
  }
}
async function restoreClipboard(cb, saved, ClipboardItem) {
  try {
    if (saved.length) await cb.write(saved.map((data) => new ClipboardItem(data)));
    else cb.clear();
  } catch { /* 写不回去就留着草稿 */ }
}

// 给 AI 的说明：为什么没直接放
const WHY = {
  not_shown: '这个账号现在没显示在 WAswitch 窗口里',
  hidden: 'WAswitch 窗口在托盘里或最小化了',
  locked: '聊天已锁定',
  busy: '用户正在打字',
  problem: '这个账号的页面有问题',
  no_chat: '这个账号现在没打开任何对话',
  other_chat: '要回的对话现在没打开',
  not_empty: '输入框里已经有文字',
  focus: '光标不在聊天输入框里',
  changed: '放的时候页面状态变了',
};

// 用户点了“放进输入框”但没放成：横幅上告诉用户下一步
const NOTE = {
  no_chat: (c) => `先在 WhatsApp 里打开和「${c}」的对话，再点“放进输入框”`,
  other_chat: (c) => `先在 WhatsApp 里打开和「${c}」的对话，再点“放进输入框”`,
  focus: () => '先点一下对话下方写消息的地方，再点“放进输入框”',
  not_found: (c) => `轻量模式里没找到「${c}」这个对话（或有重名的），没有放`,
  not_empty: () => '输入框里已经有文字，没有放',
  changed: () => '页面还没准备好，稍后再点“放进输入框”',
};

// deps（main.js 提供）：
//   findAcc(id), isLite(acc)
//   autoBlock(id) -> '' 可以直接放 | WHY 里的键
//   stillShown(id) -> boolean            读页面期间换号、锁定就不放
//   webContents(id) -> wc | null          网页版账号的页面
//   waPage: { readChatPeer, composeState }
//   clipboard, ClipboardItem            Electron 的剪贴板（异步接口）
//   liteOpenChat(id) -> { jid, title } | null
//   liteChats(id) -> [{ jid, name }]
//   liteOpen(id, jid)                     用户点按钮后打开轻量对话
//   liteFill(id, jid, text, { force, focus }) -> Promise<'ok' | 'not_empty' | 'chat' | 'none'>
//   request() / setRequest(req, ms) / clearRequest()   窗口顶部的横幅（和 AI 切换账号共用）
//   activateForUser(id) -> Promise        切到这个号并把窗口拿到前台
//   wait(ms)
function createDraftPlacer(deps) {
  let inFlight = false;
  let nonce = 0;

  async function fillWeb(acc, chat, text, byUser) {
    const wc = deps.webContents(acc.id);
    if (!wc) return 'changed';
    const peer = await deps.waPage.readChatPeer(wc);
    if (!deps.stillShown(acc.id)) return 'changed';
    if (!peer || (!peer.title && !peer.chat)) return 'no_chat';
    if (!chatMatches(chat, { title: peer.title, number: jidNumber(peer.chat) })) return 'other_chat';
    const probe = probeOf(text);
    const st = await deps.waPage.composeState(wc, probe);
    if (!deps.stillShown(acc.id)) return 'changed';
    if (!st || !st.box) return 'no_chat';
    if (!byUser && !st.empty) return 'not_empty';
    if (st.focus !== 'compose') return 'focus';
    const saved = await saveClipboard(deps.clipboard);
    await deps.clipboard.writeText(text); // 写完再贴，不然可能贴出原来剪贴板里的东西
    if (!deps.stillShown(acc.id)) { await restoreClipboard(deps.clipboard, saved, deps.ClipboardItem); return 'changed'; }
    wc.focus();
    wc.paste();
    for (let i = 0; i < CONFIRM_TRIES; i += 1) {
      await deps.wait(CONFIRM_STEP_MS);
      const after = await deps.waPage.composeState(wc, probe);
      if (after && after.has) {
        // 用户这期间自己复制了别的东西就不动剪贴板
        if ((await deps.clipboard.readText()) === text) await restoreClipboard(deps.clipboard, saved, deps.ClipboardItem);
        return 'ok';
      }
    }
    // 没确认到：剪贴板里留着草稿（换回去的话，迟到的粘贴可能贴出用户原来剪贴板里的东西）
    return 'unconfirmed';
  }

  async function fillLite(acc, chat, text, byUser) {
    const open = deps.liteOpenChat(acc.id);
    let jid = open && chatMatches(chat, { title: open.title, number: jidNumber(open.jid) }) ? open.jid : null;
    if (!jid) {
      if (!byUser) return open ? 'other_chat' : 'no_chat';
      const found = deps.liteChats(acc.id).filter((c) => chatMatches(chat, { title: c.name, number: jidNumber(c.jid) }));
      if (found.length !== 1) return 'not_found';
      jid = found[0].jid;
      deps.liteOpen(acc.id, jid);
    }
    if (!deps.stillShown(acc.id)) return 'changed';
    const r = await deps.liteFill(acc.id, jid, text, { force: byUser, focus: byUser });
    if (r === 'ok') return 'ok';
    if (r === 'not_empty') return 'not_empty';
    return r === 'chat' ? 'other_chat' : 'changed';
  }

  const fill = (acc, chat, text, byUser) => (deps.isLite(acc) ? fillLite(acc, chat, text, byUser) : fillWeb(acc, chat, text, byUser));

  // 返回 { result: 'placed' | 'pending' | 'busy' | 'gone', why?, unconfirmed? }
  async function place({ accountId, chat, text, client }) {
    const cur = deps.request();
    if (inFlight || (cur && cur.kind === 'draft')) return { result: 'busy' };
    const acc = deps.findAcc(accountId);
    if (!acc) return { result: 'gone' };
    inFlight = true;
    try {
      let why = deps.autoBlock(accountId);
      if (!why) {
        const r = await fill(acc, chat, text, false);
        if (r === 'ok') return { result: 'placed' };
        if (r === 'unconfirmed') return { result: 'placed', unconfirmed: true };
        why = r;
      }
      if (!deps.findAcc(accountId)) return { result: 'gone' };
      nonce += 1;
      deps.setRequest({ kind: 'draft', nonce, id: accountId, chat, text, client: client || '', note: '' }, DRAFT_ASK_MS);
      return { result: 'pending', why: WHY[why] || '' };
    } finally {
      inFlight = false;
    }
  }

  // 用户在横幅里点了“忽略”（yes=false）或“放进输入框”（yes=true）
  async function answer(yes) {
    const req = deps.request();
    if (!req || req.kind !== 'draft' || inFlight) return;
    const acc = deps.findAcc(req.id);
    if (!yes || !acc) { deps.clearRequest(); return; }
    inFlight = true;
    let r;
    try {
      await deps.activateForUser(req.id);
      await deps.wait(300); // 等切过去的页面显示出来
      r = await fill(acc, req.chat, req.text, true);
    } finally {
      inFlight = false;
    }
    const now = deps.request();
    if (!now || now.nonce !== req.nonce) return; // 期间被别的请求换掉了
    if (r === 'ok' || r === 'unconfirmed') { deps.clearRequest(); return; }
    const note = (NOTE[r] || NOTE.changed)(req.chat);
    deps.setRequest({ ...req, note }, DRAFT_ASK_MS);
  }

  return { place, answer };
}

module.exports = { createDraftPlacer, chatMatches, jidNumber, looksLikePhone, probeOf, DRAFT_ASK_MS };
