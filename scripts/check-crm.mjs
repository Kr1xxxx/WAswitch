// 同步到 CRM 第 1 步自检：本机加密队列、轻量号采集、网页版采集。不需要 Electron，不联网。
// node scripts/check-crm.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { crmItem, textOf } from '../src/lite/crm.mjs';

const require = createRequire(import.meta.url);
const { CrmQueue, MAX_SEEN, keyIdOf } = require('../src/crm/queue.js');
const { CrmUploader, pickBatch } = require('../src/crm/upload.js');
const { webItem, timeOf, WebReader } = require('../src/crm/web.js');
const { parsePre } = require('../src/wa-page.js');

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
console.log('同步到 CRM 自检（采集 + 上传）');

// 假的 safeStorage：加密 = 每个字节异或 + 前缀，磁盘上看不到原文
const xor = (b) => Buffer.from(b.map((x) => x ^ 0x5a));
const safe = (backend = 'gnome_libsecret') => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => backend,
  encryptString: (t) => Buffer.concat([Buffer.from('ENC1'), xor(Buffer.from(t, 'utf8'))]),
  decryptString: (b) => { if (b.subarray(0, 4).toString() !== 'ENC1') throw new Error('bad'); return xor(b.subarray(4)).toString('utf8'); },
});
const noTimers = { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crm-'));
const T0 = Date.parse('2026-10-24T10:00:00Z');

await test('队列：只收开关打开之后的、有号码的消息；重复的不收；只给条数', async () => {
  let now = T0;
  const q = new CrmQueue({ dir: tmp(), safeStorage: safe(), now: () => now, timers: noTimers });
  assert.equal(q.add('1', { mid: 'a', peer: '8613800000000', at: T0 + 1, text: 'hi' }), false, '没开同步不收');
  assert.equal(q.enable('1'), T0);
  now += 1000;
  assert.equal(q.enable('1'), T0, '再开一次不改开始时间');
  assert.equal(q.add('1', { mid: 'old', peer: '8613800000000', at: T0 - 1, text: '旧消息' }), false);
  assert.equal(q.add('1', { mid: 'x', peer: 'abc', at: T0 + 5, text: '没号码' }), false, '号码不对只计数');
  assert.equal(q.add('1', { mid: 'x', peer: 'abc', at: T0 + 5, text: '没号码' }), false, '同一条只计一次');
  assert.equal(q.add('1', { mid: 'a', peer: '8613800000000', at: T0 + 5, text: '你好' }), true);
  assert.equal(q.add('1', { mid: 'a', peer: '8613800000000', at: T0 + 6, text: '你好' }), false, '重复');
  q.skip('1', 2);
  assert.deepEqual(q.stats('1'), { on: true, since: T0, queued: 1, skipped: 3, notime: 0 });
  assert.ok(!JSON.stringify(q.stats('1')).includes('你好'));
});

await test('队列：写盘是加密的，重启后还在；去重表只存 hash', async () => {
  const dir = tmp();
  const q = new CrmQueue({ dir, safeStorage: safe(), now: () => T0, timers: noTimers });
  q.enable('7');
  q.add('7', { mid: '3EB0SECRETID', peer: '8613811112222', out: true, at: T0 + 10, text: '报价单明天发你' });
  q.saveNow();
  const raw = fs.readFileSync(path.join(dir, 'crm-queue.bin'));
  for (const bad of ['报价单', '8613811112222', '3EB0SECRETID']) assert.ok(!raw.includes(Buffer.from(bad)), `磁盘上不该有 ${bad}`);
  const plain = safe().decryptString(raw);
  // 去重表只存 hash；还没上传的条目带着 WhatsApp 消息编号（来财去重要用），上传成功就删
  const data = JSON.parse(plain);
  assert.ok(!JSON.stringify(data.accs['7'].seen).includes('3EB0SECRETID'), '去重表只存 hash');
  assert.equal(data.accs['7'].items[0].k, '3EB0SECRETID');
  const q2 = new CrmQueue({ dir, safeStorage: safe(), now: () => T0, timers: noTimers });
  assert.equal(q2.stats('7').queued, 1);
  assert.equal(q2.peek('7')[0].text, '报价单明天发你');
  assert.equal(q2.add('7', { mid: '3EB0SECRETID', peer: '8613811112222', at: T0 + 20, text: 'x' }), false, '重启后仍去重');
});

await test('Linux 上只有 basic_text 时不能开同步，也不写盘', async () => {
  const dir = tmp();
  const q = new CrmQueue({ dir, safeStorage: safe('basic_text'), now: () => T0, timers: noTimers, onError: () => {} });
  if (process.platform === 'linux') {
    assert.equal(q.canEncrypt(), false);
    q.enable('1');
    q.add('1', { mid: 'a', peer: '8613800000000', at: T0 + 1, text: 'hi' });
    q.saveNow();
    assert.ok(!fs.existsSync(path.join(dir, 'crm-queue.bin')));
  }
  const off = new CrmQueue({ dir, safeStorage: { isEncryptionAvailable: () => false }, now: () => T0, timers: noTimers });
  assert.equal(off.canEncrypt(), false);
});

await test('关开关 / 收回 / 删号：purge 删掉队列和去重表，文件也删', async () => {
  const dir = tmp();
  const q = new CrmQueue({ dir, safeStorage: safe(), now: () => T0, timers: noTimers });
  q.enable('1');
  q.add('1', { mid: 'a', peer: '8613800000000', at: T0 + 1, text: 'hi' });
  q.saveNow();
  q.purge('1');
  assert.deepEqual(q.stats('1'), { on: false, queued: 0, skipped: 0, notime: 0 });
  assert.ok(!fs.existsSync(path.join(dir, 'crm-queue.bin')));
  q.enable('1');
  assert.equal(q.add('1', { mid: 'a', peer: '8613800000000', at: T0 + 1, text: 'hi' }), true, '去重表也删了');
});

await test('文件坏了：备份后从空队列开始', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'crm-queue.bin'), 'garbage');
  const q = new CrmQueue({ dir, safeStorage: safe(), now: () => T0, timers: noTimers });
  assert.deepEqual(q.enabledIds(), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('crm-queue.bin.bad-')));
});

