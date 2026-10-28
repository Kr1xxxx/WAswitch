// MCP 的 read_messages 在主进程这一侧的做法（MCP 代码本身在可下载模块里，只通过 main.js 的 mcpHooks 调这里）。
//
// 网页版：只读“当前打开的那个对话”，在隔离环境里读（wa-page.js 的 readChatPeer / readOpenChat），不点开别的对话、不滚动、不改页面。
//         确认框弹出之前读对话编号；确认之后与消息一起读取编号再核对，重名也不能串对话。
// 轻量版：从本机聊天缓存读任意已有对话（lite/history.mjs，在后台进程里跑），不标已读、不发回执。
const { chatMatches, jidNumber } = require('./draft-place');

const pad = (n) => String(n).padStart(2, '0');
// 网页上解析出的时间（本机时间）→ "2026-10-27 14:05"；认不出就是 null
const when = (t) => (t && Number.isInteger(t.y) ? `${t.y}-${pad(t.mo)}-${pad(t.d)} ${pad(t.h)}:${pad(t.mi)}` : null);
const numberTitle = (jid) => (jidNumber(jid) ? `+${jidNumber(jid)}` : '');
// Compare the same display value on both sides; a missing raw title is not a chat change.
const webTitle = (peer) => peer.title || numberTitle(peer.chat) || '当前打开的对话';

// deps：
//   findAcc(id)、isLite(acc)
//   webContents(id) -> 已加载完的 webContents 或 null
//   waPage：wa-page.js
//   lite() -> LiteHost 或 null（findChat(id, chat)、history(id, jid, limit)）
//   liteOpenChat(id) -> { jid, title } | null（轻量聊天页当前打开的对话）
function createMessageReader(deps) {
  // 返回 { ok: true, title, ref } | { ok: false, reason, count? }。chat 为空表示读当前打开的对话
  async function locateChat(id, chat) {
    const acc = deps.findAcc(id);
    if (!acc) return { ok: false, reason: 'error' };
    if (deps.isLite(acc)) {
      const host = deps.lite();
      if (!host) return { ok: false, reason: 'notrunning' };
      if (!chat) {
        const open = deps.liteOpenChat(id);
        if (!open || !open.jid) return { ok: false, reason: 'nolite' };
        return { ok: true, title: String(open.title || numberTitle(open.jid) || '当前打开的对话').slice(0, 100), ref: open.jid };
      }
      try {
        const r = await host.findChat(id, chat);
        if (r && r.ok) return { ok: true, title: String(r.title || '').slice(0, 100), ref: r.jid };
        return r && r.reason ? r : { ok: false, reason: 'error' };
      } catch { return { ok: false, reason: 'error' }; }
    }
    const wc = deps.webContents(id);
    if (!wc) return { ok: false, reason: 'loading' };
    const peer = await deps.waPage.readChatPeer(wc);
    if (!peer || (!peer.title && !peer.chat)) return { ok: false, reason: 'nochat' };
    if (chat && !chatMatches(chat, { title: peer.title, number: jidNumber(peer.chat) })) return { ok: false, reason: 'mismatch' };
    if (!peer.chat) return { ok: false, reason: 'unrecognized' };
    return { ok: true, title: webTitle(peer), ref: peer.chat };
  }

  // 返回 { ok: true, title, group, messages: [{ from_me, time, text, sender? }] } | { ok: false, reason }
  async function readMessages(id, { ref, title, limit }) {
    const acc = deps.findAcc(id);
    if (!acc) return { ok: false, reason: 'error' };
    if (deps.isLite(acc)) {
      const host = deps.lite();
      if (!host) return { ok: false, reason: 'notrunning' };
      try {
        const r = await host.history(id, ref, limit);
        if (!r || !r.ok) return r && r.reason ? r : { ok: false, reason: 'error' };
        return { ok: true, title: r.title || title, group: r.group, messages: r.messages };
      } catch { return { ok: false, reason: 'error' }; }
    }
    const wc = deps.webContents(id);
    if (!wc) return { ok: false, reason: 'loading' };
    const r = await deps.waPage.readOpenChat(wc, { max: limit });
    if (!r.ok) return { ok: false, reason: { loading: 'loading', qr: 'loading', nochat: 'nochat' }[r.why] || 'unrecognized' };
    if (!ref || r.chat !== ref || webTitle(r) !== title) return { ok: false, reason: 'changed' };
    return { ok: true, title: webTitle(r), group: null, messages: r.msgs.map((m) => ({ from_me: m.out === true, time: when(m.t), text: m.text })) };
  }

  return { locateChat, readMessages };
}

module.exports = { createMessageReader };
