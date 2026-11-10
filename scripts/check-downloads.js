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

check('长文件名：名字被截短，扩展名 .pdf 留着，总长不超过 80', () => {
  const name = 'Proforma Invoice PI-2026-1105 Maison des Cils Paris lash trays and tweezers order final v3.pdf';
  assert.ok(name.length > 80);
  const item = downloadAnna(name);
  const base = path.basename(item.savePath);
  assert.ok(base.endsWith('.pdf'), base);
  assert.ok(base.length <= 80, `${base.length}`);
  assert.ok(base.startsWith('Proforma Invoice PI-2026-1105'));
  item.finish();
  const again = downloadAnna(name);
  const base2 = path.basename(again.savePath);
  assert.ok(base2.endsWith(' (1).pdf') && base2.length <= 90, base2);
  again.finish();
});

check('长中文文件名：扩展名 .xlsx 留着，总长不超过 80', () => {
  const item = downloadAnna(`${'二零二六年十一月巴黎睫毛托盘与镊子订单明细汇总'.repeat(4)}.xlsx`);
  const base = path.basename(item.savePath);
  assert.ok(base.endsWith('.xlsx'), base);
  assert.ok(base.length <= 80, `${base.length}`);
  item.finish();
});

check('很长的“扩展名”不算扩展名：整体不超过 80', () => {
  const item = downloadAnna(`a.${'x'.repeat(30)}`);
  const base = path.basename(item.savePath);
  assert.ok(base.length <= 80 && base === `a.${'x'.repeat(30)}`, base);
  const long = downloadAnna(`${'n'.repeat(100)}.${'y'.repeat(30)}`);
  assert.ok(path.basename(long.savePath).length <= 80);
  item.finish();
  long.finish();
});

check('Windows 保留名带扩展名：con.pdf 前面加下划线；短文件名不变', () => {
  const reserved = downloadAnna('con.pdf');
  assert.strictEqual(path.basename(reserved.savePath), '_con.pdf');
  reserved.finish();
  const short = downloadAnna('Catalog 2026 (final).pdf');
  assert.strictEqual(path.basename(short.savePath), 'Catalog 2026 (final).pdf');
  short.finish();
  const none = downloadAnna('');
  assert.strictEqual(path.basename(none.savePath), 'download');
  none.finish();
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
