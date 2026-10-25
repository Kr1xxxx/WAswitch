// CRM 同步的本机待发队列（第 1 步：只采集、只存本机，不上传）。
// 规则（审计要求）：
//   - 整个文件用 safeStorage 加密；系统不能真正加密时（例如开发用的 Linux 只有 basic_text）不允许开同步
//   - 写盘先写临时文件再改名；文件坏了就备份并从空队列开始
//   - 去重只存 hash(账号|消息编号)，每个号最多 5000 条
//   - 每个号最多留 7 天，全部加起来最多 20 MB，超了先丢最早的
//   - 关开关、号被收回、电脑被停用、换成私人号：调用 purge，队列和去重表一起删
//   - 内容不写日志、不给悬浮窗和 MCP；stats() 只给条数
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canEncrypt } = require('../secure-storage');

const FILE = 'crm-queue.bin';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SEEN = 5000;
const MAX_TEXT = 4000;
const SAVE_DELAY_MS = 2000;

const hashOf = (accId, mid) => crypto.createHash('sha256').update(`${accId}|${mid}`).digest('hex').slice(0, 32);

class CrmQueue {
  // deps: { dir, safeStorage, now?, onError? }
  constructor({ dir, safeStorage, now = Date.now, onError = () => {}, timers = { setTimeout, clearTimeout } }) {
    this.file = path.join(dir, FILE);
    this.safe = safeStorage;
    this.now = now;
    this.onError = onError;
    this.timers = timers;
    this.timer = null;
    this.accs = null; // accId -> { since, items: [], seen: [], skipped: 0 }
  }

  canEncrypt() { return canEncrypt(this.safe); }

  load() {
    if (this.accs) return this.accs;
    this.accs = new Map();
    let buf;
    try { buf = fs.readFileSync(this.file); } catch { return this.accs; }
    try {
      if (!this.canEncrypt()) throw new Error('不能解密');
      const data = JSON.parse(this.safe.decryptString(buf));
      for (const [id, a] of Object.entries(data.accs || {})) {
        if (!/^\d+$/.test(id) || !a || !Number.isFinite(a.since)) continue;
        this.accs.set(id, {
          since: a.since,
          items: Array.isArray(a.items) ? a.items.filter((x) => x && typeof x.h === 'string' && typeof x.text === 'string') : [],
          seen: Array.isArray(a.seen) ? a.seen.filter((h) => typeof h === 'string').slice(-MAX_SEEN) : [],
          skipped: Number.isInteger(a.skipped) ? a.skipped : 0,
          notime: Number.isInteger(a.notime) ? a.notime : 0,
        });
      }
    } catch {
      // 文件坏了（或换了系统钥匙环解不开）：备份后从空队列开始
      try { fs.renameSync(this.file, `${this.file}.bad-${this.now()}`); } catch { /* 改名失败就算了 */ }
      this.accs = new Map();
    }
    if (this.trim()) this.saveNow();
    return this.accs;
  }

  // 这个号开了同步：记下开始时间（只收这之后的消息）。已经开着就返回原来的时间
  enable(accId) {
    const accs = this.load();
    if (!accs.has(accId)) {
      accs.set(accId, { since: this.now(), items: [], seen: [], skipped: 0, notime: 0 });
      this.saveSoon();
    }
    return accs.get(accId).since;
  }

  since(accId) {
    const a = this.load().get(accId);
    return a ? a.since : 0;
  }

  enabledIds() { return [...this.load().keys()]; }

  // 关开关、号被收回、电脑被停用、换成私人号、删号：队列和去重表一起删
  purge(accId) {
    if (this.load().delete(accId)) this.saveNow();
  }

  // item: { mid, peer, out, at, approx?, text }。返回是否新加入
  add(accId, item) {
    const a = this.load().get(accId);
    if (!a || !item || typeof item.mid !== 'string' || !item.mid) return false;
    if (!/^\d{6,20}$/.test(String(item.peer || ''))) return false;
    const at = Number(item.at);
    if (!Number.isFinite(at) || at < a.since) return false;
    const h = hashOf(accId, item.mid);
    if (a.seen.includes(h)) return false;
    a.seen.push(h);
    if (a.seen.length > MAX_SEEN) a.seen.splice(0, a.seen.length - MAX_SEEN);
    a.items.push({ h, peer: String(item.peer), out: item.out === true, at: Math.round(at), approx: item.approx === true, text: String(item.text || '').slice(0, MAX_TEXT) });
    this.trim();
    this.saveSoon();
    return true;
  }

  // 认不出号码（@lid 拿不到真实号码）：只计数
  skip(accId, n = 1) {
    const a = this.load().get(accId);
    if (!a || !(n > 0)) return;
    a.skipped += n;
    this.saveSoon();
  }

  // 网页版读不出时间的旧消息：只计数
  skipNoTime(accId, n = 1) {
    const a = this.load().get(accId);
    if (!a || !(n > 0)) return;
    a.notime = (a.notime || 0) + n;
    this.saveSoon();
  }

  // 只给条数，不给内容（团队页显示）
  stats(accId) {
    this.sweep();
    const a = this.load().get(accId);
    return a ? { on: true, since: a.since, queued: a.items.length, skipped: a.skipped, notime: a.notime || 0 } : { on: false, queued: 0, skipped: 0, notime: 0 };
  }

  // 第 2 步上传时用：取出最早的一批（不删，确认上传成功后再 ack）
  peek(accId, max = 500) {
    this.sweep();
    const a = this.load().get(accId);
    return a ? a.items.slice(0, max).map((x) => ({ ...x })) : [];
  }

  ack(accId, hashes) {
    const a = this.load().get(accId);
    if (!a) return;
    const done = new Set(hashes);
    a.items = a.items.filter((x) => !done.has(x.h));
    this.saveSoon();
  }

  // 启动、读取和主进程定时器都清理；没有新消息时也不能无限保留旧内容。
  sweep() {
    this.load();
    if (this.trim()) this.saveNow();
  }

  trim() {
    const cut = this.now() - MAX_AGE_MS;
    let size = 0;
    let changed = false;
    for (const a of this.accs.values()) {
      const before = a.items.length;
      a.items = a.items.filter((x) => x.at >= cut);
      if (a.items.length !== before) changed = true;
      for (const x of a.items) size += x.text.length * 3 + 100;
    }
    while (size > MAX_BYTES) {
      // 丢掉所有号里最早的一条
      let oldest = null;
      for (const a of this.accs.values()) if (a.items.length && (!oldest || a.items[0].at < oldest.items[0].at)) oldest = a;
      if (!oldest) break;
      const x = oldest.items.shift();
      changed = true;
      size -= x.text.length * 3 + 100;
    }
    return changed;
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.saveNow(); }, SAVE_DELAY_MS);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  saveNow() {
    if (this.timer) { this.timers.clearTimeout(this.timer); this.timer = null; }
    if (!this.accs) return;
    try {
      if (!this.accs.size) { fs.rmSync(this.file, { force: true }); return; }
      if (!this.canEncrypt()) throw new Error('系统不能加密，队列不写盘');
      this.trim();
      const data = { v: 1, accs: Object.fromEntries(this.accs) };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, this.safe.encryptString(JSON.stringify(data)), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.onError(e);
    }
  }
}

module.exports = { CrmQueue, canEncrypt, hashOf, MAX_SEEN, MAX_AGE_MS };

