// 一个轻量模式账号的连接：扫码登录、收发文字、断线重连。
// 规则（审计要求）：
//   - 设了代理就只走账号自己的代理，没有直连兜底；连不上代理就等着重试
//   - 没设代理（用户选了直连）就用本机网络，这种号在单独的后台进程里
//   - 不向 GitHub 查 Baileys 版本；版本号只经账号自己的代理向 web.whatsapp.com 查（version.mjs）
//   - 上线时不发“在线”状态；已读回执只在用户打开对话时发
//   - 每个号每分钟最多发 10 条
//   - 被退出登录（401）或拒绝连接（403）后不再重连，交给用户处理
import fs from 'node:fs';
import net from 'node:net';
import makeWASocket, { Browsers, DisconnectReason } from 'baileys';
import QRCode from 'qrcode';
import { makeTransport, makeDirectTransport } from './transport.mjs';
import { makeAuthState } from './vault.mjs';
import { ChatStore, phoneOf } from './store.mjs';
import { waVersion, resetVersionCache } from './version.mjs';
import { crmItem } from './crm.mjs';

export const SEND_LIMIT = 10;
const SEND_WINDOW_MS = 60 * 1000;
const MAX_TEXT = 4000;
const MAX_SAME_ERROR = 5; // 这些错误连续出现这么多次就不再重连
// 只有这些断开原因重连没用（会话坏了、设备不匹配）；网络类断开（408、428、503 等）一直退避重连
const HOPELESS_CODES = new Set([500, 411]);
const MAX_RETRY_MS = 5 * 60 * 1000;
// 代理端口通、但一直连不上 WhatsApp（多半是 Clash 当前节点挂了）：
// 30 秒还没连上，或者连续失败 3 次，就报“连不上 WhatsApp”，界面换成带原因的问题页。
// 这时最长 1 分钟重试一次，节点恢复后很快自动连上（这种情况连接根本到不了 WhatsApp）。
export const SLOW_MS = 30 * 1000;
export const SLOW_FAILS = 3;
const SLOW_RETRY_MS = 60 * 1000;

// 只记录错误的简短说明，长数字（可能是号码）换掉
const scrub = (s) => String(s || '').replace(/\d{6,}/g, '[号码]').slice(0, 300);

function makeLogger(report) {
  const logger = {
    level: 'error',
    child: () => logger,
    trace() {}, debug() {}, info() {}, warn() {},
    error(obj, msg) { report(scrub(msg || obj?.err?.message || obj?.message || 'error')); },
    fatal(obj, msg) { report(scrub(msg || obj?.err?.message || obj?.message || 'fatal')); },
  };
  return logger;
}

