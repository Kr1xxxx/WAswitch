// 团队模式：员工用来财的公司邮箱收验证码登录（来财 laicrm.com 的 /api/device/*），定时同步坐席并上报账号状态。
// 登录后本机每个号都自动加入团队（没有私人号）。来财按“登录”策略（off / optional / required）决定要不要登录才能用；
// 必须登录时没登录、被停用、连续 7 天连不上来财，软件就锁成登录页（见 locked()）。自动更新不看这些。
//
// 规则（设计文档 + 审计）：
// - 只在主进程里跑，只读一份白名单状态，不碰账号的 session、页面、分区目录、轻量号密钥。
// - 同步请求走本机网络，不经过任何账号的代理，不带任何账号的 cookie；不跟随跳转。
// - 后台发来的东西只当数据：显示/隐藏、名称、颜色、备注。没有命令、网址、代理。
// - 只有显式的 403 { revoked: true, device_id: 本机 } 才算停用；401 = 令牌失效（退出过、管理员按了“重新登录”），
//   回到登录页，设备、团队号和本机队列都留着；其它任何错误都当离线，照常工作。
// - 连不上来财、没问到策略时按“必须登录”算（不让号在没登录时照常运行）。
// - 每个邮箱在这台电脑上用过的设备记在 devices 里：A→B→A 换人再换回来，A 拿回自己的设备和坐席。
// - 换了设备（换人登录）：本机原来的团队号清掉 teamId，在新设备上重新自动加入（teamRejoin），
//   来财知道这个号自己的号码之前不上传聊天（来财靠号码在电脑之间去重，不然 30 天的聊天会存两份）。
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
const TEAM_SERVER = 'https://laicrm.com';
const POLICIES = ['off', 'optional', 'required'];
const GRACE_MS = 7 * 24 * 3600 * 1000; // 必须登录时，连不上后台最多照常用 7 天
const IDLE_CHECK_MS = 30 * 60 * 1000; // 没登录或已停用时，每 30 分钟问一次后台（策略、是否恢复）
const DEBOUNCE_MS = 10 * 1000;
const EARLY_GAP_MS = 60 * 1000; // 提前同步离上一次同步至少隔 60 秒（免费额度）
const BACKOFF_MIN = [2, 4, 8, 16, 30];
const TIMEOUT_MS = 15 * 1000;
const MAX_EVENTS = 500;
const MAX_REMOVED = 500; // 本机删过的号（团队编号和本机编号）
const MAX_BODY = 1024 * 1024;
const UUID_RE = /^[0-9a-f-]{36}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/; // 只给自检用的本机假后台
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const STATES = ['ready', 'loading', 'needs_qr', 'proxy_down', 'needs_proxy', 'error', 'banned', 'stopped'];
const EVENT_KINDS = ['dropped', 'recovered', 'exit_changed', 'proxy_down', 'proxy_up', 'banned'];
const MAX_JOIN = 50; // 来财一次最多收 50 个号
const MAX_DEVICES = 20; // devices 表（邮箱 → 设备）最多记这么多人
const DEFAULT_POLICY = 'required'; // 没问到策略时按必须登录
const JOIN_RETRY_MIN_MS = 5 * 1000; // 加入后有号没拿到团队号：5 秒后再试，之后翻倍
const JOIN_RETRY_MAX_MS = 5 * 60 * 1000;

// 这个号自己的号码，给来财的格式：'+数字'；读不到或不像号码就是 ''
function phoneOf(acc) {
  const d = String((acc && acc.phone) || '').replace(/\D/g, '');
  return /^[1-9]\d{5,14}$/.test(d) ? `+${d}` : '';
}