await test('上限：去重表每个号 5000 条；超过 7 天的丢掉', async () => {
  let now = T0;
  const q = new CrmQueue({ dir: tmp(), safeStorage: safe(), now: () => now, timers: noTimers });
  q.enable('1');
  for (let i = 0; i < MAX_SEEN + 50; i += 1) q.add('1', { mid: `m${i}`, peer: '8613800000000', at: T0 + i, text: 'x' });
  assert.equal(q.load().get('1').seen.length, MAX_SEEN);
  now = T0 + 8 * 24 * 3600 * 1000;
  q.add('1', { mid: 'new', peer: '8613800000000', at: now, text: 'new' });
  assert.equal(q.stats('1').queued, 1);
});

// ---- 轻量号 ----
const msg = (over = {}) => ({ key: { remoteJid: '8613800000000@s.whatsapp.net', id: 'ID1', fromMe: false, ...(over.key || {}) }, messageTimestamp: (T0 + 60000) / 1000, message: { conversation: '你好' }, ...over, ...(over.key ? { key: { remoteJid: '8613800000000@s.whatsapp.net', id: 'ID1', fromMe: false, ...over.key } } : {}) });

await test('轻量号：单聊文字收；群、广播、开关之前的不收', async () => {
  assert.deepEqual(await crmItem(msg(), T0), { item: { mid: 'ID1', peer: '8613800000000', out: false, at: T0 + 60000, text: '你好' } });
  assert.equal(await crmItem(msg({ key: { remoteJid: '1203630@g.us' } }), T0), null);
  assert.equal(await crmItem(msg({ key: { remoteJid: 'status@broadcast' } }), T0), null);
  assert.equal(await crmItem(msg({ messageTimestamp: (T0 - 1000) / 1000 }), T0), null);
  assert.equal(await crmItem(msg(), 0), null, '没开同步');
  assert.equal((await crmItem(msg({ key: { fromMe: true } }), T0)).item.out, true);
});

await test('轻量号 @lid：用 remoteJidAlt 或 lid 映射找号码，找不到就跳过计数', async () => {
  const lid = { remoteJid: '123456789012345@lid' };
  assert.equal((await crmItem(msg({ key: { ...lid, remoteJidAlt: '8613911112222@s.whatsapp.net' } }), T0)).item.peer, '8613911112222');
  assert.equal((await crmItem(msg({ key: lid }), T0, async () => '8613933334444:0@s.whatsapp.net')).item.peer, '8613933334444');
  assert.deepEqual(await crmItem(msg({ key: lid }), T0, async () => null), { skip: 'nonumber' });
  assert.deepEqual(await crmItem(msg({ key: lid }), T0, async () => { throw new Error('x'); }), { skip: 'nonumber' });
});

await test('轻量号：拆开限时 / 一次性消息；表情回应、撤回、投票不收；图片记占位', async () => {
  assert.equal(textOf({ ephemeralMessage: { message: { extendedTextMessage: { text: '限时' } } } }), '限时');
  assert.equal(textOf({ viewOnceMessageV2: { message: { imageMessage: { caption: '看一次' } } } }), '[图片] 看一次');
  assert.equal(textOf({ reactionMessage: { text: '👍' } }), null);
  assert.equal(textOf({ protocolMessage: { type: 0 } }), null);
  assert.equal(textOf({ pollCreationMessageV3: { name: 'x' } }), null);
  assert.equal(textOf({ audioMessage: {}, messageContextInfo: {} }), '[语音]');
  assert.equal(await crmItem(msg({ message: { reactionMessage: { text: '👍' } } }), T0), null);
});

