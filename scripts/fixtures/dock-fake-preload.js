// 翻译页滚动、翻译页 ⇄ 自检用：假的主进程接口，只记下回调，其余调用什么都不做
window.__cbs = {};
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'onDock') return (cb) => { window.__cbs.dock = cb; };
  if (k === 'dockGet') return async () => window.__dock || null;
  if (k === 'trConfig') return async () => window.__trcfg || null;
  if (k === 'trPage') return async (a) => { (window.__trCalls = window.__trCalls || []).push(a); return window.__trPage ? window.__trPage(a) : null; };
  return async () => null;
} });
