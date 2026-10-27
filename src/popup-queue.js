// 自带弹窗里排着的卡片：不碰 Electron，方便单独自检（scripts/check-popup.js）。
//
// 规则（shen 2026-10-27 定的 B 样式）：
// - 最新的在最上面；同一个 key（同一个号的同一个客户）再来，合并成一张，移到最上面
// - 最多同时摆 3 张，多出来的显示成“还有 N 条”
// - 每张显示 durationMs 后自动收走；0 表示不自动收；鼠标停在弹窗上时全部暂停，移开后接着算
const MAX_SHOWN = 3;
const MAX_ITEMS = 50; // 再多就把最老的丢掉（“还有 N 条”里不会无限涨）

class PopupQueue {
  constructor({ now = () => Date.now(), durationMs = 6000 } = {}) {
    this.now = now;
    this.durationMs = durationMs;
    this.items = []; // 最新的在前
    this.hoverSince = 0; // 鼠标停在弹窗上的开始时间，0 = 没停
    this.seq = 0;
  }

  // item: { key, ... }，返回放进去的那张（合并时 merged = true）
  push(item) {
    const now = this.now();
    const old = this.items.find((x) => x.key === item.key);
    this.items = this.items.filter((x) => x !== old);
    const merged = !!old;
    const card = { ...item, uid: ++this.seq, at: now, expiresAt: this.durationMs ? now + this.durationMs : 0, merged };
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

  setDuration(ms) {
    const now = this.now();
    this.durationMs = ms;
    // 改了时长：正在显示的按新时长从现在重新算
    for (const x of this.items) x.expiresAt = ms ? now + ms : 0;
  }

  setHover(on) {
    const now = this.now();
    if (on) {
      if (!this.hoverSince) this.hoverSince = now;
      return;
    }
    if (!this.hoverSince) return;
    const paused = now - this.hoverSince;
    this.hoverSince = 0;
    // 停着的这段时间不算：每张往后顺延，至少再留 1.5 秒，鼠标一移开不会马上消失
    for (const x of this.items) if (x.expiresAt) x.expiresAt = Math.max(x.expiresAt + paused, now + 1500);
  }

  // 收走到时间的卡片，返回收走了几张
  tick() {
    if (this.hoverSince) return 0;
    const now = this.now();
    const before = this.items.length;
    this.items = this.items.filter((x) => !x.expiresAt || x.expiresAt > now);
    return before - this.items.length;
  }

  // 下一张到期的时间（没有就是 0），定时器按这个排
  nextExpiry() {
    let t = 0;
    for (const x of this.items) if (x.expiresAt && (!t || x.expiresAt < t)) t = x.expiresAt;
    return t;
  }

  view() {
    return { shown: this.items.slice(0, MAX_SHOWN), more: Math.max(0, this.items.length - MAX_SHOWN) };
  }

  get size() { return this.items.length; }
}

module.exports = { PopupQueue, MAX_SHOWN };
