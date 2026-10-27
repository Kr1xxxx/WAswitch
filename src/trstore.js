// 收到的消息的译文永久存在本机磁盘上（shen 2026-10-26：切回对话、重启软件都直接显示，不再调模型、不耗额度）。
// 每个号一个文件夹，每个对话一个文件：<dir>/<号>/<对话 hash>.json，里面是 { 原文 hash: { tr, edited, fixed, at } }。
// 不存原文和号码，只存原文的 hash 和译文。按原文认（同一对话里同样的话只翻一次），消息编号变了也认得出。
// 不设条数上限、不自动清理；只在用到某个对话时读它的文件，内存里只留最近用过的几个对话。删号时不删（shen 2026-10-26）。
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

  // 换存放位置（启动后查完盘才知道放哪）：先把没写盘的写到旧位置，再清掉内存，之后读写都在新位置
  setDir(dir) {
    this.flush();
    this.mem.clear();
    this.dir = dir;
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
// 新位置已有同名文件的不覆盖（新的为准）。
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
        const dst = path.join(to, a.name, f);
        if (fs.existsSync(dst)) continue;
        fs.copyFileSync(path.join(from, a.name, f), dst);
        n++;
      }
    } catch (err) { console.warn(`译文搬家失败：${err.message}`); return n; } // 出错就留着旧的，下次再搬
  }
  try { fs.rmSync(from, { recursive: true, force: true }); } catch { /* 忽略 */ }
  return n;
}

module.exports = { TrStore, textKey, pickDir, migrate, parseDriveProbe, isLocalFixed, dirInfo };
