// 导入文件的编码和分隔符（src/records.js readImport）：UTF-8、UTF-8 BOM、UTF-16LE/BE（Excel「Unicode 文本」，制表符分隔）、
// 分号分隔都能读；GBK 之类认不出的编码和没有列名的文件给出看得懂的提示
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readImport, toCsv } = require('../src/records');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-import-'));
const write = (name, buf) => { const f = path.join(dir, name); fs.writeFileSync(f, buf); return f; };
const want = [
  { name: 'Müller GmbH', phone: '+49 30 1234567', note: 'Rückruf, bitte "dringend"' },
  { name: 'Café Lumière', phone: '+33 1 23 45 67 89', note: '法国客户' },
];
const check = (label, file) => {
  const res = readImport('customers', file);
  assert.ok(!res.error, `${label}: ${res.error}`);
  assert.deepStrictEqual(res.rows.map((r) => ({ name: r.name, phone: r.phone, note: r.note })), want, label);
  console.log(`ok  ${label}`);
};
try {
  const csv = '名字,电话,备注\r\n' + want.map((r) => [r.name, r.phone, r.note].map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
  const tsv = '名字\t电话\t备注\r\n' + want.map((r) => [r.name, r.phone, `"${r.note.replace(/"/g, '""')}"`].join('\t')).join('\r\n') + '\r\n';
  const utf16le = (t) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]);

  check('UTF-8', write('a.csv', Buffer.from(csv, 'utf8')));
  check('UTF-8 BOM', write('b.csv', Buffer.from(`﻿${csv}`, 'utf8')));
  check('UTF-16LE 逗号', write('c.csv', utf16le(csv)));
  check('UTF-16LE 制表符（Excel Unicode 文本）', write('d.txt', utf16le(tsv)));
  check('UTF-16BE', write('e.csv', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(tsv, 'utf16le').swap16()])));
  check('UTF-16LE 无 BOM', write('f.txt', Buffer.from(tsv.replace(/^名字/, 'name').replace('电话', 'phone').replace('备注', 'note'), 'utf16le')));
  check('分号分隔', write('g.csv', Buffer.from(csv.replace(/","/g, '";"').replace(/^名字,电话,备注/, '名字;电话;备注'), 'utf8')));
  check('JSON UTF-16LE', write('h.json', utf16le(JSON.stringify(want))));

  // 自己导出的文件原样导回
  const back = readImport('customers', write('i.csv', Buffer.from(toCsv('customers', want), 'utf8')));
  assert.deepStrictEqual(back.rows.map((r) => r.name), want.map((r) => r.name));
  console.log('ok  导出再导入');

  // GBK：不硬读成乱码，提示另存为 UTF-8
  const gbk = Buffer.from([0xc3, 0xfb, 0xd7, 0xd6, 0x2c, 0xb5, 0xe7, 0xbb, 0xb0, 0x0d, 0x0a, 0x41, 0x2c, 0x31]); // 名字,电话\r\nA,1
  let r = readImport('customers', write('gbk.csv', gbk));
  assert.ok(/编码认不出/.test(r.error) && /CSV UTF-8/.test(r.error), r.error);
  console.log('ok  GBK 提示：' + r.error);

  // 没有列名
  r = readImport('customers', write('nohead.csv', Buffer.from('Anna,+44 20 7946 0000\r\n', 'utf8')));
  assert.ok(/第一行没找到列名/.test(r.error) && /名字、电话/.test(r.error) && /CSV UTF-8/.test(r.error), r.error);
  console.log('ok  缺列名提示：' + r.error);
  console.log('导入编码自检通过');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
