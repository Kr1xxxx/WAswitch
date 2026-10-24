// 小型本地记录：存成一个 JSON 数组，条数和天数都有上限，写盘延后合并（先写临时文件再改名）。
// 只用来存不敏感的小记录（时间、账号编号、事件类型、毫秒数、错误类型），不存代理地址、账号密码或聊天内容。
const fs = require('fs');

class EventLog {
  // routine：例行记录的类型（比如每 30 分钟一次的巡检），每个号只留最近 routinePerId 条，
  // 不占其他记录（掉线、恢复）的名额，免得例行记录把 7 天的掉线历史挤掉
  constructor(file, { max = 2000, maxAgeMs = 7 * 24 * 3600 * 1000, delayMs = 2000, routine = [], routinePerId = 50 } = {}) {
    this.file = file;
    this.max = max;
    this.routine = new Set(routine);
    this.routinePerId = routinePerId;
    this.maxAgeMs = maxAgeMs;
    this.delayMs = delayMs;
    this.items = null;
    this.timer = null;
  }

  load() {
    if (this.items) return this.items;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.items = Array.isArray(raw) ? raw.filter((e) => e && Number.isFinite(e.at) && typeof e.id === 'string' && typeof e.kind === 'string') : [];
    } catch {
      this.items = []; // 没有文件或文件坏了：从空的开始（只是记录，丢了不影响使用）
    }
    this.trim();
    return this.items;
  }

  trim() {
    const cutoff = Date.now() - this.maxAgeMs;
    let i = 0;
    while (i < this.items.length && this.items[i].at < cutoff) i += 1;
    if (i) this.items.splice(0, i);
    // 从新到旧数：例行记录每个号留 routinePerId 条，其他记录一共留 max 条
    const perId = new Map();
    let others = 0;
    const keep = new Array(this.items.length);
    for (let j = this.items.length - 1; j >= 0; j -= 1) {
      const e = this.items[j];
      if (this.routine.has(e.kind)) {
        const n = (perId.get(e.id) || 0) + 1;
        perId.set(e.id, n);
        keep[j] = n <= this.routinePerId;
      } else {
        others += 1;
        keep[j] = others <= this.max;
      }
    }
    if (keep.includes(false)) this.items = this.items.filter((_e, j) => keep[j]);
  }

  add(entry) {
    this.load();
    this.items.push({ at: Date.now(), ...entry });
    this.trim();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.write(); }, this.delayMs);
  }

  write() {
    try {
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.items || []));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      console.warn('记录保存失败', e.message);
    }
  }

  // 退出前把还没写盘的写掉
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    this.items = [];
    try { fs.rmSync(this.file, { force: true }); } catch {}
  }
}

module.exports = { EventLog };
