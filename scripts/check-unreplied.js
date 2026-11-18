// 「待回复」的判断和打开（src/unreplied.js）。用法：node scripts/check-unreplied.js
const assert = require('assert');
const { Unreplied, createUnrepliedOpener, digitsOfTitle, THRESHOLD_MS } = require('../src/unreplied');

const H = 60 * 60 * 1000;
let now = Date.UTC(2026, 10, 18, 15, 0);
let saved = null;
const make = (load = null) => new Unreplied({ now: () => now, load: () => load, save: (d) => { saved = d; } });
// 对话列表上一行（readChatList 的 reply 结果）
const row = (name, { out = false, age = 180, time = '12:00', unread = 0, group = false, muted = false } = {}) => ({ name, out, age, time, unread, is_group: group, muted, pinned: false });
const tick = (n) => Array.from({ length: n }, (_, i) => row(`Replied ${i}`, { out: true, age: 5, time: '14:55' }));

let u = make();
// 1) 客户发了 3 小时、我们没回：连着两次读到才列出来
assert(u.ingestWeb('a1', [row('Sophie Martin'), row('+49 151 2345678', { age: 30, time: '14:30' }), ...tick(2)]));
assert.deepStrictEqual(u.list(), [], '只读到一次不列（可能是正在输入）');
now += 60000;
u.ingestWeb('a1', [row('Sophie Martin', { age: 181 }), row('+49 151 2345678', { age: 31, time: '14:30' }), ...tick(2)]);
let l = u.list();
assert.deepStrictEqual(l.map((e) => e.name), ['Sophie Martin'], `等了 3 小时的列出来，30 分钟的不列：${JSON.stringify(l)}`);
assert(Math.abs(now - l[0].since - 181 * 60000) < 1000, '等的时间按列表上的时间算');
assert.strictEqual(l[0].accountId, 'a1');

// 2) 过了 2 小时，30 分钟那个也列出来，等得久的在前
now += 2 * H;
l = u.list();
assert.deepStrictEqual(l.map((e) => e.name), ['Sophie Martin', '+49 151 2345678'], '超过 2 小时就列，久的在前');

// 3) 回复了（最后一条有勾）就去掉；群、静音的不列；未读角标算客户发的
now += 60000;
u.ingestWeb('a1', [row('Sophie Martin', { out: true, age: 0, time: '17:02' }), row('Team Paris', { group: true }), row('Muted Klaus', { muted: true }), row('Hans Becker', { out: true, unread: 2, age: 200 }), ...tick(2)]);
now += 60000;
u.ingestWeb('a1', [row('Team Paris', { group: true }), row('Muted Klaus', { muted: true }), row('Hans Becker', { out: true, unread: 2, age: 201 }), ...tick(2)]);
l = u.list();
assert.deepStrictEqual(l.map((e) => e.name), ['Hans Becker', '+49 151 2345678'], `回了的去掉，群和静音不列，有未读的算没回：${JSON.stringify(l.map((e) => e.name))}`);

// 4) 没出现在这次列表里的（被挤下去了）照样留着
now += 60000;
u.ingestWeb('a1', tick(3));
assert.strictEqual(u.list().length, 2, '列表上没画出来的不去掉');

// 5) 读到很多私聊却一个勾都没有：当成认不出，不用
const before = JSON.stringify(u.toJSON());
assert.strictEqual(u.ingestWeb('a1', Array.from({ length: 8 }, (_, i) => row(`X${i}`))), false, '一个勾都没有的不可信');
assert.strictEqual(JSON.stringify(u.toJSON()), before, '不可信的那次不改记录');

