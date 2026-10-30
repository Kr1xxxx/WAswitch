// 译文文件读盘自检：读失败不能把整份旧译文覆盖掉。
// 内容坏了（不是 JSON 对象）先留一份 .broken- 备份再当空的；没有文件、空文件当空的不备份；
// 一时读不了（EBUSY、EPERM）或备份没成功：不覆盖，flush 报没写完，过 5 秒再读，读到了和内存合并（同一个键以盘上的为准）。
// 别名表（_chats.json）走同一条路。不连网络，不调模型。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TrStore, textKey } = require('../src/trstore');

const ACC = 'acc1';
const CHAT = '0123456789abcdef';
const OTHER = 'fedcba9876543210';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-trstore-'));
const realRead = fs.readFileSync;
const realCopy = fs.copyFileSync;
const realWarn = console.warn;
let locked = null; // { file, code }：读这个文件时抛错
let copyFails = false;
let reads = 0;
fs.readFileSync = function patchedRead(p, ...a) {
  if (locked && String(p) === locked.file) {
    reads += 1;
    const e = new Error(locked.code);
    e.code = locked.code;
    throw e;
  }
  return realRead.call(fs, p, ...a);
};
fs.copyFileSync = function patchedCopy(...a) {
  if (copyFails) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
  return realCopy.apply(fs, a);
};
let warns = [];
console.warn = (m) => { warns.push(String(m)); };

let n = 0;
const fresh = () => {
  n += 1;
  const dir = path.join(root, `t${n}`);
  fs.mkdirSync(path.join(dir, ACC), { recursive: true });
  warns = [];
  return dir;
};
const fileOf = (dir, chat = CHAT) => path.join(dir, ACC, `${chat}.json`);
const backups = (dir, chat = CHAT) => fs.readdirSync(path.join(dir, ACC)).filter((f) => f.startsWith(`${chat}.json.broken-`));
const readFile = (f) => realRead.call(fs, f);
const SAMPLES = [
  ['Hello, is the 22 inch lace front still available?', '你好，22 英寸蕾丝头套还有货吗？'],
  ['Guten Tag, wann kommt die Perücke an?', '你好，假发什么时候到？'],
  ['Bonjour, le colis est arrivé ?', '你好，包裹到了吗？'],
  ['Hola, ¿tienen la peluca en color rubio?', '你好，有金色的假发吗？'],
];
const EDITED = SAMPLES[2][0];
// 30 条译文，其中一条是手改过的
const seed = () => {
  const d = {};
  for (let i = 0; i < 30; i += 1) {
    const text = i < SAMPLES.length ? SAMPLES[i][0] : `Order #${1000 + i}: please confirm the shipping address.`;
    const tr = i < SAMPLES.length ? SAMPLES[i][1] : `订单 ${1000 + i}：请确认收货地址。`;
    d[textKey(text)] = { tr: text === EDITED ? '你好，包裹到了吗？（手改）' : tr, text, edited: text === EDITED, fixed: false, at: 1000 + i };
  }
  return d;
};
const put = (dir, data, chat = CHAT) => fs.writeFileSync(fileOf(dir, chat), JSON.stringify(data));
const count = (f) => Object.keys(JSON.parse(readFile(f))).length;

// 1. 内容坏了：备份和坏文件逐字节相同，新记录写进原文件
{
  const dir = fresh();
  const full = JSON.stringify(seed());
  const broken = full.slice(0, Math.floor(full.length / 2));
  fs.writeFileSync(fileOf(dir), broken);
  const s = new TrStore(dir);
  assert.strictEqual(s.get(ACC, CHAT, SAMPLES[0][0]), null, '坏文件读不出旧译文');
  s.put(ACC, CHAT, 'Gracias, lo confirmo mañana.', { tr: '谢谢，我明天确认。', text: 'Gracias, lo confirmo mañana.' });
  assert.strictEqual(s.flush(), true);
  const bk = backups(dir);
  assert.strictEqual(bk.length, 1, '留一份 .broken- 备份');
  assert.ok(readFile(path.join(dir, ACC, bk[0])).equals(Buffer.from(broken)), '备份和坏文件逐字节相同');
  assert.strictEqual(count(fileOf(dir)), 1, '原文件只有新的那条');
  assert.ok(warns.some((w) => w.includes('已备份到')), '日志里记一条');
  assert.ok(!warns.some((w) => w.includes(SAMPLES[0][0]) || w.includes('Gracias')), '日志里没有聊天内容');
}

