// 翻译限流倒计时自检用：假的主进程接口。trRun（工作台）和 trPage（翻译页）一直挂着，等自检放行；
// onTrWait 的回调记下来，自检自己发「还要等几毫秒」
window.__cbs = { trWait: [] };
window.__calls = [];
window.__pending = [];
const cfg = { providers: [
  { id: 'z', preset: 'zhipu', name: '智谱', model: 'glm-4-flash', hasKey: true },
  { id: 'h', preset: 'hunyuan', name: '腾讯混元', model: 'hy-mt2-plus', hasKey: true },
], primaryId: 'z', fallbackId: 'h', langs: ['英语', '德语', '中文'], deeplCap: 100000 };
const hang = (name) => (req) => { window.__calls.push([name, req]); return new Promise((res) => window.__pending.push(res)); };
const cancel = (name) => async () => { window.__calls.push([name]); const p = window.__pending.shift(); if (p) p({ error: '已取消', kind: 'cancel' }); return !!p; };
window.__release = (text) => { const p = window.__pending.shift(); if (p) p({ text }); return !!p; };
window.__wait = (w) => { for (const cb of window.__cbs.trWait) cb(w); return window.__cbs.trWait.length; };
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'onDock') return (cb) => { window.__cbs.dock = cb; };
  if (k === 'onTrWait') return (cb) => { window.__cbs.trWait.push(cb); };
  if (k === 'dockGet') return async () => window.__dock || null;
  if (k === 'trConfig') return async () => ({ config: JSON.parse(JSON.stringify(cfg)), modes: [] });
  if (k === 'trPage') return hang('trPage');
  if (k === 'trRun') return hang('trRun');
  if (k === 'trPageCancel') return cancel('trPageCancel');
  if (k === 'trCancel') return cancel('trCancel');
  return async () => null;
} });
