// 「待回复」的判断和打开（src/unreplied.js）。用法：node scripts/check-unreplied.js
const assert = require('assert');
const { Unreplied, createUnrepliedOpener, digitsOfTitle, withTimeout, THRESHOLD_MS } = require('../src/unreplied');

const H = 60 * 60 * 1000;
let now = Date.UTC(2026, 10, 18, 15, 0);
let saved = null;
const make = (load = null) => new Unreplied({ now: () => now, load: () => load, save: (d) => { saved = d; } });
// 对话列表上一行（readChatList 的 reply 结果）
const row = (name, { out = false, age = 180, time = '12:00', unread = 0, group = false, muted = false, sender = false } = {}) => ({ name, out, age, time, unread, is_group: group, muted, pinned: false, sender });
const feed = (store, id, rows, opts) => store.ingestWeb(id, rows, { atTop: true, ...opts });
const tick = (n) => Array.from({ length: n }, (_, i) => row(`Replied ${i}`, { out: true, age: 5, time: '14:55' }));

let u = make();
// 列表往前排到比它早时，这个号码的对话也要在列表里（真的列表是按时间排的）
const p49 = () => row('+49 151 2345678', { age: Math.round((now - u.get('a1', '+49 151 2345678').since) / 60000), time: '14:30' });
// 1) 客户发了 3 小时、我们没回：连着两次读到才列出来（存了名字的客户也列，不用先查到号码）
assert(feed(u, 'a1', [row('Sophie Martin'), row('+49 151 2345678', { age: 20, time: '14:40' }), ...tick(2)]).ok);
assert.deepStrictEqual(u.list(), [], '只读到一次不列（可能是正在输入）');
now += 60000;
feed(u, 'a1', [row('Sophie Martin', { age: 181 }), row('+49 151 2345678', { age: 21, time: '14:40' }), ...tick(2)]);
let l = u.list();
assert.deepStrictEqual(l.map((e) => e.name), ['Sophie Martin'], `等了 3 小时的列出来，20 分钟的不列：${JSON.stringify(l)}`);
assert(Math.abs(now - l[0].since - 181 * 60000) < 1000, '等的时间按列表上的时间算');
assert.strictEqual(l[0].accountId, 'a1');

assert.strictEqual(u.get('a1', 'Sophie Martin').digits, undefined, '存了名字的没有号码也列');
assert.strictEqual(u.get('a1', '+49 151 2345678').digits, '491512345678', '名字就是号码的记下号码');
// 2) 过了 30 分钟，20 分钟那个也列出来，等得久的在前
now += 10 * 60000;
assert.deepStrictEqual(u.list().map((e) => e.name), ['Sophie Martin', '+49 151 2345678'], '超过 30 分钟就列，久的在前');
now += 2 * H - 10 * 60000;

// 3) 回复了（最后一条有勾）就去掉；群、静音的不列；未读角标算客户发的
now += 60000;
feed(u, 'a1', [row('Sophie Martin', { out: true, age: 0, time: '17:02' }), row('Team Paris', { group: true }), row('Muted Klaus', { muted: true }), row('Hans Becker', { out: true, unread: 2, age: 200 }), row('+49 151 2345678', { age: 153, time: '14:30' }), ...tick(2)]);
now += 60000;
feed(u, 'a1', [row('Team Paris', { group: true }), row('Muted Klaus', { muted: true }), row('Hans Becker', { out: true, unread: 2, age: 201 }), row('+49 151 2345678', { age: 154, time: '14:30' }), ...tick(2)]);
l = u.list();
assert.deepStrictEqual(l.map((e) => e.name), ['Hans Becker', '+49 151 2345678'], `回了的去掉，群和静音不列，有未读的算没回：${JSON.stringify(l.map((e) => e.name))}`);

// 4) 没出现在这次列表里的（被挤下去了）照样留着
now += 60000;
feed(u, 'a1', tick(3));
assert.strictEqual(u.list().length, 2, '列表上没画出来的不去掉');

