// 自带弹窗里排着的卡片：不碰 Electron，方便单独自检（scripts/check-notify.js）。
//
// 规则（shen 2026-10-27 定的 B 样式）：
// - 最新的在最上面；同一个 key（同一个号的同一个客户）再来，合并成一张，移到最上面
// - 最多同时摆 3 张，多出来的显示成“还有 N 条”
// - 每张显示 durationMs 后自动收走；0 表示不自动收
// - 用户离开电脑超过 5 分钟：期间的卡片不再自动消失，要手动一张一张点（makeSticky）
// - 倒计时只在“用户看得见、又在用电脑”的时候走：每张卡记剩余毫秒（leftMs），由 popup.js 决定什么时候
//   调 advance() 扣时间——鼠标停在弹窗上、藏在“还有 N 条”后面、窗口还没显示、用户没动鼠标没按键时都不扣
const MAX_SHOWN = 3;
const MAX_ITEMS = 50; // 再多就把最老的丢掉（“还有 N 条”里不会无限涨）
const HOVER_GRACE_MS = 1500; // 鼠标移开后至少再留这么久，不会一移开就消失

class PopupQueue {
  constructor({ now = () => Date.now(), durationMs = 6000 } = {}) {
    this.now = now;
    this.durationMs = durationMs;
    this.items = []; // 最新的在前
    this.hoverSince = 0; // 鼠标停在弹窗上的开始时间，0 = 没停
    this.seq = 0;
  }

  // 一张卡一开始的剩余时间：0（不自动消失）记成 Infinity
  fullLeft(ms = this.durationMs) { return ms > 0 ? ms : Infinity; }

  // item: { key, ... }，返回放进去的那张（合并时 merged = true）
  push(item) {
    const now = this.now();
    const old = this.items.find((x) => x.key === item.key);
    this.items = this.items.filter((x) => x !== old);
    const merged = !!old;
    const card = { ...item, uid: ++this.seq, at: now, leftMs: this.fullLeft(), merged };
    this.items.unshift(card);
    if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS;
    return card;
  }

  get(uid) { return this.items.find((x) => x.uid === uid) || null; }

  remove(uid) {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.uid !== uid);
    return this.items.length !== before;
  }

  // 按条件删（比如某个号的未读清零了、号被删了）
  removeWhere(fn) {
    const before = this.items.length;
    this.items = this.items.filter((x) => !fn(x));
    return this.items.length !== before;
  }

  clear() { this.items = []; }

  // 改了时长：只有真的变了才动，正在显示的按新时长重新算
  setDuration(ms) {
    if (ms === this.durationMs) return;
    this.durationMs = ms;
    for (const x of this.items) x.leftMs = this.fullLeft(ms);
  }

  setHover(on) {
    if (on) {
      if (!this.hoverSince) this.hoverSince = this.now();
      return;
    }
    if (!this.hoverSince) return;
    this.hoverSince = 0;
    // 移开后至少再留一会儿，鼠标一移开不会马上消失
    for (const x of this.view().shown) if (x.leftMs !== Infinity) x.leftMs = Math.max(x.leftMs, HOVER_GRACE_MS);
  }

  // 过去了 ms 毫秒（调用方只在“看得见、在用电脑”时调；鼠标停在上面时这里也不扣）：
  // 只给前 3 张扣时间，藏在“还有 N 条”后面的不扣；扣完的收走，返回收走了几张
  advance(ms) {
    if (!(ms > 0) || this.hoverSince) return 0;
    const shown = new Set(this.view().shown);
    const before = this.items.length;
    for (const x of this.items) if (shown.has(x) && x.leftMs !== Infinity) x.leftMs -= ms;
    this.items = this.items.filter((x) => x.leftMs > 0);
    return before - this.items.length;
  }

  // 用户离开电脑超过 5 分钟（popup.js 判断）：现在所有的卡都改成不自动消失，回来后要一张一张手动点掉
  makeSticky() {
    let changed = 0;
    for (const x of this.items) if (x.leftMs !== Infinity) { x.leftMs = Infinity; x.sticky = true; changed += 1; }
    return changed;
  }

  // 还有没有会到期的卡（都是“不自动消失”时不用再计时）
  get hasExpiring() { return this.items.some((x) => x.leftMs !== Infinity); }

  view() {
    return { shown: this.items.slice(0, MAX_SHOWN), more: Math.max(0, this.items.length - MAX_SHOWN) };
  }

  get size() { return this.items.length; }
}

module.exports = { PopupQueue, MAX_SHOWN, HOVER_GRACE_MS };
