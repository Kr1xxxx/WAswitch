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
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
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

// 旁边有没有读坏时留下的备份（file.broken-时间）。读不了文件夹也当作有，宁可不清理
function hasBrokenBackup(file) {
  const prefix = `${path.basename(file)}.broken-`;
  try { return fs.readdirSync(path.dirname(file)).some((n) => n.startsWith(prefix)); } catch { return true; }
}

module.exports = { writeFileAtomic, writeJsonAtomic, hasBrokenBackup };
