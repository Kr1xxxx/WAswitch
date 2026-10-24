// 轻量模式后台进程（Electron utilityProcess）。所有轻量模式账号共用这一个进程。
// 先装网络护栏，再加载 Baileys，保证从第一行代码开始就不可能直连。
import { installGuard, setAllowedHosts } from './guard.mjs';

const port = process.parentPort;
const post = (m) => port.postMessage(m);

installGuard(({ what, host }) => post({ type: 'guard', what, host }));

const { Session } = await import('./session.mjs');
const { proxyHost } = await import('./transport.mjs');

const sessions = new Map();

function refreshAllowed() {
  setAllowedHosts([...sessions.values()].map((s) => proxyHost(s.cfg.proxy)));
}

async function handle(m) {
  const s = sessions.get(m.id);
  switch (m.type) {
    case 'start': {
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
    case 'send':
      if (!s) throw new Error('这个号没有在运行');
      await s.send(m.jid, m.text);
      return undefined;
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
