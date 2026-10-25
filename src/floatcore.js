// 悬浮翻译的核心逻辑（不碰界面和页面，方便单独测试）：
// 记下读到的“收到的消息”，决定哪些自动翻、哪些等用户点，排队调用翻译，控制每分钟和每天的上限。
// 消息的 data-id 里有对方号码，只留在主进程：对外（悬浮窗、大模型）只用 hash。全部只在内存里。
const crypto = require('crypto');

const KEEP_PER_ACCOUNT = 200;
const BACKFILL = 5; // 打开自动翻译或切到一个对话时，只补翻最近 5 条
const PER_MINUTE = 20;
const AUTO_MAX_CHARS = 1000;
const RECENT = 30; // 每个号记住当前对话最近 30 条（双方），给上下文用
const CONTEXT_N = 8; // 翻译时带上前面 8 条

const hashOf = (accId, dataId) => crypto.createHash('sha256').update(`${accId}|${dataId}`).digest('hex').slice(0, 16);
// data-id: false_<对话>_<消息编号>[_<群成员>]，第二段是对话
const chatOf = (dataId) => String(dataId).split('_')[1] || '';
// 按本机日期算“今天”（北京时间 0 点换天，不是 UTC）
const today = (now) => { const d = new Date(now); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

// 消息上显示的时间（WhatsApp 页面上写的“几点几分”），认不出就空着
const hhmm = (t) => (t && Number.isInteger(t.h) && Number.isInteger(t.mi) ? `${String(t.h).padStart(2, '0')}:${String(t.mi).padStart(2, '0')}` : '');

class FloatCore {
  // deps: { translate(text, modeId) -> Promise<result>, now?() }
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
      st = { chat: '', title: '', items: new Map(), view: [], recent: [], minute: [], day: { d: '', n: 0 }, paused: '' };
      this.accs.set(accId, st);
    }
    return st;
  }

  forget(accId) {
    this.accs.delete(accId);
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

  queueAuto(accId, st, item, opts) {
    if (item.state !== 'manual') return;
    if (item.text.length > AUTO_MAX_CHARS) { item.note = 'long'; return; }
    if (!this.canAuto(st, opts.dailyCap)) return;
    this.takeAuto(st);
    item.state = 'queued';
    this.queue.push({ accId, h: item.h });
  }

  // 读到一次当前对话。read: { title, msgs: [{ id, out, text }] }。opts: { auto, dailyCap }
  // 返回 true 表示悬浮窗要刷新
  ingest(accId, read, opts) {
    const st = this.acc(accId);
    const msgs = (read.msgs || []).filter((m) => m && typeof m.id === 'string');
    const chat = msgs.length ? chatOf(msgs[msgs.length - 1].id) : '';
    const newChat = chat !== st.chat;
    const fresh = [];
    for (const m of msgs) {
      if (m.out || !String(m.text || '').trim()) continue;
      const h = hashOf(accId, m.id);
      if (st.items.has(h)) continue;
      const item = { h, text: String(m.text), t: hhmm(m.t), state: 'manual', tr: '', err: '', warn: [], note: '' };
      st.items.set(h, item);
      fresh.push(item);
    }
    // 只保留最近 200 条（最早的先删）
    while (st.items.size > KEEP_PER_ACCOUNT) st.items.delete(st.items.keys().next().value);
    // 刚切到这个对话：已经在屏幕上的旧消息只补翻最后 5 条；之后新来的都算
    const candidates = newChat ? fresh.slice(-BACKFILL) : fresh;
    if (opts.auto) for (const item of candidates) this.queueAuto(accId, st, item, opts);
    const view = msgs.filter((m) => !m.out && String(m.text || '').trim()).map((m) => hashOf(accId, m.id));
    const changed = newChat || fresh.length > 0 || view.join() !== st.view.join() || st.title !== (read.title || '');
    st.chat = chat;
    st.title = read.title || '';
    // 当前对话最近的消息（双方都有，给翻译当上下文参考），只在内存里，不含 data-id
    st.recent = msgs.filter((m) => String(m.text || '').trim()).slice(-RECENT).map((m) => ({ h: hashOf(accId, m.id), out: !!m.out, text: String(m.text).slice(0, 1000) }));
    st.view = view;
    this.pump();
    return changed;
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
    this.queue.unshift({ accId, h, manual: true, fix: fix === true });
    this.pump();
    return true;
  }

  // 纠错建议：采用（替换译文）或不用
  suggestion(accId, h, take) {
    const st = this.accs.get(accId);
    const item = st && st.items.get(h);
    if (!item || !item.suggest) return false;
    if (take) { item.tr = item.suggest; item.edited = false; item.fixed = true; item.warn = []; }
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
    this.onChange(accId);
    return true;
  }

  // 翻译用的上下文：这条消息之前的最近几条（不传 h 就是整个对话最近几条，写回复时用）
  contextOf(accId, h) {
    const st = this.accs.get(accId);
    if (!st) return [];
    let list = st.recent;
    if (h) {
      const i = list.findIndex((m) => m.h === h);
      list = i >= 0 ? list.slice(0, i) : list;
    }
    return list.slice(-CONTEXT_N).map(({ out, text }) => ({ out, text }));
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
        try { r = await this.deps.translate(item.text, { fix: !!job.fix, prev: job.fix ? item.tr : '', context: this.contextOf(job.accId, job.h) }); } catch { r = { error: '翻译失败', kind: 'other' }; }
        if (r && r.kind === 'busy') {
          // 面板正在翻：等一下再来（之前翻好的译文还在，状态先回到排队）
          item.state = 'queued';
          await new Promise((res) => setTimeout(res, 700));
          continue;
        }
        this.queue.shift();
        if (!this.accs.get(job.accId)) continue; // 号被删了
        if (r && r.text && job.fix && item.edited) { item.state = 'done'; item.suggest = r.text; item.err = ''; } // 手动改过的：纠错结果只当建议，让用户选
        else if (r && r.text) { item.state = 'done'; item.tr = r.text; item.warn = r.warn || []; item.err = ''; item.edited = false; item.fixed = !!job.fix; item.suggest = ''; }
        else if (r && r.kind === 'consent') { item.state = 'manual'; item.err = ''; this.needConsent = r.consent; }
        else { item.state = 'error'; item.err = (r && r.error) || '翻译失败'; }
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
        .map(({ h, text, t, state, tr, err, warn, note, edited, fixed, suggest }) => ({ h, text, t, state, tr, err, warn, note, edited: !!edited, fixed: !!fixed, suggest: suggest || '' })),
    };
  }
}

module.exports = { FloatCore, hashOf, chatOf, PER_MINUTE, BACKFILL, AUTO_MAX_CHARS };