// 2. 内容是 JSON 但不是对象：都备份，都当空的
for (const bad of ['[]', '"x"', 'null', '42']) {
  const dir = fresh();
  fs.writeFileSync(fileOf(dir), bad);
  const s = new TrStore(dir);
  assert.strictEqual(s.get(ACC, CHAT, SAMPLES[0][0]), null);
  s.put(ACC, CHAT, SAMPLES[1][0], { tr: SAMPLES[1][1], text: SAMPLES[1][0] });
  assert.strictEqual(s.flush(), true, bad);
  const bk = backups(dir);
  assert.strictEqual(bk.length, 1, `${bad} 要备份`);
  assert.strictEqual(readFile(path.join(dir, ACC, bk[0])).toString(), bad);
  assert.strictEqual(s.get(ACC, CHAT, SAMPLES[1][0]).tr, SAMPLES[1][1]);
}

// 3. 空文件：不备份，当空的，能正常存
for (const blank of ['', '  \n\t ']) {
  const dir = fresh();
  fs.writeFileSync(fileOf(dir), blank);
  const s = new TrStore(dir);
  s.put(ACC, CHAT, SAMPLES[1][0], { tr: SAMPLES[1][1], text: SAMPLES[1][0] });
  assert.strictEqual(s.flush(), true);
  assert.strictEqual(backups(dir).length, 0, '空文件没东西可丢，不备份');
  assert.strictEqual(count(fileOf(dir)), 1);
  assert.strictEqual(warns.length, 0);
}

// 4. 没有文件：不备份；打开过、没有收到消息的对话不为它建文件
{
  const dir = fresh();
  const s = new TrStore(dir);
  assert.strictEqual(s.get(ACC, CHAT, SAMPLES[0][0]), null);
  s.putView(ACC, CHAT, []);
  assert.strictEqual(s.flush(), true);
  assert.ok(!fs.existsSync(fileOf(dir)), 'putView 空列表不建文件');
  s.put(ACC, CHAT, SAMPLES[0][0], { tr: SAMPLES[0][1], text: SAMPLES[0][0] });
  assert.strictEqual(s.flush(), true);
  assert.strictEqual(backups(dir).length, 0);
  assert.strictEqual(count(fileOf(dir)), 1);
  assert.strictEqual(warns.length, 0);
}

// 5. 一时读不了，一直到 flush：文件逐字节不变；6. 恢复后合并，手改的以盘上的为准
{
  const dir = fresh();
  put(dir, seed());
  const before = readFile(fileOf(dir));
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    locked = { file: fileOf(dir), code };
    const s = new TrStore(dir);
    assert.strictEqual(s.get(ACC, CHAT, EDITED), null, '这时读不到旧译文');
    s.put(ACC, CHAT, EDITED, { tr: '你好，包裹到了吗', text: EDITED }); // 自动重翻了一遍手改过的
    s.put(ACC, CHAT, 'Danke schön', { tr: '非常感谢', text: 'Danke schön' });
    assert.strictEqual(s.flush(), false, `${code}：读不了时 flush 报没写完`);
    assert.ok(readFile(fileOf(dir)).equals(before), `${code}：文件一个字没动`);
    assert.strictEqual(backups(dir).length, 0, '读不了不是坏了，不备份');
    assert.strictEqual(warns.filter((w) => w.includes('读不了')).length, 1, '同一个对话只记一条日志');
    assert.ok(warns[0].includes(code) && !warns.join('').includes('Danke'), '日志有错误码，没有聊天内容');
    warns = [];
    locked = null;
    assert.strictEqual(s.flush(), true, `${code}：恢复后写得进去`);
    const d = JSON.parse(readFile(fileOf(dir)));
    assert.strictEqual(Object.keys(d).length, 31, '30 条旧的 + 1 条新的');
    assert.strictEqual(d[textKey(EDITED)].tr, '你好，包裹到了吗？（手改）', '手改的以盘上的为准');
    assert.strictEqual(d[textKey(EDITED)].edited, true);
    assert.strictEqual(d[textKey('Danke schön')].tr, '非常感谢', '这期间新存的补上');
    assert.strictEqual(s.get(ACC, CHAT, EDITED).edited, true);
    put(dir, seed()); // 下一轮从原样开始
  }
}

