// 收到的消息的译文永久存在本机磁盘上（shen 2026-10-26：切回对话、重启软件都直接显示，不再调模型、不耗额度）。
// 每个号一个文件夹，每个对话一个文件：<dir>/<号>/<对话 hash>.json，里面是 { 原文 hash: { tr, text, edited, fixed, at } }。
// 按原文的 hash 认（同一对话里同样的话只翻一次），消息编号变了也认得出。
// 原文也存（text，shen 2026-10-29「英文的可以也存吗」「都是自己的电脑」）：补回来的旧消息能展开原文、能纠错。
// 以前存的记录没有原文：网页号等那条消息又读到时补上，轻量号按本机聊天缓存在后台慢慢补（见 trfill.js）。号码不存。
// 另外记着翻译栏显示过哪些消息（_view，只有 hash 和时间），重新打开对话时更早的译文也补回来。
// 轻量号补原文时还记着当时缓存有几条（_fill），缓存没变就不再去要。
// 同一个对话 WhatsApp 可能给两个编号（手机号 @c.us 和隐私编号 @lid，2026 年 WhatsApp 在把私聊换成后者）：
// 每个号记一张别名表（_chats.json，只有 hash）：认出来是同一个对话后，读写都归到最早的那个（老记录都在它下面），
// 别名认出来之前存在别的编号下的也找得到。同一个文件里还记着见过的客户消息在哪个对话（最多 SEEN_MAX 条，先记的先删），
// 重启后换了编号也认得出。
// 不设条数上限、不自动清理；只在用到某个对话时读它的文件，内存里只留最近用过的几个对话。删号时不删（shen 2026-10-26）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('./atomic');

