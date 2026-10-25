// 团队模式：把这台 WAswitch 登记到团队后台（Cloudflare Worker），定时同步坐席并上报账号状态。
//
// 规则（设计文档 + 审计）：
// - 只在主进程里跑，只读一份白名单状态，不碰账号的 session、页面、分区目录、轻量号密钥。
// - 同步请求走本机网络，不经过任何账号的代理，不带任何账号的 cookie；不跟随跳转。
// - 后台发来的东西只当数据：显示/隐藏、名称、颜色、备注。没有命令、网址、代理。
// - 只有显式的 403 { revoked: true, device_id: 本机 } 才停用团队号；其它任何错误都当离线，照常工作。
// - 收回只认显式的 visible:false；一次要隐藏本机一半以上的团队号时先暂停，等管理员在后台确认。
// - 不采集员工活动（最后操作时间、未读等待时长），只报未读数。
const fs = require('fs');
const path = require('path');
const { canEncrypt } = require('../secure-storage');

const PROTOCOL = 1;
const FILE = 'team.json';
const DEBOUNCE_MS = 10 * 1000;
const EARLY_GAP_MS = 60 * 1000; // 提前同步离上一次同步至少隔 60 秒（免费额度）
const BACKOFF_MIN = [2, 4, 8, 16, 30];
const TIMEOUT_MS = 15 * 1000;
const MAX_EVENTS = 500;
const MAX_BODY = 1024 * 1024;
const UUID_RE = /^[0-9a-f-]{36}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const STATES = ['ready', 'loading', 'needs_qr', 'proxy_down', 'needs_proxy', 'error', 'banned', 'stopped'];
const EVENT_KINDS = ['dropped', 'recovered', 'exit_changed', 'proxy_down', 'proxy_up', 'banned'];

// 登记前给员工看的上传清单（登记时必须勾选确认）
const UPLOAD_FIELDS = [
  '每个团队号：状态（正常 / 加载中 / 要扫码 / 代理不通 / 出错 / 可能被封）、未读数',
  '每个团队号：代理通不通、延迟、出口 IP 和国家、出口 IP 是否变了',
  '状态变化记录：掉线、恢复、换出口、代理断开或恢复（只有类型、时间和国家代码）',
  '这台电脑：WAswitch 版本、系统类型（Windows / Mac / Linux）、内存占用、是否省内存模式',
  '管理员给某个团队号开了“同步到 CRM”时：这个号单聊里的文字消息（对方号码、时间、收 / 发、文字），用来写进公司的 CRM。侧栏会一直显示“CRM”标记',
];
const NEVER_UPLOAD = [
  '没开“同步到 CRM”的号的聊天内容；所有号的群聊、对话列表、通知内容、联系人名字和通讯录',
  '二维码、登录数据、cookie、轻量号密钥',
  '代理地址、端口、用户名、密码',
  '你操作电脑的时间、最后操作时间（不监控员工活动）',
  '电脑名、系统用户名、文件路径、截图',
];

function cleanServer(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  return u.origin;
}

class TeamSync {
  // hooks:
  //   accounts() -> 账号数组（同一份对象，模块直接改 teamId/teamHidden/teamNote 等字段）
  //   save() 写 accounts.json
  //   statusOf(acc) -> { state, unread, proxy_ok, proxy_ms, exit_ip, exit_country, exit_changed }
  //   deviceInfo() -> { mem_mb, low_mem }
  //   park(acc) 停掉并隐藏；unpark(acc) 重新显示并启动
  //   createSeat(seat) -> 新建的本地账号（还没填代理，不会联网）
  //   refresh() 刷新界面
  constructor({ dir, safeStorage, hooks, appVersion, platform, fetchImpl = (...a) => fetch(...a), now = Date.now, timers = { setTimeout, clearTimeout } }) {
    this.dir = dir;
    this.safe = safeStorage;
    this.hooks = hooks;
    this.appVersion = String(appVersion || '');
    this.platform = { win32: 'win', darwin: 'mac', linux: 'linux' }[platform] || '';
    this.fetch = fetchImpl;
    this.now = now;
    this.timers = timers;
    this.timer = null;
    this.inflight = null;
    this.failures = 0;
    this.lastSig = '';
    this.state = this.load();
  }

