// 主进程这边的轻量模式管理：按需启动后台进程（utilityProcess），转发命令和事件。
// 没有轻量模式账号时不启动后台进程，不占内存；最后一个轻量账号删掉后关掉它。
// 走代理的号和直连号分在两个后台进程里：走代理的进程只许连代理（网络护栏），
// 直连进程放行本机网络。没有直连轻量号时直连进程不启动。
const { utilityProcess } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');

const scrub = (s) => String(s || '').replace(/\d{6,}/g, '[号码]').slice(0, 500);

// 一个后台进程
class LiteProc {
  constructor({ dataDir, direct, bus }) {
    this.dataDir = dataDir;
    this.direct = !!direct;
    this.bus = bus; // 事件都发到 LiteHost 上
    this.proc = null;
    this.ready = false;
    this.queue = [];
    this.pending = new Map(); // reqId -> { resolve, reject, timer }
    this.nextReq = 1;
    this.sessions = new Map(); // id -> start 参数（后台进程意外退出后用来恢复）
    this.watch = { id: null, jid: null };
    this.shuttingDown = false;
    this.crashes = [];
  }

  dirOf(id) {
    if (!/^\d+$/.test(String(id))) throw new Error('账号编号不对');
    return path.join(this.dataDir, 'lite', String(id));
  }

  pid() {
    return this.proc && this.ready ? this.proc.pid : null;
  }

