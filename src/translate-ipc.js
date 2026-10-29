// 翻译的接口：翻译设置、用户点的翻译、读当前对话自动翻译、面板“翻译”页、译文存放位置。
// 从 main.js 拆出来。会变的状态（activeId、page、translator 等）通过 ctx 读，见 main.js 里的 ctx。
const { app, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const proxy = require('./proxy');
const waPage = require('./wa-page');
const { matchChatCustomer } = require('./chatlang');
const { needsKey, extraContacts } = require('./translate');
const { TrStore, pickDir: pickTrDir, migrate: migrateTr } = require('./trstore');
const { FloatCore, fromLite, VOICE_MAX_S } = require('./floatcore');
const webVoice = require('./web-voice');
const { detectLang } = require('./langdetect');
const { makeOutTranslate } = require('./outcache');
const { DraftStore } = require('./drafts');
const { shortName } = require('./undo');
const ReplyLang = require('./shell/reply-lang');
const { friendly } = require('./errtext');

function setupTranslateIpc(ctx) {
  const {
    handleShell, onShell, findAcc, isLite, views, problems, parkedCustomer, panelShown, liteChat,
  } = ctx;

  // 翻译请求用单独的内存会话，和任何 WhatsApp 账号都不共用 cookie 和代理
  function translateSession(local) {
    return session.fromPartition(local ? 'wa-translate-local' : 'wa-translate');
  }
  async function applyTranslateNet() {
    const net = ctx.translator.load().network;
    const remote = translateSession(false);
    if (net.mode === 'proxy' && net.proxyUrl) await remote.setProxy({ proxyRules: net.proxyUrl, proxyBypassRules: '<local>' });
    else await remote.setProxy({ mode: net.mode === 'direct' ? 'direct' : 'system' });
    await translateSession(true).setProxy({ mode: 'direct' }); // 本机模型不走代理
  }
  const trState = () => ({ config: ctx.translator.publicConfig(), modes: ctx.modeStore.list() });
  handleShell('tr:config', () => trState());
  // 密钥填好、测通，或换了默认服务后：之前因为“没填密钥 / 密钥不对”失败的收到消息自动重翻（别的原因失败的不动）
  // changedId：刚改的服务商。报错的服务商是它、或已经不是默认服务了，才重翻；默认服务还没密钥就不翻
  function retryKeyErrors(changedId = '') {
    if (!floatCore) return;
    const cfg = ctx.translator.load();
    const primary = ctx.translator.provider(cfg.primaryId);
    if (!primary || needsKey(primary)) return;
    const touched = floatCore.retryKeyErrors({ dailyCap: cfg.dailyCap, match: (pid) => !pid || pid === changedId || pid !== primary.id });
    if (touched.length) pushFloat();
  }
  handleShell('tr:provider:save', (data) => {
    const r = ctx.translator.saveProvider(data);
    if (r.ok && data && typeof data.key === 'string' && data.key.trim()) retryKeyErrors(r.id);
    pushFloat();
    return { ...r, ...trState() };
  });
  handleShell('tr:provider:delete', (id) => {
    const snap = typeof id === 'string' ? ctx.translator.deleteProvider(id) : null;
    if (snap) {
      ctx.offerUndo({ kind: 'tr', where: 'body', text: `已删除「${shortName(snap.provider.name)}」` }, () => {
        if (ctx.translator.restoreProvider(snap)) { retryKeyErrors(snap.provider.id); pushFloat(); }
      });
    }
    pushFloat();
    return trState();
  });
  handleShell('tr:fix:zhipu', () => ({ ...ctx.translator.addZhipuForFix(), ...trState() }));
  handleShell('tr:roles', (roles) => { ctx.translator.setRoles(roles && typeof roles === 'object' ? roles : {}); retryKeyErrors(); pushFloat(); return trState(); });
  handleShell('tr:role', (text) => ({ ...ctx.translator.setRolePrompt(text), ...trState() }));
  handleShell('tr:deepl-cap', (n) => ({ ...ctx.translator.setDeeplCap(n), ...trState() }));
  handleShell('tr:wig', (on) => ({ ...ctx.translator.setWigTerms(on === true), ...trState() }));
  handleShell('tr:lash', (on) => ({ ...ctx.translator.setLashTerms(on === true), ...trState() }));
  handleShell('tr:network', async (net) => {
    // 翻译代理不能和任何账号的代理是同一个地址端口：否则会共用出口，带密码的代理还会被自动填上那个号的账号密码
    if (net && net.mode === 'proxy') {
      let u = null;
      try { u = new URL(String(net.proxyUrl || '').trim()); } catch {}
      const norm = (h) => { const x = String(h || '').replace(/^\[|\]$/g, '').toLowerCase(); return ['localhost', '127.0.0.1', '::1'].includes(x) ? 'loopback' : x; };
      const same = u && ctx.accounts.some((a) => { const p = proxy.parse(a.proxy); return p && !p.error && norm(p.host) === norm(u.hostname) && String(p.port) === String(u.port); });
      if (same) return { error: '这个代理端口已经给某个账号用了，翻译请用别的端口（或选“跟随系统代理”）', ...trState() };
    }
    const r = ctx.translator.setNetwork(net && typeof net === 'object' ? net : {});
    if (r.ok) { try { await applyTranslateNet(); } catch { return { error: '代理设置没生效', ...trState() }; } }
    return { ...r, ...trState() };
  });
  handleShell('tr:test', async (id) => {
    if (typeof id !== 'string') return { error: '找不到这个服务商' };
    // 和用户点的翻译一样排在自动翻译前面（刚保存密钥时自动重翻可能正在跑）
    const r = await userTranslate(null, () => ctx.translator.test(id));
    if (r && r.ok) retryKeyErrors(id);
    return r;
  });
  // 用户点的翻译（面板、悬浮窗写中文）优先：自动翻译正在跑时等它这一条翻完（最多 35 秒），
  // 等的这段时间自动翻译不再取下一条。等的时候点“取消”只取消自己，不打断自动翻译那条。
  const userTr = { waiting: 0, running: false, gen: 0, slow: false }; // slow：正在后台补翻更早的消息（用户一点就让开）
  // run：真正要做的事（默认翻译；测试服务商也走这里排队）
  async function userTranslate(args, run = (a) => ctx.translator.translate(a)) {
    const gen = userTr.gen;
    const until = Date.now() + 35000;
    userTr.waiting += 1;
    if (userTr.slow) ctx.translator.cancel(); // 后台补翻的那条不急：打断它，用户的先翻，它回去重新排
    try {
      for (;;) {
        if (userTr.gen !== gen) return { error: '已取消', kind: 'cancel' };
        if (!ctx.translator.busy) {
          userTr.running = true;
          let r;
          try { r = await run(args); } finally { userTr.running = false; }
          // 面板和悬浮窗同时点：后一个继续等
          if (!(r && r.kind === 'busy')) return r;
        }
        if (Date.now() > until) return { error: '上一段还在翻译', kind: 'busy' };
        await new Promise((res) => setTimeout(res, 250));
      }
    } finally {
      userTr.waiting -= 1;
    }
  }
  function userCancel() {
    if (userTr.running) return ctx.translator.cancel();
    userTr.gen += 1;
    return true;
  }
  // 发出的翻译：同一句中文、同一种语言、同一个模式翻过就直接用记下的译文（见 outcache.js）；fresh = 用户点了“重新翻译”
  // 角色设定（固定译法，含打开的假发词汇）也算进记录的键：改了固定译法或开关假发词汇，老译文不再用
  const outTranslate = makeOutTranslate({ store: () => trStore, translate: (a) => userTranslate(a), warnOf: extraContacts, extra: () => ctx.translator.roleText() });
  // 服务商太忙要等着重试时，告诉界面还要等几毫秒（按钮上倒计时）；lane：dock = 工作台，page = 翻译页
  const waitTo = (lane) => (ms) => {
    const wc = ctx.shellView && ctx.shellView.webContents;
    if (wc && !wc.isDestroyed()) wc.send('tr:wait', { lane, ms });
  };
  handleShell('tr:run', async ({ text, modeId, target, source, ctxAccount, fix, draft, fresh } = {}) => {
    const onWait = waitTo('dock');
    // 工作台写回复：带上当前对话最近几条当上下文（只在请求的号还是当前号时）
    const context = typeof ctxAccount === 'string' && ctxAccount === ctx.activeId && floatCore ? floatCore.contextOf(ctx.activeId) : undefined;
    // __back：回译成中文核对，用固定的忠实翻译提示词
    // 纠错要发的译文：内置校对提示词，对照中文原文和上下文改；设了纠错服务商就用它
    if (fix === true && typeof draft === 'string' && draft.trim()) return userTranslate({ text, mode: FIX_OUT, target, source, context, draft, fix: true, onWait });
    let mode = modeId === '__back' ? { prompt: '把用户的文字忠实地翻译成中文，不增不减，不润色。', temperature: 0 }
      : typeof modeId === 'string' ? ctx.modeStore.get(modeId) : null;
    if (modeId === '__back') return userTranslate({ text, mode, target, source, onWait });
    return outTranslate({ text, mode, target, source, context, onWait }, fresh === true);
  });
  handleShell('tr:cancel', () => userCancel());
  // 左侧栏「翻译」页：不跟任何对话绑定，忠实翻译，不带上下文、不用发出译文的缓存。
  // providerId = 这一栏选的模型（只用它，不换备用，纠错也用它）。没指定原文语言时顺便返回本机认出来的语言（只用来显示）
  // 用单独的翻译通道（translator.lane()）：不让工作台的自动翻译排队等，也不等它
  let pageLane = null;
  const pageTr = () => {
    if (!pageLane || Object.getPrototypeOf(pageLane) !== ctx.translator) pageLane = ctx.translator.lane();
    return pageLane;
  };
  const PAGE_MODE = { prompt: '把用户的文字忠实地翻译成{目标语言}。保留数字、链接、表情和换行，不增不减内容。', temperature: 0.2 };
  handleShell('tr:page', async ({ text, source, target, providerId, fix, draft } = {}) => {
    if (typeof text !== 'string') return { error: '先放一段要翻译的文字', kind: 'input' };
    const detected = source ? '' : detectLang(text.slice(0, 2000));
    const pid = typeof providerId === 'string' ? providerId : '';
    // 纠错也用这一栏选的模型（按钮就在模型旁边）
    const r = fix === true && typeof draft === 'string' && draft.trim()
      ? await pageTr().translate({ text, mode: FIX_OUT, target, source, draft, fix: true, providerId: pid, onWait: waitTo('page') })
      : await pageTr().translate({ text, mode: PAGE_MODE, target, source, providerId: pid, onWait: waitTo('page') });
    return { ...r, detected };
  });
  handleShell('tr:page:cancel', () => pageTr().cancel());
  // 聊天里选中文字后的悬浮译文窗（sel-translate.js、轻量号聊天页）：外文翻成中文，中文翻成客户的语言（和工作台“自动”一样）。
  // 忠实翻译、不带上下文；同一句翻过的直接用记下的译文
  async function selTranslate(text) {
    if (typeof text !== 'string' || !text.trim()) return { error: '没有选中文字', kind: 'input' };
    const t = text.trim().slice(0, 4000);
    const zh = ReplyLang.isChinese(t);
    const st = floatState();
    const target = zh ? (st.autoTarget && st.autoTarget !== '中文' ? st.autoTarget : '英语') : '中文';
    const r = await outTranslate({ text: t, mode: PAGE_MODE, target, source: zh ? '中文' : '' });
    return { ...r, target };
  }
  handleShell('seltr:translate', ({ accountId, text } = {}) => (accountId === ctx.activeId ? selTranslate(text) : { error: '当前账号变了，请重新选', kind: 'input' }));
  // 当前对话对上的客户（用客户填的语言翻译）。只在用户点翻译时读一次对话标题，隔离环境只读，不碰页面
  const chatCustomer = (accId, title) => matchChatCustomer(ctx.customerStore.list().filter((c) => !parkedCustomer(c)), accId, title);
  handleShell('tr:chatlang', async (accountId) => {
    const acc = findAcc(accountId);
    if (!acc || accountId !== ctx.activeId || ctx.page !== 'account' || ctx.locked || isLite(acc) || problems.has(acc.id)) return null;
    const view = views.get(acc.id);
    if (!view || view.webContents.isDestroyed()) return null;
    const r = await waPage.readOpenChat(view.webContents);
    if (!r.ok || accountId !== ctx.activeId) return null;
    const c = chatCustomer(acc.id, r.title);
    return { title: r.title, lang: c ? c.lang : '', name: c ? c.name : '' };
  });
  handleShell('tr:lang', ({ accountId, lang } = {}) => { if (findAcc(accountId)) ctx.translator.setAccountLang(accountId, lang); return trState(); });
  handleShell('tmode:save', (data) => {
    if (!data || typeof data !== 'object') return { error: '数据不对' };
    const rec = ctx.modeStore.upsert({ id: data.id, name: data.name, direction: data.direction, prompt: data.prompt, temperature: data.temperature });
    return rec ? { ok: true, id: rec.id, ...trState() } : { error: ctx.modeStore.list().length >= 200 ? '最多 200 个模式' : '名字和提示词都要填', ...trState() };
  });
  handleShell('tmode:delete', (id) => {
    const old = typeof id === 'string' ? ctx.modeStore.remove(id) : false;
    if (old) {
      ctx.offerUndo({ kind: 'tr', where: 'body', text: `已删除「${shortName(old.name)}」` }, () => { ctx.modeStore.restore(old); pushFloat(); });
    }
    return trState();
  });

  // ---- 悬浮翻译窗（shen 2026-10-24 选的方案 B） ----
  // 只读当前打开的对话（隔离环境，见 wa-page.js 的 readOpenChat），不改页面、不碰输入框。
  // 读当前对话、自动翻译收到的消息，给右侧工作台的「翻译」页用（原来的悬浮翻译窗已经删掉，名字里的 float 是历史沿用）
  let floatTimer = null;
  let floatFails = 0;
  let floatReadable = 'loading'; // ok | nochat | qr | unreadable | loading
  let floatCore = null;
  let trStore = null; // 收到的消息的译文，永久存在磁盘上
  let drafts = null; // 工作台回复框没发的草稿，每个对话一份（见 drafts.js）
  const draftStore = () => drafts || (drafts = new DraftStore(path.join(app.getPath('userData'), 'reply-drafts.json')));
  // 自动翻译默认开，只有手动关掉的号是 false
  const floatAuto = (id) => !!id && ctx.translator.load().accountAuto[id] !== false;
  // 读当前对话的条件：右侧面板开着（翻译页显示收到的消息，其他页给“翻译”记未读）
  const readerOn = () => panelShown();
  let floatBusy = false;
  function floatInMode() {
    const cfg = ctx.translator.load();
    const list = ctx.modeStore.list().filter((m) => m.direction === 'in' || m.direction === 'both');
    return list.find((m) => m.id === cfg.floatInMode) || list[0] || null;
  }
  // 纠错（AI 校对）的内置提示词：[原文] = <text>，[译文] = <draft>，[上下文] = <context>
  const FIX_IN = {
    prompt: '你是翻译校对员。<text> 里是客户原文，<draft> 里是当前中文译文，<context> 里是最近聊天记录，只用来理解意思，不要翻译。'
      + '对照原文和上下文检查译文：错译、漏译、多译、语气不对，人名、数字、金额、日期、型号是否正确，俚语、缩写、错别字是否理解对。'
      + '只输出改好的中文译文，不要解释；如果已经正确，原样输出。',
    temperature: 0.2,
  };
  const FIX_OUT = {
    prompt: '你是{目标语言}母语的校对员。<text> 里是原文，<draft> 里是{目标语言}译文，<context> 里是最近聊天记录，只用来理解意思。'
      + '检查译文是否准确表达原文、有没有漏译多译，修正语法和拼写，让说法自然、符合当地人聊天习惯，保持原来的语气。'
      + '保留数字、链接、表情和换行，不增加任何承诺。只输出改好的译文，不要解释。',
    temperature: 0.2,
  };
  // ---- 语音转文字（客户发来的语音） ----
  // 轻量号：后台进程下载语音；网页号：读 WhatsApp 本机存储里的下载信息，用这个号自己的会话下载解密（见 web-voice.js）。
  // 都只走这个号自己的代理 → 界面进程解码成 16 kHz 单声道（主进程没有 Opus 解码器，Chromium 自带）→ 智谱转文字。
  // 音频只在内存里，不写盘
  let decodeN = 0;
  const decodes = new Map(); // n -> { resolve, reject, timer }
  function decodeVoice(bytes) {
    const wc = ctx.shellView && ctx.shellView.webContents;
    if (!wc || wc.isDestroyed()) return Promise.reject(new Error('界面没准备好'));
    return new Promise((resolve, reject) => {
      decodeN += 1;
      const n = decodeN;
      const timer = setTimeout(() => { decodes.delete(n); reject(new Error('解码超时')); }, 30000);
      decodes.set(n, { resolve, reject, timer });
      wc.send('voice:decode', { n, bytes });
    });
  }
  onShell('voice:decoded', (n, r) => {
    const d = decodes.get(n);
    if (!d) return;
    decodes.delete(n);
    clearTimeout(d.timer);
    if (r && r.pcm instanceof Int16Array && r.pcm.length) d.resolve(r.pcm); else d.reject(new Error('解不开'));
  });
  // 网页号页面重新加载后：之前连续读不到语音的记录清掉（见 FloatCore.voiceReset）
  const hooked = new WeakSet();
  async function webVoiceBytes(acc, src, opts) {
    const view = views.get(acc.id);
    const wc = view && view.webContents;
    if (!wc || wc.isDestroyed()) return { error: '页面还没准备好，请稍后重试', kind: 'other' };
    if (!hooked.has(wc)) { hooked.add(wc); wc.on('did-finish-load', () => { if (floatCore) floatCore.voiceReset(acc.id); }); }
    const ses = session.fromPartition(`persist:wa-${acc.id}`);
    const r = await webVoice.fetchVoice(wc, (url, o) => ses.fetch(url, o), src.dataId, { accId: acc.id, maxSeconds: opts && opts.auto ? VOICE_MAX_S : 0 });
    if (r.ok) return r;
    const seconds = r.seconds || 0;
    if (r.kind === 'long') return { kind: 'long', seconds };
    if (r.kind === 'expired') return { error: '语音已过期，在 WhatsApp 里播放一次后重试', kind: 'expired', code: r.code, seconds };
    if (r.kind === 'network') return { error: friendly(r.error, '下载语音失败，请重试').text, kind: 'network', code: r.code, seconds };
    if (r.kind === 'nomedia' || r.kind === 'badfile') return { error: '读不到这条语音，请在 WhatsApp 里听', kind: r.kind, code: r.code, seconds };
    // 页面正在加载：自动转的退回按钮，下次再排（不报错）
    if (opts && opts.auto) return { kind: 'later' };
    return { error: '页面还没准备好，请稍后重试', kind: 'other', code: r.code, seconds };
  }
  async function transcribeVoice(accId, src, opts = {}) {
    const acc = findAcc(accId);
    let bytes;
    let seconds = 0;
    if (acc && !isLite(acc) && src && typeof src.dataId === 'string') {
      const r = await webVoiceBytes(acc, src, opts);
      if (!r.ok) return r;
      bytes = r.data;
      seconds = r.seconds;
    } else {
      const host = ctx.liteHost;
      if (!host || !src || typeof src.jid !== 'string' || typeof src.id !== 'string') return { error: '找不到这条语音，请在手机上听', kind: 'other' };
      try { bytes = await host.voice(accId, src.jid, src.id); } catch (e) { return { error: friendly(e, '下载语音失败，请重试').text, kind: 'network' }; }
    }
    let pcm;
    try { pcm = await decodeVoice(bytes); } catch { return { error: acc && !isLite(acc) ? '这条语音打不开，请在 WhatsApp 里听' : '这条语音打不开，请在手机上听', kind: 'other', seconds }; } finally { if (Buffer.isBuffer(bytes)) bytes.fill(0); }
    const r = await ctx.translator.transcribe(pcm);
    pcm.fill(0);
    return seconds ? { ...r, seconds } : r;
  }

  // 付费的备用一次只翻一条：等主通道空下来、用户自己的翻译先翻（最多等 60 秒）
  async function onMainLane(args) {
    const until = Date.now() + 60000;
    for (;;) {
      if (!ctx.translator.busy && !userTr.waiting && !userTr.running) {
        const r = await ctx.translator.translate(args);
        if (!(r && r.kind === 'busy')) return r;
      }
      if (Date.now() > until) return { error: '上一段还在翻译', kind: 'busy' };
      await new Promise((res) => setTimeout(res, 250));
    }
  }
  function setupFloatCore() {
    // 启动时同步定位置（D 盘能用就是 D 盘，否则 C），D 盘能用而 C 盘还有译文就搬过去一次；只往 D 搬，选了 C 不动 D 盘的
    const oldTrDir = path.join(app.getPath('userData'), 'translations');
    const dir = pickTrDir(oldTrDir);
    if (dir !== oldTrDir) {
      try { migrateTr(oldTrDir, dir); } catch (e) { console.warn(`译文搬家失败：${e.message}`); }
      console.log(`译文存在：${dir}`);
    }
    trStore = new TrStore(dir);
    floatCore = new FloatCore({
      store: trStore,
      keepGist: () => { const m = floatInMode(); return !!m && m.prompt.includes('要点'); },
      transcribe: (accId, src, _seconds, opts) => transcribeVoice(accId, src, opts),
      translate: (text, { fix, context, prev, slow } = {}) => {
        // 纠错：不用平时的模式，用内置的校对提示词，对照现在的译文和上下文改
        const draft = fix && typeof prev === 'string' ? prev : '';
        const mode = fix ? (draft ? FIX_IN : { prompt: '结合上下文，把用户的文字准确地翻译成中文。', temperature: 0.2 }) : floatInMode();
        if (!mode) return Promise.resolve({ error: '没有“收到”方向的翻译模式', kind: 'input' });
        // 默认服务商是免费的（智谱、混元）：同时发给有密钥的免费服务商，用先翻出来的；各走各的通道，
        // 不占用户翻译用的那条，可以同时翻好几条（见 parallel）。都失败了才用付费的备用，一次一条
        if (!slow && !fix && ctx.translator.raceSet().length) {
          return ctx.translator.raceFree({ text, mode, target: '中文', context }, { paid: onMainLane });
        }
        // 用户点的翻译在等：先让它
        if (userTr.waiting || userTr.running) return Promise.resolve({ error: '让用户先翻', kind: 'busy' });
        // 在后台慢慢补翻的更早的消息：只用免费的智谱或混元，都没填密钥就不翻（留着「翻译」按钮）
        const free = slow ? ctx.translator.freeProvider() : null;
        if (slow && !free) return Promise.resolve({ error: '没有免费的翻译服务', kind: 'nofree' });
        if (!slow) return ctx.translator.translate({ text, mode, target: '中文', context, draft, fix: !!fix });
        userTr.slow = true;
        return ctx.translator.translate({ text, mode, target: '中文', context, providerId: free.id })
          .then((r) => (r && r.kind === 'cancel' ? { error: '让用户先翻', kind: 'busy' } : r)) // 被用户的翻译打断：等一下再排
          .finally(() => { userTr.slow = false; });
      },
    });
    // 同时翻几条：用免费服务商时 3 条，付费的（DeepL 等）一次一条
    floatCore.deps.parallel = () => (ctx.translator.raceSet().length ? 3 : 1);
    floatCore.onChange = (accId) => { if (accId === ctx.activeId) pushFloat(); };
  }
  // 读页面的条件：悬浮窗开着、在账号页、窗口看得见、没锁、号正常、页面不在加载
  function floatCanRead() {
    if (!readerOn() || ctx.page !== 'account' || ctx.locked || !ctx.win || !ctx.win.isVisible() || ctx.win.isMinimized()) return null;
    const acc = findAcc(ctx.activeId);
    if (!acc || problems.has(acc.id)) return null;
    // 轻量号：消息本来就在软件里（后台进程推来的当前对话），不用读网页
    if (isLite(acc)) return liteChat(acc.id).status === 'open' ? { acc, lite: true } : null;
    const view = views.get(acc.id);
    if (!view || view.webContents.isDestroyed() || view.webContents.isLoading()) return null;
    return { acc, wc: view.webContents };
  }
  async function floatTick() {
    floatTimer = null;
    if (!readerOn() || floatBusy) return;
    const target = floatCanRead();
    let delay = 2000;
    let readAt = 0;
    if (target) {
      floatBusy = true;
      readAt = Date.now();
      let r;
      try {
        if (target.lite) { const lc = liteChat(target.acc.id); r = fromLite(lc.view, lc.jid); } else r = await waPage.readOpenChat(target.wc);
      } finally { floatBusy = false; }
      if (!readerOn() || target.acc.id !== ctx.activeId) { scheduleFloat(500); return; }
      if (r.why === 'wait') { scheduleFloat(300); return; } // 轻量号刚点开对话，消息还没推过来
      if (r.ok) {
        // 打开的对话里还没有消息也算读到了（悬浮窗会提示没有文字消息）
        floatFails = 0;
        const was = floatReadable;
        floatReadable = 'ok';
        const cfg = ctx.translator.load();
        let changed = floatCore.ingest(target.acc.id, r, { auto: floatAuto(target.acc.id), dailyCap: cfg.dailyCap });
        if (changed) changed = rememberDetected(target.acc.id) || changed;
        if (changed || was !== 'ok') pushFloat();
      } else if (r.why === 'nochat' || r.why === 'qr') {
        // 没打开对话，或者还在二维码页没登录：不算失败，3 秒后再看
        floatFails = 0;
        delay = 3000;
        if (floatReadable !== r.why) { floatReadable = r.why; pushFloat(); }
      } else {
        // 读不到，或对话里有消息行但一条都认不出来：连续 3 次就放慢到 30 秒一次，并提示
        floatFails += 1;
        if (floatFails >= 3) {
          delay = 30000;
          if (floatReadable !== 'unreadable') { floatReadable = 'unreadable'; pushFloat(); }
        }
      }
    }
    // 网页号读到了对话：不干等 2 秒，页面上对话一有变化（客户发来新消息）就再读；没变化最多等 2 秒再读一次
    if (target && !target.lite && delay === 2000 && floatReadable === 'ok') waitFloat(target.wc, readAt);
    else scheduleFloat(delay);
  }
  const READ_GAP = 150; // 两次读之间至少隔 150 毫秒（页面一直在变时也不会一直读）
  let floatWaitGen = 0;
  let floatWaiting = false; // 正在等页面变化（等完会自己安排下一次读）
  let floatWatchWc = null; // 在看着哪个页面（面板关了就停）
  function waitFloat(wc, readAt) {
    if (floatTimer) clearTimeout(floatTimer);
    floatTimer = null;
    const gen = ++floatWaitGen;
    floatWaiting = true;
    floatWatchWc = wc;
    waPage.waitChatChange(wc, 2000).then(() => {
      if (gen !== floatWaitGen) return; // 等的时候已经另外安排了（换号、开关面板……）
      floatWaiting = false;
      scheduleFloat(Math.max(0, READ_GAP - (Date.now() - readAt)));
    });
  }
  function scheduleFloat(ms) {
    floatWaitGen += 1;
    floatWaiting = false;
    if (floatTimer) clearTimeout(floatTimer);
    floatTimer = readerOn() ? setTimeout(floatTick, ms) : null;
  }
  // 从最近收到的几条认出客户用的语言，记在这个对话上（手动选过的不改）
  function rememberDetected(accId) {
    const v = floatCore.viewOf(accId);
    if (!v.chatKey || !v.items.length) return false;
    const lang = detectLang(v.items.slice(-5).map((it) => it.text).join('\n'));
    if (!lang || lang === '中文') return false;
    return ctx.translator.setChatLang(`${accId}:${v.chatKey}`, lang, 'detected');
  }
  // 发出的目标语言和它的来源：手动选的 > 客户名单里填的 > 认出来的 > 这个号的默认语言
  function outTarget(acc, v) {
    const key = acc && v.chatKey ? `${acc.id}:${v.chatKey}` : '';
    const kept = key ? ctx.translator.chatLang(key) : null;
    const chat = acc && v.title ? chatCustomer(acc.id, v.title) : null;
    if (kept && kept.src === 'manual') return { lang: kept.lang, from: 'manual', name: chat ? chat.name : '', auto: autoTarget(acc, chat, null) };
    return { ...autoTarget(acc, chat, kept), auto: null };
  }
  // “自动”会翻成哪种：客户名单里填的 > 从客户消息认出来的 > 这个号的默认语言 > 英语
  function autoTarget(acc, chat, kept) {
    const cfg = ctx.translator.load();
    if (chat) return { lang: chat.lang, from: 'customer', name: chat.name };
    if (kept && kept.src === 'detected') return { lang: kept.lang, from: 'detected', name: '' };
    return { lang: (acc && cfg.accountLang[acc.id]) || '英语', from: 'default', name: '' };
  }
  function floatState() {
    const cfg = ctx.translator.load();
    const acc = findAcc(ctx.activeId);
    const modes = ctx.modeStore.list();
    const v = acc ? floatCore.viewOf(acc.id) : { title: '', items: [], paused: '' };
    const primary = ctx.translator.provider(cfg.primaryId);
    const inMode = floatInMode();
    const out = outTarget(acc, v);
    return {
      accountId: acc ? acc.id : '',
      accountName: acc ? acc.name : '',
      lite: !!(acc && isLite(acc)),
      readable: floatReadable,
      title: v.title,
      items: v.items,
      paused: floatAuto(acc && acc.id) ? v.paused : '',
      today: v.today || 0,
      auto: !!(acc && floatAuto(acc.id)),
      dailyCap: cfg.dailyCap,
      hasProvider: !!primary,
      // 默认翻译服务还没填密钥：翻译页顶上显示黄条和“去填密钥”
      needKey: primary && needsKey(primary) ? { id: primary.id, name: primary.name || '翻译服务', others: (cfg.providers || []).some((p) => p.id !== primary.id && !needsKey(p)) } : null,
      providerName: primary ? primary.name : '',
      primaryId: primary ? primary.id : '',
      fallbackId: cfg.fallbackId || '',
      providers: (cfg.providers || []).map((p) => ({ id: p.id, name: p.name, model: p.model || '' })), // 翻译页的“换模型”下拉，不带密钥
      engine: primary ? (primary.model || primary.name) : '',
      modes: {
        out: modes.filter((m) => m.direction !== 'in').map(({ id, name }) => ({ id, name })),
        in: modes.filter((m) => m.direction !== 'out').map(({ id, name }) => ({ id, name })),
      },
      inModeId: inMode ? inMode.id : '',
      langs: ctx.translator.publicConfig().langs,
      target: out.lang,
      targetSrc: out.from, // manual | customer | detected | default
      autoTarget: (out.auto || out).lang, // “自动选择”时中文翻成的语言（客户的语言）
      accountLang: (acc && cfg.accountLang[acc.id]) || '', // 读不到对话时，手动选的语言记在号上
      canRemember: !!v.chatKey, // 认得出是哪个对话，才能把语言记在对话上
      chatKey: v.chatKey || '', // 回复框的草稿按它存（对话的 hash，不含号码）
      draft: acc && v.chatKey ? draftStore().get(acc.id, v.chatKey) : null, // 这个对话上次没发的草稿
    };
  }
  function pushFloat() {
    if (!panelShown() || !ctx.shellView || ctx.shellView.webContents.isDestroyed()) return;
    ctx.shellView.webContents.send('dock:state', floatState());
  }
  let floatLastAcc = null;
  // 每次重新布局时调用（切号、面板开关、回到账号页、解锁）：按需要开始或重新开始读当前对话
  function layoutFloat() {
    // 换了号：重新开始读，面板只显示新号的内容
    if (readerOn() && ctx.activeId !== floatLastAcc) {
      floatLastAcc = ctx.activeId;
      floatFails = 0;
      floatReadable = 'loading';
      pushFloat();
      scheduleFloat(200);
    } else if (readerOn() && !floatTimer && !floatBusy && !floatWaiting) scheduleFloat(300); // 面板刚打开、回到账号页、解锁
    if (!readerOn()) { // 面板关了：不再等页面变化，页面里也停止看着
      floatLastAcc = null; floatWaitGen += 1; floatWaiting = false;
      if (floatWatchWc) { waPage.stopChatWatch(floatWatchWc); floatWatchWc = null; }
    }
  }
  function readerItem(h, fix) {
    if (typeof h !== 'string' || !ctx.activeId) return null;
    floatCore.manual(ctx.activeId, h, fix === true);
    pushFloat();
    return { ok: true };
  }
  function readerAuto(on) {
    const acc = findAcc(ctx.activeId);
    if (!acc) return null;
    const cfg = ctx.translator.load();
    ctx.translator.setFloat({ accId: acc.id, auto: on === true });
    if (on) floatCore.backfill(acc.id, { dailyCap: cfg.dailyCap });
    pushFloat();
    return { ok: true };
  }
  const readerInMode = (id) => { if (typeof id === 'string' && ctx.modeStore.get(id)) ctx.translator.setFloat({ inMode: id }); pushFloat(); return true; };
  // 面板“翻译”页用的同一套（只接受软件界面发来的）
  handleShell('dock:get', () => floatState());
  handleShell('dock:item', ({ h, fix } = {}) => readerItem(h, fix));
  handleShell('dock:suggest', ({ accountId, h, take } = {}) => (accountId === ctx.activeId && typeof h === 'string' ? floatCore.suggestion(ctx.activeId, h, take === true) : false));
  handleShell('dock:edit', ({ accountId, h, text } = {}) => {
    if (accountId !== ctx.activeId || typeof h !== 'string' || typeof text !== 'string') return false;
    return floatCore.edit(ctx.activeId, h, text);
  });
  handleShell('dock:auto', readerAuto);
  handleShell('dock:inmode', readerInMode);
  // 手动选这个对话的客户语言，记住；lang 为空 = 忘掉，回到自动。对话已经换了就不记
  handleShell('dock:lang', ({ accountId, title, lang } = {}) => {
    const acc = findAcc(accountId);
    if (!acc || accountId !== ctx.activeId) return floatState();
    const v = floatCore.viewOf(acc.id);
    if (v.chatKey && v.title === title) ctx.translator.setChatLang(`${acc.id}:${v.chatKey}`, lang || '', 'manual');
    else if (!v.chatKey) ctx.translator.setAccountLang(acc.id, lang || ''); // 读不到对话：改这个号的默认语言，空 = 回到自动
    pushFloat();
    return floatState();
  });
  // 回复框的草稿：写了、翻了、改了就存；清空就删。对话可能已经切走了（切走时才把上一个对话的写下来），所以按 chatKey 存，不看当前对话
  onShell('dock:draft', ({ accountId, chatKey, draft } = {}) => {
    if (!findAcc(accountId)) return;
    draftStore().set(accountId, chatKey, draft);
  });
  // 设置 › 翻译 里按号拨的自动翻译开关（和面板、悬浮窗里的是同一个设置）
  handleShell('tr:auto', ({ accountId, on } = {}) => {
    const acc = findAcc(accountId);
    if (!acc) return trState();
    ctx.translator.setFloat({ accId: acc.id, auto: on === true });
    if (on === true) floatCore.backfill(acc.id, { dailyCap: ctx.translator.load().dailyCap });
    pushFloat();
    return trState();
  });
  handleShell('tr:dailycap', (n) => { ctx.translator.setFloat({ dailyCap: n }); pushFloat(); return trState(); });
  onShell('trdir:open', () => {
    if (!trStore) return;
    const dir = trStore.dir;
    try { fs.mkdirSync(dir, { recursive: true }); if (!fs.statSync(dir).isDirectory()) return; } catch { return; }
    shell.openPath(dir);
  });

  return {
    translateSession,
    applyTranslateNet,
    setupFloatCore,
    pushFloat,
    layoutFloat,
    selTranslate,
    // MCP translate_text 用：和用户点的翻译同一条队列
    userTranslate,
    // 轻量号的对话有变化（新消息、换对话）：马上读一次，不等 2 秒
    liteChanged(id) { if (id === ctx.activeId && readerOn() && !floatBusy) scheduleFloat(50); },
    get floatCore() { return floatCore; },
    get trStore() { return trStore; },
    get drafts() { return drafts; },
    // 删号：这个号的草稿一起删
    forgetDrafts(id) { draftStore().forgetAccount(id); },
  };
}

module.exports = { setupTranslateIpc };
