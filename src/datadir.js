// 账号数据（userData）放哪（shen 2026-10-29：「改到 默认 D 盘」，选了「新装和老电脑都放 D 盘」，「没有 D 就 C」）。
// 只管 Windows 打包版；Mac 和从源码运行不变。
//
// home = %APPDATA%\WAswitch（Electron 默认的 userData，C 盘）。这里一直留着：
//   data-dir.json   指针：{ dir: "D:\\WAswitch\\data", cleanC }，有它就用它指的位置
//   data-move.json  老电脑搬家试了几次、上次什么时候、为什么没成
//   MCP 的文件（modules\mcp、mcp.json、mcp-token.json、mcp-ai-log.json）：Claude Desktop 的配置里写死了路径，搬了要重配
//   Crashpad：Electron 可能在切换位置之前就打开了它，删不掉也不需要搬
//
// 启动时（main.js 最前面，单实例锁和 app ready 之前）选位置：
//   有指针、指的位置能用 → 用它
//   有指针、打不开（D 盘没接上、BitLocker 没解锁）→ 这次用 C 盘，指针不改，D 回来自动回去
//   没指针、C 盘没有旧数据、D:\WAswitch 已经存在且能写 → 用 D:\WAswitch\data，写指针（新装的电脑）
//   其他 → C 盘（老电脑等空闲时搬一次，见 move()）
// 软件自己不建 D:\WAswitch：只有安装包确认过 D 盘是本机硬盘才建（和译文的规则一样，见 trstore.pickDir）。
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');

const ROOT = 'D:\\WAswitch';
const POINTER = 'data-dir.json';
const STATE = 'data-move.json';
// 一直留在 home、不搬也不删的
const KEEP = new Set([POINTER, STATE, 'modules', 'mcp.json', 'mcp-token.json', 'mcp-ai-log.json', 'Crashpad']);
// Chromium 自己会重建的缓存，和正在运行的进程占着的锁文件：不搬
const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache',
  'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']);