// 5) 读到很多已读私聊却一个勾都没有（WhatsApp 改了图标名）：只信未读角标，有未读的列，没未读的去掉
{
  const t5 = make();
  const noTicks = (extra) => [...Array.from({ length: 8 }, (_, i) => row(`X${i}`, { age: 5, time: '17:05' })), ...extra];
  feed(t5, 'n1', [row('Ana Ruiz', { age: 4, time: '17:06' }), ...tick(2)]);
  const st5 = feed(t5, 'n1', noTicks([row('Nora Weber', { unread: 1, age: 40, time: '16:30' }), row('Ana Ruiz', { age: 4, time: '17:06' })]));
  assert(st5.ok && st5.noTick, '认出是勾认不出');
  now += 60000;
  feed(t5, 'n1', noTicks([row('Nora Weber', { unread: 1, age: 41, time: '16:30' })]));
  assert.deepStrictEqual(t5.list().map((e) => e.name), ['Nora Weber'], `只列有未读的：${JSON.stringify(t5.list())}`);
  assert.strictEqual(t5.get('n1', 'X0'), null, '没未读的不记');
  assert.strictEqual(t5.get('n1', 'Ana Ruiz'), null, '记下的读过了（没未读）去掉');
  assert.strictEqual(st5.unread, 1);
  assert.strictEqual(st5.out, 0);
}

// 6) 忽略、撤销；客户再发一条（时间变了）又出现
assert(u.dismiss('a1', 'Hans Becker'));
assert.deepStrictEqual(u.list().map((e) => e.name), ['+49 151 2345678']);
assert(u.undismiss('a1', 'Hans Becker'));
assert.strictEqual(u.list().length, 2, '撤销后放回');
u.dismiss('a1', 'Hans Becker');
now += 60000;
feed(u, 'a1', [row('Hans Becker', { unread: 2, age: 206, time: '12:00' }), p49(), ...tick(2)]);
assert.strictEqual(u.list().length, 1, '时间没变（没有新消息）还是忽略着');
now += 60000;
feed(u, 'a1', [row('Hans Becker', { unread: 3, age: 1, time: '17:09' }), ...tick(2)]);
now += 3 * H;
feed(u, 'a1', [row('Hans Becker', { unread: 3, age: 181, time: '17:09' }), p49(), ...tick(2)]);
assert(u.list().some((e) => e.name === 'Hans Becker'), '客户又发了一条：不再忽略');
assert(now - u.get('a1', 'Hans Becker').since < 4 * H, '今天的钟点用新的时间');

// 7) 昨天、星期几只是下限：不把以前读到的更准的时间往后挪
const y = make();
feed(y, 'b1', [row('Emma Wilson', { age: 300, time: '10:00' }), ...tick(2)]);
const first = y.get('b1', 'Emma Wilson').since;
now += 60000;
feed(y, 'b1', [row('Emma Wilson', { age: 30, time: 'Yesterday' }), ...tick(2)]);
assert.strictEqual(y.get('b1', 'Emma Wilson').since, first, '换成「昨天」时留着更准的时间');
// 认不出的日期：不新加
feed(y, 'b1', [row('Old Client', { age: null, time: '11/02/2026' }), ...tick(2)]);
assert.strictEqual(y.get('b1', 'Old Client'), null);
// 超过 7 天不列
now += 8 * 24 * H;
feed(y, 'b1', tick(2));
assert.strictEqual(y.get('b1', 'Emma Wilson'), null, '7 天以上的去掉');

// 8) 存盘再读回来一样；坏数据从空的开始；删号去掉
const again = make(JSON.parse(JSON.stringify(u.toJSON())));
assert(saved && saved.v === 1, '改了会存');
assert.deepStrictEqual(again.toJSON(), u.toJSON(), '读回来和存的一样');
assert.deepStrictEqual(make({ v: 1, accounts: { a: { x: { name: 1 } } } }).toJSON(), { v: 1, accounts: {}, todos: {} }, '坏数据丢掉');
assert.deepStrictEqual(make('garbage').toJSON(), { v: 1, accounts: {}, todos: {} });
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

