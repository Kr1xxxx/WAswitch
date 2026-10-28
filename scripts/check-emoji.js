// 账号头像 emoji 自检：每个 emoji 都有 svg（界面）和 png + @2x（托盘菜单）；随机挑选不和别的号重复；
// list.js 在界面里（没有 module）也能用。node scripts/check-emoji.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = path.join(__dirname, '..', 'src', 'emoji');
const EMOJI = require(path.join(DIR, 'list.js'));

assert.strictEqual(new Set(EMOJI.IDS).size, EMOJI.IDS.length, 'id 有重复');
for (const e of EMOJI.LIST) {
  assert.match(e.id, /^[a-z]+$/, `id 只能是小写字母：${e.id}`); // 弹窗页面按这个规则拼图片路径
  assert.ok(e.name && e.char, `${e.id} 缺中文名或字符`);
  for (const f of [`svg/${e.id}.svg`, `png/${e.id}.png`, `png/${e.id}@2x.png`]) assert.ok(fs.existsSync(path.join(DIR, f)), `缺文件 ${f}`);
}
const extra = fs.readdirSync(path.join(DIR, 'svg')).filter((f) => !EMOJI.valid(f.replace(/\.svg$/, '')));
assert.deepStrictEqual(extra, [], `svg 目录里有没用到的图：${extra.join(', ')}`);
assert.ok(fs.existsSync(path.join(DIR, 'LICENSE')), '缺 LICENSE');

// 默认顺序：新装第 1 个号四叶草，第 2 个皇冠；用户自己选走了某个，就跳过它
assert.deepStrictEqual(EMOJI.FIRST, ['clover', 'crown']);
EMOJI.FIRST.forEach((id) => assert.ok(EMOJI.valid(id), `默认 emoji 不在列表里：${id}`));
assert.strictEqual(EMOJI.pick([]), 'clover');
assert.strictEqual(EMOJI.pick(['clover']), 'crown');
assert.strictEqual(EMOJI.pick(['fox']), 'clover');
assert.strictEqual(EMOJI.pick(['crown']), 'clover');
const third = EMOJI.pick(['clover', 'crown'], () => 0);
assert.ok(!['clover', 'crown'].includes(third) && EMOJI.valid(third));
// 按新建流程连着加两个号（每次都把已有的号传进去）
const seq = [];
seq.push(EMOJI.pick(seq)); seq.push(EMOJI.pick(seq));
assert.deepStrictEqual(seq, ['clover', 'crown']);

// 随机挑：没用完时不重复；全用完了也要给一个
const used = EMOJI.IDS.slice(0, EMOJI.IDS.length - 1);
for (let i = 0; i < 20; i += 1) assert.strictEqual(EMOJI.pick(used), EMOJI.IDS[EMOJI.IDS.length - 1]);
assert.ok(EMOJI.valid(EMOJI.pick(EMOJI.IDS)));
assert.ok(!EMOJI.valid('') && !EMOJI.valid('../x') && !EMOJI.valid(undefined));

// 界面里用 <script> 引入：挂在 window.EMOJI
const win = {};
vm.runInNewContext(fs.readFileSync(path.join(DIR, 'list.js'), 'utf8'), { window: win });
assert.strictEqual(win.EMOJI.LIST.length, EMOJI.LIST.length);
console.log(`emoji 自检通过：${EMOJI.LIST.length} 个`);
