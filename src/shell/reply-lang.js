// 工作台“回复”的语言：左边原文语言（默认自动检测），右边目标语言（默认自动选择）。
// 自动 = 中文翻成客户的语言（客户资料 / 认出来的，认不出就英语），别的语言都翻成中文（shen 2026-10-28）。
// 对方写的就是中文（autoTarget 为中文）时，写中文不翻：原文就是要发的话（shen 2026-11-06）。
// 纯函数，渲染进程和 node 自检脚本都能用。
(function (root) {
  const NOT_HAN = '[^\\s\\u3400-\\u4dbf\\u4e00-\\u9fff]';
  const URL_RE = new RegExp(`(?:https?://|www\\.)${NOT_HAN}+`, 'gi');
  const MAIL_RE = new RegExp(`${NOT_HAN}+@${NOT_HAN}+\\.${NOT_HAN}+`, 'g');
  // 汉字数不少于外文单词数就算中文（中文里夹几个英文行业词还是中文）；没写字也按中文（默认是写中文回客户）
  function isChinese(text) {
    // 链接、邮箱、@账号里的英文单词不算（“看这个 https://…/lace-front-wig” 还是中文）
    const t = String(text || '').slice(0, 2000).replace(URL_RE, ' ').replace(MAIL_RE, ' ').replace(/@\w+/g, ' ');
    const han = (t.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    const words = (t.replace(/[\u3400-\u4dbf\u4e00-\u9fff]/g, ' ').match(/\p{L}+/gu) || []).length;
    if (!han && !words) return true;
    return han > 0 && han >= words;
  }
  // src：手动选的原文语言，'' = 自动检测；manual：手动选的目标语言，'' = 自动选择
  // autoTarget：中文要翻成的语言（客户的语言）。返回 { source, target }，source 为 '' 表示交给模型自己认
  function pick({ text, src, manual, autoTarget } = {}) {
    const source = src || (isChinese(text) ? '中文' : '');
    if (manual) return { source, target: manual };
    return { source, target: source === '中文' ? autoTarget || '英语' : '中文' };
  }
  // 不用翻：没手动选目标语言，写的是中文，客户也用中文。这时原文就是译文，不调模型
  function noTr(p = {}) {
    const r = pick(p);
    return !p.manual && r.source === '中文' && r.target === '中文';
  }
  // ⇄：原文和目标对调。认不出原文语言时（自动检测、写的不是中文）对调后的目标按英语；中文对中文（不用翻）对调后是中文翻英语
  function swap(p) {
    const cur = pick(p);
    if (cur.source === '中文' && cur.target === '中文') return { src: '中文', manual: '英语' };
    return { src: cur.target, manual: cur.source || '英语' };
  }
  const api = { isChinese, pick, noTr, swap };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReplyLang = api;
})(typeof window !== 'undefined' ? window : globalThis);
