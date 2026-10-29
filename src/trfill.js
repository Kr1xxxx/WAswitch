// 轻量号：以前存的译文记录里没有原文（2026-10-29 之前只存原文的 hash），按本机聊天缓存（每个对话最多 500 条）在后台慢慢补上，
// 补上后，重启后补回来的旧消息也能展开原文、能纠错（shen 2026-10-29「做一个脚本慢慢补」）。
// 原文 hash 对得上才补，只补进已有的记录：不新建记录、不改译文和时间，翻译栏上正显示着的同一条一起补，不会多出一条。
// 网页号读不到聊天缓存，那条消息又读到时由 floatcore.js 补（不自动往上翻 WhatsApp 页面）。
const { textKey } = require('./trstore');
const { hashOf, liteText } = require('./floatcore');

const GAP = 2000; // 补完一个对话歇 2 秒

// deps: { store: TrStore, accId, jids() -> 有消息的对话, incoming(jid) -> 对方发来的消息文字（旧到新）,
//         alive() -> 还要不要接着补, onFill?(ck, k, text), gap?, sleep? }。返回补上了几条
async function fillLite(deps) {
  const sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  let jids = null;
  try { jids = await deps.jids(); } catch { return 0; }
  let n = 0;
  for (const jid of Array.isArray(jids) ? jids : []) {
    if (!deps.alive()) break;
    if (typeof jid !== 'string' || !jid) continue;
    const ck = hashOf(deps.accId, `chat|${jid.replace(/_/g, '')}`); // 和 fromLite 读到的对话一样算
    const need = deps.store.missingText(deps.accId, ck);
    if (!need.size) continue;
    let texts = null;
    try { texts = await deps.incoming(jid); } catch { texts = null; }
    for (const raw of Array.isArray(texts) ? texts : []) {
      const text = liteText(raw);
      if (!text.trim()) continue;
      const k = textKey(text);
      if (!need.delete(k)) continue;
      if (deps.store.fillText(deps.accId, ck, k, text)) {
        n += 1;
        if (deps.onFill) deps.onFill(ck, k, text);
      }
    }
    await sleep(deps.gap ?? GAP);
  }
  return n;
}

module.exports = { fillLite };