// 6) 忽略、撤销；客户再发一条（时间变了）又出现
assert(u.dismiss('a1', 'Hans Becker'));
assert.deepStrictEqual(u.list().map((e) => e.name), ['+49 151 2345678']);
assert(u.undismiss('a1', 'Hans Becker'));
assert.strictEqual(u.list().length, 2, '撤销后放回');
u.dismiss('a1', 'Hans Becker');
now += 60000;
u.ingestWeb('a1', [row('Hans Becker', { unread: 2, age: 206, time: '12:00' }), ...tick(2)]);
assert.strictEqual(u.list().length, 1, '时间没变（没有新消息）还是忽略着');
now += 60000;
u.ingestWeb('a1', [row('Hans Becker', { unread: 3, age: 1, time: '17:09' }), ...tick(2)]);
now += 3 * H;
u.ingestWeb('a1', [row('Hans Becker', { unread: 3, age: 181, time: '17:09' }), ...tick(2)]);
assert(u.list().some((e) => e.name === 'Hans Becker'), '客户又发了一条：不再忽略');
assert(now - u.get('a1', 'Hans Becker').since < 4 * H, '今天的钟点用新的时间');

// 7) 昨天、星期几只是下限：不把以前读到的更准的时间往后挪
const y = make();
y.ingestWeb('b1', [row('Emma Wilson', { age: 300, time: '10:00' }), ...tick(2)]);
const first = y.get('b1', 'Emma Wilson').since;
now += 60000;
y.ingestWeb('b1', [row('Emma Wilson', { age: 30, time: 'Yesterday' }), ...tick(2)]);
assert.strictEqual(y.get('b1', 'Emma Wilson').since, first, '换成「昨天」时留着更准的时间');
// 认不出的日期：不新加
y.ingestWeb('b1', [row('Old Client', { age: null, time: '11/02/2026' }), ...tick(2)]);
assert.strictEqual(y.get('b1', 'Old Client'), null);
// 超过 7 天不列
now += 8 * 24 * H;
y.ingestWeb('b1', tick(2));
assert.strictEqual(y.get('b1', 'Emma Wilson'), null, '7 天以上的去掉');

// 8) 存盘再读回来一样；坏数据从空的开始；删号去掉
const again = make(JSON.parse(JSON.stringify(u.toJSON())));
assert(saved && saved.v === 1, '改了会存');
assert.deepStrictEqual(again.toJSON(), u.toJSON(), '读回来和存的一样');
assert.deepStrictEqual(make({ v: 1, accounts: { a: { x: { name: 1 } } } }).toJSON(), { v: 1, accounts: {} }, '坏数据丢掉');
assert.deepStrictEqual(make('garbage').toJSON(), { v: 1, accounts: {} });
again.drop('a1');
assert.deepStrictEqual(again.list(), []);

// 9) 轻量号：整份替换，最后一条是自己发的、群、没有等待时间的不列
const lite = make();
const ts = Math.floor(now / 1000);
lite.ingestLite('l1', [
  { jid: '4915112345678@s.whatsapp.net', name: 'Lena Fischer', group: false, me: false, wait: ts - 5 * 3600, ts: ts - 3600 },
  { jid: '33612345678@s.whatsapp.net', name: 'Claire', group: false, me: true, wait: 0, ts },
  { jid: '1203@g.us', name: 'Messe', group: true, me: false, wait: ts - 9000, ts },
]);
l = lite.list();
assert.deepStrictEqual(l.map((e) => e.key), ['4915112345678@s.whatsapp.net'], '轻量号只列客户最后说话的私聊');
assert(Math.abs(now - l[0].since - 5 * H) < 1000, '轻量号等的时间从我们最后一条之后客户第一条算');
lite.dismiss('l1', l[0].key);
lite.ingestLite('l1', [{ jid: '4915112345678@s.whatsapp.net', name: 'Lena Fischer', group: false, me: false, wait: ts - 5 * 3600, ts: ts - 3600 }]);
assert.deepStrictEqual(lite.list(), [], '轻量号忽略后没新消息还是忽略');
lite.ingestLite('l1', []);
assert.strictEqual(lite.get('l1', '4915112345678@s.whatsapp.net'), null, '轻量号回了（不在名单里）就去掉');

// 10) 号码样子的名字
assert.strictEqual(digitsOfTitle('+33 6 12 34 56 78'), '33612345678');
assert.strictEqual(digitsOfTitle('‪+1 (415) 555-0134‬'), '14155550134');
assert.strictEqual(digitsOfTitle('Sophie 2'), '');
assert.strictEqual(digitsOfTitle('12345'), '');

