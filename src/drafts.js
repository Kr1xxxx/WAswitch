// 工作台「回复」框里还没发的草稿（写的话和译文）存在本机：切到别的对话再切回来、重启软件、崩溃以后都还在（2026-10-28）。
// 每个号的每个对话一份，按对话的 hash 认（floatcore.js 的 chatKey，不含号码）。只有一个文件：userData/reply-drafts.json。
// 回复框清空就删掉那一份；删号时删掉这个号的；最多留 DRAFT_MAX 份（最久没动的先删）。改动后 1 秒内写盘，退出前再写一次。
const fs = require('fs');
const { writeJsonAtomic } = require('./atomic');

const DRAFT_MAX = 500;
const TEXT_MAX = 4000; // 和回复框的 maxlength 一样
const OUT_MAX = 8000; // 译文可能比原文长
const WARN_MAX = 10;
const ACC_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CHAT_RE = /^[0-9a-f]{16}$/; // floatcore.js hashOf 的长度

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// 只留认得的字段；什么都没写就是 null（= 删掉）
function clean(d) {
  if (!d || typeof d !== 'object') return null;
  const text = str(d.text, TEXT_MAX);
  const out = str(d.out, OUT_MAX);
  if (!text.trim() && !out.trim()) return null;
  return {
    text,
    out,
    src: str(d.src, TEXT_MAX),
    edited: !!d.edited && !!out,
    fixed: !!d.fixed && !!out,
    warn: out && Array.isArray(d.warn) ? d.warn.filter((w) => typeof w === 'string').slice(0, WARN_MAX).map((w) => w.slice(0, 200)) : [],
  };
}

class DraftStore {
  constructor(file) {
    this.file = file;
    this.data = null; // `${acc}:${chat}` -> { ...draft, at }
    this.dirty = false;
    this.timer = null;
  }

  load() {
    if (this.data) return this.data;
    this.data = new Map();
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, d] of Object.entries(v)) {
          const c = clean(d);
          if (c && /^[^:]+:[0-9a-f]{16}$/.test(k)) this.data.set(k, { ...c, at: Number(d.at) || 0 });
        }
      }
    } catch { /* 没有或坏了：当空的 */ }
    return this.data;
  }

  get(acc, chat) {
    if (!ACC_RE.test(String(acc)) || !CHAT_RE.test(String(chat))) return null;
    const d = this.load().get(`${acc}:${chat}`);
    if (!d) return null;
    const { at, ...rest } = d;
    return { ...rest, warn: [...rest.warn] };
  }

  // 返回 true = 收下了（存了或删了）
  set(acc, chat, draft) {
    if (!ACC_RE.test(String(acc)) || !CHAT_RE.test(String(chat))) return false;
    const data = this.load();
    const k = `${acc}:${chat}`;
    const c = clean(draft);
    if (!c) {
      if (data.delete(k)) this.touch();
      return true;
    }
    data.delete(k); // 挪到最后（最近动过）
    data.set(k, { ...c, at: Date.now() });
    while (data.size > DRAFT_MAX) data.delete(data.keys().next().value);
    this.touch();
    return true;
  }

  forgetAccount(acc) {
    const data = this.load();
    let n = 0;
    for (const k of [...data.keys()]) if (k.startsWith(`${acc}:`)) { data.delete(k); n++; }
    if (n) this.touch();
  }

  touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1000);
    if (this.timer.unref) this.timer.unref(); // 不因为它拖着不退出（退出前 main.js 会 flush）
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty || !this.data) return true;
    try {
      writeJsonAtomic(this.file, Object.fromEntries(this.data));
      this.dirty = false;
      return true;
    } catch (err) {
      console.warn(`回复草稿保存失败：${err.message}`);
      return false;
    }
  }
}

module.exports = { DraftStore, DRAFT_MAX, TEXT_MAX, OUT_MAX, clean };