// 设置 › 团队里给员工看的上传清单
const UPLOAD_FIELDS = [
  '每个团队号：状态（正常 / 加载中 / 要扫码 / 代理不通 / 出错 / 可能被封）、未读数',
  '每个团队号：代理通不通、延迟、出口 IP 和国家、出口 IP 是否变了',
  '状态变化记录：掉线、恢复、换出口、代理断开或恢复（只有类型、时间和国家代码）',
  '这台电脑：WAswitch 版本、系统类型（Windows / Mac）、内存占用、是否省内存模式',
  '每个团队号自己的号码',
  '团队号单聊里的消息（对方号码、时间、收发、文字、对方的 WhatsApp 名字）',
];
const NEVER_UPLOAD = [
  '群聊、通讯录',
  '代理设置（地址、端口、用户名、密码）',
  '你的屏幕、你操作电脑的时间',
  '二维码、登录数据、轻量号密钥',
  '电脑名、系统用户名、文件路径',
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
    this.foreign = false;
    this.state = this.load();
    // 以前登录的是别的后台（旧版连的 wa.laicrm.com）：那边给的团队号在来财不认，当作还没加入的号，登录后重新自动加入。
    // 本机队列留着，等重新加入、来财同意同步后接着传（teamKeepQueue）。已经被收回（隐藏）的号不动
    if (this.foreign) {
      let reset = false;
      for (const acc of this.hooks.accounts ? this.hooks.accounts() : []) {
        if (!acc.teamId || acc.teamHidden) continue;
        TeamSync.resetForRejoin(acc, true);
        reset = true;
      }
      if (reset) this.hooks.save();
    }
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
    const empty = { server: this.server, policy: DEFAULT_POLICY, deviceId: '', token: '', userName: '', email: '', devices: {}, joinSent: [], removed: [], cursor: 0, allowPrivate: true, revoked: false, held: [], events: [], lastOkAt: 0, lastError: '', lastUpload: null };
    try {
      const s = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      // 以前填过别的后台地址（旧版的登记表单）：那边的登录和坐席都不认
      if (s.server && (cleanServer(s.server) || s.server) !== this.server) { this.foreign = true; return empty; }
      const deviceId = UUID_RE.test(s.deviceId) ? s.deviceId : '';
      const email = TeamSync.cleanEmail(s.email);
      const devices = {};
      if (s.devices && typeof s.devices === 'object') {
        for (const [k, v] of Object.entries(s.devices)) if (TeamSync.cleanEmail(k) === k && UUID_RE.test(v)) devices[k] = v;
      }
      // 旧版文件没有 devices：上次登录的人和设备先记进去
      if (email && deviceId && !devices[email]) devices[email] = deviceId;
      return {
        ...empty,
        policy: POLICIES.includes(s.policy) ? s.policy : DEFAULT_POLICY,
        userName: typeof s.userName === 'string' ? s.userName.slice(0, 40) : '',
        email, // 上次登录用的邮箱（不是密钥）：登录页预先填好；换人登录时拿来比
        deviceId, // 本机团队号现在挂在哪个设备上
        devices,
        joinSent: Array.isArray(s.joinSent) ? s.joinSent.filter((x) => typeof x === 'string' && /^\d+$/.test(x)).slice(0, 200) : [],
        removed: Array.isArray(s.removed) ? s.removed.filter((x) => typeof x === 'string' && (UUID_RE.test(x) || /^\d+$/.test(x))).slice(-MAX_REMOVED) : [],
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
    // 还没加入团队的号（刚添加的、连不上来财时添加的）照常运行：登录着时马上自动加入（autoJoin），不让新号消失
    return false;
  }

  // 团队号要在新设备（或新后台）上重新加入：清掉 teamId 和收回、同步标记，等 autoJoin。
  // keepQueue = 本机还没传的聊天留着（同一个人换了设备、升级换后台）；换人登录时不留。
  // 留着队列时要再补传一次（teamRebackfill）：轻量号只采实时消息，重新加入之前这段时间来的消息只能靠补传（来财去重）
  static resetForRejoin(acc, keepQueue) {
    Object.assign(acc, { teamId: '', teamHidden: false, teamNeedsProxy: false, teamNote: '', teamCrm: false, teamExpected: '', teamRejoin: true });
    if (keepQueue) Object.assign(acc, { teamKeepQueue: true, teamRebackfill: true });
    else { delete acc.teamKeepQueue; delete acc.teamRebackfill; }
  }
  // 重新加入的号：来财知道它自己的号码以后才上传聊天（main.js crmOn 看 teamRejoin）
  static rejoinDone(acc) {
    if (!acc.teamRejoin) return false;
    delete acc.teamRejoin;
    return true;
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
      email: this.state.email,
      lastOkAt: this.state.lastOkAt,
      lastError: this.state.lastError,
      lastErrorDetail: this.state.lastErrorDetail || '',
      offline: this.enrolled() && this.failures > 0,
      held: this.state.held.length,
      teamCount: accs.filter((a) => a.teamId && !a.teamHidden).length,
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
      .map((a) => ({ local_id: a.id, name: a.name, color: COLOR_RE.test(a.color) ? a.color : '', mode: a.mode === 'lite' ? 'lite' : 'web', phone: phoneOf(a) }));
  }

  // sentPhones：这次 /join 带上了号码的本机号（来财已经知道它的号码）
  mapTeamIds(list, sentPhones = new Set()) {
    const accs = this.hooks.accounts();
    for (const m of Array.isArray(list) ? list : []) {
      const acc = accs.find((a) => a.id === m.local_id);
      if (acc && UUID_RE.test(m.team_id) && !acc.teamId) {
        acc.teamId = m.team_id;
        acc.teamHidden = false;
        if (sentPhones.has(acc.id)) TeamSync.rejoinDone(acc);
      }
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

  // 员工用工作邮箱登录：先要验证码（后台发到邮箱），再填码登录
  static cleanEmail(raw) {
    const e = String(raw || '').trim().toLowerCase();
    return e.length <= 254 && EMAIL_RE.test(e) ? e : '';
  }
  // 429 带 retry_after_s 时告诉员工等几秒
  static tooMany(d) {
    const n = Number.isInteger(d && d.retry_after_s) && d.retry_after_s > 0 ? Math.min(d.retry_after_s, 3600) : 60;
    return { error: `太频繁了，请 ${n} 秒后再试`, retryAfterS: n };
  }

  async requestCode({ email } = {}) {
    if (!canEncrypt(this.safe)) return { error: '这台电脑不能加密保存登录信息，没法登录' };
    const addr = TeamSync.cleanEmail(email);
    if (!addr) return { error: '邮箱格式不对' };
    let r;
    try { r = await this.post('/api/device/code', { v: PROTOCOL, email: addr }); } catch (e) {
      return { error: '连不上团队后台', offline: true, detail: errtext.rawOf(e) };
    }
    const d = r.data || {};
    if (r.status === 200 && d.ok === true) {
      const n = Number.isInteger(d.resend_after_s) && d.resend_after_s > 0 ? Math.min(d.resend_after_s, 600) : 60;
      return { ok: true, resendAfterS: n };
    }
    // 来财对任何格式正确的邮箱都回 200（不透露这个邮箱是不是成员），所以没有“没加入团队”“已停用”这两种回答
    if (r.status === 429) return TeamSync.tooMany(d);
    if (r.status === 503) return { error: '验证码发不出去，请稍后再试' };
    if (r.status === 400) return { error: '邮箱格式不对' };
    if (r.status === 426) return { error: '这个版本太旧，请更新 WAswitch' };
    return { error: '连不上团队后台', offline: true, detail: `HTTP ${r.status}` };
  }

  // device_id 带上本机上次的设备：同一个人就沿用（坐席不丢），换人就新建
  async login({ email, code } = {}) {
    if (!canEncrypt(this.safe)) return { error: '这台电脑不能加密保存登录信息，没法登录' };
    const addr = TeamSync.cleanEmail(email);
    if (!addr) return { error: '邮箱格式不对' };
    const pin = String(code || '').trim();
    if (!/^\d{6}$/.test(pin)) return { error: '验证码不对或已过期', badCode: true };
    // 这个人在这台电脑上用过的设备；旧文件什么都没记时带上次的设备（来财只在设备和人都对上时沿用）
    const known = this.state.devices || {};
    const want = known[addr] || (!Object.keys(known).length ? this.state.deviceId : '');
    let r;
    try {
      r = await this.post('/api/device/login', {
        v: PROTOCOL, email: addr, code: pin,
        device: { name: { win: 'Windows', mac: 'Mac', linux: 'Linux' }[this.platform] || '', app_version: this.appVersion, platform: this.platform },
        ...(want ? { device_id: want } : {}),
      });
    } catch (e) {
      return { error: '连不上团队后台', offline: true, detail: errtext.rawOf(e) };
    }
    const d = r.data || {};
    if (r.status === 400) return { error: '验证码不对或已过期', badCode: true };
    if (r.status === 403 && (d.disabled === true || d.error === 'disabled')) return { error: '这个账号已停用' };
    // 本机上次的设备被管理员停用了：照样留着 device_id（不换新设备绕过停用），告诉员工找管理员
    if (r.status === 403 && d.revoked === true) return { error: '这台电脑已被管理员停用', disabled: true };
    if (r.status === 429) return TeamSync.tooMany(d);
    if (r.status === 426) return { error: '这个版本太旧，请更新 WAswitch' };
    if (r.status !== 200 || typeof d.token !== 'string' || !d.token || !UUID_RE.test(d.device_id)) {
      return { error: '连不上团队后台', offline: true, detail: `HTTP ${r.status}` };
    }
    // 换了设备（换人登录、A→B→A 换回来）：本机原来的团队号清掉 teamId，在新设备上重新自动加入（不收起，免得号再也回不来）。
    // 来财按 (设备, 本机编号) 去重：换回 A 的设备时拿回 A 原来的团队号。
    // 同一个人：本机队列留着，加入后接着传；换了人：队列删掉（crmReconcile 看 keepQueue），坏了的旧队列文件也删
    const sameDevice = d.device_id === this.state.deviceId;
    const otherPerson = !!this.state.email && this.state.email !== addr;
    if (!sameDevice) {
      let changed = false;
      for (const a of this.hooks.accounts()) {
        if ((a.teamId && !a.teamHidden) || a.teamRejoin) { TeamSync.resetForRejoin(a, !otherPerson && (!!a.teamId || !!a.teamKeepQueue)); changed = true; }
      }
      if (changed) this.hooks.save();
    }
    if (otherPerson && this.hooks.personChanged) this.hooks.personChanged();
    const devices = { ...(this.state.devices || {}) };
    delete devices[addr];
    devices[addr] = d.device_id;
    const names = Object.keys(devices);
    for (const k of names.slice(0, Math.max(0, names.length - MAX_DEVICES))) delete devices[k];
    this.state = {
      ...this.state, deviceId: d.device_id, token: this.safe.encryptString(d.token).toString('base64'), devices,
      cursor: 0, revoked: false, held: [], events: sameDevice ? this.state.events : [], allowPrivate: d.allow_private !== false,
      joinSent: sameDevice ? this.state.joinSent : [],
      removed: this.state.removed, // 换人也不清：编号不会撞，同一台电脑换回原来的人时删掉的号也不能回来
      lastError: '', lastErrorDetail: '', lastOkAt: this.now(), userName: '', email: addr,
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

  // 把本机还不是团队号的号加入团队（带上它自己的号码）。来财按 (设备, local_id) 去重，重复加入没关系
  async join(localIds) {
    if (!this.enrolled()) return { error: '还没登录团队' };
    const list = this.localList(Array.isArray(localIds) ? localIds.slice(0, MAX_JOIN) : []);
    if (!list.length) return { ok: true };
    // 先记下这些号现在停没停（主进程按这个启动过），加入后 applyParking 才知道要不要启动或停下
    for (const id of list.map((a) => a.local_id)) {
      const acc = this.hooks.accounts().find((a) => a.id === id);
      if (acc && !this.parked.has(id)) this.parked.set(id, this.isParked(acc));
    }
    // 来财可能已经加入了、只是回答丢了（超时、断线、5xx）：记下这些号，同步时先重新加入再认坐席（见 doSync），不新建重复的号
    const ids = list.map((a) => a.local_id);
    const unanswered = () => {
      this.state.joinSent = [...new Set([...(this.state.joinSent || []), ...ids])].slice(-200);
      this.persist();
    };
    let r;
    try {
      r = await this.post('/api/device/join', { v: PROTOCOL, accounts: list }, this.tokenPlain());
    } catch (e) {
      unanswered();
      return { error: unreachable(e), detail: errtext.rawOf(e) };
    }
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.accounts)) {
      if (r.status >= 500 || r.status === 200) unanswered();
      return { error: `加入团队没成功（${r.status}）`, detail: r.data && typeof r.data.error === 'string' ? r.data.error.slice(0, 80) : '' };
    }
    this.mapTeamIds(r.data.accounts, new Set(list.filter((a) => a.phone).map((a) => a.local_id)));
    const done = new Set(r.data.accounts.map((m) => m && m.local_id));
    this.state.joinSent = (this.state.joinSent || []).filter((id) => !done.has(id));
    this.persist();
    this.applyParking();
    this.hooks.refresh();
    // 来财的回答里少了号（编号不合格被丢掉）：这些号还会再试，间隔翻倍（最多 5 分钟），免得每秒一次 /join + /sync
    const missing = ids.some((id) => !done.has(id));
    this.joinDelay = missing ? Math.min((this.joinDelay || JOIN_RETRY_MIN_MS / 2) * 2, JOIN_RETRY_MAX_MS) : 0;
    this.schedule(missing ? this.joinDelay : 1000);
    return { ok: true };
  }

  // 还不是团队号的本机号（被收回、隐藏的团队号不算）
  pendingJoin() { return this.hooks.accounts().filter((a) => !a.teamId).map((a) => a.id); }

  // 自动加入：登录后第一次同步、每次同步成功、新加了号时调用。同时只跑一次；失败了等下次同步再试
  autoJoin() {
    if (!this.enrolled() || this.joining) return this.joining || Promise.resolve(null);
    const ids = this.pendingJoin();
    if (!ids.length) return Promise.resolve(null);
    this.joining = this.join(ids).catch(() => null).finally(() => { this.joining = null; });
    return this.joining;
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
        phone: phoneOf(a),
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
    // 新加了号（或有号还没加入）：马上自动加入，不等下一次同步。同一批号只试一次，失败了交给下一次同步
    const pending = this.pendingJoin().join(',');
    if (pending !== this.lastJoinSig) {
      this.lastJoinSig = pending;
      if (pending && this.failures === 0) this.autoJoin();
    }
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
    // 401：令牌没了（退出过、管理员按了“重新登录”），回到登录页；设备、团队号、本机队列都留着，同一个人再登录接着用
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
    // 这次上报带上了号码的团队号：来财已经知道它的号码，重新加入的号可以开始上传聊天
    let rejoined = false;
    for (const s of body.status) {
      if (!s.phone) continue;
      const acc = this.hooks.accounts().find((a) => a.teamId === s.team_id);
      if (acc && TeamSync.rejoinDone(acc)) rejoined = true;
    }
    if (rejoined) this.hooks.save();
    // 后台给了本机还对不上的坐席，而本机还有没加入的号：先加入（来财按本机编号去重，回答里就是这些坐席），再认坐席，
    // 免得把自己的号当成新分来的号再建一个。上次加入的回答丢了、这次还是没加入成：先不认这些坐席，下次同步再来
    let defer = false;
    if (this.unknownSeats(r.data.seats).length && this.pendingJoin().length) {
      await (this.joining || this.autoJoin());
      defer = this.unknownSeats(r.data.seats).length > 0 && this.unanswered().length > 0;
    }
    this.applySeats(r.data.seats, r.data.confirm_hides === true, { skipUnknown: defer });
    if (!defer && Number.isSafeInteger(r.data.cursor) && r.data.cursor >= this.state.cursor) this.state.cursor = r.data.cursor;
    this.persist();
    this.applyParking();
    this.hooks.refresh();
    const next = Math.min(900, Math.max(60, Number(r.data.next_sync_s) || 120)) * 1000;
    this.schedule(r.data.more === true && !defer ? 1000 : next);
    // 本机还有没加入团队的号：自动加入（登录后第一次同步、启动后第一次同步都会走到这里）
    if (r.data.more !== true && this.pendingJoin().length) await this.autoJoin();
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

  // 每个号该不该停着（isParked）变了就告诉主进程：收回、停用、退出登录、令牌失效、恢复。
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

  // 本机还对不上的可见坐席（按 team_id 和 local_id 都找不到本机的号）
  unknownSeats(seats) {
    const accs = this.hooks.accounts();
    return (Array.isArray(seats) ? seats : []).filter((s) => s && s.visible === true && UUID_RE.test(s.team_id) && !this.seatAccount(accs, s) && !this.isRemoved(s));
  }
  // 坐席对应的本机号：先按 team_id；后台带了 local_id 时按本机编号认还没加入的号
  seatAccount(accs, s) {
    return accs.find((a) => a.teamId === s.team_id)
      || (typeof s.local_id === 'string' && s.local_id ? accs.find((a) => a.id === s.local_id && !a.teamId) : undefined);
  }
  isRemoved(s) {
    const removed = this.state.removed || [];
    return removed.includes(s.team_id) || (typeof s.local_id === 'string' && !!s.local_id && removed.includes(s.local_id));
  }
  // 发过 /join 但没收到回答、现在还没加入的号
  unanswered() {
    const accs = this.hooks.accounts();
    return (this.state.joinSent || []).filter((id) => accs.some((a) => a.id === id && !a.teamId));
  }

  // 用户在本机删了号：来财没有删除接口，坐席还在，记下来，同步时不再把它建回来
  forget(acc) {
    if (!acc) return;
    const ids = [acc.teamId, acc.id].filter((x) => typeof x === 'string' && x);
    if (!ids.length) return;
    this.state.removed = [...(this.state.removed || []).filter((x) => !ids.includes(x)), ...ids].slice(-MAX_REMOVED);
    this.state.joinSent = (this.state.joinSent || []).filter((x) => x !== acc.id);
    // 写不进去（磁盘满、文件被占用）也不能让删号停在半路：内存里已经记下，下次同步时会再写
    try { this.persist(); } catch (e) { console.warn(`记下删掉的团队号时写不进 team.json：${e.code || e.message}`); }
  }

  applySeats(seats, confirmHides, { skipUnknown = false } = {}) {
    const accs = this.hooks.accounts();
    const hides = [];
    let changed = false;
    for (const s of seats) {
      if (!s || !UUID_RE.test(s.team_id)) continue;
      const acc = this.seatAccount(accs, s);
      if (acc && !acc.teamId) { acc.teamId = s.team_id; acc.teamHidden = false; }
      if (s.visible !== true) {
        if (s.visible === false && acc) {
          // 暂停批量隐藏不等于继续授权采集；收回一到达就撤销 CRM。
          if (acc.teamCrm) { acc.teamCrm = false; changed = true; }
          if (acc.teamKeepQueue) { delete acc.teamKeepQueue; changed = true; }
          if (!acc.teamHidden) hides.push(acc);
        }
        continue;
      }
      if (!acc && skipUnknown) continue;
      if (!acc && this.isRemoved(s)) continue;
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
        delete acc.teamKeepQueue; // 重新加入后来财的回答到了：队列按 keepQueue 的正常规则
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

module.exports = { TeamSync, cleanServer, phoneOf, UPLOAD_FIELDS, NEVER_UPLOAD, PROTOCOL, TEAM_SERVER, GRACE_MS };

