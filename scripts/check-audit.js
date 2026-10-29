// Audited concurrency/persistence regressions. Synthetic data only; no network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { FloatCore, msgHash } = require('../src/floatcore');
const { migrate, TrStore } = require('../src/trstore');
const { McpModule } = require('../src/mcp-module');
const { createDraftPlacer } = require('../src/draft-place');
const { AiLog, registerCustomerEditTools } = require('../src/mcp/customer-edit');
const { Records } = require('../src/records');
const { customerHooks } = require('../src/customer-mcp');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-audit-'));
const tick = () => new Promise(resolve => setImmediate(resolve));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const msg = (chat, n, text, out = false) => ({ id: String(out) + '_' + chat + '_' + n, text, out });
(async () => {
  await test('2: history outgoing preserves newer unread; live outgoing clears it', async () => {
    const { ChatStore } = await import('../src/lite/store.mjs');
    const p = path.join(dir, 'lite'); fs.mkdirSync(p);
    const store = new ChatStore(p, crypto.randomBytes(32), e => { throw e; });
    const jid = '15550000000@s.whatsapp.net';
    const add = (id, fromMe, ts, countUnread) => store.addMessage({ key: { remoteJid: jid, id, fromMe }, message: { conversation: 'synthetic' }, messageTimestamp: ts }, { countUnread });
    add('incoming', false, 200, true);
    add('history', true, 100, false);
    add('old-append', true, 101, 'newer');
    assert.equal(store.chats.get(jid).unread, 1);
    assert.equal(store.unreadKeys.get(jid).length, 1);
    add('outgoing', true, 201, true);
    assert.equal(store.chats.get(jid).unread, 0);
    store.save.flush();
  });
  await test('9: manual priority does not delete a running translation job', async () => {
    let release;
    const called = [];
    const core = new FloatCore({ translate: async text => {
      called.push(text);
      if (text === 'first') await new Promise(resolve => { release = resolve; });
      return { text: 'translated ' + text };
    } });
    const messages = [msg('a@c.us', 1, 'first'), msg('a@c.us', 2, 'manual')];
    core.ingest('a', { title: 'A', msgs: messages }, { auto: false });
    core.manual('a', msgHash('a', messages[0].id));
    core.manual('a', msgHash('a', messages[1].id));
    release(); await tick(); await tick();
    assert.deepEqual(called, ['first', 'manual']);
    assert.equal(core.queue.length, 0);
    assert.ok(core.viewOf('a').items.every(item => item.state === 'done'));
  });
  await test('10: queued context remains in original chat after switching', async () => {
    let release;
    const called = [];
    const core = new FloatCore({ translate: async (text, options) => {
      called.push({ text, context: options.context });
      if (text === 'first') await new Promise(resolve => { release = resolve; });
      return { text: 'translated' };
    } });
    core.ingest('a', { title: 'A', msgs: [msg('a@c.us', 0, 'A context', true), msg('a@c.us', 1, 'first'), msg('a@c.us', 2, 'second')] }, { auto: true, dailyCap: 500 });
    core.ingest('a', { title: 'B', msgs: [msg('b@c.us', 1, 'B private', true)] }, { auto: false });
    release(); await tick(); await tick();
    assert.deepEqual(called[1].context.map(m => m.text), ['A context', 'first']);
    assert.deepEqual(core.contextOf('a', 'not-in-this-chat'), []);
  });
  await test('11: migration merges unique keys and keeps newer conflicts', async () => {
    const from = path.join(dir, 'from'), to = path.join(dir, 'to');
    fs.mkdirSync(path.join(from, 'a'), { recursive: true }); fs.mkdirSync(path.join(to, 'a'), { recursive: true });
    fs.writeFileSync(path.join(from, 'a', 'chat.json'), JSON.stringify({ a: { tr: 'A', at: 1 }, newer: { tr: 'source', at: 3 }, older: { tr: 'old', at: 1 } }));
    fs.writeFileSync(path.join(to, 'a', 'chat.json'), JSON.stringify({ b: { tr: 'B', at: 2 }, newer: { tr: 'old', at: 2 }, older: { tr: 'destination', at: 4 } }));
    assert.equal(migrate(from, to), 1);
    const data = JSON.parse(fs.readFileSync(path.join(to, 'a', 'chat.json')));
    assert.deepEqual(Object.keys(data).sort(), ['a', 'b', 'newer', 'older']);
    assert.equal(data.newer.tr, 'source'); assert.equal(data.older.tr, 'destination');
    assert.ok(!fs.existsSync(from));
    fs.mkdirSync(path.join(from, 'a'), { recursive: true });
    const source = path.join(from, 'a', 'chat.json');
    fs.writeFileSync(source, JSON.stringify({ retained: { tr: 'keep' } }));
    fs.writeFileSync(path.join(to, 'a', 'chat.json'), 'corrupt');
    assert.equal(migrate(from, to), 0); assert.ok(fs.existsSync(source));
    const cache = new TrStore(path.join(dir, 'dirty'));
    cache.put('a', 'chat', 'text', { tr: 'unsaved edit' });
    fs.mkdirSync(path.join(cache.dir, 'a', 'chat.json.tmp'), { recursive: true });
    assert.equal(cache.setDir(to), false, 'failed flush must not discard dirty cache');
    assert.equal(cache.get('a', 'chat', 'text').tr, 'unsaved edit');
    fs.rmdirSync(path.join(cache.dir, 'a', 'chat.json.tmp'));
    assert.equal(cache.flush(), true);
    fs.writeFileSync(path.join(to, 'a', 'chat.json'), '{}');
    fs.mkdirSync(path.join(to, 'a', 'chat.json.tmp')); // deterministic atomic-write failure, even as root
    assert.equal(migrate(from, to), 0); assert.ok(fs.existsSync(source));
  });
  await test('12: customer creation undo protects language/account and old incomplete logs', async () => {
    const p = path.join(dir, 'customers'); fs.mkdirSync(p);
    const records = new Records(p, 'customers');
    const hooks = { listAccounts: () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      ...customerHooks({ store: () => records, findAcc: id => ({ id }), parked: () => false }) };
    const log = new AiLog({ dir: p, hooks });
    const handlers = {};
    registerCustomerEditTools({ registerTool(name, opts, fn) { handlers[name] = fn; } }, hooks,
      { log, sessionInfo: () => ({ session: 'test', client: 'test' }) });
    for (const field of ['lang', 'accountId', 'unchanged', 'legacy']) {
      const res = await handlers.update_customer({ account_id: 'a', name: field }, {});
      const result = JSON.parse(res.content[0].text);
      assert.ok(result.customer_id);
      const rec = records.get(result.customer_id);
      if (field === 'lang') records.upsert({ ...rec, lang: 'de' });
      if (field === 'accountId') records.upsert({ ...rec, accountId: 'b' });
      if (field === 'legacy') delete log.entries[0].after.accountId;
      const answer = log.undo(log.entries[0].id);
      assert.equal(answer.ok, field === 'unchanged', field);
      assert.equal(!!records.get(rec.id), field !== 'unchanged', field);
    }
  });
  await test('8: clipboard await cannot paste into same-name different chat', async () => {
    const wc = new EventEmitter();
    let chat = '111@c.us', pasted = 0, clip = 'original';
    wc.focus = () => {}; wc.paste = () => { pasted++; };
    const p = createDraftPlacer({
      webContents: () => wc, findAcc: () => ({ id: 'a' }), isLite: () => false,
      autoBlock: () => '', stillShown: () => true, request: () => null, setRequest: () => {},
      waPage: { readChatPeer: async () => ({ title: 'Same', chat }),
        composeState: async () => ({ chat, box: true, empty: true, focus: 'compose', has: false }) },
      clipboard: { read: async () => [], writeText: async text => { clip = text; chat = '222@c.us'; },
        readText: async () => clip, clear: () => { clip = ''; } }, wait: tick,
    });
    const result = await p.place({ accountId: 'a', chat: 'Same', text: 'private draft' });
    assert.equal(result.result, 'pending'); assert.equal(pasted, 0);
    assert.equal(wc.eventNames().length, 0);
  });
  await test('8 follow-up: post-paste input, clipboard ownership and invalidation', async () => {
    for (const scenario of ['normal', 'typing', 'copy', 'chat-change', 'navigation', 'hidden', 'missing-draft', 'pre-input']) {
      const wc = new EventEmitter();
      const original = { 'text/plain': 'original text', 'text/html': '<b>original text</b>' };
      let formats = { ...original }, chat = '111@c.us', shown = true, pasted = 0, restores = 0;
      class Item {
        constructor(data) { this.data = data; this.types = Object.keys(data); }
        async getType(type) { return this.data[type]; }
      }
      wc.focus = () => {}; wc.paste = () => { pasted++; };
      const p = createDraftPlacer({
        webContents: () => wc, findAcc: () => ({ id: 'a' }), isLite: () => false,
        autoBlock: () => '', stillShown: () => shown, request: () => null, setRequest() {},
        waPage: { readChatPeer: async () => ({ title: 'Same', chat }),
          composeState: async () => ({ chat, box: true, empty: !pasted, focus: 'compose', has: !!pasted && scenario !== 'missing-draft' }) },
        ClipboardItem: Item,
        clipboard: {
          read: async () => [new Item({ ...formats })], readText: async () => formats['text/plain'],
          writeText: async text => {
            formats = { 'text/plain': text };
            if (scenario === 'pre-input') wc.emit('before-input-event', {}, { type: 'keyDown' });
          },
          write: async items => { restores++; formats = { ...items[0].data }; }, clear: () => { formats = {}; },
        },
        wait: async () => {
          if (scenario === 'typing' || scenario === 'copy' || scenario === 'missing-draft') wc.emit('before-input-event', {}, { type: 'keyDown' });
          if (scenario === 'copy') formats = { 'text/plain': 'new user copy' };
          if (scenario === 'chat-change') chat = '222@c.us';
          if (scenario === 'navigation') wc.emit('did-start-navigation');
          if (scenario === 'hidden') shown = false;
        },
      });
      const result = await p.place({ accountId: 'a', chat: 'Same', text: 'draft text' });
      const confirmed = ['normal', 'typing', 'copy'].includes(scenario);
      assert.deepEqual(result, scenario === 'pre-input' ? { result: 'pending', why: '放的时候页面状态变了' }
        : confirmed ? { result: 'placed' } : { result: 'placed', unconfirmed: true }, scenario);
      assert.equal(pasted, scenario === 'pre-input' ? 0 : 1, scenario);
      const restored = ['normal', 'typing', 'pre-input'].includes(scenario);
      assert.equal(restores, restored ? 1 : 0, scenario);
      assert.deepEqual(formats, restored ? original : { 'text/plain': scenario === 'copy' ? 'new user copy' : 'draft text' }, scenario);
      assert.equal(wc.eventNames().length, 0, scenario + ' listener cleanup');
    }
  });
  await test('13: output-stream and directory failures return error without crashing', async () => {
    const bytes = Buffer.from('synthetic module');
    const expected = { version: '0.0.0', file: 'test.js', size: bytes.length, sha512: crypto.createHash('sha512').update(bytes).digest('base64') };
    for (const kind of ['stream', 'directory']) {
      const dest = path.join(dir, 'download-' + kind);
      if (kind === 'directory') fs.writeFileSync(dest, 'file');
      else { fs.mkdirSync(dest); fs.mkdirSync(path.join(dest, 'waswitch-mcp.js.part')); }
      const mod = new McpModule({ dir: dest, dataDir: dir, expected, owner: 'test', repo: 'test',
        fetch: async (_url, { onData, signal }) => {
          onData(bytes, bytes.length, bytes.length);
          // Keep network pending until output-stream error aborts it.
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          throw Object.assign(new Error('cancelled synthetic'), { cancelled: true });
        } });
      await mod.download();
      assert.equal(mod.status, 'error', kind);
      assert.ok(mod.error);
      assert.ok(/写入/.test(mod.error), 'filesystem failures must not be reported as network failures');
      assert.ok(!fs.existsSync(path.join(dest, 'installed.json')));
    }
  });
  console.log('Audit regressions: ' + passed + ' passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
