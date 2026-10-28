// 翻译页滚动、翻译页 ⇄、回复草稿自检用：假的主进程接口，只记下回调和存草稿的调用，其余调用什么都不做
window.__cbs = {};
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'onDock') return (cb) => { window.__cbs.dock = cb; };
  if (k === 'dockGet') return async () => window.__dock || null;
  if (k === 'trConfig') return async () => window.__trcfg || null;
  if (k === 'dockDraft') return (acc, chat, d) => { (window.__drafts = window.__drafts || []).push({ acc, chat, d: JSON.parse(JSON.stringify(d)) }); };
  if (k === 'trRun') return (a) => (window.__trRun ? window.__trRun(a) : Promise.resolve({ text: `EN:${a.text}`, warn: [] }));
  if (k === 'dockLang') return async () => window.__dock || null;
  if (k === 'panelInsert') return async () => window.__insertResult || null;
  if (k === 'trPage') return async (a) => { (window.__trCalls = window.__trCalls || []).push(a); return window.__trPage ? window.__trPage(a) : null; };
  return async () => null;
} });