  // ---------- 本地文件 ----------
  file() { return path.join(this.dir, FILE); }
  load() {
    const empty = { server: '', deviceId: '', token: '', cursor: 0, allowPrivate: true, revoked: false, held: [], events: [], lastOkAt: 0, lastError: '', lastUpload: null };
    try {
      const s = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      return {
        ...empty,
        server: cleanServer(s.server) || '',
        deviceId: UUID_RE.test(s.deviceId) ? s.deviceId : '',
        token: typeof s.token === 'string' ? s.token : '',
        cursor: Number.isSafeInteger(s.cursor) && s.cursor >= 0 ? s.cursor : 0,
        allowPrivate: s.allowPrivate !== false,
        revoked: s.revoked === true,
        held: Array.isArray(s.held) ? s.held.filter((x) => UUID_RE.test(x)) : [],
        events: Array.isArray(s.events) ? s.events.slice(-MAX_EVENTS) : [],
        lastOkAt: Number(s.lastOkAt) || 0,
        lastError: typeof s.lastError === 'string' ? s.lastError : '',
        lastUpload: s.lastUpload && typeof s.lastUpload === 'object' ? s.lastUpload : null,
      };
    } catch {
      return empty;
    }
  }
  persist() {
    const file = this.file();
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  tokenPlain() {
    if (!canEncrypt(this.safe)) return '';
    if (!this.state.token) return '';
    try { return this.safe.decryptString(Buffer.from(this.state.token, 'base64')); } catch { return ''; }
  }

  // ---------- 给主进程用的判断 ----------
  joined() { return !!(this.state.server && this.state.token); }
  enrolled() { return this.joined() && !this.state.revoked; }
  // 这个号现在应该停着、不显示吗
  isParked(acc) {
    if (acc.teamId && acc.teamHidden === true) return true; // 收回的号一直停着，不管团队文件在不在
    if (!this.joined()) return false;
    if (acc.teamId) return this.state.revoked;
    return !this.state.allowPrivate && !this.state.revoked;
  }

  // 设置页“团队”用
  snapshot() {
    const accs = this.hooks.accounts();
    return {
      joined: this.joined(),
      revoked: this.state.revoked,
      server: this.state.server,
      allowPrivate: this.state.allowPrivate,
      lastOkAt: this.state.lastOkAt,
      lastError: this.state.lastError,
      offline: this.joined() && !this.state.revoked && this.failures > 0,
      held: this.state.held.length,
      teamCount: accs.filter((a) => a.teamId && !a.teamHidden).length,
      privateAccounts: accs.filter((a) => !a.teamId).map((a) => ({ id: a.id, name: a.name, color: a.color })),
      uploadFields: UPLOAD_FIELDS,
      neverUpload: NEVER_UPLOAD,
      lastUpload: this.state.lastUpload ? JSON.stringify(this.state.lastUpload, null, 2) : '',
      canEncrypt: canEncrypt(this.safe),
    };
  }

  // ---------- 网络 ----------
  async post(pathname, body, token, server = this.state.server) {
    const ctl = new AbortController();
    const t = this.timers.setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetch(`${server}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: ctl.signal,
      });
      const type = res.headers.get('content-type') || '';
      const text = await res.text();
      let data = null;
      if (type.startsWith('application/json') && text.length <= MAX_BODY) {
        try { data = JSON.parse(text); } catch { data = null; }
      }
      return { status: res.status, data };
    } finally {
      this.timers.clearTimeout(t);
    }
  }

  localList(ids) {
    const accs = this.hooks.accounts();
    return ids.map((id) => accs.find((a) => a.id === id && !a.teamId)).filter(Boolean)
      .map((a) => ({ local_id: a.id, name: a.name, color: COLOR_RE.test(a.color) ? a.color : '', mode: a.mode === 'lite' ? 'lite' : 'web' }));
  }

  mapTeamIds(list) {
    const accs = this.hooks.accounts();
    for (const m of Array.isArray(list) ? list : []) {
      const acc = accs.find((a) => a.id === m.local_id);
      if (acc && UUID_RE.test(m.team_id)) { acc.teamId = m.team_id; acc.teamHidden = false; }
    }
    this.hooks.save();
  }

  // 登记：员工填后台地址和登记码，选择哪些本机账号加入团队，并确认上传清单
  async enroll({ server, code, deviceName, localIds = [], consent } = {}) {
    if (consent !== true) return { error: '请先确认上传清单' };
    if (!canEncrypt(this.safe)) return { error: '系统没有安全钥匙环，不能登记到团队' };
    const origin = cleanServer(server);
    if (!origin) return { error: '后台地址必须是 https:// 开头的网址' };
    if (this.enrolled()) return { error: '这台电脑已经登记过了' };
    let r;
    try {
      r = await this.post('/api/device/enroll', {
        v: PROTOCOL, code: String(code || ''),
        device: { name: String(deviceName || '').slice(0, 40), app_version: this.appVersion, platform: this.platform },
        accounts: this.localList(Array.isArray(localIds) ? localIds : []),
      }, '', origin);
    } catch (e) {
      return { error: `连不上后台：${e.name === 'AbortError' ? '超时' : e.message}` };
    }
    if (r.status !== 200 || !r.data || typeof r.data.token !== 'string' || !UUID_RE.test(r.data.device_id)) {
      return { error: (r.data && r.data.error) || `登记失败（${r.status}）` };
    }
    this.state = { ...this.state, server: origin, deviceId: r.data.device_id, token: this.safe.encryptString(r.data.token).toString('base64'),
      cursor: 0, revoked: false, held: [], events: [], allowPrivate: r.data.allow_private !== false, lastError: '', lastOkAt: this.now() };
    this.persist();
    this.mapTeamIds(r.data.accounts);
    this.hooks.refresh();
    this.schedule(1000);
    return { ok: true };
  }

  // 把本机的私人号加入团队
  async join(localIds) {
    if (!this.enrolled()) return { error: '还没登记到团队' };
    let r;
    try {
      r = await this.post('/api/device/join', { v: PROTOCOL, accounts: this.localList(Array.isArray(localIds) ? localIds : []) }, this.tokenPlain());
    } catch (e) {
      return { error: `连不上后台：${e.message}` };
    }
    if (r.status !== 200 || !r.data) return { error: (r.data && r.data.error) || `加入失败（${r.status}）` };
    this.mapTeamIds(r.data.accounts);
    this.hooks.refresh();
    this.schedule(1000);
    return { ok: true };
  }

  // ---------- 状态和事件 ----------
  statusList() {
    return this.hooks.accounts().filter((a) => a.teamId && !a.teamHidden).slice(0, 100).map((a) => {
      const s = this.hooks.statusOf(a) || {};
      return {
        team_id: a.teamId,
        state: STATES.includes(s.state) ? s.state : 'error',
        unread: Number.isInteger(s.unread) && s.unread >= 0 ? s.unread : 0,
        proxy_ok: typeof s.proxy_ok === 'boolean' ? s.proxy_ok : null,
        proxy_ms: Number.isInteger(s.proxy_ms) && s.proxy_ms >= 0 ? Math.round(s.proxy_ms / 50) * 50 : null,
        exit_ip: typeof s.exit_ip === 'string' ? s.exit_ip : '',
        exit_country: typeof s.exit_country === 'string' && /^[A-Z]{2}$/.test(s.exit_country) ? s.exit_country : '',
        exit_changed: s.exit_changed === true,
      };
    });
  }

  recordEvent(acc, kind, detail = '') {
    if (!this.enrolled() || !acc || !acc.teamId || acc.teamHidden || !EVENT_KINDS.includes(kind)) return;
    const d = typeof detail === 'string' && /^[A-Z]{2}$/.test(detail) ? detail : '';
    this.state.events.push({ team_id: acc.teamId, kind, at: this.now(), detail: d });
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    this.persist();
    this.noteChange(true);
  }

  // 主进程每次刷新界面时调用。只有团队号的状态（在线、要扫码、代理断了等）变了或有新事件，才提前同步：
  // 至少等 10 秒合并变化，而且离上一次同步至少 60 秒。未读数、延迟这些等正常的 2 分钟同步带上。
  // 离线退避期间不提前（免得断网时反复重试）。
  noteChange(force = false) {
    if (!this.enrolled() || this.state.revoked) return;
    const sig = JSON.stringify(this.statusList().map((x) => [x.team_id, x.state]));
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    if (this.failures > 0) return;
    const at = Math.max(this.now() + DEBOUNCE_MS, (this.lastSyncAt || 0) + EARLY_GAP_MS);
    if (!this.dueAt || this.dueAt > at) this.schedule(at - this.now());
  }

  // ---------- 同步 ----------
  start() { if (this.enrolled()) this.schedule(5000); }
  stop() { if (this.timer) this.timers.clearTimeout(this.timer); this.timer = null; this.dueAt = 0; }
  schedule(ms) {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.dueAt = this.now() + ms;
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.dueAt = 0; this.syncNow(); }, ms);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  async syncNow() {
    if (!this.enrolled()) return { skipped: true };
    if (this.inflight) return this.inflight;
    this.inflight = this.doSync().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async doSync() {
    const token = this.tokenPlain();
    if (!token) { this.offline('本机保存的令牌读不出来，请重新登记'); return { error: 'token' }; }
    this.lastSyncAt = this.now();
    const events = this.state.events.slice(0, 100);
    const info = this.hooks.deviceInfo() || {};
    const body = {
      v: PROTOCOL,
      now: this.now(),
      cursor: this.state.cursor,
      device: { app_version: this.appVersion, platform: this.platform, mem_mb: Number.isInteger(info.mem_mb) ? info.mem_mb : 0, low_mem: info.low_mem === true, held_hides: this.state.held.length },
      status: this.statusList(),
      events,
    };
    this.state.lastUpload = { at: new Date(this.now()).toISOString(), ...body };
    let r;
    try {
      r = await this.post('/api/device/sync', body, token);
    } catch (e) {
      return this.offline(e.name === 'AbortError' ? '后台没有响应（超时）' : `连不上后台：${e.message}`);
    }
    // 只有这一种情况才停用团队号：明确的 403、带 revoked、而且说的是本机
    if (r.status === 403 && r.data && r.data.revoked === true && r.data.device_id === this.state.deviceId) {
      this.state.revoked = true;
      this.state.lastError = '这台电脑已被管理员停用';
      this.persist();
      // 团队号全部标成隐藏：以后重新登记，也要等后台重新分配才显示
      for (const a of this.hooks.accounts()) if (a.teamId) { a.teamHidden = true; this.hooks.park(a); }
      this.hooks.save();
      this.applyPrivate();
      this.stop();
      this.hooks.refresh();
      return { revoked: true };
    }
    if (r.status !== 200 || !r.data || r.data.ok !== true || !Array.isArray(r.data.seats)) {
      const why = r.status === 426 ? '这个版本太旧，请更新 WAswitch' : `后台暂时不可用（${r.status}）`;
      return this.offline(why);
    }
    // 成功：已发出的事件从队列里去掉
    this.state.events.splice(0, events.length);
    this.failures = 0;
    this.state.lastOkAt = this.now();
    this.state.lastError = '';
    this.state.allowPrivate = r.data.allow_private !== false;
    this.applySeats(r.data.seats, r.data.confirm_hides === true);
    if (Number.isSafeInteger(r.data.cursor) && r.data.cursor >= this.state.cursor) this.state.cursor = r.data.cursor;
    this.persist();
    this.applyPrivate();
    this.hooks.refresh();
    const next = Math.min(900, Math.max(60, Number(r.data.next_sync_s) || 120)) * 1000;
    this.schedule(r.data.more === true ? 1000 : next);
    return { ok: true };
  }

  offline(why) {
    this.failures += 1;
    this.state.lastError = why;
    this.persist();
    this.schedule(BACKOFF_MIN[Math.min(this.failures - 1, BACKOFF_MIN.length - 1)] * 60 * 1000);
    this.hooks.refresh();
    return { offline: true, error: why };
  }

  // 后台关掉“允许私人号”时：私人号停着并隐藏（不删数据）；打开时恢复
  applyPrivate() {
    for (const a of this.hooks.accounts()) {
      if (a.teamId) continue;
      if (this.isParked(a)) this.hooks.park(a); else this.hooks.unpark(a);
    }
  }

  applySeats(seats, confirmHides) {
    const accs = this.hooks.accounts();
    const hides = [];
    let changed = false;
    for (const s of seats) {
      if (!s || !UUID_RE.test(s.team_id)) continue;
      const acc = accs.find((a) => a.teamId === s.team_id);
      if (s.visible !== true) {
        if (s.visible === false && acc && !acc.teamHidden) hides.push(acc);
        continue;
      }
      this.state.held = this.state.held.filter((id) => id !== s.team_id);
      const fields = {
        name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 40) : null,
        color: typeof s.color === 'string' && COLOR_RE.test(s.color) ? s.color : null,
        note: typeof s.note === 'string' ? s.note.slice(0, 500) : '',
        expected: typeof s.expected_country === 'string' && /^[A-Z]{2}$/.test(s.expected_country) ? s.expected_country : '',
        crm: s.crm_sync === true,
      };
      if (acc) {
        if (fields.name) acc.name = fields.name;
        if (fields.color) acc.color = fields.color;
        acc.teamNote = fields.note;
        acc.teamExpected = fields.expected;
        acc.teamCrm = fields.crm;
        if (acc.teamHidden) { acc.teamHidden = false; this.hooks.unpark(acc); }
      } else {
        this.hooks.createSeat({ teamId: s.team_id, name: fields.name || '团队账号', color: fields.color, mode: s.mode === 'lite' ? 'lite' : 'web', note: fields.note, expected: fields.expected, crm: fields.crm });
      }
      changed = true;
    }
    // 收回：一次要隐藏本机一半以上的团队号，先暂停，等管理员确认
    const visibleTeam = accs.filter((a) => a.teamId && !a.teamHidden).length;
    const heldIds = new Set(this.state.held);
    for (const a of hides) heldIds.add(a.teamId);
    const pending = accs.filter((a) => a.teamId && !a.teamHidden && heldIds.has(a.teamId));
    if (pending.length && (confirmHides || visibleTeam < 2 || pending.length * 2 <= visibleTeam)) {
      for (const a of pending) { a.teamHidden = true; this.hooks.park(a); }
      this.state.held = [];
      changed = true;
    } else {
      this.state.held = pending.map((a) => a.teamId);
    }
    if (changed) this.hooks.save();
  }
}

module.exports = { TeamSync, cleanServer, UPLOAD_FIELDS, NEVER_UPLOAD, PROTOCOL };

