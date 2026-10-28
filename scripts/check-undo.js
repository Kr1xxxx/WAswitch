// 撤销（src/undo.js）：删除、清空以后能放回去。话术 / 客户 / 翻译模式、翻译服务商（连同密钥和用途）、连接记录。
const assert = require('assert');
const Module = require('module');
// 第 5 部分要加载真的 translate-ipc.js：换成假的 electron 模块
const fakeElectron = { app: { getPath: () => require('os').tmpdir() }, session: { fromPartition: () => ({ setProxy: async () => {} }) }, ipcMain: { handle() {}, on() {} }, clipboard: {}, shell: {}, WebContentsView: function () {} };
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest); };
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UndoSlot, UNDO_MS, shortName } = require('../src/undo');
const R = require('../src/records');
const { EventLog } = require('../src/eventlog');
const T = require('../src/translate');

// 1. 只记最近一次；编号对不上、过期、用过一次都不能再撤销
let now = 1000;
const slot = new UndoSlot(() => now);
let restored = [];
const t1 = slot.put(() => restored.push('a'));
const t2 = slot.put(() => restored.push('b'));
assert.equal(slot.run(t1), false, '前一次被新的一次顶掉了');
assert.equal(slot.run(t2), true);
assert.deepEqual(restored, ['b']);
assert.equal(slot.run(t2), false, '同一次不能撤销两回');
const t3 = slot.put(() => restored.push('c'));
now += UNDO_MS + 1;
assert.equal(slot.run(t3), false, '过期不能撤销');
assert.equal(shortName('  a\n b  '), 'a b');
assert.equal(shortName('x'.repeat(40)).length, 31);

// 2. 记录：删掉再放回，id、内容、跟进状态都一样；已经有同 id 的不重复放
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undo-'));
const cs = new R.Records(dir, 'customers');
const c = cs.upsert({ accountId: 'a1', name: 'Maria Lopez', phone: '+34 612 345 678', tags: ['VIP'], note: 'size 16"', followUpAt: 5, lang: 'es' });
cs.patch(c.id, { reminded: true });
const snap = { ...cs.get(c.id), tags: [...c.tags] };
const removed = cs.remove(c.id);
assert.equal(removed.name, 'Maria Lopez', 'remove 返回删除前的内容（不是清空后的）');
assert.deepEqual(removed.tags, ['VIP']);
assert.equal(cs.list().length, 0);
assert(cs.restore(snap));
const back = new R.Records(dir, 'customers').get(c.id); // 从文件重新读
assert.equal(back.name, 'Maria Lopez');
assert.deepEqual(back.tags, ['VIP']);
assert.equal(back.reminded, true, '已提醒过的不再重新提醒');
assert.equal(back.lang, 'es');
assert.equal(cs.restore(snap), false, '已经放回的不重复放');
assert.equal(cs.items.filter((r) => r.id === c.id).length, 1);

const rs = new R.Records(dir, 'replies');
const r1 = rs.upsert({ title: 'Price', text: 'Our lace front wigs start at 120 EUR.' });
const rsnap = { ...rs.get(r1.id) };
rs.remove(r1.id);
rs.items = rs.items.filter((r) => r.id !== r1.id); // 删除标记已经被清掉了：也能放回
assert(rs.restore(rsnap));
assert.equal(rs.get(r1.id).text, 'Our lace front wigs start at 120 EUR.');

// 3. 连接记录：清空后放回，清空以后新记的排在后面
const log = new EventLog(path.join(dir, 'net.json'), { delayMs: 10 });
log.add({ id: 'a1', kind: 'down' });
log.add({ id: 'a1', kind: 'up' });
const old = log.clear();
assert.equal(old.length, 2);
assert.equal(log.load().length, 0);
log.add({ id: 'a2', kind: 'down' });
log.restore(old);
assert.deepEqual(log.load().map((e) => e.kind + e.id), ['downa1', 'upa1', 'downa2']);
assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'net.json'), 'utf8')).length, 3, '放回后马上写盘');

// 4. 翻译服务商：放回原位置，密钥和“默认 / 纠错”用途都回来
const ss = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(`E${t}`), decryptString: (b) => b.toString().slice(1) };
const tr = new T.Translator({ seed: false, dir, safeStorage: ss, sessionFor: () => ({}) });
const a = tr.saveProvider({ preset: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', key: 'kz-1234' }).id;
const b = tr.saveProvider({ preset: 'deepl', key: 'dk-5678' }).id;
tr.setRoles({ primaryId: a, fallbackId: b, fixId: a });
const psnap = tr.deleteProvider(a);
assert.equal(tr.load().primaryId, b);
assert.equal(tr.load().fixId, '');
assert(tr.restoreProvider(psnap));
const cfg = tr.load();
assert.deepEqual(cfg.providers.map((p) => p.id), [a, b], '回到原来的位置');
assert.equal(cfg.primaryId, a);
assert.equal(cfg.fallbackId, b);
assert.equal(cfg.fixId, a);
assert.equal(tr.publicConfig().providers[0].hasKey, true, '密钥一起回来');
assert.equal(tr.restoreProvider(psnap), false, '已经有了不重复放');
assert.equal(tr.deleteProvider('nope'), null);
assert.equal(cs.restore({ id: 'empty', name: '', phone: '' }), false, '空记录不放回');

// 5. 经过真的 translate-ipc 接口：删翻译模式、删服务商，再撤销，内容一样
const { setupTranslateIpc } = require('../src/translate-ipc');
const handlers = {};
const offers = [];
const modes = new R.Records(dir, 'tmodes');
const real = { handleShell: (n, f) => { handlers[n] = f; }, onShell: () => {}, modeStore: modes, translator: tr, offerUndo: (o, fn) => offers.push({ ...o, fn }) };
setupTranslateIpc(new Proxy(real, { get: (t, k) => (k in t ? t[k] : () => {}) }));
const m = modes.upsert({ name: 'Formal German', direction: 'out', prompt: 'Translate into formal German (Sie).' });
handlers['tmode:delete'](m.id);
assert.equal(modes.get(m.id), null);
assert.equal(offers.at(-1).text, '已删除「Formal German」', '撤销条显示名字');
offers.at(-1).fn();
assert.equal(modes.get(m.id).prompt, 'Translate into formal German (Sie).', '撤销后提示词还在');
handlers['tr:provider:delete'](b);
assert.equal(offers.at(-1).text, '已删除「DeepL」');
offers.at(-1).fn();
assert.equal(tr.provider(b).keyTail, '5678');

console.log('check-undo: ok');