const KEEP_IN_MEMORY = 20; // 内存里最多留 20 个对话的译文
const TR_MAX = 4000; // 一条译文最多存多少字（再长截断）
const TEXT_MAX = 65536; // 原文不截断（截了 hash 就对不上，补回来时认不出）；比 WhatsApp 一条消息还长的不存
const FILL_KEY = '_fill'; // 轻量号上次补原文时这个对话缓存里有几条（见 trfill.js），条数没变就不再补
const VIEW_KEY = '_view'; // 译文文件里放“翻译栏显示过哪些消息”的那一项（别的键都是原文 hash）
const VIEW_MAX = 40; // 和 floatcore.js 的 KEEP_VIEW 一样：翻译栏最多 40 条
const HEX_KEY = /^[0-9a-f]{24}$/;
const CHAT_KEY = /^[0-9a-f]{16}$/; // floatcore.js hashOf 算出来的对话 hash（别的文件名不走别名）
const META = '_chats'; // 每个号的别名表和最近消息索引
const SEEN_MAX = 2000; // 见过的客户消息最多记 2000 条，先记的先删
const RETRY_MS = 5000; // 读不了的文件最多每 5 秒再读一次
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
    if (e) {
      this.mem.delete(k); this.mem.set(k, e); // 挪到最近用过
      if (e.unread && Date.now() - e.unread >= RETRY_MS) this.reread(acc, chat, e);
      return e;
    }
    const r = this.readDisk(acc, chat);
    e = { data: r.data || {}, dirty: false, ...(r.data ? {} : { unread: Date.now() }) };
    this.mem.set(k, e);
    this.trim();
    return e;
  }

  // 读一个对话的文件：{ data } 读到了（没有文件、空文件是 {}）；{ data: null } 一时读不了，先别覆盖它
  // 内容坏了（不是 JSON 对象）：先在旁边留一份 .broken-时间 的备份，备份成功才当空的
  readDisk(acc, chat, quiet = false) {
    const f = this.file(acc, chat);
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (err) {
      if (err && err.code === 'ENOENT') return { data: {} };
      if (!quiet) console.warn(`译文文件读不了（${(err && err.code) || err}），先不覆盖：${acc}/${chat}.json`);
      return { data: null };
    }
    if (!raw.trim()) return { data: {} };
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { data: v };
    } catch { /* 下面备份 */ }
    const backup = `${f}.broken-${Date.now()}`;
    try { fs.copyFileSync(f, backup); } catch (err) {
      if (!quiet) console.warn(`译文文件坏了，备份失败（${err.code || err.message}），先不覆盖：${acc}/${chat}.json`);
      return { data: null };
    }
    console.warn(`译文文件坏了，已备份到 ${path.basename(backup)}`);
    return { data: {} };
  }

  // 上次读不了的再读一次：读到了就合上（同一个键以盘上的为准，这期间新存的只补盘上没有的）
  reread(acc, chat, e) {
    const r = this.readDisk(acc, chat, true); // 第一次已经记过日志，重试失败不再刷屏
    if (!r.data) { e.unread = Date.now(); return false; }
    const merged = { ...e.data, ...r.data };
    if (chat === META) { // 别名表里两张表各自合：盘上的别名不变，这期间新记的“见过”补进去
      for (const t of ['alias', 'seen']) {
        const a = e.data[t];
        const b = r.data[t];
        if (a && typeof a === 'object' && b && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) merged[t] = { ...a, ...b };
      }
    }
    e.data = merged;
    delete e.unread;
    return true;
  }

  // 内存里超过的对话：先写盘再丢
  trim() {
    while (this.mem.size > KEEP_IN_MEMORY) {
      const [k, e] = this.mem.entries().next().value;
      if (e.dirty) this.write(k, e);
      this.mem.delete(k);
    }
  }

  get(acc, chat, text) { return this.getKey(acc, chat, textKey(text)); }

  // 按原文的 hash 取（翻译栏补回来的旧消息手里只有 hash，原文从记录里拿）
  getKey(acc, chat, key) {
    if (!HEX_KEY.test(String(key))) return null;
    for (const c of this.group(acc, chat)) {
      const e = this.load(acc, c);
      const r = e && Object.hasOwn(e.data, key) ? e.data[key] : null;
      if (r && typeof r.tr === 'string' && r.tr) return r;
    }
    return null;
  }

  // ---- 同一个对话的几个编号 ----
  meta(acc) {
    const e = this.load(acc, META);
    if (!e) return null;
    const d = e.data;
    if (!d.alias || typeof d.alias !== 'object' || Array.isArray(d.alias)) d.alias = {};
    if (!d.seen || typeof d.seen !== 'object' || Array.isArray(d.seen)) d.seen = {};
    return e;
  }

  // 这个对话归到哪个 hash 下（没有别名就是它自己）
  canon(acc, chat) {
    if (!CHAT_KEY.test(String(chat))) return chat;
    const e = this.meta(acc);
    const to = e && e.data.alias[chat];
    return typeof to === 'string' && CHAT_KEY.test(to) ? to : chat;
  }

  // 同一个对话的所有 hash：正式的排第一
  group(acc, chat) {
    const c = this.canon(acc, chat);
    if (!CHAT_KEY.test(String(c))) return [c];
    const e = this.meta(acc);
    const out = [c];
    for (const [k, to] of Object.entries(e ? e.data.alias : {})) if (to === c && k !== c) out.push(k);
    return out;
  }

  // 认出 other 和 keep 是同一个对话：other 那一组都归到 keep 的正式 hash 下。以前不知道是一个对话时返回 true
  // keep 那边还没有译文文件、other 那边有：用 other 的（老记录、草稿、记住的客户语言都在它下面）
  link(acc, keep, other) {
    if (!CHAT_KEY.test(String(keep)) || !CHAT_KEY.test(String(other))) return false;
    let a = this.canon(acc, keep);
    let b = this.canon(acc, other);
    if (a === b) return false;
    if (!this.hasFile(acc, a) && this.hasFile(acc, b)) [a, b] = [b, a];
    const e = this.meta(acc);
    if (!e) return false;
    for (const [k, to] of Object.entries(e.data.alias)) if (to === b) e.data.alias[k] = a;
    e.data.alias[b] = a;
    this.touch(e);
    return true;
  }

  hasFile(acc, chat) {
    const e = this.mem.get(`${acc}/${chat}`);
    return (e ? Object.keys(e.data).length > 0 : false) || fs.existsSync(this.file(acc, chat));
  }

  // 一条客户消息（按 floatcore.js 的消息 hash）以前在哪个对话里见过
  seenChat(acc, h) {
    const e = this.meta(acc);
    const c = e && Object.hasOwn(e.data.seen, h) ? e.data.seen[h] : null;
    return typeof c === 'string' && CHAT_KEY.test(c) ? c : null;
  }

  markSeen(acc, h, chat) {
    if (!/^[0-9a-f]{16}$/.test(String(h)) || !CHAT_KEY.test(String(chat))) return;
    const e = this.meta(acc);
    if (!e || e.data.seen[h] === chat) return;
    delete e.data.seen[h]; // 新记的放到最后；满了先删最早记下的（记过的不再挪，免得每次读页面都写盘）
    e.data.seen[h] = chat;
    const keys = Object.keys(e.data.seen);
    for (const k of keys.slice(0, Math.max(0, keys.length - SEEN_MAX))) delete e.data.seen[k];
    this.touch(e);
  }

  // 按旧键存的记录按新键再存一份（语音以前按整条 data-id 存，见 floatcore.js）。复制了返回 true
  copyKey(acc, chat, from, to) {
    if (!HEX_KEY.test(String(from)) || !HEX_KEY.test(String(to))) return false;
    const dst = this.load(acc, this.canon(acc, chat));
    if (!dst || Object.hasOwn(dst.data, to)) return false;
    for (const c of this.group(acc, chat)) {
      const e = this.load(acc, c);
      const r = e && Object.hasOwn(e.data, from) ? e.data[from] : null;
      if (r && typeof r === 'object') { dst.data[to] = { ...r }; this.touch(dst); return true; }
    }
    return false;
  }

  put(acc, chat, text, rec) { this.putKey(acc, chat, textKey(text), rec); }

  putKey(acc, chat, key, rec) {
    const e = this.load(acc, this.canon(acc, chat));
    if (!e || !HEX_KEY.test(String(key)) || !rec || typeof rec.tr !== 'string' || !rec.tr.trim()) return;
    const old = Object.hasOwn(e.data, key) ? e.data[key] : null;
    const text = typeof rec.text === 'string' && rec.text.trim() && rec.text.length <= TEXT_MAX ? rec.text : (old && typeof old.text === 'string' ? old.text : '');
    e.data[key] = { tr: rec.tr.slice(0, TR_MAX), ...(text ? { text } : {}), edited: !!rec.edited, fixed: !!rec.fixed, at: Date.now() };
    this.touch(e);
  }

  // 以前存的记录没有原文：读到那条消息时补上（原文的 hash 对得上才补，不改译文和时间）。补上了返回 true
  fillText(acc, chat, key, text) {
    const t = String(text || '');
    if (!t.trim() || t.length > TEXT_MAX || textKey(t) !== key) return false;
    let e = null;
    let r = null;
    for (const c of this.group(acc, chat)) {
      e = this.load(acc, c);
      r = e && Object.hasOwn(e.data, key) ? e.data[key] : null;
      if (r) break;
    }
    if (!r || typeof r.tr !== 'string' || !r.tr || (typeof r.text === 'string' && r.text)) return false;
    r.text = t;
    this.touch(e);
    return true;
  }

  // 语音转出来的文字：还没翻成功也先存（heard），翻译失败、重启后不再花钱重转；没听出话的存空文字。
  // 已经有译文的记录不动；之后翻好了 putKey 整条换掉
  putHeard(acc, chat, key, text) {
    const e = this.load(acc, this.canon(acc, chat));
    if (!e || !HEX_KEY.test(String(key))) return;
    if (this.getKey(acc, chat, key)) return;
    e.data[key] = { tr: '', text: String(text || '').slice(0, TEXT_MAX), heard: true, at: Date.now() };
    this.touch(e);
  }

  // 存着的语音转写（没有返回 null；没听出话是 ''）
  getHeard(acc, chat, key) {
    if (!HEX_KEY.test(String(key))) return null;
    for (const c of this.group(acc, chat)) {
      const e = this.load(acc, c);
      const r = e && Object.hasOwn(e.data, key) ? e.data[key] : null;
      if (r && r.heard === true && typeof r.text === 'string') return r.text;
    }
    return null;
  }

  // 轻量号上次补原文时这个对话缓存里有几条（没补过是 -1）
  fillMark(acc, chat) {
    const e = this.load(acc, this.canon(acc, chat));
    const v = e && e.data[FILL_KEY];
    return v && Number.isInteger(v.n) ? v.n : -1;
  }

  setFillMark(acc, chat, n) {
    const e = this.load(acc, this.canon(acc, chat));
    if (!e || !Number.isInteger(n) || this.fillMark(acc, chat) === n) return;
    e.data[FILL_KEY] = { at: Date.now(), n };
    this.touch(e);
  }

  // 这个对话里有译文、没有原文的记录（原文 hash 的集合）。没有文件的对话不读盘、不建文件
  missingText(acc, chat) {
    const out = new Set();
    if (!safe(acc) || !safe(chat)) return out;
    for (const c of this.group(acc, chat)) {
      if (!this.mem.has(`${acc}/${c}`) && !fs.existsSync(this.file(acc, c))) continue;
      const e = this.load(acc, c);
      for (const [k, r] of Object.entries(e ? e.data : {})) {
        if (HEX_KEY.test(k) && r && typeof r.tr === 'string' && r.tr && !(typeof r.text === 'string' && r.text)) out.add(k);
      }
    }
    return out;
  }

  // 翻译栏上这个对话显示过哪些消息（按顺序，最多 VIEW_MAX 条）：重新打开对话、重启软件时，
  // 读页面只读得到最后 20 条，更早的译文按这张单子补回来（shen 2026-10-28：「后续打开页面，翻译的文本都一直在这」）。
  // 每条只有 { h: 消息编号的 hash, k: 原文的 hash, t: 几点几分 }，原文在 k 对应的记录里，不存号码
  getView(acc, chat) {
    // 正式的那个没有就用别名下的（认出别名之前记在别的编号下）
    let v = null;
    for (const c of this.group(acc, chat)) {
      const e = this.load(acc, c);
      v = e && e.data[VIEW_KEY];
      if (v && Array.isArray(v.list) && v.list.length) break;
    }
    if (!v || !Array.isArray(v.list)) return [];
    return v.list.filter((x) => x && typeof x.h === 'string' && HEX_KEY.test(String(x.k)))
      .map((x) => ({ h: x.h.slice(0, 64), k: x.k, t: typeof x.t === 'string' ? x.t.slice(0, 5) : '', ...(Number.isFinite(x.v) ? { v: x.v } : {}) }));
  }

  putView(acc, chat, list) {
    const e = this.load(acc, this.canon(acc, chat));
    if (!e || !Array.isArray(list)) return;
    // v：语音的时长（秒），只有语音有
    const next = list.slice(-VIEW_MAX).map(({ h, k, t, v }) => ({ h, k, t: t || '', ...(Number.isFinite(v) ? { v } : {}) }));
    const prev = e.data[VIEW_KEY];
    if (!prev && !next.length) return; // 打开过、没有收到消息的对话：不为它建文件
    if (prev && JSON.stringify(prev.list) === JSON.stringify(next)) return;
    e.data[VIEW_KEY] = { at: Date.now(), list: next };
    this.touch(e);
  }

  touch(e) {
    e.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1000);
  }

  // 一个文件最多留 max 条：超了就删最早存的（发出的译文用，见 outcache.js）
  cap(acc, chat, max) {
    const e = this.load(acc, chat);
    if (!e) return;
    const keys = Object.keys(e.data);
    if (keys.length <= max) return;
    keys.sort((a, b) => (e.data[a].at || 0) - (e.data[b].at || 0));
    for (const k of keys.slice(0, keys.length - max)) delete e.data[k];
    e.dirty = true;
  }

  write(k, e) {
    const [acc, chat] = k.split('/');
    if (e.unread && !this.reread(acc, chat, e)) return; // 还是读不了：不覆盖，留着下次再试
    try {
      fs.mkdirSync(path.join(this.dir, acc), { recursive: true });
      writeJsonAtomic(this.file(acc, chat), e.data);
      e.dirty = false;
    } catch (err) { console.warn(`译文保存失败：${err.message}`); }
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const [k, e] of this.mem) if (e.dirty) this.write(k, e);
    return [...this.mem.values()].every((e) => !e.dirty);
  }

  // 换存放位置（启动后查完盘才知道放哪）：先把没写盘的写到旧位置，再清掉内存，之后读写都在新位置
  setDir(dir) {
    if (!this.flush()) return false;
    this.mem.clear();
    this.dir = dir;
    return true;
  }

  // 删号：磁盘上的译文保留，只把内存里的写盘后放掉
  forgetAccount(acc) {
    for (const [k, e] of [...this.mem]) {
      if (!k.startsWith(`${acc}/`)) continue;
      if (e.dirty) this.write(k, e);
      this.mem.delete(k);
    }
  }
}