// ---- 网页版 ----
await test('网页版：时间只取数字，名字不带出来；日月拿不准时取不晚于现在的', async () => {
  const p = parsePre('[10:31, 2026/10/24] 张三: ');
  assert.deepEqual(p, { y: 2026, mo: 10, d: 24, h: 10, mi: 31, ambig: false, at: new Date(2026, 9, 24, 10, 31).getTime(), altAt: null });
  assert.ok(!JSON.stringify(p).includes('张三'));
  assert.equal(parsePre('[下午3:05, 2026/10/24] x: ').h, 15);
  assert.equal(parsePre('[3:05 PM, 10/24/2026] x: ').d, 24);
  assert.equal(parsePre('没有时间'), null);
  const now = new Date(2026, 9, 24, 12, 0).getTime();
  const amb = timeOf(parsePre('[09:00, 10/11/2026] x: '), now); // 11 月 10 日在将来，取 10 月 11 日
  assert.equal(amb.at, new Date(2026, 9, 11, 9, 0).getTime());
  assert.equal(amb.approx, true);
  assert.equal(timeOf(null, now), null, '没有时间不能用读取时刻补造');
  assert.equal(parsePre('[09:00, 2026/2/30] x: '), null, '不存在的日期不能进位');
});

await test('网页版：@c.us 收，@lid 跳过计数，群不收，开关之前的不收', async () => {
  const now = new Date(2026, 9, 24, 12, 0).getTime();
  const since = new Date(2026, 9, 24, 10, 0).getTime();
  const t = parsePre('[11:00, 2026/10/24] x: ');
  const r = webItem({ id: 'false_8613800000000@c.us_3EB0AAA', out: false, text: '在吗', t }, since, now);
  assert.deepEqual(r.item, { mid: 'false_8613800000000@c.us_3EB0AAA', peer: '8613800000000', out: false, at: new Date(2026, 9, 24, 11, 0).getTime(), approx: false, text: '在吗' });
  assert.equal(webItem({ id: 'true_8613800000000@c.us_3EB0BBB', text: '', t }, since, now).item.text, '[非文字消息]');
  assert.deepEqual(webItem({ id: 'true_8613800000000@c.us_3EB0BBB', text: '', t: null }, since, now), { skip: 'notime' });
  assert.deepEqual(webItem({ id: 'false_99887766@lid_3EB0CCC', text: 'x', t }, since, now), { skip: 'nonumber' });
  assert.equal(webItem({ id: 'false_120363@g.us_3EB0DDD_861@c.us', text: 'x', t }, since, now), null);
  assert.equal(webItem({ id: 'false_8613800000000@c.us_3EB0EEE', text: 'x', t: parsePre('[09:00, 2026/10/24] x: ') }, since, now), null);
});

await test('网页版：无时间的消息始终跳过，滚动加载的历史不能当作新消息', async () => {
  const now = new Date(2026, 9, 24, 12, 0).getTime();
  const since = new Date(2026, 9, 24, 10, 0).getTime();
  const reader = new WebReader();
  const old = [1, 2, 3].map((i) => ({ id: `false_8613800000000@c.us_OLD${i}`, text: i === 2 ? '' : `旧消息${i}`, t: null }));
  const a = reader.collect('5', old, since, now);
  assert.deepEqual(a, { items: [], nonumber: 0, notime: 3 }, '第一次读到的对话：读不出时间的都算旧的');
  const b = reader.collect('5', old, since, now + 15000);
  assert.deepEqual(b, { items: [], nonumber: 0, notime: 0 }, '再读一次不重复计数');
  const c = reader.collect('5', [...old, { id: 'false_8613800000000@c.us_NEW1', text: '', t: null }], since, now + 30000);
  assert.equal(c.items.length, 0);
  assert.equal(c.notime, 1, '后续出现的无时间消息也不采集');
  const scroll = reader.collect('5', [{ id: 'false_8613800000000@c.us_OLDER_SCROLL', text: '旧内容', t: null }], since, now + 45000);
  assert.equal(scroll.items.length, 0, '滚动回历史记录不能绕过采集开始时间');
  // 有时间的消息第一次读到也照常按时间判断
  const t = parsePre('[11:00, 2026/10/24] x: ');
  const d = reader.collect('5', [{ id: 'false_8613811112222@c.us_T1', text: '新', t }, { id: 'false_77@lid_L1', text: 'x', t }], since, now);
  assert.equal(d.items.length, 1);
  assert.equal(d.nonumber, 1);
  assert.equal(reader.collect('5', [{ id: 'false_77@lid_L1', text: 'x', t }], since, now).nonumber, 0, '@lid 只算一次');
  reader.forget('5');
  assert.equal(reader.chats.size, 0);
});

