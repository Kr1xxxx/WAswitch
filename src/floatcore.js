// 悬浮翻译的核心逻辑（不碰界面和页面，方便单独测试）：
// 记下读到的“收到的消息”，决定哪些自动翻、哪些等用户点，排队调用翻译，控制每分钟和每天的上限。
// 消息的 data-id 里有对方号码，只留在主进程：对外（悬浮窗、大模型）只用 hash。
// 译文另外永久存到磁盘（deps.store，见 trstore.js）：切回对话、重启都直接显示，不再调模型。
// 轻量号客户发来的语音：先转文字（deps.transcribe，智谱 GLM-ASR），转出来的文字当原文照常翻译；按「voice:+消息编号」存，不再转。
// 翻译栏显示过哪些消息也记在磁盘上：重新打开对话时，页面上读不到的更早的译文按记录补回来（记录里有原文的连原文一起）。
const crypto = require('crypto');
const { textKey, VIEW_MAX } = require('./trstore');

const KEEP_PER_ACCOUNT = 200;
const BACKFILL = 5; // 打开自动翻译或切到一个对话时，最近 5 条没翻的照常自动翻（用默认服务商，算额度）
const SLOW_GAP = 2000; // 更早没翻的用免费服务商在后台慢慢补：每条之间隔 2 秒
const PER_MINUTE = 20;
const MAX_PARALLEL = 3; // 收到的消息最多同时翻 3 条（只在用免费服务商时，见 maxParallel）
const BUSY_RETRY = 700; // 对方说忙：700 毫秒后再来
const AUTO_MAX_CHARS = 1000;
const RECENT = 30; // 每个号记住当前对话最近 30 条（双方），给上下文用
const CONTEXT_N = 8; // 翻译时带上前面 8 条
const VOICE_MAX_S = 300; // 超过 5 分钟的语音不自动转（点「转文字」只转前 5 分钟，见 asr.js）
const KEEP_VIEW = VIEW_MAX; // 40（和 trstore.js 存的条数一样）。读页面只读最后 20 条，被挤出去的旧消息也留在翻译栏上，加起来最多 40 条（轻量号一次读到更多就按读到的条数）

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

// 轻量号客户发来的语音（voice 是时长，秒）：没有文字也显示在翻译栏上
const isVoice = (m) => !!m && typeof m.voice === 'number';
// 翻译栏显示的消息：客户发来的，有文字或是语音
const shown = (m) => !m.out && (!!String(m.text || '').trim() || isVoice(m));

// 消息上显示的时间（WhatsApp 页面上写的“几点几分”），认不出就空着
const hhmm = (t) => (t && Number.isInteger(t.h) && Number.isInteger(t.mi) ? `${String(t.h).padStart(2, '0')}:${String(t.mi).padStart(2, '0')}` : '');

// 没有任何文字（字母、汉字）的消息不用翻：时间、数字、编号、电话、表情、标点，原样看得懂（shen 2026-10-28）
const noWords = (text) => !/\p{L}/u.test(String(text));
// 以前默认模式「看懂客户」会在译文后面另起一行写【要点】总结（shen 2026-10-28 不要）：存着的旧译文显示时去掉那段
function dropGist(tr) {
  const t = String(tr || '');
  const i = t.search(/\n\s*【要点】/);
  return i > 0 && t.slice(0, i).trim() ? t.slice(0, i).trim() : t;
}

// 轻量号的消息里图片、语音等是一个类型标签（见 lite/store.mjs 的 LABELS），本身不用翻；带说明文字的只翻说明
const LITE_LABEL = /^\[(?:图片|视频|语音|文件|贴纸|名片|位置|实时位置|投票|活动|暂不支持的消息，请在手机上查看)\]\s*/;
const liteText = (raw) => String(raw || '').replace(LITE_LABEL, '');

