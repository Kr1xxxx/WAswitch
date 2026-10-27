// 翻译页滚动自检用：假的主进程接口，只记下回调，其余调用什么都不做
window.__cbs = {};
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'onDock') return (cb) => { window.__cbs.dock = cb; };
  if (k === 'dockGet') return async () => window.__dock || null;
  return async () => null;
} });
