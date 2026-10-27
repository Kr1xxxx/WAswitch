// 新账号 id（src/account-id.js）：同一毫秒连建两个号 id 不同；和已有账号不重复；时间往回调也不重复
const assert = require('assert');
const { newAccountId } = require('../src/account-id');

const accounts = [];
const now = 1800000000000;

// 同一毫秒连建两个号（第二个建的时候第一个已经在列表里）
const a = newAccountId(accounts, now); accounts.push({ id: a });
const b = newAccountId(accounts, now); accounts.push({ id: b });
assert.notStrictEqual(a, b, '同一毫秒连建两个号 id 应不同');

// 还没放进列表就再要一个（两处同时新建）也不同
const c = newAccountId(accounts, now);
const d = newAccountId(accounts, now);
assert.notStrictEqual(c, d, '还没保存时连要两次 id 应不同');
accounts.push({ id: c }, { id: d });

// 已有账号占着的 id 会跳过（例如从文件读回来的旧号）
const taken = [{ id: String(now + 100) }, { id: String(now + 101) }];
const e = newAccountId(taken, now + 100);
assert.ok(!taken.some((x) => x.id === e), '不应和已有账号同 id');

// 系统时间往回调了：不会拿到用过的 id
const f = newAccountId(accounts, now - 60000);
assert.ok(!accounts.some((x) => x.id === f), '时间回调后不应重复');

// id 还是字符串数字（分区名、存档都按字符串用）
for (const id of [a, b, c, d, e, f]) assert.match(id, /^\d+$/);

console.log('新账号 id 自检通过');
