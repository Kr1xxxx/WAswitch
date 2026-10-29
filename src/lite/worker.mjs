// 轻量模式后台进程（Electron utilityProcess）。所有轻量模式账号共用这一个进程。
// 先装网络护栏，再加载 Baileys，保证从第一行代码开始就不可能直连。
// 带 --direct 启动的是直连号专用的进程：只放行 TCP 和 DNS，只接没设代理的号。
import { installGuard, setAllowedHosts, setAllowAll } from './guard.mjs';

const DIRECT = process.argv.includes('--direct');

const port = process.parentPort;
const post = (m) => port.postMessage(m);

installGuard(({ what, host }) => post({ type: 'guard', what, host }));
if (DIRECT) setAllowAll(true);

const { Session } = await import('./session.mjs');
const { proxyHost } = await import('./transport.mjs');
const { findChat, readHistory } = await import('./history.mjs');
const { MAX_PER_CHAT } = await import('./store.mjs');

const sessions = new Map();

function refreshAllowed() {
  if (DIRECT) return;
  setAllowedHosts([...sessions.values()].map((s) => proxyHost(s.cfg.proxy)));
}

async function handle(m) {
  const s = sessions.get(m.id);
  switch (m.type) {
    case 'start': {
      // 走代理的号和直连号不混在一个进程里
      if (DIRECT ? m.proxy : !m.proxy) throw new Error(DIRECT ? '直连进程不接走代理的号' : '没有代理的号不能在这个进程里运行');
      if (s) { s.stop(); sessions.delete(m.id); }
      const session = new Session({ id: m.id, proxy: m.proxy, dir: m.dir, key: m.key, os: m.os, crm: m.crm }, post);
      sessions.set(m.id, session);
      refreshAllowed();
      session.watch(m.watched, m.jid);
      await session.start();
      return undefined;
    }
    case 'stop':
      if (s) { s.stop(); sessions.delete(m.id); refreshAllowed(); }
      return undefined;
    case 'logout':
      if (s) { await s.logout(); sessions.delete(m.id); refreshAllowed(); }
      return undefined;
    case 'watch':
      for (const [id, x] of sessions) x.watch(id === m.id, id === m.id ? m.jid : undefined);
      return undefined;
    case 'crm':
      if (s) s.setCrm(m.since);
      return undefined;
    case 'read':
      if (s) await s.read(m.jid);
      return undefined;
    // MCP read_messages：只读本机缓存，不标已读、不联网
    case 'findChat':
      if (!s || !s.store) return { ok: false, reason: 'notrunning' };
      return findChat(s.store, m.chat);
    case 'history':
      if (!s || !s.store) return { ok: false, reason: 'notrunning' };
      return readHistory(s.store, m.jid, m.limit);
    // 后台补译文记录里的原文（见 trfill.js）：有消息的对话、某个对话里对方发来的消息文字，只读本机缓存
    case 'jids':
      return s && s.store ? [...s.store.msgs.keys()] : null;
    case 'incoming':
      return s && s.store ? s.store.messages(m.jid, MAX_PER_CHAT).filter((x) => x && !x.me).map((x) => String(x.text || '')) : null;
    case 'send':
      if (!s) throw new Error('这个号没有在运行');
      await s.send(m.jid, m.text);
      return undefined;
    case 'chats':
      return s ? s.chatList() : null;
    case 'peer':
      return s ? s.peerNumber(m.jid) : '';
    case 'shutdown':
      for (const x of sessions.values()) x.stop();
      sessions.clear();
      return undefined;
    default:
      throw new Error(`未知命令 ${m.type}`);
  }
}

port.on('message', (e) => {
  const m = e.data || {};
  handle(m).then(
    (value) => { if (m.reqId) post({ type: 'reply', reqId: m.reqId, ok: true, value }); if (m.type === 'shutdown') setTimeout(() => process.exit(0), 50); },
    (err) => { if (m.reqId) post({ type: 'reply', reqId: m.reqId, ok: false, error: String(err && err.message ? err.message : err) }); },
  );
});

// 未处理的异常：进程状态已经不可靠，先把所有账号的数据写盘，再退出，由主进程按次数上限重启
process.on('uncaughtException', (e) => {
  post({ type: 'log', msg: `后台进程错误，正在重启：${String(e && e.message).replace(/\d{6,}/g, '[号码]')}` });
  for (const x of sessions.values()) { try { x.flush(); } catch { /* 尽量写 */ } }
  setTimeout(() => process.exit(1), 50);
});
process.on('unhandledRejection', (e) => post({ type: 'log', msg: `后台进程错误：${String(e && e.message).replace(/\d{6,}/g, '[号码]')}` }));

post({ type: 'ready' });