// 先试一下代理端口通不通（只连代理本身）
function probe(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { clearTimeout(timer); sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export function browserFor(os) {
  if (os === 'darwin') return Browsers.macOS('Desktop');
  if (os === 'win32') return Browsers.windows('Desktop');
  return Browsers.ubuntu('Desktop');
}

export class Session {
  // cfg: { id, proxy, dir, key(hex), os }；post(message) 发给主进程
  constructor(cfg, post, opts = {}) {
    this.id = cfg.id;
    this.cfg = cfg;
    this.post = post;
    this.key = Buffer.from(cfg.key, 'hex');
    if (this.key.length !== 32) throw new Error('密钥长度不对');
    this.makeSocket = opts.makeSocket || makeWASocket; // 自检时替换
    this.fetchVersion = opts.fetchVersion; // 自检时替换
    this.slowMs = opts.slowMs || SLOW_MS; // 自检时改短
    this.status = 'idle';
    this.attempt = 0;
    this.fails = 0; // 连续几次没连上（连上过或出了二维码就清零）
    this.unreachable = false; // 已经报了“连不上 WhatsApp”
    this.wasOpen = false; // 这次启动后连上过（没连上过的号界面写“正在连接”，不写“连接断开”）
    this.lastErr = '';
    this.sends = [];
    this.watched = false;
    this.watchJid = null;
    this.rev = 0;
    this.lastUnread = -1;
    this.crmSince = Number(cfg.crm) || 0; // 开了 CRM 同步：只收这个时间之后的消息；0 = 没开
  }

  // 主进程打开 / 关掉这个号的 CRM 同步
  setCrm(since) { this.crmSince = Number(since) || 0; }

  // 只取单聊里开关打开之后的消息（见 crm.mjs）。历史同步（messaging-history.set）不走这里
  async captureCrm(sock, messages) {
    const since = this.crmSince;
    const items = [];
    let skipped = 0;
    const pnForLid = (lid) => sock.signalRepository?.lidMapping?.getPNForLID?.(lid);
    for (const m of messages) {
      try {
        const r = await crmItem(m, since, pnForLid);
        if (!r) continue;
        if (r.skip) skipped += 1; else items.push(r.item);
      } catch { /* 这一条取不出来就跳过 */ }
    }
    if (sock !== this.sock || this.crmSince !== since || (!items.length && !skipped)) return;
    this.post({ type: 'crm', id: this.id, items, skipped });
  }

  log(msg) { this.post({ type: 'log', id: this.id, msg: scrub(msg) }); }

  setStatus(status, extra = {}) {
    this.status = status;
    this.post({ type: 'state', id: this.id, status, ...extra });
  }

  async start() {
    this.stopped = false;
    clearTimeout(this.retryTimer);
    if (this.sock || this.starting) return;
    this.starting = true;
    try {
      this.watchSlow();
      // 刚才是代理端口不通：先保持那个提示，这次连上了或者换了原因再更新，免得问题页来回跳
      if (this.status !== 'proxyDown') this.setDown('connecting');
      try {
        if (!this.auth) this.auth = makeAuthState(this.cfg.dir, this.key, (e) => this.log(`凭据写盘失败：${e.message}`));
        if (!this.store) this.store = new ChatStore(this.cfg.dir, this.key, (e) => this.log(`聊天缓存写盘失败：${e.message}`));
      } catch (e) {
        this.setStatus('authError', { detail: scrub(e.message) });
        return;
      }
      if (this.cfg.proxy) {
        const u = new URL(this.cfg.proxy);
        if (!(await probe(u.hostname, Number(u.port)))) {
          if (this.stopped) return;
          this.lastErr = '';
          this.setStatus('proxyDown');
          this.scheduleRetry();
          return;
        }
      }
      if (this.stopped) return;
      if (!this.transport) this.transport = this.cfg.proxy ? makeTransport(this.cfg.proxy) : makeDirectTransport();
      this.version = await waVersion(this.transport.dispatcher, (m) => this.log(m), this.fetchVersion);
      if (this.stopped || this.sock) return;
      this.connect();
    } finally {
      this.starting = false;
    }
  }

  // 还没连上时的状态：已经报了“连不上 WhatsApp”就一直显示它，免得每次重试问题页一闪就没
  setDown(status, extra = {}) {
    if (this.unreachable) this.setStatus('unreachable', { detail: this.lastErr, ...extra });
    else this.setStatus(status, { fresh: !this.wasOpen, ...extra });
  }

  // 开始等连接：30 秒还没连上（也没出二维码）就报原因
  watchSlow() {
    if (this.slowTimer || this.unreachable) return;
    this.slowTimer = setTimeout(() => { this.slowTimer = null; this.markUnreachable(); }, this.slowMs);
  }

  markUnreachable() {
    if (this.stopped || this.unreachable) return;
    this.unreachable = true;
    // 代理端口不通（proxyDown）原因更具体，保持不变；被封、退出登录这些也不覆盖
    if (['connecting', 'reconnecting'].includes(this.status)) this.setDown(this.status);
  }

  // 连上 WhatsApp 了（登录成功或出了二维码）：清掉计数和计时
  reached() {
    clearTimeout(this.slowTimer);
    this.slowTimer = null;
    this.fails = 0;
    this.unreachable = false;
    this.lastErr = '';
  }

  connect() {
    const { agent, dispatcher } = this.transport;
    const sock = this.makeSocket({
      auth: this.auth.state,
      logger: makeLogger((m) => this.log(m)),
      browser: browserFor(this.cfg.os),
      ...(this.version ? { version: this.version } : {}), // 查不到时用 Baileys 内置版本
      agent, // WebSocket
      fetchAgent: agent, // 上传：Baileys 在 Node 里用 http 模块上传，要的是 https.Agent（不是 undici dispatcher）
      options: { dispatcher }, // 历史同步、聊天记录等下载
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      emitOwnEvents: true,
      shouldIgnoreJid: (jid) => !!jid && (jid.endsWith('@broadcast') || jid.endsWith('@newsletter')),
      getMessage: async (key) => this.store?.sentMessage(key.id), // 对方请求重发自己发过的消息
    });
    this.sock = sock;
    this.qrShown = false;
    const ev = sock.ev;
    ev.on('creds.update', () => this.auth && this.auth.saveCreds());
    ev.on('connection.update', (u) => this.onConnection(sock, u));
    ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
      if (sock !== this.sock) return;
      for (const c of contacts || []) this.store.setName(c.id, c.name || c.notify || c.verifiedName);
      for (const c of chats || []) this.store.updateChat(c);
      for (const m of messages || []) this.store.addMessage(m, { countUnread: false });
      this.changed();
    });
    // 在线时的对话变化：unreadCount 正数是 Baileys 这一批新增的条数，新消息的未读由下面 messages.upsert 一条条加（见 store.liveChat）
    ev.on('chats.upsert', (list) => { for (const c of list) this.store.liveChat(c); this.changed(); });
    ev.on('chats.update', (list) => { for (const c of list) this.store.liveChat(c); this.changed(); });
    ev.on('chats.delete', (ids) => { for (const id of ids) this.store.remove(id); this.changed(); });
    const names = (list) => { for (const c of list) this.store.setName(c.id, c.name || c.notify || c.verifiedName); this.changed(); };
    ev.on('contacts.upsert', names);
    ev.on('contacts.update', names);
    ev.on('groups.update', (list) => { for (const g of list) if (g.subject) this.store.updateChat({ id: g.id, subject: g.subject }); this.changed(); });
    ev.on('messages.upsert', ({ messages, type }) => {
      if (sock !== this.sock) return;
      for (const m of messages) {
        // notify：在线收到的；append：断线期间收到、重连后补发的（比缓存里最后一条新才算未读），或自己发的
        const r = this.store.addMessage(m, { countUnread: type === 'notify' ? true : type === 'append' ? 'newer' : false });
        if (r && r.incoming) this.post({ type: 'incoming', id: this.id, jid: r.jid });
      }
      if (this.crmSince) this.captureCrm(sock, messages);
      this.changed();
    });
  }

  onConnection(sock, { connection, lastDisconnect, qr }) {
    if (sock !== this.sock) return;
    if (qr) {
      this.qrShown = true;
      this.reached();
      QRCode.toDataURL(qr, { margin: 1, width: 264 }).then((url) => {
        if (sock === this.sock && !this.stopped) this.setStatus('qr', { qr: url });
      }, (e) => this.log(`二维码生成失败：${e.message}`));
    }
    if (connection === 'open') {
      this.reached();
      this.wasOpen = true;
      this.attempt = 0;
      this.lastCode = null;
      this.sameCode = 0;
      // 自己的号（如 "8613800000000:12@s.whatsapp.net"），主进程只取出手机号显示在侧栏
      this.setStatus('open', { me: String(this.auth?.state?.creds?.me?.id || '').slice(0, 100) });
      this.changed();
      // 群名称
      sock.groupFetchAllParticipating().then((groups) => {
        for (const g of Object.values(groups || {})) this.store.updateChat({ id: g.id, subject: g.subject });
        this.changed();
      }, () => {});
    }
    if (connection !== 'close') return;
    this.sock = null;
    if (this.stopped) return;
    const code = lastDisconnect?.error?.output?.statusCode;
    this.flush();
    if (code === DisconnectReason.loggedOut) {
      // 手机上移除了设备或登录失效：删掉凭据和聊天缓存，下次重新扫码
      this.auth.wipe();
      this.auth = null;
      this.store.save.cancel();
      fs.rmSync(this.store.file, { force: true });
      this.store = null;
      this.setStatus('loggedOut');
      return;
    }
    if (code === DisconnectReason.forbidden) { this.setStatus('banned'); return; }
    if (code === DisconnectReason.connectionReplaced) { this.setStatus('replaced'); return; }
    if (code === 405) { resetVersionCache(); this.setStatus('outdated'); return; } // 版本被拒：下次连接重新查
    if (code === DisconnectReason.restartRequired) { this.start(); return; } // 扫码成功后的正常重启
    if (this.qrShown && !this.auth.state.creds.me) { this.setStatus('qrExpired'); return; }
    const errMsg = String(lastDisconnect?.error?.message || '').split('\n')[0];
    // 500 badSession、411 这类错误连续出现，重连也没用，停下来让用户处理；网络类断开不计数。
    // 连接本身没建立（Baileys 报 “WebSocket Error”，比如代理节点不通）也会带 500，那是网络问题，照样一直重试
    if (HOPELESS_CODES.has(code) && !/^WebSocket Error/.test(errMsg)) {
      this.sameCode = code === this.lastCode ? this.sameCode + 1 : 1;
      this.lastCode = code;
      if (this.sameCode >= MAX_SAME_ERROR) { this.setStatus('stuck', { code }); return; }
    }
    this.fails += 1;
    this.lastErr = scrub(errMsg);
    if (this.fails >= SLOW_FAILS) this.unreachable = true;
    this.watchSlow();
    this.setDown('reconnecting', { code: code || 0 });
    this.scheduleRetry();
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    const delay = Math.min(10000 * 2 ** Math.min(this.attempt, 10), this.unreachable ? SLOW_RETRY_MS : MAX_RETRY_MS);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => this.start(), delay);
  }

  // 主进程关心的变化（未读数、对话列表）合并后再发
  changed() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emitNow(); }, 250);
  }

  emitNow() {
    if (!this.store) return;
    const unread = this.store.unreadChats();
    // 带上最近几个有未读的对话（名字、未读条数、最后一条预览），主进程弹窗用。
    // 未读对话数没变、但某个客户又发了一条（未读条数变了）也推一次
    const chats = this.store.summary().filter((c) => c.unread > 0).slice(0, 5)
      .map((c) => ({ jid: c.jid, name: c.name, unread: c.unread, ts: c.ts, preview: String(c.preview || '').slice(0, 160) }));
    const sig = `${unread}|${chats.map((c) => `${c.jid}:${c.unread}`).join(',')}`;
    if (sig !== this.lastUnreadSig) {
      this.lastUnreadSig = sig;
      this.lastUnread = unread;
      this.post({ type: 'unread', id: this.id, count: unread, chats });
    }
    if (!this.watched) return;
    const jid = this.watchJid;
    this.rev += 1;
    this.post({
      type: 'view',
      id: this.id,
      rev: this.rev,
      chats: this.store.summary(),
      jid,
      title: jid ? (this.store.nameOf(jid) || '') : '',
      messages: jid ? this.store.messages(jid) : [],
    });
  }

  // 主进程告诉我们这个号正在被看、看的是哪个对话
  watch(watched, jid) {
    this.watched = !!watched;
    if (jid !== undefined) this.watchJid = jid || null;
    if (this.watched) this.emitNow();
  }

  // 用户打开对话时发已读回执
  async read(jid) {
    if (!this.store) return;
    const keys = this.store.takeUnread(jid);
    this.changed();
    if (keys.length && this.sock && this.status === 'open') {
      try { await this.sock.readMessages(keys); } catch (e) { this.log(`已读回执失败：${e.message}`); }
    }
  }

  // MCP 搜索对话用：本机保存的全部对话，只读。号码只给个人对话，群和隐藏号码的对话没有
  chatList() {
    if (!this.store) return null;
    return this.store.summary(2000).map((c) => ({
      name: c.name, number: phoneOf(c.jid), unread: c.unread, ts: c.ts, group: c.group,
      preview: String(c.preview || '').slice(0, 160),
    }));
  }

  async send(jid, text) {
    text = String(text || '').trim();
    if (this.status === 'loggedOut') throw new Error('这个号已退出登录，请重新扫码');
    if (!text) throw new Error('消息是空的');
    if (text.length > MAX_TEXT) throw new Error(`一条消息最多 ${MAX_TEXT} 个字`);
    if (!this.sock || this.status !== 'open') throw new Error('还没连上，暂时不能发送');
    if (!this.store.chats.has(jid)) throw new Error('只能回复已有的对话');
    const now = Date.now();
    this.sends = this.sends.filter((t) => now - t < SEND_WINDOW_MS);
    if (this.sends.length >= SEND_LIMIT) throw new Error(`发送太快：每个号每分钟最多 ${SEND_LIMIT} 条，请稍后再发`);
    this.sends.push(now);
    const sent = await this.sock.sendMessage(jid, { text });
    if (sent?.key?.id && sent.message) this.store?.rememberSent(sent.key.id, sent.message);
  }

  flush() {
    try { this.auth && this.auth.flush(); } catch { /* 已在 onError 里记录 */ }
    try { this.store && this.store.save.flush(); } catch { /* 同上 */ }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.slowTimer);
    this.slowTimer = null;
    clearTimeout(this.emitTimer);
    this.emitTimer = null;
    const sock = this.sock;
    this.sock = null;
    if (sock) { try { sock.end(undefined); } catch { /* 已经断开 */ } }
    this.flush();
    this.status = 'idle';
  }

  // 删除账号：已连上时先让手机上的“已关联的设备”退出，再删本机数据
  async logout() {
    const sock = this.sock;
    if (sock && this.status === 'open') {
      try {
        await Promise.race([sock.logout(), new Promise((resolve) => { setTimeout(resolve, 6000); })]);
      } catch { /* 退不掉也继续删本机数据 */ }
    }
    this.stop();
    if (this.auth) this.auth.wipe();
    if (this.store) this.store.save.cancel();
    this.auth = null;
    this.store = null;
    fs.rmSync(this.cfg.dir, { recursive: true, force: true });
  }
}
