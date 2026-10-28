// 删除、清空以后留一小会儿可以撤销（界面底部显示「已删除…　撤销」）。
// 只记最近一次：再删别的，前一次就不能撤销了。超过 UNDO_MS 也不能撤销。
const UNDO_MS = 15000;

class UndoSlot {
  constructor(now = Date.now) {
    this.now = now;
    this.entry = null;
    this.seq = 0;
  }

  // restore：撤销时调用，把删掉的放回去。返回编号，撤销时带回来
  put(restore) {
    this.seq += 1;
    this.entry = { token: this.seq, at: this.now(), restore };
    return this.seq;
  }

  // 编号对得上、没过期才撤销。返回 true 表示已经放回去
  run(token) {
    const e = this.entry;
    if (!e || e.token !== token || this.now() - e.at > UNDO_MS) return false;
    this.entry = null;
    e.restore();
    return true;
  }
}

// 提示里显示的名字：合并空白，太长截断
const shortName = (t, n = 30) => {
  const x = String(t || '').replace(/\s+/g, ' ').trim();
  return x.length > n ? `${x.slice(0, n)}…` : x;
};

module.exports = { UndoSlot, UNDO_MS, shortName };
