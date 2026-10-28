// 翻译页忙碌 / 取消自检用：假的主进程接口。trPage 一直挂着，等自检放行（__release）或被 trPageCancel 取消
window.__cbs = {};
window.__calls = [];
window.__pending = [];
const cfg = { providers: [
  { id: 'z', preset: 'zhipu', name: '智谱', model: 'glm-4-flash', hasKey: true },
  { id: 'h', preset: 'hunyuan', name: '腾讯混元', model: 'hunyuan-turbos-latest', hasKey: true },
], primaryId: 'z', fallbackId: 'h', langs: ['英语', '德语', '中文'], deeplCap: 100000 };
window.__release = (text) => { const p = window.__pending.shift(); if (p) p({ text }); return !!p; };
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'trConfig') return async () => ({ config: JSON.parse(JSON.stringify(cfg)), modes: [] });
  if (k === 'trPage') return (req) => { window.__calls.push(['trPage', req.providerId, !!req.fix]); return new Promise((res) => window.__pending.push(res)); };
  if (k === 'trPageCancel') return async () => {
    window.__calls.push(['trPageCancel']);
    const p = window.__pending.shift();
    if (p) p({ error: '已取消', kind: 'cancel' });
    return !!p;
  };
  if (k === 'trCancel') return async () => { window.__calls.push(['trCancel']); return true; };
  return async () => null;
} });
