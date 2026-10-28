// 翻译密钥框自检用：假的主进程接口。服务商列表里没有混元（0.5.4 起新装的就是这样）
window.__cbs = {};
window.__calls = [];
const presets = [
  { id: 'hunyuan', name: '腾讯混元', baseUrl: 'https://tokenhub.tencentmaas.com/v1', model: 'hy-mt2-plus', models: ['hy-mt2-plus', 'hy-mt2-lite'] },
  { id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', models: ['glm-4-flash'] },
  { id: 'deepl', name: 'DeepL', baseUrl: 'https://api.deepl.com/v2', model: '' },
];
window.__cfg = { providers: [
  { id: 'z', preset: 'zhipu', name: '智谱', baseUrl: presets[1].baseUrl, model: 'glm-4-flash', hasKey: true, keyTail: 'ab12', thinking: 'disabled' },
  { id: 'd', preset: 'deepl', name: 'DeepL', baseUrl: presets[2].baseUrl, model: '', hasKey: false, keyTail: '', thinking: '' },
], primaryId: 'z', fallbackId: 'd', fixId: 'z', presets, langs: ['英语', '德语', '中文'], deeplCap: 100000, canEncrypt: true, wigTerms: true, lashTerms: true, wigList: [], lashList: [],
  network: { mode: 'system', proxyUrl: '' }, accountLang: {}, accountAuto: {}, dailyCap: 500, dailyCaps: [100, 500, 1000], floatInMode: '', rolePrompt: '' };
const state = () => ({ config: JSON.parse(JSON.stringify(window.__cfg)), modes: [] });
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'trConfig') return async () => state();
  if (k === 'trProviderSave') return async (data) => {
    window.__calls.push(['save', data]);
    let p = data.id && window.__cfg.providers.find((x) => x.id === data.id);
    if (!p) { p = { id: 'new1' }; window.__cfg.providers.push(p); }
    Object.assign(p, { preset: data.preset, name: data.name, baseUrl: data.baseUrl, model: data.model, hasKey: true, keyTail: data.key.slice(-4) });
    return { ok: true, id: p.id, ...state() };
  };
  if (k === 'trRoles') return async (primaryId, fallbackId, fixId) => {
    window.__calls.push(['roles', primaryId, fallbackId, fixId]);
    Object.assign(window.__cfg, { primaryId, fallbackId }, typeof fixId === 'string' ? { fixId } : {});
    return state();
  };
  if (k === 'trTest') return async (id) => { window.__calls.push(['test', id]); return { ok: true }; };
  if (k === 'showPage') return async (page) => { window.__calls.push(['page', page]); };
  return async () => null;
} });