// 轻量号不用读网页：后台进程推来的当前对话（view）本来就有消息文字，换成和 readOpenChat 一样的格式。
// jid：用户在轻量聊天页点开的对话。view 还没跟上（刚点开）时返回 why: 'wait'
function fromLite(view, jid) {
  if (!jid) return { ok: false, why: 'nochat' };
  if (!view || view.jid !== jid) return { ok: false, why: 'wait' };
  const chat = String(jid).replace(/_/g, '');
  const msgs = [];
  for (const m of Array.isArray(view.messages) ? view.messages : []) {
    if (!m || !m.id) continue;
    const text = liteText(m.text);
    const voice = !m.me && typeof m.voice === 'number' && Number.isFinite(m.voice);
    if (!text.trim() && !voice) continue;
    const d = m.ts ? new Date(m.ts * 1000) : null;
    const row = { id: `${!!m.me}_${chat}_${String(m.id).replace(/_/g, '')}`, out: !!m.me, text, t: d ? { h: d.getHours(), mi: d.getMinutes(), at: d.getTime() } : null };
    // 语音：时长和下载用的对话、消息编号（只留在主进程，见 viewOf）
    if (voice) Object.assign(row, { text: '', voice: Math.max(0, Math.round(m.voice)), src: { jid: String(jid), id: String(m.id) } });
    msgs.push(row);
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
    this.running = false; // 有没有正在翻的
    this.active = 0; // 正在翻几条
    this.slowTimer = null;
    this.slowReady = false;
    this.retryTimer = null;
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
    if (item.text.length > AUTO_MAX_CHARS || (isVoice(item) && !item.text && item.voice > VOICE_MAX_S)) { item.note = 'long'; return; }
    if (isVoice(item) && !item.text && !this.deps.transcribe) return;
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
      if (i >= 0 && this.queue.splice(i, 1)[0].slow) { /* 后台补翻的不占额度，不用退 */ } else if (i >= 0) {
        if (st.day.n > 0) st.day.n -= 1;
        st.minute.pop();
        if (st.paused === 'day') st.paused = '';
      }
    }
    st.items.delete(h);
  }

  // 存着的译文里的【要点】留着不删：用户现在用的「收到」模式自己要要点（deps.keepGist），或者客户原文里本来就有【要点】
  keepGist(text) {
    return String(text).includes('【要点】') || !!(this.deps.keepGist && this.deps.keepGist());
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
    let filled = false;
    // 当前对话最近的消息（双方都有），入队时从这里截上下文；只在内存里，不含 data-id。
    // 下面判断“和上次读到的接不接得上”还要用上次的 st.recent，所以最后才写回
    const recent = msgs.filter((m) => String(m.text || '').trim()).slice(-RECENT).map((m) => ({ h: hashOf(accId, m.id), out: !!m.out, text: String(m.text).slice(0, 1000) }));
    for (const m of msgs) {
      if (m.out) { this.dropOwn(accId, st, m.id); continue; }
      if (!shown(m)) continue;
      const h = hashOf(accId, m.id);
      const had = st.items.get(h);
      if (had) { if (!had.text && !isVoice(had) && this.fillItem(accId, had, String(m.text), true)) filled = true; continue; } // 补回来时没有原文的旧消息又读到了：补上原文
      const item = { h, ck: hashOf(accId, `chat|${chatOf(m.id)}`), text: String(m.text), t: hhmm(m.t), state: 'manual', tr: '', err: '', warn: [], note: '' };
      if (isVoice(m)) {
        // 语音：按消息编号存（没有原文 hash）；以前转过、翻过的直接用转出来的文字和译文
        Object.assign(item, { text: '', voice: m.voice, src: m.src, k: textKey(`voice:${m.id}`) });
        const saved = this.deps.store ? this.deps.store.getKey(accId, item.ck, item.k) : null;
        if (saved && typeof saved.text === 'string' && saved.text.trim()) {
          Object.assign(item, { state: 'done', text: saved.text, tr: saved.edited ? saved.tr : dropGist(saved.tr), edited: !!saved.edited, fixed: !!saved.fixed });
        }
        else {
          // 转过、还没翻成的：用存着的文字照常翻，不再转；以前没听出话的显示原因，用户点「重试」才再转
          const heard = this.deps.store && this.deps.store.getHeard ? this.deps.store.getHeard(accId, item.ck, item.k) : null;
          if (heard !== null && !heard.trim()) Object.assign(item, { state: 'error', err: '没听出说的话', errKind: 'empty' });
          else if (heard !== null) Object.assign(item, { text: heard, state: noWords(heard) ? 'skip' : 'manual' });
        }
        st.items.set(h, item);
        fresh.push(item);
        continue;
      }
      // 以前翻过（存在磁盘上）：直接用，不排队、不算额度
      const skip = noWords(item.text);
      const saved = !skip && this.deps.store ? this.deps.store.get(accId, item.ck, item.text) : null;
      if (skip) item.state = 'skip';
      else if (saved) {
        item.state = 'done'; item.tr = saved.edited || this.keepGist(item.text) ? saved.tr : dropGist(saved.tr); item.edited = !!saved.edited; item.fixed = !!saved.fixed;
        if (!saved.text) this.deps.store.fillText(accId, item.ck, textKey(item.text), item.text); // 以前存的没有原文：这次读到了，补上
      }
      st.items.set(h, item);
      fresh.push(item);
    }
    // 只保留最近 200 条（最早的先删）
    while (st.items.size > KEEP_PER_ACCOUNT) st.items.delete(st.items.keys().next().value);
    // 刚切到这个对话：已经在屏幕上的旧消息里没翻的补上（见 catchUp）；之后新来的都照常自动翻
    if (opts.auto) {
      if (newChat) this.catchUp(accId, st, hs, opts, recent);
      else for (const item of fresh) this.queueAuto(accId, st, item, opts, recent);
    }
    let view = msgs.filter(shown).map((m) => hashOf(accId, m.id));
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
    // 刚打开（切回、重启后）这个对话：读页面只读得到最后 20 条，以前翻译栏上更早的译文按存的记录补在上面
    if (newChat && chat) view = [...this.restore(accId, st, chat, view, msgs), ...view];
    const changed = newChat || filled || fresh.length > 0 || view.join() !== st.view.join() || st.title !== (read.title || '');
    st.chat = chat;
    st.title = read.title || '';
    st.recent = recent;
    st.view = view;
    st.seen = hs;
    st.newest = newChat ? newest : Math.max(st.newest, newest);
    if (chat) this.keepView(accId, st, chat);
    this.pump();
    return changed;
  }

  // 存的记录里，比这次读到的都早的、有译文的消息：放回 st.items，返回它们的 hash（按原来的顺序）
  restore(accId, st, chat, view, msgs) {
    const store = this.deps.store;
    if (!store || !store.getView) return [];
    const ck = hashOf(accId, `chat|${chat}`);
    const saved = store.getView(accId, ck);
    if (!saved.length) return [];
    // 和这次读到的接上：记录里这次读到的第一条之前的那些；接不上（不在的时候又来了 20 多条）就整张单子都比这次早
    const inRead = new Set(view);
    const readKeys = new Set(msgs.filter((m) => !m.out).map((m) => textKey(String(m.text || ''))));
    const at = view.length ? saved.findIndex((x) => x.h === view[0]) : -1;
    const older = (at >= 0 ? saved.slice(0, at) : saved).filter((x) => !inRead.has(x.h) && (at >= 0 || !readKeys.has(x.k)));
    const out = [];
    for (const x of older) {
      if (out.includes(x.h)) continue;
      let item = st.items.get(x.h);
      if (!item) {
        const rec = store.getKey(accId, ck, x.k);
        if (!rec) continue; // 没翻过的不补
        // 原文：记录里有就带上（能展开、能纠错）；以前存的没有原文，等读到那条消息或轻量号后台补（fillItem / fillText）。
        // 语音的原文是转出来的文字，按消息编号存，hash 对不上原文
        const voice = typeof x.v === 'number';
        const text = typeof rec.text === 'string' && (voice || textKey(rec.text) === x.k) ? rec.text : '';
        item = { h: x.h, ck, k: x.k, text, t: x.t, state: 'done', tr: rec.edited || this.keepGist(text) ? rec.tr : dropGist(rec.tr), edited: !!rec.edited, fixed: !!rec.fixed, err: '', warn: [], note: '', ...(voice ? { voice: x.v } : {}) };
        st.items.set(x.h, item);
      }
      out.push(x.h);
    }
    return out.slice(-Math.max(0, KEEP_VIEW - view.length));
  }

  // 翻译栏现在显示的消息记到磁盘上（只有 hash 和时间）
  keepView(accId, st, chat) {
    const store = this.deps.store;
    if (!store || !store.putView) return;
    const list = st.view.map((h) => st.items.get(h)).filter(Boolean)
      .map((it) => ({ h: it.h, k: it.k || textKey(it.text), t: it.t || '', ...(isVoice(it) ? { v: it.voice } : {}) }));
    store.putView(accId, hashOf(accId, `chat|${chat}`), list);
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

  // 切到一个对话、打开自动翻译时，这次读到的客户消息（最后 40 条）里还没翻的：
  // 最后 5 条照常自动翻（默认服务商，算额度）；更早的用免费的智谱或混元在后台慢慢补，最新的先翻，
  // 不算自动翻译的额度（shen 2026-10-29「之前的消息自动用智谱或者混元，免费的慢慢翻完」）。
  // 以前翻过、存着的不算在里面；同一次运行里切走再切回也会补（hs 是这次读到的，不只是第一次见到的）
  catchUp(accId, st, hs, opts, recent = st.recent) {
    const todo = hs.slice(-KEEP_VIEW).map((h) => st.items.get(h)).filter((it) => it && (it.text || isVoice(it)) && it.state === 'manual');
    for (const item of todo.slice(-BACKFILL)) this.queueAuto(accId, st, item, opts, recent);
    for (const item of todo.slice(0, -BACKFILL).reverse()) this.queueSlow(accId, item, recent);
  }

  // 语音转文字要花钱：更早的语音不在后台补，留着「转文字」按钮
  queueSlow(accId, item, recent) {
    if (item.state !== 'manual' || !item.text || item.text.length > AUTO_MAX_CHARS) return;
    item.state = 'queued';
    this.queue.push({ accId, h: item.h, slow: true, context: contextFrom(recent, item.h) });
  }

  // 打开自动翻译：当前对话里没翻的补上（同 catchUp）
  backfill(accId, opts) {
    const st = this.acc(accId);
    this.catchUp(accId, st, st.seen, { ...opts, auto: true });
    this.pump();
  }

  // 用户点“翻译”或“纠错”：不受自动翻译的上限限制。fix=true 用更仔细的校对提示词重翻（会替换手动改过的）
  manual(accId, h, fix = false) {
    const st = this.accs.get(accId);
    const item = st && st.items.get(h);
    if (!item || (!item.text && !(isVoice(item) && item.src)) || item.state === 'running' || item.state === 'skip') return false; // 补回来的旧译文还没补上原文的，不能重翻
    if (!item.text && !this.deps.transcribe) return false;
    if (item.state === 'queued') {
      // 在后台慢慢补的那条用户等不及点了：插到最前面马上翻
      const i = this.queue.findIndex((q) => q.accId === accId && q.h === h && q.slow);
      if (i < 0) return false;
      this.queue.splice(i, 1);
    }
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
    if (!item || !t.trim() || item.state === 'queued' || item.state === 'running' || item.state === 'skip') return false;
    item.tr = t; item.state = 'done'; item.err = ''; item.warn = []; item.edited = true; item.suggest = '';
    this.save(accId, item);
    this.onChange(accId);
    return true;
  }

  // 译文和原文写到磁盘（手动改的、纠错采用的也存）
  save(accId, item) {
    if (this.deps.store && item.ck) this.deps.store.putKey(accId, item.ck, item.k || textKey(item.text), { tr: item.tr, text: item.text, edited: item.edited, fixed: item.fixed });
  }

  // 补回来时没有原文的旧消息：原文对得上（hash 一样）就补到这条上，也补进磁盘的记录
  // quiet：读页面时一次补好几条，由 ingest 的返回值统一刷新
  fillItem(accId, item, text, quiet = false) {
    if (item.text || !item.k || !text.trim() || textKey(text) !== item.k) return false;
    item.text = text;
    if (this.deps.store && item.ck) this.deps.store.fillText(accId, item.ck, item.k, text);
    if (!quiet) this.onChange(accId);
    return true;
  }

  // 轻量号后台补原文（见 trfill.js）补进了磁盘：正显示着的同一条也补上，不用重开对话
  fillText(accId, ck, k, text) {
    const st = this.accs.get(accId);
    if (!st) return;
    for (const item of st.items.values()) if (item.ck === ck && item.k === k && !item.text) this.fillItem(accId, item, text);
  }

  // 翻译用的上下文：这条消息之前的最近几条（不传 h 就是整个对话最近几条，写回复时用）
  contextOf(accId, h) {
    const st = this.accs.get(accId);
    return st ? contextFrom(st.recent, h) : [];
  }

  // 同时最多翻几条：deps.parallel() 说了算（默认服务商是免费的智谱、混元时 3 条，付费的 1 条，见 translate-ipc.js）
  maxParallel() {
    const n = this.deps.parallel ? Number(this.deps.parallel()) : 1;
    return Number.isFinite(n) ? Math.min(MAX_PARALLEL, Math.max(1, Math.floor(n))) : 1;
  }

  // 从队列里取下一条开始翻，直到占满能同时翻的条数。
  // 后台慢慢补翻的排在最后，一次只翻一条：别的都翻完了、隔一会儿（SLOW_GAP）才翻下一条，隔的时候来了别的先翻别的
  pump() {
    const max = this.maxParallel();
    while (this.active < max) {
      const now = Date.now();
      const next = this.queue.find((q) => !q.slow && !q.taken && !(q.after > now));
      if (next) {
        this.stopSlowGap();
        this.start(next);
        continue;
      }
      // 刚才说忙的那条：到时间再来
      const later = this.queue.filter((q) => !q.slow && !q.taken).map((q) => q.after);
      if (later.length) {
        if (!this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = null; this.pump(); }, Math.max(0, Math.min(...later) - now));
        return;
      }
      if (this.active > 0) return;
      const slow = this.queue.find((q) => q.slow && !q.taken);
      if (!slow) return;
      if (!this.slowReady) {
        if (!this.slowTimer) this.slowTimer = setTimeout(() => { this.slowTimer = null; this.slowReady = true; this.pump(); }, this.deps.slowGap ?? SLOW_GAP);
        return;
      }
      this.slowReady = false;
      this.start(slow);
    }
  }

  stopSlowGap() {
    if (this.slowTimer) { clearTimeout(this.slowTimer); this.slowTimer = null; }
    this.slowReady = false;
  }

  start(job) {
    job.taken = true;
    this.active += 1;
    this.running = true;
    this.run(job).catch(() => {}).finally(() => {
      job.taken = false;
      this.active -= 1;
      this.running = this.active > 0;
      this.pump();
    });
  }

  // 翻一条（job 在队列里，翻完才拿掉；对方说忙就放回去，700 毫秒后再来）
  async run(job) {
    const done = () => { const i = this.queue.indexOf(job); if (i >= 0) this.queue.splice(i, 1); };
    const st = this.accs.get(job.accId);
    const item = st && st.items.get(job.h);
    if (!item || item.state !== 'queued') { done(); return; }
    item.state = 'running';
    this.onChange(job.accId);
    // 语音还没转文字：先转（转出来的文字就是原文），失败就报错，不翻
    if (isVoice(item) && !item.text) {
      let v;
      try { v = await this.deps.transcribe(job.accId, item.src, item.voice); } catch { v = { error: '转文字失败', kind: 'other' }; }
      if (this.accs.get(job.accId) !== st) { done(); return; } // 号被删了或重建了
      const heard = (t) => { if (this.deps.store && this.deps.store.putHeard && item.ck) this.deps.store.putHeard(job.accId, item.ck, item.k, t); };
      if (!(v && typeof v.text === 'string' && v.text.trim())) {
        done();
        if (v && v.kind === 'empty') heard(''); // 没听出话也付了钱：记下来，重启后不再自动转
        Object.assign(item, { state: 'error', err: (v && v.error) || '转文字失败', errKind: (v && v.kind) || 'other', errPid: (v && v.kind === 'auth' && v.providerId) || '' });
        this.onChange(job.accId);
        return;
      }
      item.text = v.text.trim().slice(0, 4000);
      heard(item.text); // 先存转出来的文字：翻译失败、重启后不再重转
      if (noWords(item.text)) {
        done();
        item.state = 'skip';
        this.onChange(job.accId);
        return;
      }
      this.onChange(job.accId);
    }
    let r;
    try { r = await this.deps.translate(item.text, { fix: !!job.fix, prev: job.fix ? item.tr : '', context: job.context, slow: !!job.slow }); } catch { r = { error: '翻译失败', kind: 'other' }; }
    if (r && r.kind === 'busy') {
      // 用户自己在翻、或付费的那条通道正忙：等一下再来（之前翻好的译文还在，状态先回到排队）
      if (this.queue.includes(job)) { item.state = 'queued'; job.after = Date.now() + BUSY_RETRY; }
      return;
    }
    done();
    if (this.accs.get(job.accId) !== st) return; // 号被删了或重建了
    if (r && r.text && job.fix && item.edited) { item.state = 'done'; item.suggest = r.text; item.err = ''; } // 手动改过的：纠错结果只当建议，让用户选
    else if (job.slow && !(r && r.text)) this.slowFailed(item);
    else if (r && r.text) { item.state = 'done'; item.tr = r.text; item.warn = r.warn || []; item.err = ''; item.edited = false; item.fixed = !!job.fix; item.suggest = ''; this.save(job.accId, item); }
    else { item.state = 'error'; item.err = (r && r.error) || '翻译失败'; item.errKind = (r && r.kind) || 'other'; item.errPid = (r && r.kind === 'auth' && r.providerId) || ''; }
    this.onChange(job.accId);
  }

  // 后台补翻失败（没有免费服务商、网络不通、超时、密钥不对……）：不显示报错，这条和排着的都退回「翻译」按钮，
  // 不再一条条去试（节点挂了时每条要等 30 秒，会一直占着翻译）；下次切到对话再补
  slowFailed(item) {
    item.state = 'manual';
    this.queue = this.queue.filter((q) => {
      if (!q.slow) return true;
      const it = this.accs.get(q.accId)?.items.get(q.h);
      if (it && it.state === 'queued') { it.state = 'manual'; this.onChange(q.accId); }
      return false;
    });
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
        .map(({ h, text, t, state, tr, err, errPid, warn, note, edited, fixed, suggest, voice }) => ({ h, text, t, state, tr, err, errPid: errPid || '', warn, note, edited: !!edited, fixed: !!fixed, suggest: suggest || '', voice: typeof voice === 'number' ? voice : null })),
    };
  }
}

module.exports = { FloatCore, fromLite, liteText, hashOf, chatOf, noWords, dropGist, PER_MINUTE, BACKFILL, AUTO_MAX_CHARS, VOICE_MAX_S };
