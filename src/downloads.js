// 下载：每个号存到自己的文件夹，位置固定，不能改。
// 位置：系统“下载”文件夹/WAswitch/<账号名>。两个号同名时，文件夹名后面加上账号编号。
// 文件夹写不进去时，退回系统的“另存为”对话框。下载完不会自动打开文件。
// 0.5.8 起去掉了“下载文件夹”选项：之前改过文件夹的号也回到这个默认位置。
const fs = require('fs');
const path = require('path');

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
function safeName(name, fallback) {
  let n = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim();
  n = n.replace(/[. ]+$/, ''); // Windows 不允许结尾是点或空格
  if (WIN_RESERVED.test(n)) n = `_${n}`;
  n = n.slice(0, 80).replace(/[. ]+$/, '');
  return n || fallback;
}

// downloadsPath()：系统“下载”文件夹；getAccounts()：全部账号；findAcc(id)：按编号找号
function createDownloads({ downloadsPath, getAccounts, findAcc, warn = console.warn }) {
  function downloadDirOf(acc) {
    const base = safeName(acc.name, `account-${safeName(acc.id, 'x')}`);
    const dup = getAccounts().some((a) => a !== acc && safeName(a.name, '') === base);
    return path.join(downloadsPath(), 'WAswitch', dup ? `${base}-${safeName(acc.id, 'x')}` : base);
  }
  const reserved = new Set(); // 正在下载的目标路径，同时下两个同名文件不会撞
  function uniquePath(dir, filename) {
    const ext = path.extname(filename);
    const stem = filename.slice(0, filename.length - ext.length) || 'file';
    for (let i = 0; i < 1000; i += 1) {
      const p = path.join(dir, i ? `${stem} (${i})${ext}` : `${stem}${ext}`);
      if (!reserved.has(p) && !fs.existsSync(p)) return p;
    }
    return null;
  }
  const active = new Map(); // id -> 正在下载的文件数，下载中的账号不做内存回收
  const hooked = new WeakSet(); // 每个 session 只挂一次（视图重建时 session 不变）
  function setup(acc, ses) {
    if (hooked.has(ses)) return;
    hooked.add(ses);
    const id = acc.id;
    ses.on('will-download', (_e, item) => {
      const cur = findAcc(id);
      if (!cur) return;
      active.set(id, (active.get(id) || 0) + 1);
      item.once('done', () => {
        const n = (active.get(id) || 1) - 1;
        if (n > 0) active.set(id, n); else active.delete(id);
      });
      const dir = downloadDirOf(cur);
      let target = null;
      try {
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.statSync(dir).isDirectory()) throw new Error('not a folder');
        fs.accessSync(dir, fs.constants.W_OK);
        const name = safeName(path.basename(item.getFilename() || ''), 'download');
        target = uniquePath(dir, WIN_RESERVED.test(name) ? `_${name}` : name);
      } catch (e) {
        warn(`账号 ${id} 的下载文件夹不可写（${e.code || e.message}），改用另存为对话框`);
      }
      if (!target) return; // 不设路径：Electron 会弹系统的“另存为”对话框
      reserved.add(target);
      item.setSavePath(target);
      item.once('done', () => reserved.delete(target));
    });
  }
  return { setup, downloadDirOf, isDownloading: (id) => active.has(id) };
}

module.exports = { createDownloads, safeName };
