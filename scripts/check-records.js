// 话术 / 客户 / 翻译模式的导出导入：同一个文件导两次条数不变，停用账号的客户也能导出导回
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../src/records');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
const out = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
const roundTrip = (store, kind, format) => {
  const rows = store.list();
  const text = format === 'json'
    ? JSON.stringify(rows.map(({ deleted, reminded, updatedAt, ...rest }) => rest), null, 2)
    : R.toCsv(kind, rows);
  const res = R.readImport(kind, out(`${kind}.${format}`, text));
  assert(!res.error, res.error);
  return res.rows;
};

// 客户：a1 是正常账号，a2 是停用账号（导出时 main.js 不再过滤它）
const cs = new R.Records(dir, 'customers');
cs.upsert({ accountId: 'a1', name: 'Maria Lopez', phone: '+34 612 345 678', tags: ['VIP'] });
cs.upsert({ accountId: 'a1', name: 'Tom Becker', phone: '' });
cs.upsert({ accountId: 'a2', name: 'Claire Dubois', phone: '+33 6 12 34 56 78' });
cs.upsert({ accountId: 'a2', name: 'Maria Lopez', phone: '+34 612 345 678' }); // 同一个电话、另一个账号：不算重复
assert.equal(cs.list().length, 4);

for (const format of ['csv', 'json']) {
  const rows = roundTrip(cs, 'customers', format);
  assert.equal(rows.length, 4, `${format} 导出应包含停用账号的客户`);
  const r1 = cs.importRows(rows);
  assert.deepEqual(r1, { added: 0, dup: 4, bad: 0 }, `${format} 原样导回不该新增`);
  const r2 = cs.importRows(rows);
  assert.deepEqual(r2, { added: 0, dup: 4, bad: 0 });
  assert.equal(cs.list().length, 4, `${format} 导两次条数不变`);
}

// 换个空的本机导入两次：第一次全加，第二次全跳过
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rec2-'));
const cs2 = new R.Records(dir2, 'customers');
const rows = roundTrip(cs, 'customers', 'csv');
assert.deepEqual(cs2.importRows(rows), { added: 4, dup: 0, bad: 0 });
assert.deepEqual(cs2.importRows(rows), { added: 0, dup: 4, bad: 0 });
assert.equal(cs2.list().length, 4);
assert.equal(cs2.list().filter((c) => c.accountId === 'a2').length, 2, '停用账号的客户导回原账号');

// 电话写法不同也算同一个；文件里自己重复的只留一条；没名字没电话的算内容不全
assert.deepEqual(cs2.importRows([
  { accountId: 'a1', name: 'Maria L.', phone: '34612345678' },
  { accountId: 'a1', name: 'tom becker' },
  { accountId: 'a3', name: 'Jan Novak', phone: '+49 151 1234 5678' },
  { accountId: 'a3', name: 'Jan N.', phone: '+49-151-12345678' },
  { accountId: 'a3', note: 'nothing' },
]), { added: 1, dup: 3, bad: 1 });
assert.equal(cs2.list().length, 5);

// 删掉的不挡导入
const tom = cs2.list().find((c) => c.name === 'Tom Becker');
cs2.remove(tom.id);
assert.deepEqual(cs2.importRows([{ accountId: 'a1', name: 'Tom Becker' }]), { added: 1, dup: 0, bad: 0 });

// 话术和翻译模式：导两次也不变
const rs = new R.Records(dir, 'replies');
rs.upsert({ title: 'Hi', text: 'Hello, thanks for reaching out.' });
rs.upsert({ title: 'Price', text: 'Our price list is attached.' });
const rrows = roundTrip(rs, 'replies', 'csv');
rs.importRows(rrows); rs.importRows(rrows);
assert.equal(rs.list().length, 2);
const ms = new R.Records(dir, 'tmodes');
ms.upsert({ name: 'Formal', direction: 'out', prompt: 'Write formally.' });
const mrows = roundTrip(ms, 'tmodes', 'json');
ms.importRows(mrows); ms.importRows(mrows);
assert.equal(ms.list().length, 1);

// 存盘后重新读出来条数一样
assert.equal(new R.Records(dir2, 'customers').list().length, cs2.list().length);
console.log('check-records ok');
