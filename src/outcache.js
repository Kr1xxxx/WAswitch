// 发出的译文记下来（shen 2026-10-28：话术不要每次都翻）：工作台写回复、话术，同一句中文、同一种语言、同一个模式
// 再翻就直接用上次的译文，不调模型、不耗额度，切换对话、换号、重启软件都还在。
// 中文改了一个字、换了语言、换了模式、改了模式的提示词，都算新的一句，会重新翻；点“重新翻译”（fresh）也重新调模型并更新记录。
// 只记模型翻出来的：纠错、回译、手动改过的不记（改过的可能带着这个客户的名字，不能带到下一个客户）。
// 和收到的译文放在同一个文件夹（见 trstore.js），只存 hash 和译文，在 _out/replies.json，最多留 OUT_MAX 条（最早的先删）。
const OUT_ACC = '_out'; // 账号 id 都是数字，不会撞
const OUT_CHAT = 'replies';
const OUT_MAX = 3000;

function outKey({ text, target, source, mode }) {
  return JSON.stringify(['out', String(text).trim(), target || '', source || '', mode.prompt, Number.isFinite(mode.temperature) ? mode.temperature : null]);
}

// deps: { store: () => TrStore | null, translate(args) -> Promise<result>, warnOf(text, tr) -> [] }
// 返回 run(args, fresh)：args 和 translator.translate 一样（text, mode, target, source, context）
function makeOutTranslate({ store, translate, warnOf = () => [] }) {
  return async function run(args, fresh = false) {
    const ok = args && typeof args.text === 'string' && args.text.trim() && args.mode && typeof args.mode.prompt === 'string';
    const key = ok ? outKey(args) : '';
    const st = store();
    if (key && !fresh && st) {
      const hit = st.get(OUT_ACC, OUT_CHAT, key);
      if (hit) return { text: hit.tr, cached: true, warn: warnOf(args.text, hit.tr) };
    }
    const r = await translate(args);
    const st2 = store(); // 翻译期间存放位置可能换了
    if (key && st2 && r && typeof r.text === 'string' && r.text.trim()) {
      st2.put(OUT_ACC, OUT_CHAT, key, { tr: r.text });
      st2.cap(OUT_ACC, OUT_CHAT, OUT_MAX);
    }
    return r;
  };
}

module.exports = { makeOutTranslate, outKey, OUT_ACC, OUT_CHAT, OUT_MAX };
