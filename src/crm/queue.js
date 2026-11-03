// CRM 同步的本机待发队列：采集到的单聊消息先存在这里，由 upload.js 传到来财。
// 规则（审计要求）：
//   - 整个文件用 safeStorage 加密；系统不能真正加密时（例如开发用的 Linux 只有 basic_text）不允许开同步
//   - 写盘先写临时文件再改名；文件坏了就备份并从空队列开始
//   - 去重只存 hash(账号|消息编号)，每个号最多 20000 条
//   - 每个号两张表：items 待发；held 来财说“对方还不是客户”、先留着的（每小时再传一次）
//   - 消息最多留 30 天，全部加起来最多 1 GB（公司电脑），超了先丢最早的
//   - 整个文件每次都整体重写：队列大时写盘间隔拉长（SAVE_DELAY_BIG_MS）
//   - 关开关、号被收回、电脑被停用、换成私人号：调用 purge，队列和去重表一起删
//   - 内容不写日志、不给悬浮窗和 MCP；stats() 只给条数
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canEncrypt } = require('../secure-storage');
const { writeFileAtomic } = require('../atomic');

const FILE = 'crm-queue.bin';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_SEEN = 20000;
const MAX_TEXT = 4000;
const MAX_NAME = 100;
const SAVE_DELAY_MS = 2000;
const BIG_BYTES = 8 * 1024 * 1024; // 队列超过这么大：写盘最多 30 秒一次（每次都要整个重写）
const SAVE_DELAY_BIG_MS = 30 * 1000;
const HELD_RETRY_MS = 60 * 60 * 1000; // 来财说先留着的，每小时再传一次
const itemSize = (x) => x.text.length * 3 + (x.name ? x.name.length * 3 : 0) + 100;

// 对方的 WhatsApp 名字：去掉多余空白，最多 100 个字符；像号码的（没存名字时网页版标题就是号码）不要
function cleanName(raw) {
  const v = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!v || /^[+\d\s().-]+$/.test(v)) return '';
  return Array.from(v).slice(0, MAX_NAME).join('');
}

