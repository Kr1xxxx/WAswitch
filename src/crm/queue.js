// CRM 同步的本机待发队列：采集到的单聊消息先存在这里，由 upload.js 传到来财。
// 规则（审计要求）：
//   - 整个文件用 safeStorage 加密；系统不能真正加密时（例如开发用的 Linux 只有 basic_text）不允许开同步
//   - 写盘先写临时文件再改名
//   - 系统还不能加密（safeStorage 没准备好）：文件不动、不读不写，能加密了再读
//   - 解不开：改名成 .bad-<时间> 从空队列开始；之后每 30 分钟再试最新的一个，解开了就并回来；
//     .bad 文件 30 天后删，换了人登录时也删（dropBad）
//   - 去重只存 hash(账号|消息编号)，每个号最多 20000 条
//   - 每个号两张表：items 待发；held 来财说“对方还不是客户”、先留着的（每小时再传一次）
//   - 消息最多留 30 天；全部加起来最多约 400 MB（整个文件要一次写成一个字符串，太大就写不进去），
//     超了先丢最早的 held（等建档的），没有 held 了再丢最早的待发，丢了多少记在 dropped 里给团队页看
//   - 整个文件每次都整体重写：队列大时写盘间隔拉长（SAVE_DELAY_BIG_MS）
//   - 号被收回、来财不再同步、删号、换人登录：调用 purge，队列和去重表一起删；退出登录不删
//   - 内容不写日志、不给悬浮窗和 MCP；stats() 只给条数
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canEncrypt } = require('../secure-storage');
const { writeFileAtomic } = require('../atomic');

const FILE = 'crm-queue.bin';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MAX_BYTES = 400 * 1024 * 1024; // 估算的写盘大小上限（V8 一个字符串最多约 5 亿个字符）
const MAX_SEEN = 20000;
const MAX_TEXT = 4000;
const MAX_NAME = 100;
const SAVE_DELAY_MS = 2000;
const BIG_BYTES = 8 * 1024 * 1024; // 队列超过这么大：写盘最多 30 秒一次（每次都要整个重写）
const SAVE_DELAY_BIG_MS = 30 * 1000;
const HELD_RETRY_MS = 60 * 60 * 1000; // 来财说先留着的，每小时再传一次
const BAD_RETRY_MS = 30 * 60 * 1000; // 解不开的旧文件每 30 分钟再试一次
const BAD_KEEP_MS = MAX_AGE_MS; // 解不开的旧文件留 30 天
const BAD_RE = /^crm-queue\.bin\.bad-(\d+)$/;
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

// 这个号现在不采集时，本机队列要不要留着。
// 留着：电脑被停用（403）、登录失效（401）、退出登录、还没登录、号暂时停着——员工重新登录后接着传；
// 同一个人换了设备、升级换了后台，号在重新加入（teamKeepQueue）。
// 删掉：号被收回（隐藏）、来财不再同步这个号、号删了、不再是团队号（换人登录时 login() 清掉 teamId，不留队列）
function keepQueue(acc) {
  if (!acc || acc.teamHidden) return false;
  return !!((acc.teamId && acc.teamCrm) || acc.teamKeepQueue);
}