// 存在哪（shen 2026-10-26）：Windows 上不放 C 盘，放 D:\WAswitch\translations；不放桌面。Mac 不变。
// 2026-10-27：D 盘必须是本机固定硬盘才放（U 盘、SD 卡、移动硬盘、网络盘、光驱都不放），查不出来也不放，
// 写不进去也不放，这些情况都放 C（userData 里）。查盘要调 PowerShell，所以是异步的。opts 只给自检用。
async function pickDir(fallback, { platform = process.platform, preferred = 'D:\\WAswitch\\translations', probe = probeDrive } = {}) {
  if (platform !== 'win32') return fallback;
  let info = null;
  try { info = await probe(path.parse(preferred).root); } catch { /* 查不出来 */ }
  if (!isLocalFixed(info)) return fallback;
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const probeFile = path.join(preferred, `.probe-${process.pid}`);
    fs.writeFileSync(probeFile, '');
    fs.rmSync(probeFile, { force: true });
    return preferred;
  } catch { return fallback; }
}

// 盘的类型（.NET DriveInfo）和接口（Get-Disk 的 BusType，认出插在 USB 上的移动硬盘）。输出像 "Fixed|NVMe"。
const REMOVABLE_BUS = new Set(['usb', 'sd', 'mmc', '7', '12', '13']);
function parseDriveProbe(out) {
  const [type = '', bus = ''] = String(out || '').trim().split(/\r?\n/).pop().split('|').map((x) => x.trim());
  return type ? { type, bus } : null;
}
function isLocalFixed(info) {
  return !!info && info.type.toLowerCase() === 'fixed' && !REMOVABLE_BUS.has(info.bus.toLowerCase());
}
function probeDrive(root) {
  const letter = String(root || '').charAt(0).toUpperCase();
  if (!/^[A-Z]$/.test(letter)) return Promise.resolve(null);
  const ps = "$ErrorActionPreference='SilentlyContinue';"
    + `$t=(New-Object System.IO.DriveInfo '${letter}').DriveType;`
    + `$b=(Get-Partition -DriveLetter ${letter} | Get-Disk | Select-Object -First 1).BusType;`
    + "Write-Output ([string]$t+'|'+[string]$b)"; // 不用双引号：Windows 传参时双引号要转义，容易出错
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 15000, windowsHide: true }, (e, out) => resolve(e ? null : parseDriveProbe(out)));
  });
}

