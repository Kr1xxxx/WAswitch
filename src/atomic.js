// 安全写文件：先写临时文件 → fsync 强制落盘 → 改名替换。
// 只改名不 fsync 的话，Windows 突然断电后可能留下一个空的或全是 0 的目标文件。
// 这样写，断电后读到的要么是旧的完整文件，要么是新的完整文件。
const fs = require('fs');
const path = require('path');

// data：字符串或 Buffer。opts.mode：新文件的权限（比如 0o600，Windows 上基本不起作用）
function writeFileAtomic(file, data, opts = {}) {
  const tmp = `${file}.tmp`;
  // 上次断电留下的临时文件先删掉（可能是只读的，或权限不对）
  try { fs.unlinkSync(tmp); } catch { /* 没有就算了 */ }
  const fd = fs.openSync(tmp, 'w', opts.mode);
  try {
    // 临时文件可能是上次留下的，权限不一定对，重新设一次
    if (opts.mode !== undefined) {
      try { fs.fchmodSync(fd, opts.mode); } catch { /* Windows 不支持就算了 */ }
    }
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameRetry(tmp, file);
  syncDir(path.dirname(file));
}

// Windows 上杀毒软件、搜索索引会短暂锁住刚写好的文件，改名报 EPERM/EACCES/EBUSY。
// 同步等 50 毫秒再试，最多 10 次（最多卡约半秒）。Mac 上和别的错误不重试
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_TIMES = 10;
const RETRY_WAIT_MS = 50;
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (process.platform !== 'win32' || !RETRY_CODES.has(e.code) || i >= RETRY_TIMES - 1) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_WAIT_MS);
    }
  }
}

// 改名本身记在文件夹里，Mac 上也同步一下文件夹。Windows 打不开文件夹，跳过
function syncDir(dir) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* 有的文件系统不支持，不影响已经写好的文件 */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// space：JSON 缩进，和原来各处一样（有的 2，有的 1，有的不缩进）
function writeJsonAtomic(file, value, space, opts) {
  writeFileAtomic(file, JSON.stringify(value, null, space), opts);
}

// 整份写的保存（账号、分组、设置）：写不进去（盘满、文件被锁）不抛错，记一行日志，返回 false。
// 内存里的数据是完整的，下一次保存会整份补上。同一个文件连续失败只记第一次，成功一次后再失败重新记
const failing = new Set();
function writeJsonQuiet(file, value, space) {
  try {
    writeJsonAtomic(file, value, space);
    failing.delete(file);
    return true;
  } catch (e) {
    if (!failing.has(file)) console.warn(`${path.basename(file)} 保存失败：${e.code || e.message}`);
    failing.add(file);
    return false;
  }
}

// 旁边有没有读坏时留下的备份（file.broken-时间）。读不了文件夹也当作有，宁可不清理
function hasBrokenBackup(file) {
  const prefix = `${path.basename(file)}.broken-`;
  try { return fs.readdirSync(path.dirname(file)).some((n) => n.startsWith(prefix)); } catch { return true; }
}

module.exports = { writeFileAtomic, writeJsonAtomic, writeJsonQuiet, hasBrokenBackup };
