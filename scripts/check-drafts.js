// 回复框草稿自检（drafts.js）：按 号 + 对话 存取；清空就删；重启（新的 DraftStore）后还在；
// 最多留 DRAFT_MAX 份，最久没动的先删；删号只删这个号的；不认得的号、对话 hash、坏文件都不出错。不连网络。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DraftStore, DRAFT_MAX, TEXT_MAX } = require('../src/drafts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-drafts-'));
const file = path.join(dir, 'reply-drafts.json');
const A = 'a1b2c3d4e5f60718';
const B = '0000000000000abc';
let st = new DraftStore(file);

assert.strictEqual(st.get('1', A), null, '没有草稿是 null');
st.set('1', A, { text: '您好，假发明天发货', out: 'Hello, the wig ships tomorrow', src: '您好，假发明天发货', edited: true, fixed: false, warn: [], extra: 'x' });
assert.deepStrictEqual(st.get('1', A), { text: '您好，假发明天发货', out: 'Hello, the wig ships tomorrow', src: '您好，假发明天发货', edited: true, fixed: false, warn: [] });
assert.strictEqual(st.get('1', B), null, '别的对话没有');
assert.strictEqual(st.get('2', A), null, '别的号没有');
// 只写了原文（还没翻）也存
st.set('1', B, { text: 'Can you send photos?', out: '', src: '', edited: true, fixed: true });
assert.deepStrictEqual(st.get('1', B), { text: 'Can you send photos?', out: '', src: '', edited: false, fixed: false, warn: [] }, '没有译文时“改过/纠错过”不算');
// 拿到的是副本
st.get('1', A).warn.push('x');
assert.deepStrictEqual(st.get('1', A).warn, []);

// 写盘，重启后还在
assert(st.flush());
st = new DraftStore(file);
assert.strictEqual(st.get('1', A).out, 'Hello, the wig ships tomorrow', '重启后草稿还在');
assert.strictEqual(st.get('1', B).text, 'Can you send photos?');
// 文件里不存号码、对话名：只有号 id 和对话 hash
const raw = fs.readFileSync(file, 'utf8');
assert(!/whatsapp|@c\.us|@lid/.test(raw));

// 清空（只剩空白）就删
st.set('1', B, { text: '  \n', out: '' });
assert.strictEqual(st.get('1', B), null, '清空就删');
st.flush();
assert.strictEqual(new DraftStore(file).get('1', B), null, '删掉的重启后也没有');

// 太长截断
st.set('1', A, { text: 'x'.repeat(TEXT_MAX + 50), out: 'y' });
assert.strictEqual(st.get('1', A).text.length, TEXT_MAX);

// 不认得的 key：不存、不报错
assert.strictEqual(st.set('1', 'not-a-hash', { text: 'a' }), false);
assert.strictEqual(st.set('../x', A, { text: 'a' }), false);
assert.strictEqual(st.set('1', '__proto__', { text: 'a' }), false);
assert.strictEqual(st.get('1', 'not-a-hash'), null);
assert.strictEqual(st.set('1', A, null), true);
assert.strictEqual(st.get('1', A), null, 'null 就是删');

// 删号只删这个号的
st.set('1', A, { text: '一号' });
st.set('12', A, { text: '十二号' });
st.forgetAccount('1');
assert.strictEqual(st.get('1', A), null);
assert.strictEqual(st.get('12', A).text, '十二号', '号 id 前缀相同的别的号不受影响');

// 最多留 DRAFT_MAX 份：最久没动的先删；动过的挪到最后
st = new DraftStore(path.join(dir, 'cap.json'));
const key = (i) => i.toString(16).padStart(16, '0');
for (let i = 0; i < DRAFT_MAX; i++) st.set('1', key(i), { text: `#${i}` });
st.set('1', key(0), { text: '#0 改过' }); // 第 0 份刚动过
st.set('1', key(DRAFT_MAX), { text: 'new' });
assert.strictEqual(st.get('1', key(0)).text, '#0 改过', '刚动过的不删');
assert.strictEqual(st.get('1', key(1)), null, '最久没动的删掉');
assert.strictEqual(st.get('1', key(DRAFT_MAX)).text, 'new');
st.flush();
assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'cap.json'), 'utf8'))).length, DRAFT_MAX);

// 坏文件：当空的，能接着存
fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
st = new DraftStore(path.join(dir, 'bad.json'));
assert.strictEqual(st.get('1', A), null);
st.set('1', A, { text: 'ok' });
assert(st.flush());
assert.strictEqual(new DraftStore(path.join(dir, 'bad.json')).get('1', A).text, 'ok');
// 文件里混进不认得的条目：跳过
fs.writeFileSync(path.join(dir, 'mixed.json'), JSON.stringify({ [`1:${A}`]: { text: 'keep', at: 1 }, 'junk': { text: 'x' }, [`1:${B}`]: 'str', __proto__: { text: 'p' } }));
st = new DraftStore(path.join(dir, 'mixed.json'));
assert.strictEqual(st.get('1', A).text, 'keep');
assert.strictEqual(st.get('1', B), null);

fs.rmSync(dir, { recursive: true, force: true });
console.log('回复草稿存取自检通过（按对话存、清空删、重启还在、上限、删号、坏文件）');