// 关于页用：文件夹里存了多少（每个号一个文件夹，每个对话一个 .json）
async function dirInfo(dir) {
  const fsp = fs.promises;
  let bytes = 0;
  let files = 0;
  let accs = [];
  try { accs = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()); } catch { return { bytes, files }; }
  for (const a of accs) {
    let names = [];
    try { names = await fsp.readdir(path.join(dir, a.name)); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      try { bytes += (await fsp.stat(path.join(dir, a.name, f))).size; files++; } catch { /* 刚好被删 */ }
    }
  }
  return { bytes, files };
}

// 旧位置的译文搬到新位置（一次性；之后旧文件夹没了就什么都不做）。跨盘不能 rename，所以复制再删。
// 同名文件按记录合并：保留两边独有的译文，冲突用时间较新的。成功写入才删除对应源文件。
function migrate(from, to) {
  if (!from || !to || path.resolve(from) === path.resolve(to)) return 0;
  let accs;
  try { accs = fs.readdirSync(from, { withFileTypes: true }).filter((d) => d.isDirectory() && safe(d.name)); } catch { return 0; }
  let n = 0;
  for (const a of accs) {
    try {
      fs.mkdirSync(path.join(to, a.name), { recursive: true });
      for (const f of fs.readdirSync(path.join(from, a.name))) {
        if (!f.endsWith('.json')) continue;
        const src = path.join(from, a.name, f);
        const dst = path.join(to, a.name, f);
        const read = (file) => {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('译文文件格式不对');
          return data;
        };
        const source = read(src);
        const merged = fs.existsSync(dst) ? read(dst) : {};
        for (const [key, rec] of Object.entries(source)) {
          if (!Object.hasOwn(merged, key) || (rec?.at || 0) > (merged[key]?.at || 0)) {
            Object.defineProperty(merged, key, { value: rec, enumerable: true, writable: true, configurable: true });
          }
        }
        writeJsonAtomic(dst, merged);
        fs.unlinkSync(src);
        n++;
      }
      try { fs.rmdirSync(path.join(from, a.name)); } catch { /* 保留未处理的文件 */ }
    } catch (err) { console.warn(`译文搬家失败：${err.message}`); return n; } // 出错就留着旧的，下次再搬
  }
  try { fs.rmdirSync(from); } catch { /* 保留未处理的文件 */ }
  return n;
}

module.exports = { TrStore, TR_MAX, VIEW_MAX, textKey, pickDir, migrate, parseDriveProbe, isLocalFixed, dirInfo };