// 6b. 反向：读不了期间用户手改了盘上的自动译文，恢复后手改的赢
{
  const dir = fresh();
  const d0 = seed();
  const auto = textKey(SAMPLES[0][0]);
  put(dir, d0);
  locked = { file: fileOf(dir), code: 'EBUSY' };
  const s = new TrStore(dir);
  s.get(ACC, CHAT, SAMPLES[0][0]);
  s.putKey(ACC, CHAT, auto, { tr: '你好，22 英寸蕾丝头套还有现货吗？（手改）', text: SAMPLES[0][0], edited: true });
  assert.strictEqual(s.flush(), false);
  locked = null;
  assert.strictEqual(s.flush(), true);
  const d = JSON.parse(readFile(fileOf(dir)));
  assert.strictEqual(d[auto].edited, true, '读不了期间手改的不能被盘上的自动译文盖掉');
  assert.strictEqual(d[auto].tr, '你好，22 英寸蕾丝头套还有现货吗？（手改）');
  assert.strictEqual(Object.keys(d).length, 30);
}

// 7. 再读的节奏：读不了之后马上 get 不重读；过了 5 秒才再读
{
  const dir = fresh();
  put(dir, seed());
  locked = { file: fileOf(dir), code: 'EBUSY' };
  reads = 0;
  const s = new TrStore(dir);
  assert.strictEqual(s.get(ACC, CHAT, SAMPLES[0][0]), null);
  assert.strictEqual(reads, 1);
  s.get(ACC, CHAT, SAMPLES[0][0]);
  s.get(ACC, CHAT, SAMPLES[1][0]);
  assert.strictEqual(reads, 1, '5 秒内不重读');
  locked = null;
  assert.strictEqual(s.get(ACC, CHAT, SAMPLES[0][0]), null, '5 秒内文件好了也先不读');
  s.mem.get(`${ACC}/${CHAT}`).unread -= 5000;
  assert.strictEqual(s.get(ACC, CHAT, SAMPLES[0][0]).tr, SAMPLES[0][1], '过了 5 秒读到旧译文');
  assert.strictEqual(s.mem.get(`${ACC}/${CHAT}`).unread, undefined);
  // 过了 5 秒还读不了：继续等，不记第二条日志
  put(dir, seed());
  warns = [];
  locked = { file: fileOf(dir, OTHER), code: 'EBUSY' };
  put(dir, seed(), OTHER);
  const s2 = new TrStore(dir);
  s2.get(ACC, OTHER, SAMPLES[0][0]);
  for (let i = 0; i < 3; i += 1) { s2.mem.get(`${ACC}/${OTHER}`).unread -= 5000; s2.get(ACC, OTHER, SAMPLES[0][0]); }
  assert.strictEqual(warns.length, 1, '重试失败不刷屏');
  locked = null;
}

// 8. 备份失败：不覆盖，flush 报没写完
{
  const dir = fresh();
  const full = JSON.stringify(seed());
  const broken = full.slice(0, 200);
  fs.writeFileSync(fileOf(dir), broken);
  copyFails = true;
  const s = new TrStore(dir);
  s.put(ACC, CHAT, SAMPLES[1][0], { tr: SAMPLES[1][1], text: SAMPLES[1][0] });
  assert.strictEqual(s.flush(), false);
  assert.ok(readFile(fileOf(dir)).equals(Buffer.from(broken)), '备份没成功，坏文件也不动');
  assert.strictEqual(backups(dir).length, 0);
  assert.ok(warns.some((w) => w.includes('备份失败') && w.includes('EACCES')));
  copyFails = false;
  assert.strictEqual(s.flush(), true, '备份能做了就写');
  assert.strictEqual(backups(dir).length, 1);
  assert.ok(readFile(path.join(dir, ACC, backups(dir)[0])).equals(Buffer.from(broken)));
  assert.strictEqual(count(fileOf(dir)), 1);
}