// WhatsApp 自己的消息编号：网页版的编号形如 "false_8613800000000@c.us_3EB0..."，取最后一段；轻量版本来就是它。
// 同一条消息在网页版和轻量版、换电脑后都一样，来财靠它去重
function keyIdOf(mid) {
  const m = /^(?:true|false)_[^_]+_([A-Za-z0-9]{6,64})$/.exec(mid);
  if (m) return m[1];
  return /^[A-Za-z0-9]{6,64}$/.test(mid) ? mid : '';
}

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
    this.accs = null; // accId -> { since, items: [], held: [], seen: Set, skipped, notime, backfilled }
    this.bytes = 0; // 上次 trim 算出的大小（估计值）
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
        const ok = (x) => x && typeof x.h === 'string' && typeof x.text === 'string' && Number.isFinite(x.at);
        this.accs.set(id, {
          since: a.since,
          items: Array.isArray(a.items) ? a.items.filter(ok) : [],
          held: Array.isArray(a.held) ? a.held.filter(ok) : [],
          seen: new Set(Array.isArray(a.seen) ? a.seen.filter((h) => typeof h === 'string').slice(-MAX_SEEN) : []),
          skipped: Number.isInteger(a.skipped) ? a.skipped : 0,
          notime: Number.isInteger(a.notime) ? a.notime : 0,
          // 这个版本以前就在采集的号也没有这个标记：轻量号补传一次最近 30 天
          backfilled: a.backfilled === true,
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

  // 这个号开始采集：记下开始时间（只收这之后的消息）。已经开着就返回原来的时间
  enable(accId) {
    const accs = this.load();
    if (!accs.has(accId)) {
      accs.set(accId, { since: this.now(), items: [], held: [], seen: new Set(), skipped: 0, notime: 0, backfilled: false });
      this.saveSoon();
    }
    return accs.get(accId).since;
  }

  since(accId) {
    const a = this.load().get(accId);
    return a ? a.since : 0;
  }

  enabledIds() { return [...this.load().keys()]; }

  // 轻量号第一次开始采集时，把本机最近 30 天的单聊补传一次（见 main.js crmBackfill）
  needsBackfill(accId) {
    const a = this.load().get(accId);
    return !!a && !a.backfilled;
  }
  markBackfilled(accId) {
    const a = this.load().get(accId);
    if (!a || a.backfilled) return;
    a.backfilled = true;
    this.saveSoon();
  }

  // 关开关、号被收回、电脑被停用、换成私人号、删号：队列和去重表一起删
  purge(accId) {
    if (this.load().delete(accId)) this.saveNow();
  }

  // item: { mid, peer, out, at, approx?, text, name? }。返回是否新加入。
  // backfill：补传本机已有的旧消息，不看开始时间，只要在 30 天内
  add(accId, item, { backfill = false } = {}) {
    const a = this.load().get(accId);
    if (!a || !item || typeof item.mid !== 'string' || !item.mid) return false;
    const at = Number(item.at);
    if (!Number.isFinite(at)) return false;
    if (backfill ? at < this.now() - MAX_AGE_MS : at < a.since) return false;
    const h = hashOf(accId, item.mid);
    if (a.seen.has(h)) return false;
    a.seen.add(h);
    if (a.seen.size > MAX_SEEN) a.seen.delete(a.seen.values().next().value);
    // 号码只收 8～15 位（国际号码最长 15 位，和来财一致）；不合格的只计数
    if (!/^\d{8,15}$/.test(String(item.peer || ''))) { a.skipped += 1; this.saveSoon(); return false; }
    const x = { h, k: keyIdOf(item.mid), peer: String(item.peer), out: item.out === true, at: Math.round(at), approx: item.approx === true, text: Array.from(String(item.text || '')).slice(0, MAX_TEXT).join('') };
    const name = cleanName(item.name);
    if (name) x.name = name;
    // 补传的旧消息按时间插到前面（上传先传早的）；新消息直接放最后
    if (a.items.length && a.items[a.items.length - 1].at > x.at) {
      const i = a.items.findIndex((y) => y.at > x.at);
      a.items.splice(i, 0, x);
    } else a.items.push(x);
    this.bytes += itemSize(x);
    if (this.bytes > MAX_BYTES) this.trim();
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
    return a ? { on: true, since: a.since, queued: a.items.length, held: a.held.length, skipped: a.skipped, notime: a.notime || 0 } : { on: false, queued: 0, held: 0, skipped: 0, notime: 0 };
  }

  // 上传时用：取出最早的一批（不删，来财回答后再 ack / settle）
  peek(accId, max = 500) {
    this.sweep();
    const a = this.load().get(accId);
    return a ? a.items.slice(0, max).map((x) => ({ ...x })) : [];
  }

  // 先留着的消息里到了再传时间的（每小时一次）
  peekHeld(accId, max = 500) {
    this.sweep();
    const a = this.load().get(accId);
    if (!a) return [];
    const now = this.now();
    return a.held.filter((x) => !(x.retryAt > now)).slice(0, max).map((x) => ({ ...x }));
  }

  // 旧后台（不回每条结果）：这批全部删掉
  ack(accId, hashes) {
    const a = this.load().get(accId);
    if (!a) return;
    const done = new Set(hashes);
    a.items = a.items.filter((x) => !done.has(x.h));
    a.held = a.held.filter((x) => !done.has(x.h));
    this.saveSoon();
  }

  // 来财对每条的回答：stored / duplicate / rejected 删掉；held（对方还不是客户）留到 held 表，一小时后再传。
  // results: [{ h, status }]。不认识的回答当 held（留着比丢掉安全，30 天后自动清掉）
  settle(accId, results) {
    const a = this.load().get(accId);
    if (!a) return { done: 0, held: 0 };
    const status = new Map(results.map((r) => [r.h, r.status]));
    const retryAt = this.now() + HELD_RETRY_MS;
    let done = 0;
    let held = 0;
    const keep = (x) => {
      const st = status.get(x.h);
      if (st === undefined) return true;
      if (st === 'stored' || st === 'duplicate' || st === 'rejected') { done += 1; return false; }
      return null; // held
    };
    const moved = [];
    a.items = a.items.filter((x) => { const k = keep(x); if (k === null) { moved.push(x); return false; } return k; });
    a.held = a.held.filter((x) => { const k = keep(x); if (k === null) { x.retryAt = retryAt; held += 1; } return k !== false; });
    for (const x of moved) { x.retryAt = retryAt; a.held.push(x); held += 1; }
    if (moved.length) a.held.sort((p, q) => p.at - q.at);
    this.saveSoon();
    return { done, held };
  }

  // 启动、读取和主进程定时器都清理；没有新消息时也不能无限保留旧内容。
  sweep() {
    this.load();
    if (this.trim()) this.saveNow();
  }

  // 超过 30 天的删掉（待发和先留着的都一样）；总大小超了先丢所有号里最早的一条
  trim() {
    const cut = this.now() - MAX_AGE_MS;
    let size = 0;
    let changed = false;
    const lists = [];
    for (const a of this.accs.values()) {
      for (const key of ['items', 'held']) {
        const before = a[key].length;
        a[key] = a[key].filter((x) => x.at >= cut);
        if (a[key].length !== before) changed = true;
        for (const x of a[key]) size += itemSize(x);
        lists.push([a, key]);
      }
    }
    while (size > MAX_BYTES) {
      let oldest = null;
      for (const [a, key] of lists) if (a[key].length && (!oldest || a[key][0].at < oldest[0][oldest[1]][0].at)) oldest = [a, key];
      if (!oldest) break;
      const x = oldest[0][oldest[1]].shift();
      changed = true;
      size -= itemSize(x);
    }
    this.bytes = size;
    return changed;
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.saveNow(); }, this.bytes > BIG_BYTES ? SAVE_DELAY_BIG_MS : SAVE_DELAY_MS);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  saveNow() {
    if (this.timer) { this.timers.clearTimeout(this.timer); this.timer = null; }
    if (!this.accs) return;
    try {
      if (!this.accs.size) { fs.rmSync(this.file, { force: true }); return; }
      if (!this.canEncrypt()) throw new Error('系统不能加密，队列不写盘');
      this.trim();
      const accs = {};
      for (const [id, a] of this.accs) accs[id] = { ...a, seen: [...a.seen] };
      const data = { v: 1, accs };
      writeFileAtomic(this.file, this.safe.encryptString(JSON.stringify(data)), { mode: 0o600 });
    } catch (e) {
      this.onError(e);
    }
  }
}

module.exports = { CrmQueue, canEncrypt, hashOf, keyIdOf, cleanName, MAX_SEEN, MAX_AGE_MS, MAX_BYTES, HELD_RETRY_MS };

