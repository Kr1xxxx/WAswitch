// 悬浮翻译的核心逻辑（不碰界面和页面，方便单独测试）：
// 记下读到的“收到的消息”，决定哪些自动翻、哪些等用户点，排队调用翻译，控制每分钟和每天的上限。
// 消息的 data-id 里有对方号码，只留在主进程：对外（悬浮窗、大模型）只用 hash。
// 译文另外永久存到磁盘（deps.store，见 trstore.js）：切回对话、重启都直接显示，不再调模型。
const crypto = require('crypto');

const KEEP_PER_ACCOUNT = 200;
const BACKFILL = 5; // 打开自动翻译或切到一个对话时，只补翻最近 5 条
const PER_MINUTE = 20;
const AUTO_MAX_CHARS = 1000;
const RECENT = 30; // 每个号记住当前对话最近 30 条（双方），给上下文用
const CONTEXT_N = 8; // 翻译时带上前面 8 条
const KEEP_VIEW = 40; // 读页面只读最后 20 条，被挤出去的旧消息也留在翻译栏上，加起来最多 40 条（轻量号一次读到更多就按读到的条数）

// 从最近消息里截上下文：这条消息之前的几条；这条不在里面就不给（别的对话的内容不能串进来）
function contextFrom(list, h) {
  if (h) {
    const i = list.findIndex((m) => m.h === h);
    list = i >= 0 ? list.slice(0, i) : [];
  }
  return list.slice(-CONTEXT_N).map(({ out, text }) => ({ out, text }));
}
const hashOf = (accId, dataId) => crypto.createHash('sha256').update(`${accId}|${dataId}`).digest('hex').slice(0, 16);
// data-id: false_<对话>_<消息编号>[_<群成员>]，第二段是对话
const chatOf = (dataId) => String(dataId).split('_')[1] || '';
// 按本机日期算“今天”（北京时间 0 点换天，不是 UTC）
const today = (now) => { const d = new Date(now); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

// 消息上显示的时间（WhatsApp 页面上写的“几点几分”），认不出就空着
const hhmm = (t) => (t && Number.isInteger(t.h) && Number.isInteger(t.mi) ? `${String(t.h).padStart(2, '0')}:${String(t.mi).padStart(2, '0')}` : '');

// 轻量号的消息里图片、语音等是一个类型标签（见 lite/store.mjs 的 LABELS），本身不用翻；带说明文字的只翻说明
const LITE_LABEL = /^\[(?:图片|视频|语音|文件|贴纸|名片|位置|实时位置|投票|活动|暂不支持的消息，请在手机上查看)\]\s*/;

// 轻量号不用读网页：后台进程推来的当前对话（view）本来就有消息文字，换成和 readOpenChat 一样的格式。
// jid：用户在轻量聊天页点开的对话。view 还没跟上（刚点开）时返回 why: 'wait'
function fromLite(view, jid) {
  if (!jid) return { ok: false, why: 'nochat' };
  if (!view || view.jid !== jid) return { ok: false, why: 'wait' };
  const chat = String(jid).replace(/_/g, '');
  const msgs = [];
  for (const m of Array.isArray(view.messages) ? view.messages : []) {
    if (!m || !m.id) continue;
    const text = String(m.text || '').replace(LITE_LABEL, '');
    if (!text.trim()) continue;
    const d = m.ts ? new Date(m.ts * 1000) : null;
    msgs.push({ id: `${!!m.me}_${chat}_${String(m.id).replace(/_/g, '')}`, out: !!m.me, text, t: d ? { h: d.getHours(), mi: d.getMinutes(), at: d.getTime() } : null });
  }
  const listed = (Array.isArray(view.chats) ? view.chats : []).find((c) => c && c.jid === jid);
  // 没名字的私聊用号码当标题（和 WhatsApp 网页一样），客户名单能按号码对上
  const user = String(jid).split('@')[0].split(':')[0];
  const number = String(jid).endsWith('@s.whatsapp.net') ? `+${user}` : '';
  // 轻量号拿到的总是对话里最新的那些（不跟着滑动变），算停在最下面
  return { ok: true, title: view.title || (listed && listed.name) || number, msgs, bottom: true };
}

class FloatCore {
  // deps: { translate(text, modeId) -> Promise<result>, now?(), store?: TrStore }
  constructor(deps) {
    this.deps = deps;
    this.accs = new Map(); // accId -> state
    this.queue = []; // { accId, h, auto }
    this.running = false;
    this.onChange = () => {};
  }

  now() { return this.deps.now ? this.deps.now() : Date.now(); }

  acc(accId) {
    let st = this.accs.get(accId);
    if (!st) {
      st = { chat: '', title: '', items: new Map(), view: [], recent: [], seen: [], newest: 0, minute: [], day: { d: '', n: 0 }, paused: '' };
      this.accs.set(accId, st);
    }
    return st;
  }

  forget(accId) {
    this.accs.delete(accId);
    if (this.deps.store) this.deps.store.forgetAccount(accId);
    this.queue = this.queue.filter((q) => q.accId !== accId);
  }

  // 自动翻译还能不能再翻一条（每分钟 20 条、每天 dailyCap 条，补翻也算）
  canAuto(st, dailyCap) {
    const now = this.now();
    st.minute = st.minute.filter((t) => now - t < 60000);
    if (st.day.d !== today(now)) st.day = { d: today(now), n: 0 };
    if (st.day.n >= dailyCap) { st.paused = 'day'; return false; }
    if (st.minute.length >= PER_MINUTE) { st.paused = 'minute'; return false; }
    if (st.paused === 'minute') st.paused = '';
    return true;
  }

  takeAuto(st) {
    st.minute.push(this.now());
    st.day.n += 1;
  }

  // recent：这次读到的最近消息（ingest 还没写回 st.recent 时传进来），上下文从里面截
  queueAuto(accId, st, item, opts, recent = st.recent) {
    if (item.state !== 'manual') return;
    if (item.text.length > AUTO_MAX_CHARS) { item.note = 'long'; return; }
    if (!this.canAuto(st, opts.dailyCap)) return;
    this.takeAuto(st);
    item.state = 'queued';
    this.queue.push({ accId, h: item.h, context: contextFrom(recent, item.h) });
  }

  // 自己发的消息上一次被当成了收到的（比如刚发出去时还认不出方向）：从列表里去掉；
  // 还在排队没开始翻的撤掉，并退回占用的自动翻译额度
  dropOwn(accId, st, id) {
    if (!id.startsWith('true_')) return;
    const h = hashOf(accId, 'false_' + id.slice(5));
    const item = st.items.get(h);
    if (!item) return;
    if (item.state === 'running') return;
    if (item.state === 'queued') {
      const i = this.queue.findIndex((q) => q.accId === accId && q.h === h);
      if (i >= 0 && this.queue[i].manual) return; // 用户自己点的翻译，照常翻
      if (i >= 0) {
        this.queue.splice(i, 1);
        if (st.day.n > 0) st.day.n -= 1;
        st.minute.pop();
        if (st.paused === 'day') st.paused = '';
      }
    }
    st.items.delete(h);
  }

  // 读到一次当前对话。read: { title, msgs: [{ id, out, text }] }。opts: { auto, dailyCap }
  // 返回 true 表示悬浮窗要刷新
  ingest(accId, read, opts) {
    const st = this.acc(accId);
    const msgs = (read.msgs || []).filter((m) => m && typeof m.id === 'string');
    const chat = msgs.length ? chatOf(msgs[msgs.length - 1].id) : '';
    const newChat = chat !== st.chat;
    const hs = msgs.map((m) => hashOf(accId, m.id));
    const newest = Math.max(0, ...msgs.map((m) => (m.t && Number.isFinite(m.t.at) ? m.t.at : 0)));
    if (!newChat && this.behind(st, read, hs, newest)) return false;
    const fresh = [];
    // 当前对话最近的消息（双方都有），入队时从这里截上下文；只在内存里，不含 data-id。
    // 下面判断“和上次读到的接不接得上”还要用上次的 st.recent，所以最后才写回
    const recent = msgs.filter((m) => String(m.text || '').trim()).slice(-RECENT).map((m) => ({ h: hashOf(accId, m.id), out: !!m.out, text: String(m.text).slice(0, 1000) }));
    for (const m of msgs) {
      if (m.out) { this.dropOwn(accId, st, m.id); continue; }
      if (!String(m.text || '').trim()) continue;
      const h = hashOf(accId, m.id);
      if (st.items.has(h)) continue;
      const item = { h, ck: hashOf(accId, `chat|${chatOf(m.id)}`), text: String(m.text), t: hhmm(m.t), state: 'manual', tr: '', err: '', warn: [], note: '' };
      // 以前翻过（存在磁盘上）：直接用，不排队、不算额度
      const saved = this.deps.store ? this.deps.store.get(accId, item.ck, item.text) : null;
      if (saved) { item.state = 'done'; item.tr = saved.tr; item.edited = !!saved.edited; item.fixed = !!saved.fixed; }
      st.items.set(h, item);
      fresh.push(item);
    }
    // 只保留最近 200 条（最早的先删）
    while (st.items.size > KEEP_PER_ACCOUNT) st.items.delete(st.items.keys().next().value);
    // 刚切到这个对话：已经在屏幕上的旧消息只补翻最后 5 条；之后新来的都算
    const candidates = newChat ? fresh.slice(-BACKFILL) : fresh;
    if (opts.auto) for (const item of candidates) this.queueAuto(accId, st, item, opts, recent);
    let view = msgs.filter((m) => !m.out && String(m.text || '').trim()).map((m) => hashOf(accId, m.id));
    // 读页面只读最后 20 条（双方）：自己每发一条，最老的一条就被挤出去。还是同一个对话、和上次读到的接得上，
    // 挤出去的客户消息照样留在翻译栏上面，不然每发一条，翻译栏就少一条、整列往上跳（shen 2026-10-28）
    const prevAll = new Set(st.recent.map((m) => m.h));
    if (!newChat && msgs.some((m) => prevAll.has(hashOf(accId, m.id)))) {
      // 只留比这次读到的都早的那一段（中间不见了的是客户撤回的，不留）；这次认出是自己发的（上次当成了收到的）也不留
      const inView = new Set(view);
      const first = st.view.findIndex((h) => inView.has(h));
      const own = new Set(msgs.filter((m) => m.out && m.id.startsWith('true_')).map((m) => hashOf(accId, 'false_' + m.id.slice(5))));
      const kept = (first < 0 ? st.view : st.view.slice(0, first)).filter((h) => !own.has(h) && st.items.has(h));
      // 只限制留下的旧消息，这次读到的一条不少；轻量号一次读到的多，按上次的条数留
      const room = Math.max(0, Math.max(KEEP_VIEW, st.view.length) - view.length);
      if (room && kept.length) view = [...kept.slice(-room), ...view];
    }
    const changed = newChat || fresh.length > 0 || view.join() !== st.view.join() || st.title !== (read.title || '');
    st.chat = chat;
    st.title = read.title || '';
    st.recent = recent;
    st.view = view;
    st.seen = hs;
    st.newest = newChat ? newest : Math.max(st.newest, newest);
    this.pump();
    return changed;
  }

  // 用户往上翻聊天记录：WhatsApp 把最下面的新消息从页面上拿掉了，读到的最后 20 条是更早的。
  // 这样的读数整个不用，翻译栏一直是对话里最新的那些，不跟着滑动变（shen 2026-10-28）。
  // 上次读到的最后一条还在、或者页面说停在最下面：照常用（最新的那条被删了也不会卡住）
  behind(st, read, hs, newest) {
    if (!st.seen.length || read.bottom === true) return false;
    if (hs.includes(st.seen[st.seen.length - 1])) return false;
    // 读到了比以前都新的消息：往上翻只会露出更早的，所以照常用（位置认错了、一下来了 20 多条也不会卡住）
    if (newest && newest > st.newest) return false;
    if (read.bottom === false) return true;
    // 页面说不清在哪：读到的最新一条比以前读到的早，或者最后一条是以前就读到过的旧消息
    if (newest && st.newest && newest < st.newest) return true;
    return hs.length > 0 && st.seen.includes(hs[hs.length - 1]);
  }

  // 打开自动翻译：当前对话最近 5 条还没翻的补上
  backfill(accId, opts) {
    const st = this.acc(accId);
    const items = st.view.map((h) => st.items.get(h)).filter(Boolean).slice(-BACKFILL);
    for (const item of items) this.queueAuto(accId, st, item, { ...opts, auto: true });
    this.pump();
  }

  // 用户点“翻译”或“纠错”：不受自动翻译的上限限制。fix=true 用更仔细的校对提示词重翻（会替换手动改过的）
  manual(accId, h, fix = false) {
    const st = this.accs.get(accId);
    const item = st && st.items.get(h);
    if (!item || item.state === 'queued' || item.state === 'running') return false;
    item.state = 'queued';
    item.err = '';
    item.errKind = '';
    this.queue.unshift({ accId, h, manual: true, fix: fix === true, context: this.contextOf(accId, h) });
    this.pump();
    return true;
  }

  // 密钥填好（或换了默认服务）后：因为“没填密钥 / 密钥不对”失败的消息自动重翻一次。
  // 别的原因（额度、网络、模型名……）失败的不动。opts: { dailyCap, match(errPid) -> 要不要重翻 }
  // 正显示在面板上的：照自动翻译的上限排队（超了就退回“翻译”按钮，不再显示旧报错）；
  // 别的对话里的：直接忘掉，下次打开那个对话按新消息处理。返回改动了的号
  retryKeyErrors(opts = {}) {
    const touched = [];
    for (const [accId, st] of this.accs) {
      let hit = false;
      for (const [h, item] of [...st.items]) {
        if (item.state !== 'error' || item.errKind !== 'auth') continue;
        if (opts.match && !opts.match(item.errPid || '')) continue;
        hit = true;
        item.err = ''; item.errKind = ''; item.errPid = '';
        // 纠错失败的：原来的译文还在，直接恢复，不再请求
        if (item.tr) { item.state = 'done'; continue; }
        if (!st.view.includes(h)) { st.items.delete(h); continue; }
        if (this.canAuto(st, opts.dailyCap ?? Infinity)) {
          this.takeAuto(st);
          item.state = 'queued';
          this.queue.push({ accId, h, context: this.contextOf(accId, h) });
        } else item.state = 'manual';
      }
      if (hit) touched.push(accId);
    }
    if (touched.length) this.pump();
    return touched;
  }

  // 纠错建议：采用（替换译文）或不用
  suggestion(accId, h, take) {
    const st = this.accs.get(accId);
    const item = st && st.items.get(h);
    if (!item || !item.suggest) return false;
    if (take) { item.tr = item.suggest; item.edited = false; item.fixed = true; item.warn = []; this.save(accId, item); }
    item.suggest = '';
    this.onChange(accId);
    return true;
  }

  // 用户手动改译文：保留，自动翻译不会再覆盖
  edit(accId, h, text) {
    const st = this.accs.get(accId);
    const item = st && st.items.get(h);
    const t = String(text || '').slice(0, 4000);
    if (!item || !t.trim() || item.state === 'queued' || item.state === 'running') return false;
    item.tr = t; item.state = 'done'; item.err = ''; item.warn = []; item.edited = true; item.suggest = '';
    this.save(accId, item);
    this.onChange(accId);
    return true;
  }

  // 译文写到磁盘（手动改的、纠错采用的也存）
  save(accId, item) {
    if (this.deps.store && item.ck) this.deps.store.put(accId, item.ck, item.text, { tr: item.tr, edited: item.edited, fixed: item.fixed });
  }

  // 翻译用的上下文：这条消息之前的最近几条（不传 h 就是整个对话最近几条，写回复时用）
  contextOf(accId, h) {
    const st = this.accs.get(accId);
    return st ? contextFrom(st.recent, h) : [];
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue[0];
        const st = this.accs.get(job.accId);
        const item = st && st.items.get(job.h);
        if (!item || item.state !== 'queued') { this.queue.shift(); continue; }
        item.state = 'running';
        this.onChange(job.accId);
        let r;
        try { r = await this.deps.translate(item.text, { fix: !!job.fix, prev: job.fix ? item.tr : '', context: job.context }); } catch { r = { error: '翻译失败', kind: 'other' }; }
        if (r && r.kind === 'busy') {
          // 面板正在翻：等一下再来（之前翻好的译文还在，状态先回到排队）
          item.state = 'queued';
          await new Promise((res) => setTimeout(res, 700));
          continue;
        }
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        if (this.accs.get(job.accId) !== st) continue; // 号被删了或重建了
        if (r && r.text && job.fix && item.edited) { item.state = 'done'; item.suggest = r.text; item.err = ''; } // 手动改过的：纠错结果只当建议，让用户选
        else if (r && r.text) { item.state = 'done'; item.tr = r.text; item.warn = r.warn || []; item.err = ''; item.edited = false; item.fixed = !!job.fix; item.suggest = ''; this.save(job.accId, item); }
        else { item.state = 'error'; item.err = (r && r.error) || '翻译失败'; item.errKind = (r && r.kind) || 'other'; item.errPid = (r && r.kind === 'auth' && r.providerId) || ''; }
        this.onChange(job.accId);
      }
    } finally {
      this.running = false;
    }
  }

  // 给悬浮窗看的：当前对话里收到的消息（不含 data-id）
  viewOf(accId) {
    const st = this.accs.get(accId);
    if (!st) return { title: '', items: [], paused: '', chatKey: '' };
    return {
      title: st.title,
      // 对话的 hash（记住客户语言用），不含号码
      chatKey: st.chat ? hashOf(accId, `chat|${st.chat}`) : '',
      paused: st.paused,
      today: st.day.n,
      items: st.view.map((h) => st.items.get(h)).filter(Boolean)
        .map(({ h, text, t, state, tr, err, errPid, warn, note, edited, fixed, suggest }) => ({ h, text, t, state, tr, err, errPid: errPid || '', warn, note, edited: !!edited, fixed: !!fixed, suggest: suggest || '' })),
    };
  }
}

module.exports = { FloatCore, fromLite, hashOf, chatOf, PER_MINUTE, BACKFILL, AUTO_MAX_CHARS };
