// 撤销提示自检用：假的主进程接口。删话术时像主进程一样发 undo:offer，记下撤销调用
window.__cbs = {};
window.__calls = [];
window.__replies = [{ id: 'r1', title: 'Price', text: 'Our lace front wigs start at 120 EUR.', updatedAt: 2 }, { id: 'r2', title: 'Shipping', text: 'We ship to Germany in 3-5 days.', updatedAt: 1 }];
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'onUndoOffer') return (cb) => { window.__cbs.undo = cb; };
  if (k === 'panelData') return async () => ({ replies: window.__replies.slice(), customers: [] });
  if (k === 'replyDelete') return async (id) => {
    window.__calls.push(['replyDelete', id]);
    const r = window.__replies.find((x) => x.id === id);
    window.__replies = window.__replies.filter((x) => x.id !== id);
    setTimeout(() => window.__cbs.undo({ token: 7, kind: 'panel', where: 'panel', text: `已删除「${r.title}」` }), 0);
    return { replies: window.__replies.slice(), customers: [] };
  };
  if (k === 'undo') return async (token) => { window.__calls.push(['undo', token]); window.__replies.push({ id: 'r1', title: 'Price', text: 'Our lace front wigs start at 120 EUR.', updatedAt: 2 }); return true; };
  return async () => null;
} });
