// 「待回复」：所有号里客户说了话、我们超过 30 分钟还没回的对话（shen 2026-11-18 选的第 2 项）。
//
// 网页号：每分钟在隔离环境里只读一次左侧对话列表（wa-page.js 的 readChatList，reply 选项），
//   看每个对话最后一条前面有没有发送状态的勾（有就是我们发的）和列表上的时间。不点击、不滚动、不注入。
//   列表只画出最上面十几个对话，所以记下来的对话要存住：看到它最后一条变成我们发的才去掉（回复后对话会排到最上面，一定看得到）。
//   只看到一次「客户发的」不算，要连着两次（对方正在输入时预览会暂时换成「正在输入…」，没有勾）。
//   列表画出来的对话已经往前排到比某个记下的对话还早，它却不在里面（存成联系人改了名字、归档、删了、换了号）：去掉。
//   只列私聊。群：默认群头像，或者预览前面有「发送人: 」（头像是照片的群只能这样认）。搜索或筛选时读到的不用。
//   以前只列查得到号码的，真号上存了名字的客户多半查不到，一个都列不出来（1.0.17）；现在查不到号码也列，点开时再查。
//   勾一个都认不出时（WhatsApp 改了图标名）只信未读角标：有未读的列，没未读的去掉。
// 轻量号：本机聊天缓存是全的（lite/session.mjs 的 chatList），每次整份替换。
//
// 点了圆圈（办完了）的对话，客户再发一条（今天的时间比记下的晚，或者未读变多）又会出现。
// 存在本机 unreplied.json（只有号、对话名字、号码、时间，没有消息内容）。这是能重新读出来的数据，文件坏了就从空的开始。
const THRESHOLD_MS = 30 * 60 * 1000; // 等了这么久才列出来（shen 2026-11-18 从 2 小时改成 30 分钟）
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 超过 7 天没回的不再列（多半是不用回的）
const MAX_PER_ACC = 300;
const MIN_HITS = 2;
const MIN = 60000;
// 一次读到这么多个已读的私聊、却一个勾都没有：多半是 WhatsApp 改了图标，这次只信未读角标（不然所有对话都会被当成没回）。
// 有未读的不算（早上一堆客户的未读本来就没有勾）
const NO_TICK_ROWS = 6;
const cleanKey = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 100);

class Unreplied {
  constructor({ now = Date.now, load = () => null, save = () => {} } = {}) {
    this.now = now;
    this.save = save;
    this.byAcc = new Map(); // 账号 id -> Map(对话 key -> { name, since, hits, sig, unread, dismissed, digits?, jid? })
    const data = load();
    if (data && typeof data === 'object' && data.v === 1 && data.accounts && typeof data.accounts === 'object') {
      for (const [id, chats] of Object.entries(data.accounts)) {
        if (!chats || typeof chats !== 'object') continue;
        const m = new Map();
        for (const [key, e] of Object.entries(chats)) {
          if (!e || typeof e !== 'object' || !Number.isFinite(e.since) || typeof e.name !== 'string') continue;
          m.set(key, {
            name: e.name.slice(0, 100), since: e.since, hits: Number(e.hits) || 0, sig: String(e.sig || ''), unread: Number(e.unread) || 0, dismissed: e.dismissed === true,
            ...(typeof e.digits === 'string' && /^\d{7,15}$/.test(e.digits) ? { digits: e.digits } : {}),
            ...(typeof e.jid === 'string' ? { jid: e.jid } : {}),
          });
        }
        if (m.size) this.byAcc.set(String(id), m);
      }
    }
  }

  toJSON() {
    const accounts = {};
    for (const [id, m] of this.byAcc) accounts[id] = Object.fromEntries(m);
    return { v: 1, accounts };
  }

  changed() { this.save(this.toJSON()); }

  acc(id) {
    let m = this.byAcc.get(id);
    if (!m) { m = new Map(); this.byAcc.set(id, m); }
    return m;
  }

