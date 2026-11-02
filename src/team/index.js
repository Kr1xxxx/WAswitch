// 团队模式：员工用账号和密码登录团队后台（Cloudflare Worker），定时同步坐席并上报账号状态。
// 后台按“登录”开关（off / optional / required）决定要不要登录才能用；必须登录时没登录、被停用、
// 连续 7 天连不上后台，软件就锁成登录页（见 locked()）。自动更新不看这些。
//
// 规则（设计文档 + 审计）：
// - 只在主进程里跑，只读一份白名单状态，不碰账号的 session、页面、分区目录、轻量号密钥。
// - 同步请求走本机网络，不经过任何账号的代理，不带任何账号的 cookie；不跟随跳转。
// - 后台发来的东西只当数据：显示/隐藏、名称、颜色、备注。没有命令、网址、代理。
// - 只有显式的 403 { revoked: true, device_id: 本机 } 才算停用；401 = 令牌失效，回到没登录；其它任何错误都当离线，照常工作。
// - 收回只认显式的 visible:false；一次要隐藏本机一半以上的团队号时先暂停，等管理员在后台确认。
// - 不采集员工活动（最后操作时间、未读等待时长），只报未读数。
const fs = require('fs');
const path = require('path');
const { canEncrypt } = require('../secure-storage');
const { writeJsonAtomic } = require('../atomic');
const errtext = require('../errtext');
const RADIX = require('../colors/radix');

const PROTOCOL = 1;
const FILE = 'team.json';
const TEAM_SERVER = 'https://wa.laicrm.com';
const POLICIES = ['off', 'optional', 'required'];
const GRACE_MS = 7 * 24 * 3600 * 1000; // 必须登录时，连不上后台最多照常用 7 天
const IDLE_CHECK_MS = 30 * 60 * 1000; // 没登录或已停用时，每 30 分钟问一次后台（策略、是否恢复）
const DEBOUNCE_MS = 10 * 1000;
const EARLY_GAP_MS = 60 * 1000; // 提前同步离上一次同步至少隔 60 秒（免费额度）
const BACKOFF_MIN = [2, 4, 8, 16, 30];
const TIMEOUT_MS = 15 * 1000;
const MAX_EVENTS = 500;
const MAX_BODY = 1024 * 1024;
const UUID_RE = /^[0-9a-f-]{36}$/;
const LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/; // 只给自检用的本机假后台
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const STATES = ['ready', 'loading', 'needs_qr', 'proxy_down', 'needs_proxy', 'error', 'banned', 'stopped'];
const EVENT_KINDS = ['dropped', 'recovered', 'exit_changed', 'proxy_down', 'proxy_up', 'banned'];