// 有这些之一就算 C 盘有旧数据
const DATA_MARKS = ['accounts.json', 'Partitions', 'lite', 'Local State'];
const RETRY_MS = 24 * 3600 * 1000;
const MAX_TRIES = 3;
const SPARE = 1.1; // D 盘剩余空间至少是要搬的 1.1 倍

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// 能在这个文件夹里写文件（文件夹要已经存在）
function writable(dir) {
  try {
    if (!isDir(dir)) return false;
    const probe = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch { return false; }
}

const hasData = (dir) => DATA_MARKS.some((n) => exists(path.join(dir, n)));
const dataDirOf = (root) => path.join(root, 'data');

function readPointer(home) {
  const p = readJson(path.join(home, POINTER));
  return p && typeof p.dir === 'string' && p.dir ? p : null;
}
// 新装的电脑第一次启动时 userData 已经指到 D，Electron 不会再建 %APPDATA%\WAswitch：先建好再写
function writePointer(home, p) { fs.mkdirSync(home, { recursive: true }); writeJsonAtomic(path.join(home, POINTER), p, 2); }
function readState(home) { const s = readJson(path.join(home, STATE)); return { tries: Number(s?.tries) || 0, lastAt: Number(s?.lastAt) || 0, error: s?.error || '' }; }
function writeState(home, s) { try { fs.mkdirSync(home, { recursive: true }); writeJsonAtomic(path.join(home, STATE), s, 2); } catch { /* 写不了就下次再算 */ } }

// D:\WAswitch 存在，能在里面建 data 并写文件
function rootUsable(root) {
  if (!isDir(root)) return false;
  try { fs.mkdirSync(dataDirOf(root), { recursive: true }); } catch { return false; }
  return writable(dataDirOf(root));
}

// 选这次用哪个文件夹。不抛错：任何意外都留在 home（C 盘），软件照常打开
// 返回 { dir, home, pointer, fallback, wanted, fresh }
function resolve({ platform = process.platform, home, root = ROOT } = {}) {
  const out = { dir: home, home, pointer: null, fallback: false, wanted: '', fresh: false };
  if (platform !== 'win32') return out;
  try {
    const pointer = readPointer(home);
    out.pointer = pointer;
    if (pointer) {
      if (writable(pointer.dir)) { out.dir = pointer.dir; return out; }
      // 指的文件夹不见了，但 D:\WAswitch 在、C 盘也没数据（比如有人删了 data）：重新建，不要永远停在 C 盘
      if (pointer.dir === dataDirOf(root) && !hasData(home) && rootUsable(root)) { out.dir = pointer.dir; return out; }
      // 打不开：这次用 C 盘，指针的位置不改。C 盘那份旧数据（如果还没删）这次又被用了，以后不再删它
      out.fallback = true;
      out.wanted = pointer.dir;
      if (pointer.cleanC) { try { writePointer(home, { ...pointer, cleanC: false }); out.pointer = { ...pointer, cleanC: false }; } catch { /* 写不了：下次还会走到这里 */ } }
      return out;
    }
    if (hasData(home)) return out; // 老电脑：先留在 C，空闲时再搬
    if (!rootUsable(root)) return out;
    out.dir = dataDirOf(root);
    out.fresh = true;
    try { writePointer(home, { dir: out.dir, cleanC: false }); out.pointer = { dir: out.dir, cleanC: false }; } catch { /* 下次启动 C 盘照样没数据，还会选 D */ }
  } catch { out.dir = home; out.fallback = false; }
  return out;
}

// 在 app ready 之前调用；只有 Windows 打包版生效。opts 只给自检用
function apply(app, { platform = process.platform, packaged = app.isPackaged, root = ROOT, home = app.getPath('userData') } = {}) {
  if (!(packaged && platform === 'win32')) return { dir: home, home, pointer: null, fallback: false, wanted: '', fresh: false, active: false };
  const r = resolve({ platform, home, root });
  if (r.dir !== home) {
    app.setPath('userData', r.dir);
    app.setPath('sessionData', r.dir);
  }
  return { ...r, active: true, root };
}

// ---------- 老电脑：搬一次 ----------

// 现在该不该搬（软件空闲时由 main.js 调用）
function shouldMove(start, { now = Date.now(), root = start.root || ROOT } = {}) {
  if (!start.active || start.pointer || start.dir !== start.home) return false;
  if (!hasData(start.home)) return false;
  const s = readState(start.home);
  if (s.tries >= MAX_TRIES || now - s.lastAt < RETRY_MS) return false;
  return rootUsable(root);
}

// 准备重启去搬之前记一次：搬的那次启动要是崩了，也不会反复重启
function noteAttempt(home, now = Date.now()) {
  const s = readState(home);
  writeState(home, { ...s, tries: s.tries + 1, lastAt: now });
}

const skipTop = (name) => KEEP.has(name);
// 统计要搬的文件数和字节数（跳过缓存和锁文件；顶层跳过留在 home 的）
function measure(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d, top) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name) || (top && skipTop(e.name))) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, false);
      else if (e.isFile()) { files++; bytes += fs.statSync(p).size; }
    }
  };
  walk(dir, true);
  return { files, bytes };
}

function freeBytes(dir, statfs = fs.statfsSync) {
  const s = statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
// 复制；被杀毒软件锁住就等一会儿再来（force 覆盖已经复制好的那部分）
function copyAll(from, to, cp, wait) {
  for (let i = 0; ; i++) {
    try {
      cp(from, to, {
        recursive: true, force: true, errorOnExist: false, preserveTimestamps: true,
        filter: (src) => {
          const rel = path.relative(from, src);
          if (!rel) return true;
          const parts = rel.split(path.sep);
          if (parts.length === 1 && skipTop(parts[0])) return false;
          return !SKIP.has(parts[parts.length - 1]);
        },
      });
      return;
    } catch (e) {
      if (!BUSY.has(e.code) || i >= 4) throw e;
      wait(2000);
    }
  }
}

function renameRetry(from, to, wait) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (!BUSY.has(e.code) || i >= 9) throw e;
      wait(500);
    }
  }
}