  ensure() {
    if (this.proc) return;
    this.ready = false;
    const proc = utilityProcess.fork(path.join(__dirname, 'worker.mjs'), this.direct ? ['--direct'] : [], { serviceName: this.direct ? 'WAswitch 轻量模式（直连）' : 'WAswitch 轻量模式', stdio: 'pipe' });
    this.proc = proc;
    const pipe = (stream, level) => stream && stream.on('data', (d) => {
      for (const line of String(d).split('\n')) if (line.trim()) console[level](`[轻量模式] ${scrub(line)}`);
    });
    pipe(proc.stdout, 'log');
    pipe(proc.stderr, 'warn');
    proc.on('message', (m) => { if (this.proc === proc) this.onMessage(m); });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('后台进程已退出')); }
      this.pending.clear();
      this.queue = [];
      if (this.shuttingDown || !this.sessions.size) return;
      // 意外退出：10 分钟内最多自动恢复 3 次
      const now = Date.now();
      this.crashes = this.crashes.filter((t) => now - t < 10 * 60 * 1000);
      this.crashes.push(now);
      console.warn(`轻量模式后台进程意外退出（${code}）`);
      for (const id of this.sessions.keys()) this.bus.emit('state', { id, status: 'crashed' });
      if (this.crashes.length > 3) {
        // 反复崩溃：不再自动恢复，让用户手动点“重新连接”
        for (const id of this.sessions.keys()) this.bus.emit('state', { id, status: 'crashLoop' });
        return;
      }
      setTimeout(() => {
        if (this.shuttingDown || this.proc) return;
        for (const cfg of this.sessions.values()) this.send({ type: 'start', ...cfg, ...this.watchFor(cfg.id) });
      }, 3000);
    });
  }

  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ready') {
      this.ready = true;
      const q = this.queue;
      this.queue = [];
      for (const x of q) this.proc.postMessage(x);
      return;
    }
    if (m.type === 'reply') {
      const p = this.pending.get(m.reqId);
      if (!p) return;
      this.pending.delete(m.reqId);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
      return;
    }
    if (m.type === 'log') { console.warn(`[轻量模式${m.id ? ` ${m.id}` : ''}] ${scrub(m.msg)}`); return; }
    if (m.type === 'guard') { console.warn(`[轻量模式] 网络护栏拦下了${m.what} ${scrub(m.host)}`); }
    this.bus.emit(m.type, m);
  }

  // 有请求（比如发消息）还没回来
  busy() {
    return this.pending.size > 0 || this.queue.length > 0;
  }

  send(msg) {
    this.ensure();
    if (this.ready) this.proc.postMessage(msg); else this.queue.push(msg);
  }

  request(msg, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const reqId = this.nextReq++;
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error('后台进程没有响应')); }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.send({ ...msg, reqId });
    });
  }

  watchFor(id) {
    return { watched: this.watch.id === id, jid: this.watch.id === id ? this.watch.jid : null };
  }

  // proxy：socks5h://… 或 http(s)://…；key：这个号的数据密钥（hex）
  // crm：开了 CRM 同步时是开关打开的时间（只收之后的消息），没开是 0
  start(id, { proxy, key, os, crm = 0 }) {
    if (!this.proc) this.crashes = []; // 用户手动重新连接时重新计数
    const cfg = { id, proxy, key, os, crm, dir: this.dirOf(id) };
    this.sessions.set(id, cfg);
    this.send({ type: 'start', ...cfg, ...this.watchFor(id) });
  }

  stop(id) {
    if (!this.sessions.delete(id)) return;
    if (this.proc) this.send({ type: 'stop', id });
    this.stopIfIdle();
  }

  async logout(id) {
    const had = this.sessions.delete(id);
    if (had && this.proc) {
      try { await this.request({ type: 'logout', id }, 15000); } catch (e) { console.warn(`轻量模式退出登录失败：${e.message}`); }
    }
    this.stopIfIdle();
  }

  // 告诉后台进程现在正在看哪个号、哪个对话（只有这个号会推送对话列表）
  setWatch(id, jid) {
    if (this.watch.id === id && this.watch.jid === jid) return;
    this.watch = { id, jid };
    if (this.proc) this.send({ type: 'watch', id, jid });
  }

  setCrm(id, since) {
    const cfg = this.sessions.get(id);
    if (!cfg || cfg.crm === since) return;
    cfg.crm = since;
    if (this.proc) this.send({ type: 'crm', id, since });
  }

  read(id, jid) {
    if (this.sessions.has(id)) this.send({ type: 'read', id, jid });
  }

  sendText(id, jid, text) {
    if (!this.sessions.has(id)) return Promise.reject(new Error('这个号没有在运行'));
    return this.request({ type: 'send', id, jid, text }, 30000);
  }

  // MCP 搜索对话：这个号在本机保存的全部对话。号没在运行时返回 null（不为了这个启动后台进程）
  chatList(id) {
    if (!this.sessions.has(id) || !this.proc) return Promise.resolve(null);
    return this.request({ type: 'chats', id }, 10000);
  }

  // 顶栏“客户当地时间”：打开的对话的真实号码（@lid 也查）。号没在运行时返回 ''
  peerNumber(id, jid) {
    if (!this.sessions.has(id) || !this.proc) return Promise.resolve('');
    return this.request({ type: 'peer', id, jid }, 5000);
  }

  // 转文字：下载客户发来的一条语音（只在内存里），返回 Uint8Array
  voice(id, jid, msgId) {
    if (!this.sessions.has(id) || !this.proc) return Promise.reject(new Error('这个号没有在运行'));
    return this.request({ type: 'voice', id, jid, msgId }, 120000);
  }

  // MCP read_messages：按名称或号码找对话、读最近的消息（只读本机缓存）
  ask(msg) {
    if (!this.sessions.has(msg.id)) return Promise.resolve({ ok: false, reason: 'notrunning' });
    return this.request(msg, 10000);
  }

  stopIfIdle() {
    if (this.sessions.size || !this.proc) return;
    this.shutdownProc();
  }

  // 关掉后台进程：先让它把数据写盘再退出，4 秒没退就强制结束。
  // 先把 this.proc 置空，之后再有账号启动会开一个新进程，不会把命令发给正在退出的旧进程。
  async shutdownProc() {
    const proc = this.proc;
    if (!proc) return;
    const wasReady = this.ready;
    this.proc = null;
    this.ready = false;
    this.queue = [];
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('后台进程已关闭')); }
    this.pending.clear();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* 已经退出 */ } resolve(); }, 4000);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
      if (!wasReady) { clearTimeout(timer); try { proc.kill(); } catch { /* 已经退出 */ } resolve(); return; }
      try { proc.postMessage({ type: 'shutdown' }); } catch { clearTimeout(timer); resolve(); }
    });
  }

  running() {
    return !!this.proc;
  }

  // 退出软件前调用：让后台进程把凭据和缓存写盘
  async shutdown() {
    this.shuttingDown = true;
    await this.shutdownProc();
  }

  // 关掉之后又不退出了（比如自动更新没装成）：允许重新启动后台进程
  resume() {
    this.shuttingDown = false;
  }
}