// 设置 › 团队里给员工看的上传清单
const UPLOAD_FIELDS = [
  '每个团队号：状态（正常 / 加载中 / 要扫码 / 代理不通 / 出错 / 可能被封）、未读数',
  '每个团队号：代理通不通、延迟、出口 IP 和国家、出口 IP 是否变了',
  '状态变化记录：掉线、恢复、换出口、代理断开或恢复（只有类型、时间和国家代码）',
  '这台电脑：WAswitch 版本、系统类型（Windows / Mac）、内存占用、是否省内存模式',
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


// 连不上后台时给用户看的话。原话（fetch failed、ENOTFOUND 之类）另外放进 detail
function unreachable(e) {
  if (e && e.name === 'AbortError') return '团队后台没有响应（超时）：检查网络，稍后会自动再试';
  const kind = errtext.netKind(errtext.rawOf(e));
  if (kind === 'cert') return '连不上团队后台：安全证书不对，检查网络或代理设置';
  return '连不上团队后台：检查网络，稍后会自动再试';
}
class TeamSync {
  // hooks:
  //   accounts() -> 账号数组（同一份对象，模块直接改 teamId/teamHidden/teamNote 等字段）
  //   save() 写 accounts.json
  //   statusOf(acc) -> { state, unread, proxy_ok, proxy_ms, exit_ip, exit_country, exit_changed }
  //   deviceInfo() -> { mem_mb, low_mem }
  //   park(acc) 停掉并隐藏；unpark(acc) 重新显示并启动
  //   createSeat(seat) -> 新建的本地账号（还没填代理，不会联网）
  //   refresh() 刷新界面（登录状态、策略变了也走这里，主进程顺便看要不要锁）
  // server 只给自检用；软件里固定是 TEAM_SERVER
  constructor({ dir, safeStorage, hooks, appVersion, platform, server = TEAM_SERVER, fetchImpl = (...a) => fetch(...a), now = Date.now, timers = { setTimeout, clearTimeout } }) {
    this.dir = dir;
    this.server = cleanServer(server) || (LOOPBACK_RE.test(String(server)) ? String(server) : TEAM_SERVER);
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
    this.parked = new Map(); // id -> 上次告诉主进程的“停着”状态
    for (const acc of this.hooks.accounts ? this.hooks.accounts() : []) this.parked.set(acc.id, this.isParked(acc));
    // 升级前已暂停的收回可能不会再次下发，启动时先撤销这些号的采集授权。
    let changed = false;
    for (const acc of this.state.held.length ? this.hooks.accounts() : []) {
      if (this.state.held.includes(acc.teamId) && acc.teamCrm) { acc.teamCrm = false; changed = true; }
    }
    if (changed) this.hooks.save();
  }

  // ---------- 本地文件 ----------
  file() { return path.join(this.dir, FILE); }
  load() {
    const empty = { server: this.server, policy: 'off', deviceId: '', token: '', userName: '', cursor: 0, allowPrivate: true, revoked: false, held: [], events: [], lastOkAt: 0, lastError: '', lastUpload: null };
    try {
      const s = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      // 以前填过别的后台地址（旧版的登记表单）：那边的登录和坐席都不认
      if (s.server && (cleanServer(s.server) || s.server) !== this.server) return empty;
      return {
        ...empty,
        policy: POLICIES.includes(s.policy) ? s.policy : 'off',
        userName: typeof s.userName === 'string' ? s.userName.slice(0, 40) : '',
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
    writeJsonAtomic(file, this.state, 2, { mode: 0o600 });
  }
  tokenPlain() {
    if (!canEncrypt(this.safe)) return '';
    if (!this.state.token) return '';
    try { return this.safe.decryptString(Buffer.from(this.state.token, 'base64')); } catch { return ''; }
  }

  // ---------- 给主进程用的判断 ----------
  joined() { return !!this.state.token; }
  enrolled() { return this.joined() && !this.state.revoked; }
  // none 没登录；disabled 被管理员停用（这台电脑或这个人）；ok 已登录
  loginState() { return !this.joined() ? 'none' : this.state.revoked ? 'disabled' : 'ok'; }
  policy() { return this.state.policy; }
  // 已登录，但连续 7 天没和后台同步成功
  staleOffline() { return this.enrolled() && this.now() - (this.state.lastOkAt || 0) > GRACE_MS; }
  // 软件整个锁成登录页：后台要求必须登录，并且没登录、被停用或太久连不上
  locked() { return this.state.policy === 'required' && (this.loginState() !== 'ok' || this.staleOffline()); }
  // 这个号现在应该停着、不显示吗
  isParked(acc) {
    if (this.locked()) return true;
    if (acc.teamId && acc.teamHidden === true) return true; // 收回的号一直停着，不管团队文件在不在
    if (acc.teamId) return !this.enrolled(); // 团队号只在登录着、没被停用时运行
    if (!this.joined()) return false;
    return !this.state.allowPrivate && !this.state.revoked;
  }

  // 设置页“团队”用
  snapshot() {
    const accs = this.hooks.accounts();
    return {
      joined: this.joined(),
      revoked: this.state.revoked,
      login: this.loginState(),
      policy: this.state.policy,
      locked: this.locked(),
      userName: this.state.userName,
      allowPrivate: this.state.allowPrivate,
      lastOkAt: this.state.lastOkAt,
      lastError: this.state.lastError,
      lastErrorDetail: this.state.lastErrorDetail || '',
      offline: this.enrolled() && this.failures > 0,
      held: this.state.held.length,
      teamCount: accs.filter((a) => a.teamId && !a.teamHidden).length,
      privateAccounts: accs.filter((a) => !a.teamId).map((a) => ({ id: a.id, name: a.name, color: a.color, emoji: a.emoji })),
      uploadFields: UPLOAD_FIELDS,
      neverUpload: NEVER_UPLOAD,
      lastUpload: this.state.lastUpload ? JSON.stringify(this.state.lastUpload, null, 2) : '',
      canEncrypt: canEncrypt(this.safe),
    };
  }

  // ---------- 网络 ----------
  post(pathname, body, token) { return this.request('POST', pathname, body, token); }
  async request(method, pathname, body, token) {
    const ctl = new AbortController();
    const t = this.timers.setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetch(`${this.server}${pathname}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  // ---------- 登录 ----------
  setPolicy(p) {
    if (!POLICIES.includes(p) || p === this.state.policy) return false;
    this.state.policy = p;
    return true;
  }
  setUserName(user) {
    const name = user && typeof user.name === 'string' ? user.name.trim().slice(0, 40) : '';
    if (!name || name === this.state.userName) return false;
    this.state.userName = name;
    return true;
  }

  // 问后台现在要不要登录（不带令牌）。连不上就用上次记下的
  async fetchPolicy() {
    let r;
    try { r = await this.request('GET', '/api/device/policy'); } catch { return { offline: true }; }
    if (r.status !== 200 || !r.data || !POLICIES.includes(r.data.login)) return { offline: true };
    if (this.setPolicy(r.data.login)) { this.persist(); this.hooks.refresh(); }
    return { ok: true, policy: this.state.policy };
  }

  // 员工用账号和密码登录。device_id 带上本机上次的设备：同一个人就沿用（坐席不丢），换人就新建
  async login({ login, password } = {}) {
    if (!canEncrypt(this.safe)) return { error: '这台电脑不能加密保存登录信息，没法登录' };
    const name = String(login || '').trim();
    if (!name || !password) return { error: '请填写账号和密码' };
    let r;
    try {
      r = await this.post('/api/device/login', {
        v: PROTOCOL, login: name.slice(0, 64), password: String(password).slice(0, 256),
        device: { name: { win: 'Windows', mac: 'Mac', linux: 'Linux' }[this.platform] || '', app_version: this.appVersion, platform: this.platform },
        ...(this.state.deviceId ? { device_id: this.state.deviceId } : {}),
      });
    } catch (e) {
      return { error: '连不上团队后台', offline: true, detail: errtext.rawOf(e) };
    }
    const d = r.data || {};
    if (r.status === 400) return { error: '账号或密码不对' };
    if (r.status === 403 && d.disabled === true) return { error: '这个账号已停用' };
    // 本机上次的设备被管理员停用了：照样留着 device_id（不换新设备绕过停用），告诉员工找管理员
    if (r.status === 403 && d.revoked === true) return { error: '这台电脑已被管理员停用', disabled: true };
    if (r.status === 429) return { error: '尝试太多次，请 10 分钟后再试' };
    if (r.status === 426) return { error: '这个版本太旧，请更新 WAswitch' };
    if (r.status !== 200 || typeof d.token !== 'string' || !d.token || !UUID_RE.test(d.device_id)) {
      return { error: '连不上团队后台', offline: true, detail: `HTTP ${r.status}` };
    }
    // 换了设备（换人登录、或上次的设备被停用）：本机原来的团队号先全部收起，等后台给新设备分配
    const sameDevice = d.device_id === this.state.deviceId;
    if (!sameDevice) {
      let changed = false;
      for (const a of this.hooks.accounts()) if (a.teamId && !a.teamHidden) { a.teamHidden = true; a.teamCrm = false; changed = true; }
      if (changed) this.hooks.save();
    }
    this.state = {
      ...this.state, deviceId: d.device_id, token: this.safe.encryptString(d.token).toString('base64'),
      cursor: 0, revoked: false, held: [], events: sameDevice ? this.state.events : [], allowPrivate: d.allow_private !== false,
      lastError: '', lastErrorDetail: '', lastOkAt: this.now(), userName: '',
    };
    this.setUserName(d.user);
    this.setPolicy(d.login);
    this.failures = 0;
    this.persist();
    this.applyParking();
    this.hooks.refresh();
    this.schedule(1000);
    return { ok: true };
  }

  // 退出登录：先告诉后台让令牌失效（连不上也照样退出），本机删掉令牌，团队号停着
  async logout() {
    const token = this.tokenPlain();
    this.state = { ...this.state, token: '', revoked: false, userName: '', held: [], lastError: '', lastErrorDetail: '' };
    this.failures = 0;
    this.persist();
    this.applyParking();
    this.hooks.refresh();
    this.schedule(IDLE_CHECK_MS);
    if (token) {
      try { await this.post('/api/device/logout', { v: PROTOCOL }, token); } catch { /* 令牌已经从本机删掉，后台那边过期也就作废了 */ }
    }
    return { ok: true };
  }

  // 把本机的私人号加入团队
  async join(localIds) {
    if (!this.enrolled()) return { error: '还没登录团队' };
    let r;
    try {
      r = await this.post('/api/device/join', { v: PROTOCOL, accounts: this.localList(Array.isArray(localIds) ? localIds : []) }, this.tokenPlain());
    } catch (e) {
      return { error: unreachable(e), detail: errtext.rawOf(e) };
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
  start() {
    this.fetchPolicy();
    this.schedule(this.joined() ? 5000 : IDLE_CHECK_MS);
  }
  stop() { if (this.timer) this.timers.clearTimeout(this.timer); this.timer = null; this.dueAt = 0; }
  schedule(ms) {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.dueAt = this.now() + ms;
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.dueAt = 0; this.syncNow(); }, ms);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  async syncNow() {
    // 没登录：只问一下策略（管理员可能刚改成必须登录），过一会再问
    if (!this.joined()) {
      await this.fetchPolicy();
      this.schedule(IDLE_CHECK_MS);
      return { skipped: true };
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.doSync().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async doSync() {
    const token = this.tokenPlain();
    if (!token) return this.tokenGone('本机保存的登录信息读不出来，请重新登录');
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
      return this.offline(unreachable(e), errtext.rawOf(e));
    }
    // 只有这一种情况才算停用：明确的 403、带 revoked、而且说的是本机
    if (r.status === 403 && r.data && r.data.revoked === true && r.data.device_id === this.state.deviceId) {
      if (!this.state.revoked) {
        this.state.revoked = true;
        // 团队号全部停着（isParked 看 revoked），不标成收回：管理员恢复这台设备后从头拿一遍坐席，
        // 这期间被分走的号会带着 visible:false 回来。换人登录是新设备，login() 里另外收起
      }
      this.state.lastError = '这台电脑已被管理员停用';
      this.state.lastErrorDetail = '';
      this.persist();
      this.applyParking();
      this.hooks.refresh();
      // 过一会再问：管理员恢复以后自动回来
      this.schedule(IDLE_CHECK_MS);
      return { revoked: true };
    }
    // 401：令牌没了（退出过、管理员重置了密码），回到没登录
    if (r.status === 401) return this.tokenGone('登录已失效，请重新登录');
    if (r.status !== 200 || !r.data || r.data.ok !== true || !Array.isArray(r.data.seats)) {
      const why = r.status === 426 ? '这个版本太旧，请更新 WAswitch' : `后台暂时不可用（${r.status}）`;
      return this.offline(why);
    }
    // 成功：已发出的事件从队列里去掉
    this.state.events.splice(0, events.length);
    if (this.state.revoked) { this.state.revoked = false; this.state.cursor = 0; } // 管理员恢复了：从头拿一遍坐席
    this.setPolicy(r.data.login);
    this.setUserName(r.data.user);
    this.failures = 0;
    this.state.lastOkAt = this.now();
    this.state.lastError = '';
    this.state.lastErrorDetail = '';
    this.state.allowPrivate = r.data.allow_private !== false;
    this.applySeats(r.data.seats, r.data.confirm_hides === true);
    if (Number.isSafeInteger(r.data.cursor) && r.data.cursor >= this.state.cursor) this.state.cursor = r.data.cursor;
    this.persist();
    this.applyParking();
    this.hooks.refresh();
    const next = Math.min(900, Math.max(60, Number(r.data.next_sync_s) || 120)) * 1000;
    this.schedule(r.data.more === true ? 1000 : next);
    return { ok: true };
  }

  tokenGone(why) {
    this.state = { ...this.state, token: '', revoked: false, userName: '', held: [], lastError: why, lastErrorDetail: '' };
    this.failures = 0;
    this.persist();
    this.applyParking();
    this.hooks.refresh();
    this.schedule(IDLE_CHECK_MS);
    return { loggedOut: true, error: why };
  }

  offline(why, detail = '') {
    this.failures += 1;
    this.state.lastError = why;
    this.state.lastErrorDetail = detail;
    this.persist();
    this.schedule(BACKOFF_MIN[Math.min(this.failures - 1, BACKOFF_MIN.length - 1)] * 60 * 1000);
    this.hooks.refresh();
    return { offline: true, error: why, ...(detail ? { detail } : {}) };
  }

  // 每个号该不该停着（isParked）变了就告诉主进程：后台不允许私人号、停用、退出登录、令牌失效、恢复。
  // 只在变化时调用，同一个号不会反复停、反复启动
  setParked(acc, on) {
    this.parked.set(acc.id, on);
    if (on) this.hooks.park(acc); else this.hooks.unpark(acc);
  }
  applyParking() {
    for (const a of this.hooks.accounts()) {
      const on = this.isParked(a);
      if (this.parked.has(a.id) && this.parked.get(a.id) === on) continue;
      if (!this.parked.has(a.id) && !on) { this.parked.set(a.id, on); continue; } // 第一次见、在运行：主进程已经按 isParked 启动过
      this.setParked(a, on);
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
        if (s.visible === false && acc) {
          // 暂停批量隐藏不等于继续授权采集；收回一到达就撤销 CRM。
          if (acc.teamCrm) { acc.teamCrm = false; changed = true; }
          if (!acc.teamHidden) hides.push(acc);
        }
        continue;
      }
      this.state.held = this.state.held.filter((id) => id !== s.team_id);
      const fields = {
        name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 40) : null,
        color: RADIX.accountColor(s.color) || null, // 后台存的旧颜色换成新的
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
        if (acc.teamHidden) { acc.teamHidden = false; this.setParked(acc, false); }
      } else {
        this.hooks.createSeat({ teamId: s.team_id, name: fields.name || '团队账号', color: fields.color, mode: s.mode === 'lite' ? 'lite' : 'web', note: fields.note, expected: fields.expected, crm: fields.crm });
      }
      changed = true;
    }
    // 收回：一次要隐藏本机一半以上的团队号，先暂停，等管理员确认
    const visibleTeam = accs.filter((a) => a.teamId && !a.teamHidden).length;
    const heldIds = new Set(this.state.held);
    for (const a of hides) heldIds.add(a.teamId);
    // 兼容升级前已暂停的收回：cursor 已推进，下次可能不再重复下发隐藏记录。
    for (const a of accs) if (heldIds.has(a.teamId) && a.teamCrm) { a.teamCrm = false; changed = true; }
    const pending = accs.filter((a) => a.teamId && !a.teamHidden && heldIds.has(a.teamId));
    if (pending.length && (confirmHides || visibleTeam < 2 || pending.length * 2 <= visibleTeam)) {
      for (const a of pending) { a.teamHidden = true; this.setParked(a, true); }
      this.state.held = [];
      changed = true;
    } else {
      this.state.held = pending.map((a) => a.teamId);
    }
    if (changed) this.hooks.save();
  }
}

module.exports = { TeamSync, cleanServer, UPLOAD_FIELDS, NEVER_UPLOAD, PROTOCOL, TEAM_SERVER, GRACE_MS };