// 9. 别名表（_chats.json）：读不了不覆盖，恢复后别名原样、新的“见过”补进去；坏了有备份
{
  const dir = fresh();
  const meta = path.join(dir, ACC, '_chats.json');
  const aliasOnly = { alias: { [OTHER]: CHAT }, seen: { '1111111111111111': CHAT } };
  fs.writeFileSync(meta, JSON.stringify(aliasOnly));
  const before = readFile(meta);
  locked = { file: meta, code: 'EPERM' };
  const s = new TrStore(dir);
  s.markSeen(ACC, '2222222222222222', OTHER);
  assert.strictEqual(s.flush(), false);
  assert.ok(readFile(meta).equals(before), '别名表没变');
  locked = null;
  assert.strictEqual(s.flush(), true);
  const d = JSON.parse(readFile(meta));
  assert.deepStrictEqual(d.alias, { [OTHER]: CHAT }, '别名原样');
  assert.strictEqual(d.seen['1111111111111111'], CHAT);
  assert.strictEqual(d.seen['2222222222222222'], OTHER, '新的见过补进去');
  assert.strictEqual(s.canon(ACC, OTHER), CHAT);
  assert.deepStrictEqual(Object.keys(d.seen), ['1111111111111111', '2222222222222222'], '盘上的在前，新记的排后面');

  const dir2 = fresh();
  const meta2 = path.join(dir2, ACC, '_chats.json');
  const broken = JSON.stringify(aliasOnly).slice(0, 25);
  fs.writeFileSync(meta2, broken);
  const s2 = new TrStore(dir2);
  s2.markSeen(ACC, '2222222222222222', OTHER);
  assert.strictEqual(s2.flush(), true);
  const bk = fs.readdirSync(path.join(dir2, ACC)).filter((f) => f.startsWith('_chats.json.broken-'));
  assert.strictEqual(bk.length, 1, '别名表坏了也留备份');
  assert.ok(readFile(path.join(dir2, ACC, bk[0])).equals(Buffer.from(broken)));
}

// 10. 文件里有 __proto__ 键，读不了之后合并：原型不变，键作为自有属性还在
{
  const dir = fresh();
  const k = textKey(SAMPLES[0][0]);
  fs.writeFileSync(fileOf(dir), `{"__proto__": {"tr": "x"}, "${k}": {"tr": "y", "at": 1}}`);
  locked = { file: fileOf(dir), code: 'EBUSY' };
  const s = new TrStore(dir);
  s.get(ACC, CHAT, 'z');
  s.put(ACC, CHAT, 'Hola', { tr: '你好', text: 'Hola' });
  locked = null;
  assert.strictEqual(s.flush(), true);
  const e = s.mem.get(`${ACC}/${CHAT}`);
  assert.strictEqual(Object.getPrototypeOf(e.data), Object.prototype);
  assert.ok(Object.hasOwn(e.data, '__proto__'));
  assert.strictEqual(e.data[k].tr, 'y');
  assert.strictEqual(e.data[textKey('Hola')].tr, '你好');
}

// 11. 退出：读不了的对话 flush（main.js 退出时走的就是 flush）文件不变；setDir 这次不换
{
  const dir = fresh();
  put(dir, seed());
  const before = readFile(fileOf(dir));
  locked = { file: fileOf(dir), code: 'EBUSY' };
  const s = new TrStore(dir);
  s.put(ACC, CHAT, SAMPLES[3][0], { tr: SAMPLES[3][1], text: SAMPLES[3][0] });
  assert.strictEqual(s.flush(), false);
  assert.ok(readFile(fileOf(dir)).equals(before));
  assert.strictEqual(s.setDir(path.join(root, 'elsewhere')), false, '有没写完的就不换位置');
  assert.strictEqual(s.dir, dir);
  locked = null;
}