// 主进程用的入口：按账号有没有代理分到两个后台进程，对外用法和一个进程时一样
class LiteHost extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.proxied = new LiteProc({ dataDir, direct: false, bus: this });
    this.directProc = new LiteProc({ dataDir, direct: true, bus: this });
  }

  procs() { return [this.proxied, this.directProc]; }

  procOf(id) { return this.procs().find((p) => p.sessions.has(id)) || null; }

  // 没有代理（proxy 为空）的号进直连进程；号从直连改成代理（或反过来）时先从原来的进程里停掉
  start(id, cfg) {
    const target = cfg.proxy ? this.proxied : this.directProc;
    for (const p of this.procs()) if (p !== target) p.stop(id);
    target.start(id, { ...cfg, proxy: cfg.proxy || null });
  }

  stop(id) { for (const p of this.procs()) p.stop(id); }

  async logout(id) { await Promise.all(this.procs().map((p) => p.logout(id))); }

  // 两个进程都告诉：不在这个进程里的号，进程里所有号都会变成“没在看”
  setWatch(id, jid) { for (const p of this.procs()) p.setWatch(id, jid); }

  setCrm(id, since) { for (const p of this.procs()) p.setCrm(id, since); }

  read(id, jid) { for (const p of this.procs()) p.read(id, jid); }

  sendText(id, jid, text) {
    const p = this.procOf(id);
    return p ? p.sendText(id, jid, text) : Promise.reject(new Error('这个号没有在运行'));
  }

  chatList(id) {
    const p = this.procOf(id);
    return p ? p.chatList(id) : Promise.resolve(null);
  }

  peerNumber(id, jid) {
    const p = this.procOf(id);
    return p ? p.peerNumber(id, jid) : Promise.resolve('');
  }

  findChat(id, chat) {
    const p = this.procOf(id);
    return p ? p.ask({ type: 'findChat', id, chat }) : Promise.resolve({ ok: false, reason: 'notrunning' });
  }

  history(id, jid, limit) {
    const p = this.procOf(id);
    return p ? p.ask({ type: 'history', id, jid, limit }) : Promise.resolve({ ok: false, reason: 'notrunning' });
  }

  // 后台补译文记录里的原文（见 trfill.js）。号没在运行时返回 null
  chatJids(id) {
    const p = this.procOf(id);
    return p && p.running() ? p.request({ type: 'jids', id }, 10000) : Promise.resolve(null);
  }

  incomingTexts(id, jid) {
    const p = this.procOf(id);
    return p && p.running() ? p.request({ type: 'incoming', id, jid }, 10000) : Promise.resolve(null);
  }

  voice(id, jid, msgId) {
    const p = this.procOf(id);
    return p ? p.voice(id, jid, msgId) : Promise.reject(new Error('这个号没有在运行'));
  }

  // 两个后台进程的 pid（内存统计用）
  pids() { return this.procs().map((p) => p.pid()).filter(Boolean); }

  busy() { return this.procs().some((p) => p.busy()); }

  running() { return this.procs().some((p) => p.running()); }

  async shutdown() { await Promise.all(this.procs().map((p) => p.shutdown())); }

  resume() { for (const p of this.procs()) p.resume(); }
}

module.exports = { LiteHost };
