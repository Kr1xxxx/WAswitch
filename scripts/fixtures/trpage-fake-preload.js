// 翻译页忙碌 / 取消自检用：假的主进程接口。trPage 一直挂着，等自检放行（__release）或被 trPageCancel 取消
window.__cbs = {};
window.__calls = [];
window.__pending = [];
// 翻译只走来财：只有一个「模型」，翻译页没有对照栏、没有模型下拉
const cfg = { providers: [{ id: 'cloud', preset: 'cloud', name: '来财', model: 'DeepSeek' }], primaryId: 'cloud', fallbackId: '', fixId: 'cloud', langs: ['英语', '德语', '中文'] };
window.__release = (text) => { const p = window.__pending.shift(); if (p) p({ text }); return !!p; };
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'trConfig') return async () => ({ config: JSON.parse(JSON.stringify(cfg)), modes: [] });
  if (k === 'trPage') return (req) => { window.__calls.push(['trPage', !!req.fix, 'providerId' in req]); return new Promise((res) => window.__pending.push(res)); };
  if (k === 'trPageCancel') return async () => {
    window.__calls.push(['trPageCancel']);
    const p = window.__pending.shift();
    if (p) p({ error: '已取消', kind: 'cancel' });
    return !!p;
  };
  if (k === 'trCancel') return async () => { window.__calls.push(['trCancel']); return true; };
  return async () => null;
} });
