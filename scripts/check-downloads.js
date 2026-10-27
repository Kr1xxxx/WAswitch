// 下载自检（不需要 Electron）：node scripts/check-downloads.js
// 用假的 session 和下载项，看文件存到 下载/WAswitch/<账号名>/、同名不覆盖、同名账号分开、
// 老版本存的自定义文件夹不再生效、文件夹写不进去时退回“另存为”，以及右键菜单里没有“下载文件夹”了。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createDownloads } = require('../src/downloads');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`通过：${name}`); } catch (e) { failures += 1; console.log(`失败：${name}\n  ${e.message}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-dl-'));
let downloadsRoot = path.join(tmp, 'Downloads');
const accounts = [];
const warns = [];
const dl = createDownloads({
  downloadsPath: () => downloadsRoot,
  getAccounts: () => accounts,
  findAcc: (id) => accounts.find((a) => a.id === id),
  warn: (m) => warns.push(m),
});
function fakeItem(filename) {
  const item = new EventEmitter();
  item.savePath = null;
  item.getFilename = () => filename;
  item.setSavePath = (p) => { item.savePath = p; };
  item.finish = () => { if (item.savePath) fs.writeFileSync(item.savePath, 'x'); item.emit('done'); };
  return item;
}
function addAccount(acc) {
  accounts.push(acc);
  const ses = new EventEmitter();
  dl.setup(acc, ses);
  return (filename) => { const item = fakeItem(filename); ses.emit('will-download', {}, item); return item; };
}

const downloadAnna = addAccount({ id: 'a1', name: 'Anna Berlin' });

check('下载存到 下载/WAswitch/<账号名>/', () => {
  const item = downloadAnna('invoice.pdf');
  assert.strictEqual(item.savePath, path.join(downloadsRoot, 'WAswitch', 'Anna Berlin', 'invoice.pdf'));
  assert.strictEqual(dl.isDownloading('a1'), true);
  item.finish();
  assert.strictEqual(dl.isDownloading('a1'), false);
  assert.ok(fs.existsSync(item.savePath));
});

check('同一个号再下同名文件：变成“文件 (1)”，不覆盖', () => {
  const item = downloadAnna('invoice.pdf');
  assert.strictEqual(path.basename(item.savePath), 'invoice (1).pdf');
  item.finish();
});

check('老版本改过的下载文件夹不再生效，回到默认位置', () => {
  const custom = path.join(tmp, 'custom');
  const download = addAccount({ id: 'b2', name: 'Lucas Paris', downloadDir: custom });
  const item = download('photo.jpg');
  assert.strictEqual(item.savePath, path.join(downloadsRoot, 'WAswitch', 'Lucas Paris', 'photo.jpg'));
  assert.ok(!fs.existsSync(custom));
  item.finish();
});

check('两个号同名：文件夹名后面加账号编号，不混在一起', () => {
  const download = addAccount({ id: 'c3', name: 'Anna Berlin' });
  const item = download('menu.pdf');
  assert.strictEqual(path.dirname(item.savePath), path.join(downloadsRoot, 'WAswitch', 'Anna Berlin-c3'));
  item.finish();
});

check('下载文件夹写不进去：不设路径，交给系统“另存为”', () => {
  downloadsRoot = path.join(tmp, 'not-a-folder');
  fs.writeFileSync(downloadsRoot, 'file');
  const item = downloadAnna('report.xlsx');
  assert.strictEqual(item.savePath, null);
  assert.ok(warns.some((m) => m.includes('另存为')));
  item.finish();
  downloadsRoot = path.join(tmp, 'Downloads');
});

check('右键菜单没有“下载文件夹”，读账号时丢掉老的 downloadDir', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.ok(!src.includes("'下载文件夹"), 'main.js 里还有“下载文件夹”菜单');
  assert.ok(!/pickDownloadDir|openDownloadDir/.test(src), '还有改文件夹/打开文件夹的代码');
  assert.ok(src.includes('delete acc.downloadDir;'), '读账号时没丢掉 downloadDir');
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} 项失败`); process.exit(1); }
console.log('\n下载自检全部通过');