// 把 home 里的账号数据搬到 D:\WAswitch\data。同步执行，在 --move-data 那次启动里、ready 之前、拿到单实例锁之后调用，
// 保证没有别的 WAswitch 在用这些文件。C 盘那份一点不动（等 D 盘启动成功后才由 cleanOld 删）。
// 任何一步失败：删掉 D 盘半截的 data.tmp，留在 C 盘。返回 { ok, reason, files, bytes }
// opts.cp / statfs / wait 只给自检用（模拟复制一半失败、空间不够）
function move({ home, root = ROOT, cp = fs.cpSync, statfs = fs.statfsSync, wait = sleep, log = () => {} } = {}) {
  const dest = dataDirOf(root);
  const tmp = `${dest}.tmp`;
  const fail = (reason, e) => {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 下次搬之前还会先删 */ }
    const s = readState(home);
    writeState(home, { ...s, error: reason });
    log(`账号数据没搬到 D 盘（${reason}${e ? `：${e.message}` : ''}），继续用 C 盘`);
    return { ok: false, reason };
  };
  try {
    if (readPointer(home)) return { ok: false, reason: 'already' };
    if (!hasData(home)) return { ok: false, reason: 'nodata' };
    if (!isDir(root)) return fail('noroot');
    // D:\WAswitch\data 里已经有账号数据（以前在 D 盘用过）：不覆盖
    if (hasData(dest)) return fail('exists');
    const src = measure(home);
    let free;
    try { free = freeBytes(root, statfs); } catch (e) { return fail('nostat', e); }
    if (free < src.bytes * SPARE) return fail('nospace');
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { return fail('tmp', e); }
    try { copyAll(home, tmp, cp, wait); } catch (e) { return fail('copy', e); }
    let got;
    try { got = measure(tmp); } catch (e) { return fail('verify', e); }
    if (got.files !== src.files || got.bytes !== src.bytes) return fail(`verify ${got.files}/${src.files} ${got.bytes}/${src.bytes}`);
    // 空的 data 文件夹（安装包或上次 rootUsable 建的）先删掉，才能改名
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) { return fail('dest', e); }
    try { renameRetry(tmp, dest, wait); } catch (e) { return fail('rename', e); }
    try { writePointer(home, { dir: dest, cleanC: true, movedAt: Date.now() }); } catch (e) {
      // 指针写不进去：这份 D 盘的副本没人会用，改回 tmp 再删，留在 C
      try { fs.renameSync(dest, tmp); } catch { /* 删不掉就留着，下次搬前会先删 tmp */ }
      return fail('pointer', e);
    }
    writeState(home, { ...readState(home), error: '' });
    log(`账号数据已搬到 ${dest}（${src.files} 个文件，${Math.round(src.bytes / 1048576)} MB）`);
    return { ok: true, files: src.files, bytes: src.bytes };
  } catch (e) { return fail('error', e); }
}

// 从 D 盘正常启动、读到 accounts.json 以后，后台删掉 C 盘那份旧数据（留指针和 MCP 的文件）。
// 删不完的下次启动再删；全删完才把 cleanC 改成 false
async function cleanOld(home, { log = () => {} } = {}) {
  const p = readPointer(home);
  if (!p || !p.cleanC) return false;
  let left = 0;
  let names = [];
  try { names = await fs.promises.readdir(home); } catch { return false; }
  for (const n of names) {
    if (KEEP.has(n)) continue;
    try { await fs.promises.rm(path.join(home, n), { recursive: true, force: true, maxRetries: 3 }); } catch (e) { left++; log(`C 盘旧数据 ${n} 没删掉：${e.message}`); }
  }
  if (left) return false;
  // 删的这段时间里指针可能被改过（不会，但不覆盖别人写的）
  const now = readPointer(home);
  if (now && now.dir === p.dir && now.cleanC) writePointer(home, { ...now, cleanC: false });
  log('C 盘的旧账号数据已删除');
  return true;
}

// 搬家那次启动：等上一个 WAswitch 完全退出（它还占着单实例锁）
function waitForExit(pid, ms = 60000, wait = sleep) {
  if (!pid) return;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch { return; }
    wait(200);
  }
}

// D 盘打不开时界面上那一句
function fallbackText(start) {
  return start && start.fallback ? `D 盘打不开，账号数据在 ${start.wanted}，现在先用 C 盘。接好 D 盘后重启 WAswitch。` : '';
}

module.exports = { ROOT, POINTER, STATE, KEEP, SKIP, apply, resolve, shouldMove, noteAttempt, move, cleanOld, measure, hasData, readPointer, readState, waitForExit, fallbackText, MAX_TRIES, RETRY_MS };
