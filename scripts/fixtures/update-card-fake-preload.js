// 更新卡片自检用：假的主进程接口，记下调用
window.__cbs = {};
window.__calls = [];
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'updateLater' || k === 'updateInstall' || k === 'updateCheck') return () => window.__calls.push([k]);
  if (k.startsWith('on')) return () => {};
  return async () => null;
} });