  // 网页号读到的对话列表（readChatList 的 chats，带 out、age、sender）。filtered：搜索或筛选时读到的；
  // atTop：列表在最上面（用户往下翻过时画出来的只是更早的对话，不能拿来判断谁不在列表上了）。
  // 返回这次读到的计数（只有数字，main.js 写日志用）；ok 为假表示这次读到的没用
  ingestWeb(id, chats, { filtered = false, atTop = false } = {}) {
    const st = { ok: false, rows: Array.isArray(chats) ? chats.length : 0, groups: 0, solo: 0, out: 0, unread: 0, aged: 0, noTick: false };
    if (!Array.isArray(chats) || filtered) return st;
    const isGroup = (c) => c.is_group === true || c.sender === true;
    const solo = chats.filter((c) => c && c.name && !isGroup(c));
    const read = solo.filter((c) => !(c.unread > 0));
    st.ok = true;
    st.groups = chats.length - solo.length;
    st.solo = solo.length;
    st.out = solo.filter((c) => c.out === true).length;
    st.unread = solo.length - read.length;
    st.aged = solo.filter((c) => Number.isFinite(c.age)).length;
    st.noTick = read.length >= NO_TICK_ROWS && st.out === 0;
    const m = this.acc(String(id));
    const now = this.now();
    let dirty = false;
    const seen = new Set();
    // 认出是群的：以前当成私聊记下的去掉
    for (const c of chats) {
      if (!c || !c.name || !isGroup(c)) continue;
      const key = cleanKey(c.name);
      if (m.has(key) && !m.get(key).jid) { m.delete(key); dirty = true; }
    }
    for (const c of solo) {
      const key = cleanKey(c.name);
      if (!key) continue;
      seen.add(key);
      const e = m.get(key);
      const unread = Number(c.unread) || 0;
      const incoming = unread > 0 || (!st.noTick && c.out === false);
      if (!incoming || c.muted) { if (e) { m.delete(key); dirty = true; } continue; }
      if (!Number.isFinite(c.age)) continue; // 认不出时间（更早的日期）：不新加，已有的照旧
      const since = Math.floor((now - c.age * MIN) / MIN) * MIN; // 取整到分钟，不然每分钟都要写盘
      const sig = String(c.time || '');
      if (!e) {
        const digits = digitsOfTitle(key);
        m.set(key, { name: key, since, hits: 1, sig, unread, dismissed: false, ...(digits ? { digits } : {}) });
        dirty = true;
        continue;
      }
      // 今天的钟点是准的（客户又发了一条就用新的时间）；昨天、星期几只是下限，留着以前读到的更准的那个
      const exact = /\d[:.]\d\d/.test(sig);
      const next = { ...e, since: exact ? since : Math.min(e.since, since), hits: Math.min(e.hits + 1, MIN_HITS), sig, unread };
      // 客户又发了一条才不再忽略：今天的时间比记下的晚，或者未读变多。过了半夜「21:40」变成「昨天」不算
      if (e.dismissed && ((exact && since > e.since + MIN) || unread > (e.unread || 0))) next.dismissed = false;
      if (JSON.stringify(next) !== JSON.stringify(e)) { m.set(key, next); dirty = true; }
    }
    // 画出来的（不置顶的）对话往前排到了多久以前：记下的对话比这还新却不在里面，说明已经不在列表上了
    let reach = 0;
    for (const c of atTop ? chats : []) {
      if (!c || c.pinned || !c.time) continue;
      reach = Number.isFinite(c.age) ? Math.max(reach, c.age * MIN) : Infinity;
    }
    for (const [key, e] of m) {
      if (seen.has(key) || e.jid) continue;
      if (now - e.since + 2 * MIN < reach) { m.delete(key); dirty = true; }
    }
    if (this.trim(m)) dirty = true;
    if (dirty) this.changed();
    return st;
  }

  // 轻量号：后台进程的全部对话 [{ jid, name, group, me, wait, ts }]（wait = 我们最后一条之后客户第一条的时间，秒）
  ingestLite(id, chats) {
    if (!Array.isArray(chats)) return;
    const old = this.byAcc.get(String(id)) || new Map();
    const m = new Map();
    for (const c of chats) {
      if (!c || typeof c.jid !== 'string' || c.group || c.me !== false || !(c.wait > 0)) continue;
      const sig = String(c.ts || '');
      const prev = old.get(c.jid);
      m.set(c.jid, { name: String(c.name || '').slice(0, 100), since: c.wait * 1000, hits: MIN_HITS, sig, dismissed: !!(prev && prev.dismissed && prev.sig === sig), jid: c.jid });
    }
    this.trim(m);
    if (JSON.stringify(Object.fromEntries(m)) === JSON.stringify(Object.fromEntries(old))) return;
    if (m.size) this.byAcc.set(String(id), m); else this.byAcc.delete(String(id));
    this.changed();
  }

  // 去掉太久的；每个号最多留 MAX_PER_ACC 个（先丢最久的）
  trim(m) {
    const now = this.now();
    let dirty = false;
    for (const [k, e] of m) if (now - e.since > MAX_AGE_MS) { m.delete(k); dirty = true; }
    if (m.size > MAX_PER_ACC) {
      const keys = [...m.entries()].sort((a, b) => a[1].since - b[1].since).slice(0, m.size - MAX_PER_ACC).map(([k]) => k);
      for (const k of keys) m.delete(k);
      dirty = true;
    }
    return dirty;
  }

