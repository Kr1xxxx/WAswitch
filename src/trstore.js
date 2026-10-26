// 收到的消息的译文永久存在本机磁盘上（shen 2026-10-26：切回对话、重启软件都直接显示，不再调模型、不耗额度）。
// 每个号一个文件夹，每个对话一个文件：<dir>/<号>/<对话 hash>.json，里面是 { 原文 hash: { tr, edited, fixed, at } }。
// 不存原文和号码，只存原文的 hash 和译文。按原文认（同一对话里同样的话只翻一次），消息编号变了也认得出。
// 不设条数上限、不自动清理；只在用到某个对话时读它的文件，内存里只留最近用过的几个对话。删号时整个文件夹删掉。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEEP_IN_MEMORY = 20; // 内存里最多留 20 个对话的译文
const textKey = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 24);
const safe = (s) => /^[A-Za-z0-9_-]{1,80}$/.test(String(s));

class TrStore {
  constructor(dir) {
    this.dir = dir;
    this.mem = new Map(); // `${acc}/${chat}` -> { data, dirty }
    this.timer = null;
  }

  file(acc, chat) { return path.join(this.dir, acc, `${chat}.json`); }

  load(acc, chat) {
    if (!safe(acc) || !safe(chat)) return null;
    const k = `${acc}/${chat}`;
    let e = this.mem.get(k);
    if (e) { this.mem.delete(k); this.mem.set(k, e); return e; } // 挪到最近用过
    let data = {};
    try {
      const v = JSON.parse(fs.readFileSync(this.file(acc, chat), 'utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) data = v;
    } catch { /* 没有或坏了：当空的 */ }
    e = { data, dirty: false };
    this.mem.set(k, e);
    this.trim();
    return e;
  }

  // 内存里超过的对话：先写盘再丢
  trim() {
    while (this.mem.size > KEEP_IN_MEMORY) {
      const [k, e] = this.mem.entries().next().value;
      if (e.dirty) this.write(k, e);
      this.mem.delete(k);
    }
  }

  get(acc, chat, text) {
    const e = this.load(acc, chat);
    const r = e && e.data[textKey(text)];
    return r && typeof r.tr === 'string' && r.tr ? r : null;
  }

  put(acc, chat, text, rec) {
    const e = this.load(acc, chat);
    if (!e || !rec || typeof rec.tr !== 'string' || !rec.tr.trim()) return;
    e.data[textKey(text)] = { tr: rec.tr.slice(0, 4000), edited: !!rec.edited, fixed: !!rec.fixed, at: Date.now() };
    e.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1000);
  }

  write(k, e) {
    const [acc, chat] = k.split('/');
    try {
      fs.mkdirSync(path.join(this.dir, acc), { recursive: true });
      const f = this.file(acc, chat);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(e.data));
      fs.renameSync(`${f}.tmp`, f);
      e.dirty = false;
    } catch (err) { console.warn(`译文保存失败：${err.message}`); }
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const [k, e] of this.mem) if (e.dirty) this.write(k, e);
  }

  forgetAccount(acc) {
    for (const k of [...this.mem.keys()]) if (k.startsWith(`${acc}/`)) this.mem.delete(k);
    if (!safe(acc)) return;
    try { fs.rmSync(path.join(this.dir, acc), { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

module.exports = { TrStore, textKey };