// ---- 打开 ----
(async () => {
  const store = make();
  store.ingestWeb('w1', [row('+33 6 12 34 56 78'), row('Sophie Martin'), ...tick(2)]);
  now += 60000;
  store.ingestWeb('w1', [row('+33 6 12 34 56 78'), row('Sophie Martin'), ...tick(2)]);
  store.ingestLite('l1', [{ jid: '4915112345678@s.whatsapp.net', name: 'Lena Fischer', group: false, me: false, wait: Math.floor(now / 1000) - 4 * 3600, ts: 1 }]);
  const calls = [];
  const st = { peer: { title: 'Someone else', chat: '' }, lookup: '', compose: { box: true, empty: true }, wc: {} };
  const opener = createUnrepliedOpener({
    store: () => store,
    findAcc: (id) => ({ w1: { id: 'w1', mode: 'web' }, l1: { id: 'l1', mode: 'lite' } })[id] || null,
    isLite: (a) => a.mode === 'lite',
    locked: () => false,
    webContents: () => st.wc,
    waPage: {
      readChatPeer: async () => st.peer,
      lookupPeerPhone: async (_wc, { title }) => { calls.push(['lookup', title]); return { digits: st.lookup }; },
      composeState: async () => st.compose,
    },
    activate: async (id) => { calls.push(['activate', id]); },
    liteOpen: (id, jid) => calls.push(['liteOpen', id, jid]),
    openNumber: async (id, digits) => { calls.push(['openNumber', id, digits]); return { result: 'opened' }; },
  });
  // 没存联系人的号：名字就是号码
  assert.deepStrictEqual(await opener.open('w1', '+33 6 12 34 56 78'), { result: 'opened' });
  assert.deepStrictEqual(calls.splice(0), [['activate', 'w1'], ['openNumber', 'w1', '33612345678']]);
  // 存了名字的：查 WhatsApp 本地联系人
  st.lookup = '33698765432';
  assert.deepStrictEqual(await opener.open('w1', 'Sophie Martin'), { result: 'opened' });
  assert.deepStrictEqual(calls.splice(0), [['lookup', 'Sophie Martin'], ['activate', 'w1'], ['openNumber', 'w1', '33698765432']]);
  // 查不到号码：只切到那个号
  st.lookup = '';
  assert.deepStrictEqual(await opener.open('w1', 'Sophie Martin'), { result: 'switched' });
  assert.deepStrictEqual(calls.splice(0), [['lookup', 'Sophie Martin'], ['activate', 'w1']]);
  // 已经开着：只切过去，不刷新
  st.peer = { title: 'Sophie Martin', chat: '' };
  assert.deepStrictEqual(await opener.open('w1', 'Sophie Martin'), { result: 'already' });
  assert.deepStrictEqual(calls.splice(0), [['activate', 'w1']]);
  // 输入框有字：先不切、不刷新，回 not_empty；带 force 再来才打开
  st.peer = null;
  st.compose = { box: true, empty: false };
  assert.deepStrictEqual(await opener.open('w1', '+33 6 12 34 56 78'), { result: 'not_empty' });
  assert.deepStrictEqual(calls.splice(0), [], '输入框有字时什么都不做');
  assert.deepStrictEqual(await opener.open('w1', '+33 6 12 34 56 78', true), { result: 'opened' });
  assert.deepStrictEqual(calls.splice(0), [['activate', 'w1'], ['openNumber', 'w1', '33612345678']]);
  // 页面没加载好：只切过去
  st.wc = null;
  assert.deepStrictEqual(await opener.open('w1', '+33 6 12 34 56 78'), { result: 'switched' });
  calls.splice(0);
  // 轻量号：选中这个对话
  assert.deepStrictEqual(await opener.open('l1', '4915112345678@s.whatsapp.net'), { result: 'opened' });
  assert.deepStrictEqual(calls.splice(0), [['activate', 'l1'], ['liteOpen', 'l1', '4915112345678@s.whatsapp.net']]);
  // 不在名单里的
  assert.deepStrictEqual(await opener.open('w1', 'Nobody'), { result: 'gone' });
  assert(THRESHOLD_MS === 2 * H);
  console.log('check-unreplied: ok');
})().catch((e) => { console.error(e); process.exit(1); });