// 12. via：点译文右下角的时间显示的翻译情况（shen 2026-10-30）。只留 at、ms、name、model、fix，类型不对的丢掉、太长的截断；
// 没传 via（手动改译文）保留记录里原来的；存盘后读回来一样；复制、搬家整条带上；以前存的没有 via 的记录照常读
{
  const { cleanVia, migrate } = require('../src/trstore');
  assert.strictEqual(cleanVia(null), null);
  assert.strictEqual(cleanVia('x'), null);
  assert.strictEqual(cleanVia({ ms: 5 }), null, '没有时间就不要');
  assert.strictEqual(cleanVia({ at: -1 }), null);
  assert.strictEqual(cleanVia({ at: 1.5 }), null);
  assert.strictEqual(cleanVia({ at: '1761857100000' }), null);
  assert.deepStrictEqual(cleanVia({ at: 5 }), { at: 5, fix: false });
  assert.deepStrictEqual(cleanVia({ at: 5, ms: -3, name: 7, model: {}, fix: 'yes', extra: 'x', phone: '4915112345678' }), { at: 5, fix: false }, '类型不对的、别的字段丢掉');
  const long = cleanVia({ at: 5, ms: 1200, name: 'N'.repeat(80), model: 'm'.repeat(300), fix: true });
  assert.deepStrictEqual([long.name.length, long.model.length, long.ms, long.fix], [40, 100, 1200, true]);
  const via = { at: 1761857100000, ms: 1234, name: '智谱', model: 'glm-4-flash', fix: false };
  const dir = fresh();
  const st = new TrStore(dir);
  st.put(ACC, CHAT, 'Hola', { tr: '你好', text: 'Hola', via: { ...via, junk: 1, phone: '4915112345678' } });
  assert.deepStrictEqual(st.get(ACC, CHAT, 'Hola').via, via, '只留那 5 项');
  st.put(ACC, CHAT, 'Hola', { tr: '你好呀（我改的）', text: 'Hola', edited: true });
  assert.deepStrictEqual(st.get(ACC, CHAT, 'Hola').via, via, '没传 via（手动改）：保留原来的');
  st.put(ACC, CHAT, 'Hola', { tr: '你好呀（我改的）', text: 'Hola', edited: true, via: 'bad' });
  assert.deepStrictEqual(st.get(ACC, CHAT, 'Hola').via, via, 'via 不对也保留原来的');
  const via2 = { at: 1761857200000, ms: 3000, name: '腾讯混元', model: 'hy-mt2-plus', fix: true };
  st.put(ACC, CHAT, 'Hola', { tr: '你好呀', text: 'Hola', fixed: true, via: via2 });
  assert.deepStrictEqual(st.get(ACC, CHAT, 'Hola').via, via2, '重翻、纠错换成新的');
  const k = textKey('Hola');
  assert(st.copyKey(ACC, CHAT, k, textKey('voice:x')), '复制');
  assert.deepStrictEqual(st.getKey(ACC, CHAT, textKey('voice:x')).via, via2, '复制整条带上 via');
  assert.strictEqual(st.flush(), true);
  assert.deepStrictEqual(new TrStore(dir).get(ACC, CHAT, 'Hola').via, via2, '存盘读回来一样');
  // 以前存的记录（没有 via）：照常读；新代码改它（没传 via）不凭空多出 via
  const legacy = fresh();
  fs.mkdirSync(path.join(legacy, ACC), { recursive: true });
  fs.writeFileSync(path.join(legacy, ACC, `${CHAT}.json`), JSON.stringify({ [textKey('Hallo')]: { tr: '你好', text: 'Hallo', edited: false, fixed: false, at: 1761000000000 } }));
  const ls = new TrStore(legacy);
  const old = ls.get(ACC, CHAT, 'Hallo');
  assert.deepStrictEqual([old.tr, old.at, 'via' in old], ['你好', 1761000000000, false]);
  ls.put(ACC, CHAT, 'Hallo', { tr: '你好（改）', text: 'Hallo', edited: true });
  assert.strictEqual(ls.get(ACC, CHAT, 'Hallo').via, undefined, '老记录改了也不凭空多出 via');
  assert.strictEqual(ls.get(ACC, CHAT, 'Hallo').tr, '你好（改）');
  // 搬家合并：整条复制，via 跟着走
  const to = fresh();
  assert.strictEqual(migrate(dir, to), 1);
  assert.deepStrictEqual(new TrStore(to).get(ACC, CHAT, 'Hola').via, via2, '搬家带上 via');
  // 新代码写的带 via 的记录，旧代码（只认 tr、text、edited、fixed、at）照常读：多出来的字段它不看
  const raw = JSON.parse(fs.readFileSync(path.join(to, ACC, `${CHAT}.json`), 'utf8'))[k];
  assert.deepStrictEqual(Object.keys(raw).sort(), ['at', 'edited', 'fixed', 'text', 'tr', 'via']);
}

fs.readFileSync = realRead;
fs.copyFileSync = realCopy;
console.warn = realWarn;
fs.rmSync(root, { recursive: true, force: true });
console.log('trstore 读盘自检通过');
process.exit(0); // 有的对话没 flush，别让 1 秒的存盘定时器在清掉临时目录之后又建文件
