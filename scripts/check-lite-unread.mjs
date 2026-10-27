// 自检：轻量号的未读条数和弹窗——同一个客户连发多条，未读一条条涨、每条都弹；
// 断线期间收到的消息重连后补发（append），未读数对、只弹新的。
// 运行：npm run check:lite-unread（不联网，不用 WhatsApp 账号，不用 Electron）
//
// 用真的 Session（假连接）+ 真的 Baileys 事件缓冲和 processMessage，事件顺序和真连接一样：
// 收一条消息 = 一个缓冲函数里先 messages.upsert，再由 processMessage 发 chats.update（unreadCount 是这一批新增的条数），
// 100 ms 后合并放出来，chats.update 排在 messages.upsert 前面。
// 主进程那边照搬 main.js 的 liteHost.on('unread')，交给真的 Notifier 判断弹不弹。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('module');
const fakeElectron = {
  app: { setBadgeCount() {}, setAppUserModelId() {} },
  Tray: class {},
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
  BrowserWindow: class {},
  screen: {},
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : load.call(this, req, ...rest); };
const { Notifier } = require('../src/notify');

const { makeEventBuffer } = await import('baileys');
const { default: processMessage } = await import(new URL('../node_modules/baileys/lib/Utils/process-message.js', import.meta.url));
const { processSyncAction } = await import(new URL('../node_modules/baileys/lib/Utils/chat-utils.js', import.meta.url));
const { Session } = await import('../src/lite/session.mjs');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const settle = () => sleep(450); // 事件缓冲 100 ms + Session.changed() 合并 250 ms
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-lite-unread-'));
const silent = { level: 'silent', child() { return silent; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
const ME = '4930123456@s.whatsapp.net';
const EMMA = '491701234567@s.whatsapp.net';
const JOHN = '12125550123@s.whatsapp.net';
const ANNA = '4915112345678@s.whatsapp.net';

// 假的 WhatsApp 连接：ev 是 Baileys 真的事件缓冲；收消息照 Baileys 的 upsertMessage（Socket/chats.js）写
function fakeSock() {
  const ev = makeEventBuffer(silent);
  const sock = { ev, reads: [], sent: [] };
  sock.readMessages = async (keys) => { sock.reads.push(keys); };
  sock.groupFetchAllParticipating = async () => ({});
  sock.end = () => {};
  sock.logout = async () => {};
  sock.sendMessage = async (jid, content) => ({ key: { remoteJid: jid, id: `S${(sock.sent.push(content))}`, fromMe: true }, message: { conversation: content.text }, messageTimestamp: Math.floor(Date.now() / 1000) });
  sock.upsert = ev.createBufferedFunction(async (msg, type) => {
    ev.emit('messages.upsert', { messages: [msg], type });
    if (msg.pushName && !msg.key.fromMe) ev.emit('contacts.update', [{ id: msg.key.remoteJid, notify: msg.pushName }]);
    await processMessage(msg, { shouldProcessHistoryMsg: false, ev, creds: { me: { id: ME } }, signalRepository: {}, keyStore: {}, logger: silent, options: {}, getMessage: async () => undefined });
  });
  // 在手机上读了 / 标成未读（app state 同步）
  sock.syncRead = (jid, read) => processSyncAction({ syncAction: { value: { markChatAsReadAction: { read } } }, index: ['markChatAsRead', jid] }, ev, { id: ME }, undefined, silent);
  return sock;
}

// 一个轻量号：Session（后台进程）+ 主进程 liteHost.on('unread') + Notifier
class LiteAccount {
  constructor(name) {
    this.acc = { id: name, name };
    this.dir = path.join(tmp, name);
    this.key = crypto.randomBytes(32).toString('hex');
    this.pushed = null; // main.js 的 liteUnreadChats
    this.pushes = 0;
    this.cards = [];
    this.ts = 1793000000;
    this.msgId = 0;
    const popup = { cards: this.cards, dnd: false, show: (c) => { this.cards.push(c); return true; }, dropAccount() {}, dropKey() {} };
    this.n = new Notifier({ getAccounts: () => [this.acc], getWindow: () => null, activate() {}, quit() {}, readChats: async () => this.pushed, popup });
    this.n.refresh = () => {};
    this.saved = 0;
  }

  async start() {
    this.session = new Session({ id: this.acc.id, proxy: null, dir: this.dir, key: this.key, os: 'win32' }, (m) => this.onPost(m), {
      makeSocket: () => { this.sock = fakeSock(); return this.sock; },
      fetchVersion: async () => ({ isLatest: true, version: [2, 3000, 123456] }),
    });
    await this.session.start();
    this.sock.ev.emit('connection.update', { connection: 'open' });
    await settle();
  }

  // main.js：liteHost.on('unread')
  onPost(m) {
    if (m.type !== 'unread') return;
    this.pushes += 1;
    this.pushed = Array.isArray(m.chats) ? m.chats : [];
    const grew = m.count > (this.n.unread.get(this.acc.id) || 0);
    const baseline = this.n.unread.has(this.acc.id) ? 0 : this.saved;
    this.n.update(this.acc, m.count, { isActive: false, baseline });
    this.saved = m.count;
    if (!grew) this.n.recheck(this.acc, { isActive: false });
  }

  // 对方发来一条（或自己在手机上发一条）。type：在线 notify；断线期间收到、重连后补发 append
  async message(jid, name, text, { type = 'notify', fromMe = false, id = null, ts = null } = {}) {
    const msg = { key: { remoteJid: jid, id: id || `M${(this.msgId += 1)}`, fromMe }, message: { conversation: text }, messageTimestamp: ts || (this.ts += 60), pushName: fromMe ? undefined : name };
    await this.sock.upsert(msg, type);
    return msg;
  }

  unread(jid) { return this.session.store.chats.get(jid)?.unread || 0; }
  take() { const c = this.cards.splice(0); return c.map((x) => `${x.chat}:${x.count}`).join(' / '); }

  // 断线重连：后台进程重新连一个新的连接（聊天缓存还在）
  async reconnect() {
    this.sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
    clearTimeout(this.session.retryTimer);
    await this.session.start();
    this.sock.ev.emit('connection.update', { connection: 'open' });
    await settle();
  }

  stop() { this.session.stop(); }
}

try {
  // ---------- 在线：同一个客户连发多条 ----------
  const a = new LiteAccount('sales-de');
  await a.start();
  const counts = [];
  const pops = [];
  for (let i = 1; i <= 4; i += 1) {
    await a.message(EMMA, 'Emma Schneider', `Nachricht ${i}`);
    await settle();
    counts.push(a.unread(EMMA));
    pops.push(a.take());
  }
  check(counts.join(',') === '1,2,3,4', `Emma 连发 4 条：未读条数 1、2、3、4（得到 ${counts.join('、')}）`);
  check(pops.every((p, i) => p === `Emma Schneider:${i + 1}`), `每一条都弹，卡片上写几条（${pops.join(' | ')}）`);

  // 两条在 100 ms 里一起到（Baileys 合并成一批，chats.update 的 unreadCount 是 2）
  await Promise.all([a.message(EMMA, 'Emma Schneider', 'Noch eins'), a.message(EMMA, 'Emma Schneider', 'Und noch eins')]);
  await settle();
  check(a.unread(EMMA) === 6, `一批来两条：未读 +2（得到 ${a.unread(EMMA)}）`);
  check(a.take() === 'Emma Schneider:6', '一批来两条：弹一次');

  // 另一个客户也来一条：两个客户的条数各自对
  const john1 = await a.message(JOHN, 'John Miller', 'Thanks!');
  await settle();
  check(a.unread(JOHN) === 1 && a.unread(EMMA) === 6, `John 来一条：John 1 条、Emma 还是 6 条（${a.unread(JOHN)} / ${a.unread(EMMA)}）`);
  check(a.take() === 'John Miller:1', '只弹 John');

  // 同一条消息又收到一遍（同一个 id）：不加、不弹
  await a.message(JOHN, 'John Miller', 'Thanks!', { id: john1.key.id, ts: john1.messageTimestamp });
  await settle();
  check(a.unread(JOHN) === 1 && a.cards.length === 0, `同一条消息收到两遍：还是 1 条，不再弹（${a.unread(JOHN)}）`);

  // 在手机上读了 John：清零；在手机上把 John 标成未读：至少 1 条
  a.sock.syncRead(JOHN, true);
  await settle();
  check(a.unread(JOHN) === 0, `手机上读了：未读清零（${a.unread(JOHN)}）`);
  a.sock.syncRead(JOHN, false);
  await settle();
  check(a.unread(JOHN) === 1, `手机上标成未读：算 1 条（以前会变成 0）（${a.unread(JOHN)}）`);
  a.take();

  // 自己在手机上回了 Emma：Emma 清零；她再发一条从 1 开始
  await a.message(EMMA, '', 'Danke, ich prüfe das.', { fromMe: true, type: 'append' });
  await settle();
  check(a.unread(EMMA) === 0, `自己回了 Emma：未读清零（${a.unread(EMMA)}）`);
  await a.message(EMMA, 'Emma Schneider', 'Super, danke!');
  await settle();
  check(a.unread(EMMA) === 1 && a.take() === 'Emma Schneider:1', `回过以后她再发：从 1 条开始，弹（${a.unread(EMMA)}）`);
  a.stop();

  // ---------- 断线期间收到的消息（重连后补发，type append） ----------
  const b = new LiteAccount('support-us');
  await b.start();
  await b.message(EMMA, 'Emma Schneider', 'Hallo!');
  await b.message(EMMA, 'Emma Schneider', 'Ist der Liefertermin noch der 12.11.?');
  await settle();
  check(b.unread(EMMA) === 2 && b.take() === 'Emma Schneider:2', `断线前 Emma 2 条未读（${b.unread(EMMA)}）`);
  await b.reconnect();
  check(b.cards.length === 0, '重连后推来同样的未读：不弹');
  // 断线期间 Emma 又发 2 条、新客户 Anna 发 1 条，重连后一条条补发
  await b.message(EMMA, 'Emma Schneider', 'Hallo?', { type: 'append' });
  await b.message(EMMA, 'Emma Schneider', 'Bitte um Rückmeldung.', { type: 'append' });
  await b.message(ANNA, 'Anna Weber', 'Is the order shipped?', { type: 'append' });
  await settle();
  check(b.unread(EMMA) === 4, `断线期间 Emma 又发 2 条：未读 2 + 2 = 4（以前会变成 2）（${b.unread(EMMA)}）`);
  check(b.unread(ANNA) === 1, `断线期间新客户 Anna 1 条：未读 1（${b.unread(ANNA)}）`);
  const offline = b.take();
  check(offline.includes('Emma Schneider:4') && offline.includes('Anna Weber:1'), `补发的新消息弹出来（${offline}）`);
  // 重连时把断线前已经有的那条又补发一遍（同一个 id）：不加
  await b.message(EMMA, 'Emma Schneider', 'Hallo!', { type: 'append', id: 'M1', ts: 1793000060 });
  await settle();
  check(b.unread(EMMA) === 4 && b.cards.length === 0, `已经有的消息又补发一遍：不加、不弹（${b.unread(EMMA)}）`);
  // 补发一条比缓存里最后一条还旧、缓存里没有的消息（早就在别处看过）：存下来，不算未读
  await b.message(JOHN, 'John Miller', 'Order #4711 received', { ts: b.ts + 600 });
  await settle();
  b.take();
  await b.message(JOHN, 'John Miller', 'Old note', { type: 'append', ts: b.ts - 6000 });
  await settle();
  check(b.unread(JOHN) === 1 && b.cards.length === 0, `补发的旧消息：不算未读（John 还是 ${b.unread(JOHN)} 条）`);
  // 断线期间自己在手机上回了 Anna（补发的自己的消息在她那条后面）：Anna 清零
  await b.message(ANNA, '', 'Yes, shipped today.', { fromMe: true, type: 'append' });
  await settle();
  check(b.unread(ANNA) === 0, `断线期间自己回了 Anna：清零（${b.unread(ANNA)}）`);
  b.stop();
} catch (e) {
  console.error(e);
  failures += 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