// 9b) 轻量号后台进程：真的 ChatStore + Session.chatList 给出 me 和 wait
const liteCheck = (async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { ChatStore } = await import('../src/lite/store.mjs');
  const { Session, replyState } = await import('../src/lite/session.mjs');
  assert.deepStrictEqual(replyState([]), { me: null, wait: 0 });
  assert.deepStrictEqual(replyState([{ me: true, ts: 5 }, { me: false, ts: 7 }, { me: false, ts: 9 }]), { me: false, wait: 7 }, '我们最后一条之后客户第一条');
  assert.deepStrictEqual(replyState([{ me: false, ts: 5 }, { me: true, ts: 9 }]), { me: true, wait: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-unreplied-'));
  const store = new ChatStore(dir, require('crypto').randomBytes(32), () => {});
  const msg = (jid, id, fromMe, t, text) => ({ key: { remoteJid: jid, id, fromMe }, messageTimestamp: t, message: { conversation: text } });
  const A = '4915112345678@s.whatsapp.net';
  const B = '33612345678@s.whatsapp.net';
  store.addMessage(msg(A, 'a1', false, 1000, 'Hallo'), { countUnread: false });
  store.addMessage(msg(A, 'a2', true, 1100, 'Hi'), { countUnread: false });
  store.addMessage(msg(A, 'a3', false, 1200, 'Preis?'), { countUnread: false });
  store.addMessage(msg(A, 'a4', false, 1300, 'Und Versand?'), { countUnread: false });
  store.addMessage(msg(B, 'b1', false, 1000, 'Bonjour'), { countUnread: false });
  store.addMessage(msg(B, 'b2', true, 1400, 'Bonjour !'), { countUnread: false });
  store.save.cancel();
  const by = Object.fromEntries(Session.prototype.chatList.call({ store }).map((c) => [c.jid, c]));
  assert.strictEqual(by[A].me, false);
  assert.strictEqual(by[A].wait, 1200, '轻量号 chatList：客户最后说话，从回复后客户第一条算');
  assert.strictEqual(by[B].me, true);
  assert.strictEqual(by[B].wait, 0, '轻量号 chatList：我们最后说话没有等待');
  fs.rmSync(dir, { recursive: true, force: true });
})();

// 9c) 审计提的几种情况
{
  const s2 = make();
  // 头像是照片的群：列表上认不出是群（is_group null），预览前面有发送人，不列
  feed(s2, 'g1', [row('Team Lyon', { group: null, sender: true }), ...tick(2)]);
  now += 60000;
  const st1 = feed(s2, 'g1', [row('Team Lyon', { group: null, sender: true }), ...tick(2)]);
  assert.deepStrictEqual(s2.list(), [], '预览前面有发送人的（头像是照片的群）不列');
  assert.strictEqual(st1.groups, 1);
  // 以前当成私聊记下的（最后一条是系统消息，没有发送人），后来认出是群：去掉
  feed(s2, 'g1', [row('Team Nice', { group: null }), ...tick(2)]);
  now += 60000;
  feed(s2, 'g1', [row('Team Nice', { group: null }), ...tick(2)]);
  assert.strictEqual(s2.list(new Set(['g1'])).length, 1);
  feed(s2, 'g1', [row('Team Nice', { group: null, sender: true }), ...tick(2)]);
  assert.strictEqual(s2.get('g1', 'Team Nice'), null, '认出是群就去掉');
  // 忽略以后过了半夜：「21:40」变成「昨天」，没有新消息，还是忽略着
  feed(s2, 'g2', [row('Sophie Martin', { age: 200, time: '21:40' }), ...tick(2)]);
  now += 60000;
  feed(s2, 'g2', [row('Sophie Martin', { age: 201, time: '21:40' }), ...tick(2)]);
  assert(s2.dismiss('g2', 'Sophie Martin'));
  now += 60000;
  feed(s2, 'g2', [row('Sophie Martin', { age: 5, time: 'Yesterday' }), ...tick(2)]);
  assert.strictEqual(s2.get('g2', 'Sophie Martin').dismissed, true, '过了半夜变成「昨天」不算新消息');
  // 搜索、筛选时读到的不用
  const snap = JSON.stringify(s2.toJSON());
  assert.strictEqual(feed(s2, 'g2', [row('Sophie Martin', { out: true, age: 0, time: '00:10' }), ...tick(2)], { filtered: true }).ok, false);
  assert.strictEqual(JSON.stringify(s2.toJSON()), snap, '搜索时读到的不改记录');
  // 早上一堆客户的未读（都没有勾）：照样用
  const morning = Array.from({ length: 8 }, (_, i) => row(`+49 151 00000${10 + i}`, { unread: 1, age: 300, time: '07:00' }));
  const st3 = feed(s2, 'g3', morning);
  assert(st3.ok && !st3.noTick, '有未读的不算进「一个勾都没有」');
  // 不在列表上了：画出来的对话已经排到比它还早，它却不在里面（存成联系人改了名字、归档、删了）
  feed(s2, 'g4', [row('+33 6 12 34 56 78', { age: 180, time: '09:00' }), ...tick(2)]);
  now += 60000;
  feed(s2, 'g4', [row('+33 6 12 34 56 78', { age: 181, time: '09:00' }), ...tick(2)]);
  assert.strictEqual(s2.list(new Set(['g4'])).length, 1);
  now += 60000;
  // 只画出了比它新的对话：留着
  feed(s2, 'g4', [row('Marie', { out: true, age: 1, time: '12:01' }), ...tick(2)]);
  assert.strictEqual(s2.list(new Set(['g4'])).length, 1, '列表没排到它那么早：留着');
  // 画出来的对话已经排到 5 小时前：它不在里面，去掉
  now += 60000;
  feed(s2, 'g4', [row('Marie', { out: true, age: 2, time: '12:02' }), ...tick(2), row('Old Lars', { out: true, age: 300, time: '07:03' })]);
  assert.strictEqual(s2.get('g4', '+33 6 12 34 56 78'), null, '列表排到比它还早、它却不在：去掉');
  // 用户把对话列表往下翻了：画出来的只是更早的对话，不能拿来去掉记下的（忽略也不能丢）
  feed(s2, 'g6', [row('+33 6 12 34 56 70', { age: 180, time: '09:00' }), ...tick(2)]);
  now += 60000;
  feed(s2, 'g6', [row('+33 6 12 34 56 70', { age: 181, time: '09:00' }), ...tick(2)]);
  s2.dismiss('g6', '+33 6 12 34 56 70');
  now += 60000;
  assert.strictEqual(feed(s2, 'g6', [row('Old A', { out: true, age: null, time: '11/10/2026' }), row('Old B', { out: true, age: null, time: '10/10/2026' })], { atTop: false }).ok, true);
  assert.strictEqual(s2.get('g6', '+33 6 12 34 56 70').dismissed, true, '往下翻过时不去掉，忽略也还在');
  // 翻回最上面也一样
  feed(s2, 'g6', [row('+33 6 12 34 56 70', { age: 183, time: '09:00' }), ...tick(2)]);
  assert.strictEqual(s2.get('g6', '+33 6 12 34 56 70').dismissed, true);
  // 以前的版本存的 noNum、tries 读回来时丢掉，照样列
  const old = make({ v: 1, accounts: { g8: { 'Nina A': { name: 'Nina A', since: now - H, hits: 2, sig: '09:00', unread: 0, dismissed: false, noNum: true, tries: 2 } } } });
  assert.deepStrictEqual(old.list().map((e) => e.name), ['Nina A'], '旧记录里查不到号码的也列');
  assert.strictEqual(old.get('g8', 'Nina A').noNum, undefined);
  // 置顶的对话不算往前排
  feed(s2, 'g5', [row('+33 6 12 34 56 79', { age: 180, time: '09:00' }), ...tick(2)]);
  now += 60000;
  feed(s2, 'g5', [{ ...row('Pinned Old', { out: true, age: 900, time: '00:00' }), pinned: true }, ...tick(2)]);
  assert(s2.get('g5', '+33 6 12 34 56 79'), '置顶的旧对话不算');
  // 时间取整到分钟：同一条消息每分钟读一次不再写盘
  saved = null;
  now += 20000;
  feed(s2, 'g5', [row('+33 6 12 34 56 79', { age: 184, time: '09:00' }), ...tick(2)]);
  saved = null;
  now += 60000;
  feed(s2, 'g5', [row('+33 6 12 34 56 79', { age: 185, time: '09:00' }), ...tick(2)]);
  assert.strictEqual(saved, null, '没有变化不写盘');
}

// 9d) 已完成：点了圆圈的、列出来以后我们回了的；放回；客户又发一条回到待回复；存盘还在；留 7 天
{
  const MIN = 60000;
  // 这里每次只给几行，不拿「画出来的行」去判断谁不在列表上了
  const feed = (store, id, rows) => store.ingestWeb(id, rows, { atTop: false });
  now = Date.UTC(2026, 10, 18, 15, 0);
  const d = make();
  const two = (rows) => { feed(d, 'd1', rows); now += MIN; feed(d, 'd1', rows.map((r) => ({ ...r, age: r.age + 1 }))); };
  const long = 'Hi, do you have the 0.07 C curl trays in stock? '.repeat(4);
  two([row('Emily Carter', { age: 90, time: '13:30', unread: 1 }), row('Lukas Müller', { age: 40, time: '14:20' }), row('Tom Reed', { age: 10, time: '14:50' }), ...tick(2)].map((r) => ({ ...r, last: r.name === 'Emily Carter' ? long : 'Wann können Sie die Muster verschicken?' })));
  let ls = d.list();
  assert.deepStrictEqual(ls.map((e) => e.name), ['Emily Carter', 'Lukas Müller'], '30 分钟以上的两个列出来');
  assert.strictEqual(ls[0].last.length, 120, '客户最后一句最多存 120 字');
  assert.strictEqual(ls[1].last, 'Wann können Sie die Muster verschicken?');
  assert.deepStrictEqual(d.doneList(), [], '一开始没有已完成');
  // 点圆圈：进已完成，记下钟点
  const t1 = now;
  assert(d.done('d1', 'Emily Carter'));
  assert.deepStrictEqual(d.list().map((e) => e.name), ['Lukas Müller']);
  assert.deepStrictEqual(d.doneList().map((e) => [e.name, e.kind, e.doneAt]), [['Emily Carter', 'reply', Math.floor(t1 / MIN) * MIN]], '点了圆圈进已完成');
  // 我们回了列出来的 Lukas：一分钟内进已完成；还没列出来的 Tom 回了直接去掉
  now += MIN;
  feed(d, 'd1', [row('Lukas Müller', { out: true, age: 0, time: '15:03' }), row('Tom Reed', { out: true, age: 0, time: '15:03' }), row('Emily Carter', { age: 93, time: '13:30', unread: 1 }), ...tick(2)]);
  assert.deepStrictEqual(d.list(), [], '回了的不列');
  assert.deepStrictEqual(d.doneList().map((e) => [e.name, d.get('d1', e.key).how]), [['Lukas Müller', 'replied'], ['Emily Carter', 'tick']], '回过的进已完成，最近的在前');
  assert.strictEqual(d.get('d1', 'Tom Reed'), null, '还没列出来的回了就去掉');
  // 对方正在输入（只一次没有勾、时间比记下的新）：还在已完成；连着两次才回到待回复
  now += MIN;
  feed(d, 'd1', [row('Lukas Müller', { age: 0, time: '15:04' }), ...tick(2)]);
  assert(d.doneList().some((e) => e.name === 'Lukas Müller'), '读到一次「正在输入」不算客户又发了');
  now += MIN;
  feed(d, 'd1', [row('Lukas Müller', { out: true, age: 2, time: '15:03' }), ...tick(2)]);
  assert.strictEqual(d.get('d1', 'Lukas Müller').back, undefined, '又看到是我们发的，清掉那一次');
  now += MIN;
  feed(d, 'd1', [{ ...row('Lukas Müller', { age: 0, time: '15:07' }), last: 'Danke!' }, ...tick(2)]);
  now += MIN;
  feed(d, 'd1', [{ ...row('Lukas Müller', { age: 1, time: '15:07' }), last: 'Danke!' }, ...tick(2)]);
  assert(!d.doneList().some((e) => e.name === 'Lukas Müller'), '客户又发了一条：不在已完成');
  assert.strictEqual(d.get('d1', 'Lukas Müller').last, 'Danke!', '第二行换成新的一句');
  now += 31 * MIN;
  assert(d.list().some((e) => e.name === 'Lukas Müller'), '过 30 分钟回到待回复');
  // 未读变多：一次就回到待回复
  feed(d, 'd1', [row('Emily Carter', { age: 130, time: '13:30', unread: 2 }), ...tick(2)]);
  assert(d.list().some((e) => e.name === 'Emily Carter'), '未读变多回到待回复');
  // 放回：点了圆圈的直接放回；回过的放回后不再自己挪去已完成
  d.done('d1', 'Emily Carter');
  assert.strictEqual(d.restore('d1', 'Emily Carter'), true);
  assert(d.list().some((e) => e.name === 'Emily Carter'), '点绿勾放回待回复');
  assert.strictEqual(d.restore('d1', 'Emily Carter'), false, '不在已完成的放回不了');
  feed(d, 'd1', [row('Lukas Müller', { out: true, age: 0, time: '15:40' }), ...tick(2)]);
  assert.strictEqual(d.get('d1', 'Lukas Müller').how, 'replied');
  d.restore('d1', 'Lukas Müller');
  now += MIN;
  feed(d, 'd1', [row('Lukas Müller', { out: true, age: 1, time: '15:40' }), ...tick(2)]);
  assert(d.list().some((e) => e.name === 'Lukas Müller'), '放回的回过的对话留在待回复');
  d.done('d1', 'Lukas Müller');
  assert.strictEqual(d.get('d1', 'Lukas Müller').keep, undefined, '再点圆圈清掉 keep');
  // 存盘再读回来：已完成还在
  const back = make(JSON.parse(JSON.stringify(d.toJSON())));
  assert.deepStrictEqual(back.doneList(), d.doneList(), '重启后已完成还在');
  assert.deepStrictEqual(back.list(), d.list());
  // 旧文件（点过圆圈、没有 doneAt）：不算已完成，也不报错
  const old = make({ v: 1, accounts: { o1: { 'Ann Lee': { name: 'Ann Lee', since: now - 3 * H, hits: 2, sig: '12:00', unread: 0, dismissed: true } } } });
  assert.deepStrictEqual([old.list(), old.doneList()], [[], []], '旧文件按没有已完成处理');
  // 不只今天：过了半夜还在；办完 7 天后去掉
  assert.deepStrictEqual(d.doneList().map((e) => e.name), ['Lukas Müller']);
  now += 24 * H;
  assert.deepStrictEqual(d.doneList().map((e) => e.name), ['Lukas Müller'], '过了半夜还在');
  now += 7 * 24 * H;
  feed(d, 'd1', tick(2));
  assert.deepStrictEqual(d.doneList(), [], '7 天后去掉');
  // 认不出勾的号：回了不知道，只有点了圆圈的进已完成
  now = Date.UTC(2026, 10, 18, 15, 0);
  const nt = make();
  const quiet = (extra) => [...Array.from({ length: 8 }, (_, i) => row(`Q${i}`, { age: 5, time: '14:55' })), ...extra];
  feed(nt, 'n2', quiet([row('Nora Weber', { unread: 1, age: 40, time: '14:20' })]));
  now += MIN;
  feed(nt, 'n2', quiet([row('Nora Weber', { unread: 1, age: 41, time: '14:20' })]));
  assert.strictEqual(nt.list().length, 1);
  now += MIN;
  feed(nt, 'n2', quiet([row('Nora Weber', { age: 0, time: '15:02' })]));
  assert.deepStrictEqual([nt.list(), nt.doneList()], [[], []], '认不出勾时读过了就去掉，不进已完成');
  // 轻量号：列出来的回了进已完成；客户又发一条（ts 变了）回到待回复；客户最后一句取预览
  now = Date.UTC(2026, 10, 18, 15, 0);
  const lt = make();
  const jid = '4915112345678@s.whatsapp.net';
  const sec = (ms) => ms / 1000;
  lt.ingestLite('l9', [{ jid, name: 'Anna Schmidt', me: false, wait: sec(now - 2 * H), ts: sec(now - 2 * H), preview: 'Können Sie mir den Katalog schicken?' }]);
  assert.strictEqual(lt.list()[0].last, 'Können Sie mir den Katalog schicken?', '轻量号第二行用预览');
  now += MIN;
  lt.ingestLite('l9', [{ jid, name: 'Anna Schmidt', me: true, ts: sec(now) }]);
  assert.deepStrictEqual([lt.list().length, lt.doneList().map((e) => e.name)], [0, ['Anna Schmidt']], '轻量号回了进已完成');
  now += MIN;
  lt.ingestLite('l9', [{ jid, name: 'Anna Schmidt', me: true, ts: sec(now - MIN) }]);
  assert.strictEqual(lt.doneList().length, 1, '轻量号已完成留着');
  lt.ingestLite('l9', [{ jid, name: 'Anna Schmidt', me: false, wait: sec(now), ts: sec(now), preview: 'Danke' }]);
  assert.deepStrictEqual(lt.doneList(), [], '客户又发了一条，不在已完成');
  now += 31 * MIN;
  assert.strictEqual(lt.list()[0].last, 'Danke');
  lt.done('l9', jid);
  lt.ingestLite('l9', [{ jid, name: 'Anna Schmidt', me: false, wait: sec(now - 31 * MIN), ts: sec(now - 31 * MIN), preview: 'Danke' }]);
  assert.strictEqual(lt.doneList().length, 1, '点了圆圈的，最后一条没变就留在已完成');
  lt.restore('l9', jid);
  assert.strictEqual(lt.list().length, 1, '轻量号放回');
}

// 10) 号码样子的名字
assert.strictEqual(digitsOfTitle('+33 6 12 34 56 78'), '33612345678');
assert.strictEqual(digitsOfTitle('‪+1 (415) 555-0134‬'), '14155550134');
assert.strictEqual(digitsOfTitle('Sophie 2'), '');
assert.strictEqual(digitsOfTitle('12345'), '');

// ---- 打开 ----
(async () => {
  await liteCheck;
  const store = make();
  feed(store, 'w1', [row('+33 6 12 34 56 78'), row('Sophie Martin'), ...tick(2)]);
  now += 60000;
  feed(store, 'w1', [row('+33 6 12 34 56 78'), row('Sophie Martin'), ...tick(2)]);
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
  // 存了名字的：点的时候查 WhatsApp 本地联系人
  st.lookup = '33611111111';
  assert.deepStrictEqual(await opener.open('w1', 'Sophie Martin'), { result: 'opened' });
  assert.deepStrictEqual(calls.splice(0), [['lookup', 'Sophie Martin'], ['activate', 'w1'], ['openNumber', 'w1', '33611111111']]);
  store.acc('w1').set('Paul Klein', { name: 'Paul Klein', since: now - 3 * H, hits: 2, sig: '12:00', unread: 0, dismissed: false });
  st.lookup = '33698765432';
  assert.deepStrictEqual(await opener.open('w1', 'Paul Klein'), { result: 'opened' });
  assert.deepStrictEqual(calls.splice(0), [['lookup', 'Paul Klein'], ['activate', 'w1'], ['openNumber', 'w1', '33698765432']]);
  // 查不到号码：只切到那个号
  st.lookup = '';
  assert.deepStrictEqual(await opener.open('w1', 'Paul Klein'), { result: 'switched' });
  assert.deepStrictEqual(calls.splice(0), [['lookup', 'Paul Klein'], ['activate', 'w1']]);
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
  assert(THRESHOLD_MS === 30 * 60000, '等 30 分钟');
  // 页面卡住（脚本永远不回）：读取按时放弃，下一分钟还能再读
  assert.strictEqual(await withTimeout(new Promise(() => {}), 50, 'gave-up'), 'gave-up', '卡住的读取超时放弃');
  assert.strictEqual(await withTimeout(Promise.reject(new Error('x')), 50, null), null, '出错给默认值');
  assert.strictEqual(await withTimeout(Promise.resolve(7), 50, null), 7);
  console.log('check-unreplied: ok');
})().catch((e) => { console.error(e); process.exit(1); });
