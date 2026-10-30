// 工作台收到消息的译文：点气泡右下角的时间，弹出这条是什么时候翻的、用了多久、哪个模型（shen 2026-10-30）。
// via 是主进程记的 { at: 翻的时间, ms: 用时, name: 服务商, model: 模型, fix: 是不是纠错 }（floatcore.js），老记录只有 at 和 fix。
// 纯函数，渲染进程和 node 自检脚本都能用。
(function (root) {
  const pad = (n) => String(n).padStart(2, '0');
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  // 按本机时间：今天 20:45，昨天 昨天 20:45，今年更早 10月28日 20:45，不是今年 2025年10月28日 20:45
  function when(at, now = Date.now()) {
    const d = new Date(at);
    const n = new Date(now);
    const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const days = Math.round((dayStart(n) - dayStart(d)) / 864e5);
    if (days === 0) return clock;
    if (days === 1) return `昨天 ${clock}`;
    if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
  }

  // 10 秒以内一位小数，10 秒以上取整，一分钟以上 1 分 5 秒
  function took(ms) {
    const tenths = Math.round(ms / 100);
    if (tenths < 100) return `${(tenths / 10).toFixed(1)} 秒`;
    const secs = Math.round(ms / 1000);
    if (secs < 60) return `${secs} 秒`;
    const m = Math.floor(secs / 60);
    const r = secs % 60;
    return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  }

  // 和翻译页一样：服务商名加模型名，没有模型名的只写名字
  const who = (name, model) => [name, model].filter((x) => typeof x === 'string' && x).join(' ');

  // [[标签, 值], …]：缺哪项就没有哪一行
  function rows(via, now = Date.now()) {
    if (!via || !Number.isFinite(via.at)) return [];
    const out = [[via.fix ? '纠错时间' : '翻译时间', when(via.at, now)]];
    if (Number.isFinite(via.ms) && via.ms >= 0) out.push(['用时', took(via.ms)]);
    const m = who(via.name, via.model);
    if (m) out.push(['模型', m]);
    return out;
  }

  // 这条的时间能不能点：有译文（翻好的）、页面上读到了消息时间、记着翻译情况
  const openable = (it) => !!it && it.state === 'done' && !!it.t && rows(it.via).length > 0;

  const api = { when, took, who, rows, openable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TrInfo = api;
})(typeof window !== 'undefined' ? window : globalThis);
