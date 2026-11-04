// 设置 › 翻译自检用：假的主进程接口。翻译只走来财，配置里没有服务商、密钥；tr:cloud-status 的回答由自检改 window.__status
window.__cbs = {};
window.__calls = [];
window.__status = { ready: true, overBudget: false };
window.__cfg = {
  providers: [{ id: 'cloud', preset: 'cloud', name: '来财', model: 'DeepSeek' }], primaryId: 'cloud', fallbackId: '', fixId: 'cloud',
  langs: ['英语', '德语', '法语', '西班牙语', '中文'], wigTerms: true, lashTerms: true,
  wigList: [{ zh: '蕾丝前发', en: 'lace front wig' }, { zh: '头套', en: 'wig' }], lashList: [{ zh: '假睫毛', en: 'false lashes' }],
  accountLang: {}, accountAuto: {}, dailyCap: 500, dailyCaps: [100, 500, 1000], floatInMode: '', rolePrompt: '', trPlace: 'inline', loggedIn: true, busy: false,
};
const modes = [{ id: 'm1', name: '商务正式', direction: 'out', prompt: '翻译得正式、礼貌。' }, { id: 'm2', name: '收到的消息', direction: 'in', prompt: '把客户的话翻成中文。' }];
const state = () => ({ config: JSON.parse(JSON.stringify(window.__cfg)), modes: JSON.parse(JSON.stringify(modes)) });
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'trConfig') return async () => state();
  if (k === 'trCloudStatus') return async () => { window.__calls.push(['status']); return JSON.parse(JSON.stringify(window.__status)); };
  if (k === 'showLogin') return () => { window.__calls.push(['login']); };
  if (k === 'showPage') return async (page) => { window.__calls.push(['page', page]); };
  if (k.startsWith('on')) return () => {};
  return async () => null;
} });