function parseAccs(data) {
  const out = new Map();
  for (const [id, a] of Object.entries((data && data.accs) || {})) {
    if (!/^\d+$/.test(id) || !a || !Number.isFinite(a.since)) continue;
    const ok = (x) => x && typeof x.h === 'string' && typeof x.text === 'string' && Number.isFinite(x.at);
    out.set(id, {
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
  return out;
}

// 两份队列并成一份（重新解开的旧文件并回现在的）：同一条（hash 一样）只留一份
function mergeAcc(a, b) {
  const union = (x, y) => {
    const have = new Set(x.map((i) => i.h));
    return [...x, ...y.filter((i) => !have.has(i.h))].sort((p, q) => p.at - q.at);
  };
  const seen = new Set([...b.seen, ...a.seen]);
  return {
    since: Math.min(a.since, b.since),
    items: union(a.items, b.items),
    held: union(a.held, b.held),
    seen: new Set([...seen].slice(-MAX_SEEN)),
    skipped: Math.max(a.skipped, b.skipped),
    notime: Math.max(a.notime || 0, b.notime || 0),
    backfilled: a.backfilled || b.backfilled,
  };
}

class CrmQueue {
  // deps: { dir, safeStorage, now?, onError?, maxBytes?（自检用小一点的上限） }
  constructor({ dir, safeStorage, now = Date.now, onError = () => {}, timers = { setTimeout, clearTimeout }, maxBytes = MAX_BYTES }) {
    this.file = path.join(dir, FILE);
    this.maxBytes = maxBytes;
    this.safe = safeStorage;
    this.now = now;
    this.onError = onError;
    this.timers = timers;
    this.timer = null;
    this.accs = null; // accId -> { since, items: [], held: [], seen: Set, skipped, notime, backfilled }
    this.bytes = 0; // 上次 trim 算出的大小（估计值）
    this.unreadable = false; // 文件在，但系统还不能解密：不读不写，等能加密了再读
    this.badAt = 0; // 上次再试 .bad 文件的时间
    this.dropped = { n: 0, at: 0 }; // 超过大小上限丢掉的条数（团队页显示一行）
  }

  dir() { return path.dirname(this.file); }
  badFiles() {
    let names = [];
    try { names = fs.readdirSync(this.dir()); } catch { return []; }
    return names.map((f) => BAD_RE.exec(f)).filter(Boolean).map((m) => ({ file: path.join(this.dir(), m[0]), at: Number(m[1]) })).sort((p, q) => q.at - p.at);
  }
  decode(buf) {
    try { return parseAccs(JSON.parse(this.safe.decryptString(buf))); } catch { return null; }
  }
  merge(map) {
    for (const [id, a] of map) this.accs.set(id, this.accs.has(id) ? mergeAcc(this.accs.get(id), a) : a);
  }

  // 解不开的旧文件：超过 30 天的删掉；最新的一个每 30 分钟再试一次，解开了并回来、删掉文件
  checkBad(force = false) {
    if (!this.accs || this.unreadable || !this.canEncrypt()) return;
    if (!force && this.now() - this.badAt < BAD_RETRY_MS) return;
    this.badAt = this.now();
    const bad = this.badFiles();
    for (const b of bad) if (b.at < this.now() - BAD_KEEP_MS) { try { fs.rmSync(b.file, { force: true }); } catch { /* 下次再删 */ } }
    const newest = bad.find((b) => b.at >= this.now() - BAD_KEEP_MS);
    if (!newest) return;
    let buf;
    try { buf = fs.readFileSync(newest.file); } catch { return; }
    const map = this.decode(buf);
    if (!map) return;
    this.merge(map);
    this.saveNow();
    if (!this.unreadable) { try { fs.rmSync(newest.file, { force: true }); } catch { /* 下次再删 */ } }
  }

  // 换了人登录：解不开的旧队列（上一个人的聊天）一起删
  dropBad() {
    for (const b of this.badFiles()) { try { fs.rmSync(b.file, { force: true }); } catch { /* 下次再删 */ } }
  }

  canEncrypt() { return canEncrypt(this.safe); }

  // 文件之前读不了（系统还不能加密）而现在能了：重新读，读到的和这期间内存里的并在一起
  load() {
    if (this.accs && !(this.unreadable && this.canEncrypt())) return this.accs;
    const mem = this.accs;
    this.accs = new Map();
    this.unreadable = false;
    let buf = null;
    try { buf = fs.readFileSync(this.file); } catch { /* 没有文件 */ }
    if (buf) {
      // 系统还不能加密（启动早期 safeStorage 没准备好、钥匙环没解锁）：文件原样留着，能加密了再读（sweep）
      if (!this.canEncrypt()) { this.unreadable = true; return this.accs; }
      const map = this.decode(buf);
      if (map) this.accs = map;
      else {
        // 解不开（文件坏了、钥匙环拒绝）：改名留着，从空队列开始；checkBad 之后再试
        try { fs.renameSync(this.file, `${this.file}.bad-${this.now()}`); } catch { /* 改名失败就算了 */ }
        this.badAt = this.now(); // 刚失败的不马上再试
      }
    }
    if (mem) this.merge(mem);
    this.checkBad(!buf);
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
  // 重新加入的号：再补传一次（main.js crmReconcile 看 teamRebackfill）
  rebackfill(accId) {
    const a = this.load().get(accId);
    if (!a || !a.backfilled) return;
    a.backfilled = false;
    this.saveSoon();
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
    // 号码只收 8～15 位、不以 0 开头（国际号码最长 15 位，和来财一致）；不合格的只计数
    if (!/^[1-9]\d{7,14}$/.test(String(item.peer || ''))) { a.skipped += 1; this.saveSoon(); return false; }
    const x = { h, k: keyIdOf(item.mid), peer: String(item.peer), out: item.out === true, at: Math.round(at), approx: item.approx === true, text: Array.from(String(item.text || '')).slice(0, MAX_TEXT).join('') };
    const name = cleanName(item.name);
    if (name) x.name = name;
    // 补传的旧消息按时间插到前面（上传先传早的）；新消息直接放最后
    if (a.items.length && a.items[a.items.length - 1].at > x.at) {
      const i = a.items.findIndex((y) => y.at > x.at);
      a.items.splice(i, 0, x);
    } else a.items.push(x);
    this.bytes += itemSize(x);
    if (this.bytes > this.maxBytes) this.trim();
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
    if (this.unreadable) return;
    this.checkBad();
    if (this.trim()) this.saveNow();
  }

  // 超过 30 天的删掉（待发和先留着的都一样）；总大小超了先丢最早的 held（等建档的），没有了再丢最早的待发
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
    let dropped = 0;
    for (const kind of ['held', 'items']) {
      const own = lists.filter(([, key]) => key === kind);
      // 每个表按时间排好，从最早的一端成批丢（不一条条 shift，大队列也快）
      const cut = new Map(own.map(([a]) => [a, 0]));
      while (size > this.maxBytes) {
        let oldest = null;
        for (const [a] of own) { const i = cut.get(a); if (i < a[kind].length && (!oldest || a[kind][i].at < oldest[kind][cut.get(oldest)].at)) oldest = a; }
        if (!oldest) break;
        const i = cut.get(oldest);
        size -= itemSize(oldest[kind][i]);
        cut.set(oldest, i + 1);
        dropped += 1;
      }
      for (const [a, n] of cut) if (n) a[kind] = a[kind].slice(n);
    }
    if (dropped) {
      changed = true;
      this.dropped = { n: this.dropped.n + dropped, at: this.now() };
      this.onError(new Error(`本机队列太大，丢掉最早的 ${dropped} 条`));
    } else if (this.dropped.n && size < this.maxBytes * 0.9) {
      this.dropped = { n: 0, at: 0 }; // 队列传掉一些、回到上限以下了：团队页那句话不再显示
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
    if (!this.accs || this.unreadable) return; // 读不了的文件不能被空队列覆盖或删掉
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

module.exports = { CrmQueue, canEncrypt, hashOf, keyIdOf, cleanName, keepQueue, MAX_SEEN, MAX_AGE_MS, MAX_BYTES, HELD_RETRY_MS, BAD_RETRY_MS };