  // 列出来的：等了 30 分钟以上、没点办完的，等得最久的在前
  list(ids = null) {
    const now = this.now();
    const out = [];
    for (const [id, m] of this.byAcc) {
      if (ids && !ids.has(id)) continue;
      for (const [key, e] of m) {
        if (e.dismissed || e.hits < MIN_HITS) continue;
        const wait = now - e.since;
        if (wait < THRESHOLD_MS || wait > MAX_AGE_MS) continue;
        out.push({ accountId: id, key, name: e.name, since: e.since });
      }
    }
    return out.sort((a, b) => a.since - b.since);
  }

  get(id, key) { return this.byAcc.get(String(id))?.get(String(key)) || null; }

  // 点了圆圈（办完了）：返回原来的那条，撤销时放回
  dismiss(id, key) {
    const e = this.get(id, key);
    if (!e || e.dismissed) return null;
    this.acc(String(id)).set(String(key), { ...e, dismissed: true });
    this.changed();
    return e;
  }

  undismiss(id, key) {
    const e = this.get(id, key);
    if (!e || !e.dismissed) return false;
    this.acc(String(id)).set(String(key), { ...e, dismissed: false });
    this.changed();
    return true;
  }

  // 删掉了这个号（或者退出登录、换了号）
  drop(id) {
    if (this.byAcc.delete(String(id))) this.changed();
  }
}

// 号码样子的对话名字（没存联系人的号，如 "+33 6 12 34 56 78"）→ 只有数字；不是号码返回 ''
function digitsOfTitle(name) {
  const t = String(name || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (!/^\+?[\d\s().-]{7,24}$/.test(t)) return '';
  const d = t.replace(/\D/g, '');
  return /^\d{7,15}$/.test(d) ? d : '';
}
const normTitle = (t) => String(t || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// 点了「待回复」里的一个对话：切到那个号并打开这个对话。
// 轻量号：直接选中这个对话。
// 网页号：已经开着就只切过去；否则用 WhatsApp 自己的 send?phone= 链接打开（和 MCP 的打开对话同一条路，不点击、不注入），
//   号码从名字认（没存联系人的号），认不出就只读查 WhatsApp 本地的联系人（wa-page.js 的 lookupPeerPhone）。
//   打开要刷新这个号的页面：输入框里有没发的字时先回 not_empty，界面问过用户再带 force 来。查不到号码就只切到那个号。
// deps（main.js 提供）：store()、findAcc(id)、isLite(acc)、locked()、webContents(id) -> wc | null、
//   waPage: { readChatPeer, lookupPeerPhone, composeState }、activate(id)（切过去并拿到前台）、liteOpen(id, jid)、
//   openNumber(id, digits) -> chat-open.js 的 openForUser 的结果
// 返回 { result: 'opened' | 'already' | 'switched' | 'not_empty' | 'gone' | 'busy' | 'failed' }
function createUnrepliedOpener(deps) {
  async function open(accountId, key, force = false) {
    const acc = deps.findAcc(accountId);
    const e = acc ? deps.store().get(accountId, key) : null;
    if (!acc || !e || deps.locked()) return { result: 'gone' };
    if (deps.isLite(acc)) {
      await deps.activate(accountId);
      deps.liteOpen(accountId, e.jid || key);
      return { result: 'opened' };
    }
    const wc = deps.webContents(accountId);
    if (!wc) { await deps.activate(accountId); return { result: 'switched' }; }
    const peer = await deps.waPage.readChatPeer(wc);
    if (peer && peer.title && normTitle(peer.title) === normTitle(e.name)) { await deps.activate(accountId); return { result: 'already' }; }
    let digits = e.digits || digitsOfTitle(e.name);
    if (!digits) {
      const r = await deps.waPage.lookupPeerPhone(wc, { title: e.name });
      digits = (r && r.digits) || '';
    }
    if (!digits) { await deps.activate(accountId); return { result: 'switched' }; }
    if (!force) {
      const st = await deps.waPage.composeState(wc, '');
      if (st && st.box && !st.empty) return { result: 'not_empty' };
    }
    await deps.activate(accountId);
    const r = await deps.openNumber(accountId, digits);
    const result = r && ['opened', 'already', 'busy'].includes(r.result) ? r.result : 'failed';
    return { result };
  }
  return { open };
}

// 等 p 最多 ms 毫秒；超时或出错给 fallback（页面停在空地址上时，在里面跑脚本永远等不到回音）
function withTimeout(p, ms, fallback) {
  let timer;
  return Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => { timer = setTimeout(() => r(fallback), ms); })]).finally(() => clearTimeout(timer));
}

module.exports = { Unreplied, createUnrepliedOpener, withTimeout, digitsOfTitle, THRESHOLD_MS, MAX_AGE_MS, MIN_HITS };