await test('第 2 步：号码只收 8～15 位；记下 WhatsApp 消息编号；文字按字符截断', async () => {
  const q = new CrmQueue({ dir: tmp(), safeStorage: safe(), now: () => T0, timers: noTimers });
  q.enable('1');
  assert.equal(q.add('1', { mid: 'a1', peer: '1234567', at: T0, text: 'x' }), false);
  assert.equal(q.add('1', { mid: 'a2', peer: '1234567890123456', at: T0, text: 'x' }), false);
  assert.equal(q.add('1', { mid: 'false_447700900123@c.us_3EB0ABCDEF', peer: '447700900123', at: T0, text: '😀'.repeat(5000) }), true);
  assert.equal(q.add('1', { mid: '3EB0LITE01', peer: '447700900123', at: T0, text: 'x' }), true);
  const [w, l] = q.peek('1');
  assert.equal(w.k, '3EB0ABCDEF', '网页版取最后一段');
  assert.equal(l.k, '3EB0LITE01', '轻量版就是 key.id');
  assert.equal(Array.from(w.text).length, 4000);
  assert.equal(keyIdOf('true_8613800000000@c.us_3EB0X1Y2Z3'), '3EB0X1Y2Z3');
  assert.equal(keyIdOf('../bad'), '');
  assert.equal(q.stats('1').skipped, 2);
});

function fakeTeam(replies) {
  const calls = [];
  return { calls, enrolled: () => true, tokenPlain: () => 'tok',
    async post(p, body, token) {
      calls.push({ p, body, token });
      const r = replies.shift() || { status: 200, data: { ok: true } };
      if (r === 'throw') throw new Error('net');
      return r;
    } };
}
await test('第 2 步上传：后台回 200 才从本机删；503 暂停、断网、429 都留着', async () => {
  const q = new CrmQueue({ dir: tmp(), safeStorage: safe(), now: () => T0, timers: noTimers });
  q.enable('1');
  for (let i = 0; i < 3; i += 1) q.add('1', { mid: `3EB0UP0${i}`, peer: '447700900123', at: T0 + i, text: `m${i}` });
  const accs = [{ id: '1', teamId: '00000000-0000-0000-0000-000000000001' }, { id: '2', teamId: 'x' }];
  const crmOn = (a) => a.id === '1';
  for (const reply of [{ status: 503, data: { crm_paused: true } }, 'throw', { status: 429, data: {} }, { status: 409, data: { crm_off: true } }]) {
    const team = fakeTeam([reply]);
    await new CrmUploader({ queue: q, team, accounts: () => accs, crmOn }).run();
    assert.equal(q.stats('1').queued, 3, JSON.stringify(reply));
    assert.equal(team.calls.length, 1);
  }
  const team = fakeTeam([]);
  const up = new CrmUploader({ queue: q, team, accounts: () => accs, crmOn });
  const r = await up.run();
  assert.equal(r.sent, 3);
  assert.equal(q.stats('1').queued, 0);
  assert.equal(team.calls.length, 1, '没开同步的号不传');
  const sent = team.calls[0].body;
  assert.equal(sent.team_id, accs[0].teamId);
  assert.deepEqual(Object.keys(sent.items[0]).sort(), ['approx', 'at', 'k', 'out', 'peer', 'text']);
  assert.equal(up.last.error, '');
});
await test('第 2 步上传：每次最多约 200 KB，一个号一轮最多传 3 次', async () => {
  const q = new CrmQueue({ dir: tmp(), safeStorage: safe(), now: () => T0, timers: noTimers });
  q.enable('1');
  for (let i = 0; i < 400; i += 1) q.add('1', { mid: `3EB0BIG${i}`, peer: '447700900123', at: T0 + i, text: '中'.repeat(1000) });
  const parts = pickBatch(q.peek('1', 500));
  assert.ok(Buffer.byteLength(JSON.stringify({ v: 1, team_id: 'x', items: parts.map((p) => p.item) })) <= 200 * 1024);
  const team = fakeTeam([]);
  await new CrmUploader({ queue: q, team, accounts: () => [{ id: '1', teamId: 't' }], crmOn: () => true }).run();
  assert.equal(team.calls.length, 3);
  assert.ok(q.stats('1').queued > 0, '剩下的下一轮再传');
});

await test('代码里不把队列内容写进日志', async () => {
  for (const f of ['src/crm/queue.js', 'src/crm/web.js', 'src/lite/crm.mjs', 'src/crm/upload.js', 'server/src/crm.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/console\.(log|warn|error)\([^)]*(text|item|peer)/.test(src), `${f} 不该打印消息内容`);
  }
});

console.log(`全部通过（${passed} 项）`);

