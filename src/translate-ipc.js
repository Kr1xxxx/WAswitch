// 翻译和悬浮翻译窗的接口：翻译设置、用户点的翻译、读当前对话自动翻译、悬浮窗和面板“翻译”页、译文存放位置。
// 从 main.js 拆出来。会变的状态（activeId、page、translator 等）通过 ctx 读，见 main.js 里的 ctx。
const { app, session, ipcMain, clipboard, shell, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');
const proxy = require('./proxy');
const waPage = require('./wa-page');
const { matchChatCustomer } = require('./chatlang');
const { needsKey } = require('./translate');
const { TrStore, pickDir: pickTrDir, migrate: migrateTr, dirInfo: trDirInfo } = require('./trstore');
const { FloatCore, fromLite } = require('./floatcore');
const { detectLang } = require('./langdetect');

function setupTranslateIpc(ctx) {
  const {
    handleShell, onShell, findAcc, isLite, views, problems, parkedCustomer, panelShown, liteChat,
    layout, pushState, focusActive, lockLocalPage, insertText,
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
  handleShell('tr:provider:delete', (id) => { if (typeof id === 'string') ctx.translator.deleteProvider(id); pushFloat(); return trState(); });
  handleShell('tr:fix:zhipu', () => ({ ...ctx.translator.addZhipuForFix(), ...trState() }));
  handleShell('tr:roles', (roles) => { ctx.translator.setRoles(roles && typeof roles === 'object' ? roles : {}); retryKeyErrors(); pushFloat(); return trState(); });
  handleShell('tr:role', (text) => ({ ...ctx.translator.setRolePrompt(text), ...trState() }));
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
  const userTr = { waiting: 0, running: false, gen: 0 };
  // run：真正要做的事（默认翻译；测试服务商也走这里排队）
  async function userTranslate(args, run = (a) => ctx.translator.translate(a)) {
    const gen = userTr.gen;
    const until = Date.now() + 35000;
    userTr.waiting += 1;
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
  handleShell('tr:run', async ({ text, modeId, target, source, ctxAccount, fix, draft } = {}) => {
    // 工作台写回复：带上当前对话最近几条当上下文（只在请求的号还是当前号时）
    const context = typeof ctxAccount === 'string' && ctxAccount === ctx.activeId && floatCore ? floatCore.contextOf(ctx.activeId) : undefined;
    // __back：回译成中文核对，用固定的忠实翻译提示词
    // 纠错要发的译文：内置校对提示词，对照中文原文和上下文改；设了纠错服务商就用它
    if (fix === true && typeof draft === 'string' && draft.trim()) return userTranslate({ text, mode: FIX_OUT, target, context, draft, fix: true });
    let mode = modeId === '__back' ? { prompt: '把用户的文字忠实地翻译成中文，不增不减，不润色。', temperature: 0 }
      : typeof modeId === 'string' ? ctx.modeStore.get(modeId) : null;
    return userTranslate({ text, mode, target, source, context: modeId === '__back' ? undefined : context });
  });
  handleShell('tr:cancel', () => userCancel());
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
  handleShell('tmode:delete', (id) => { if (typeof id === 'string') ctx.modeStore.remove(id); return trState(); });

  // ---- 悬浮翻译窗（shen 2026-10-24 选的方案 B） ----
  // 只读当前打开的对话（隔离环境，见 wa-page.js 的 readOpenChat），不改页面、不碰输入框。
  // 悬浮窗是软件自己的小视图，叠在 WhatsApp 视图上面；关掉就销毁。读到的消息和译文只在内存里。
  const FLOAT_W = 340;
  const FLOAT_MIN_H = 260;
  const FLOAT_MAX_H = 480;
  const FLOAT_PILL = { width: 130, height: 34 };
  const FLOAT_COMPOSE_GAP = 76; // 底部留给 WhatsApp 输入框，不盖住
  let floatView = null;
  let floatOpen = false;
  let floatTimer = null;
  let floatFails = 0;
  let floatReadable = 'loading'; // ok | nochat | qr | unreadable | loading
  let floatArea = null; // 账号视图的位置（layout 算出来的）
  let floatCore = null;
  let trStore = null; // 收到的消息的译文，永久存在磁盘上
  // 自动翻译默认开，只有手动关掉的号是 false
  const floatAuto = (id) => !!id && ctx.translator.load().accountAuto[id] !== false;
  // 读当前对话的条件之一：悬浮窗开着，或者右侧面板开着（翻译页显示收到的消息，其他页给“翻译”记未读）
  const readerOn = () => (floatOpen && !!floatView) || panelShown();
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
    prompt: '你是{目标语言}母语的校对员。<text> 里是中文原文，<draft> 里是{目标语言}译文，<context> 里是最近聊天记录，只用来理解意思。'
      + '检查译文是否准确表达原文、有没有漏译多译，修正语法和拼写，让说法自然、符合当地人聊天习惯，保持原来的语气。'
      + '保留数字、链接、表情和换行，不增加任何承诺。只输出改好的译文，不要解释。',
    temperature: 0.2,
  };
  function setupFloatCore() {
    // 先用上次的位置（D 盘有就是 D 盘，否则 C），后台查 D 盘是不是本机固定硬盘，定下来后把另一处的译文搬过来
    const oldTrDir = path.join(app.getPath('userData'), 'translations');
    const dTrDir = 'D:\\WAswitch\\translations';
    const guess = process.platform === 'win32' && fs.existsSync(dTrDir) ? dTrDir : oldTrDir;
    trStore = new TrStore(guess);
    pickTrDir(oldTrDir, { preferred: dTrDir }).then((dir) => {
      if (!trStore) return;
      trStore.flush();
      if (process.platform === 'win32') migrateTr(dir === dTrDir ? oldTrDir : dTrDir, dir);
      if (dir !== trStore.dir) { trStore.setDir(dir); console.log(`译文存在：${dir}`); }
    }).catch((e) => console.warn(`译文位置检查失败：${e.message}`));
    floatCore = new FloatCore({
      store: trStore,
      translate: (text, { fix, context, prev } = {}) => {
        // 纠错：不用平时的模式，用内置的校对提示词，对照现在的译文和上下文改
        const draft = fix && typeof prev === 'string' ? prev : '';
        const mode = fix ? (draft ? FIX_IN : { prompt: '结合上下文，把用户的文字准确地翻译成中文。', temperature: 0.2 }) : floatInMode();
        if (!mode) return Promise.resolve({ error: '没有“收到”方向的翻译模式', kind: 'input' });
        // 用户点的翻译在等：先让它
        if (userTr.waiting || userTr.running) return Promise.resolve({ error: '让用户先翻', kind: 'busy' });
        return ctx.translator.translate({ text, mode, target: '中文', context, draft, fix: !!fix });
      },
    });
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
    if (target) {
      floatBusy = true;
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
    scheduleFloat(delay);
  }
  function scheduleFloat(ms) {
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
      collapsed: cfg.float.collapsed,
      modes: {
        out: modes.filter((m) => m.direction !== 'in').map(({ id, name }) => ({ id, name })),
        in: modes.filter((m) => m.direction !== 'out').map(({ id, name }) => ({ id, name })),
      },
      inModeId: inMode ? inMode.id : '',
      langs: ctx.translator.publicConfig().langs,
      target: out.lang,
      targetSrc: out.from, // manual | customer | detected | default
      autoTarget: (out.auto || out).lang, // 下拉里“自动（…）”显示的语言
      accountLang: (acc && cfg.accountLang[acc.id]) || '', // 读不到对话时，手动选的语言记在号上
      canRemember: !!v.chatKey, // 认得出是哪个对话，才能把语言记在对话上
      // 悬浮窗用：不是号的默认语言时，手动改只管这一个对话
      targetFrom: out.from === 'default' ? '' : (out.name || '这个对话'),
    };
  }
  function pushFloat() {
    const both = floatView && !floatView.webContents.isDestroyed();
    const dock = panelShown() && ctx.shellView && !ctx.shellView.webContents.isDestroyed();
    if (!both && !dock) return;
    const st = floatState();
    if (both) floatView.webContents.send('float:state', st);
    if (dock) ctx.shellView.webContents.send('dock:state', st);
  }
  let floatLastAcc = null;
  function layoutFloat(area) {
    floatArea = area;
    // 换了号：重新开始读，悬浮窗和面板只显示新号的内容
    if (readerOn() && ctx.activeId !== floatLastAcc) {
      floatLastAcc = ctx.activeId;
      floatFails = 0;
      floatReadable = 'loading';
      pushFloat();
      scheduleFloat(200);
    } else if (readerOn() && !floatTimer && !floatBusy) scheduleFloat(300); // 面板刚打开、回到账号页、解锁
    if (!readerOn()) floatLastAcc = null;
    if (!floatView) return;
    const acc = findAcc(ctx.activeId);
    const show = floatOpen && ctx.page === 'account' && !ctx.locked && !!acc && !problems.has(acc.id) && area.width > FLOAT_W + 40;
    floatView.setVisible(show);
    if (!show) return;
    const pos = ctx.translator.load().float;
    const pill = pos.collapsed;
    const w = pill ? FLOAT_PILL.width : FLOAT_W;
    const h = pill ? FLOAT_PILL.height : Math.max(FLOAT_MIN_H, Math.min(FLOAT_MAX_H, area.height - 64 - FLOAT_COMPOSE_GAP));
    const maxX = area.x + area.width - w - 8;
    const maxY = area.y + area.height - h - FLOAT_COMPOSE_GAP;
    const x = Math.max(area.x + 8, Math.min(maxX, area.x + area.width - w - pos.dx));
    const y = Math.max(area.y + 8, Math.min(Math.max(area.y + 8, maxY), area.y + pos.dy));
    floatView.setBounds({ x, y, width: w, height: h });
    // 账号视图重建时会被加到最上面：保证悬浮窗始终在最上层
    const kids = ctx.win.contentView.children;
    if (kids[kids.length - 1] !== floatView) ctx.win.contentView.addChildView(floatView);
  }
  function openFloat() {
    if (floatView) { floatOpen = true; layout(); scheduleFloat(0); pushState(); return; }
    floatOpen = true;
    floatView = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'float', 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    floatView.setBackgroundColor('#00000000');
    lockLocalPage(floatView.webContents);
    floatView.webContents.loadFile(path.join(__dirname, 'float', 'index.html'));
    ctx.win.contentView.addChildView(floatView);
    floatReadable = 'loading';
    floatFails = 0;
    layout();
    scheduleFloat(300);
    pushState();
  }
  function closeFloat() {
    floatOpen = false;
    if (floatTimer) { clearTimeout(floatTimer); floatTimer = null; }
    if (floatView) {
      const v = floatView;
      floatView = null;
      try { ctx.win.contentView.removeChildView(v); } catch {}
      if (!v.webContents.isDestroyed()) v.webContents.close();
    }
    focusActive();
    pushState();
  }
  // 只接受悬浮窗自己发来的
  const fromFloat = (e) => !!floatView && !floatView.webContents.isDestroyed() && e.sender === floatView.webContents;
  const handleFloat = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
    if (!fromFloat(e)) throw new Error('not allowed');
    return fn(...args);
  });
  const onFloat = (channel, fn) => ipcMain.on(channel, (e, ...args) => { if (fromFloat(e)) fn(...args); });
  onShell('float:toggle', (on) => { if (typeof on === 'boolean' ? on : !floatOpen) openFloat(); else closeFloat(); });
  onFloat('float:ready', () => pushFloat());
  onFloat('float:close', () => closeFloat());
  onFloat('float:collapse', (on) => { ctx.translator.setFloat({ pos: { collapsed: on === true } }); layout(); pushFloat(); });
  let floatDrag = null;
  onFloat('float:move', ({ dx, dy } = {}) => {
    if (!floatView || !floatArea || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const b = floatView.getBounds();
    floatDrag = floatDrag || { x: b.x, y: b.y };
    floatDrag.x += Math.max(-500, Math.min(500, dx));
    floatDrag.y += Math.max(-500, Math.min(500, dy));
    const a = floatArea;
    const x = Math.max(a.x + 8, Math.min(a.x + a.width - b.width - 8, floatDrag.x));
    const y = Math.max(a.y + 8, Math.min(Math.max(a.y + 8, a.y + a.height - b.height - FLOAT_COMPOSE_GAP), floatDrag.y));
    floatView.setBounds({ ...b, x, y });
  });
  onFloat('float:moveend', () => {
    floatDrag = null;
    if (!floatView || !floatArea) return;
    const b = floatView.getBounds();
    ctx.translator.setFloat({ pos: { dx: floatArea.x + floatArea.width - b.width - b.x, dy: b.y - floatArea.y } });
  });
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
  handleFloat('float:item', (h) => readerItem(h, false));
  handleFloat('float:auto', readerAuto);
  handleFloat('float:inmode', readerInMode);
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
  handleFloat('float:compose', ({ text, modeId, target, accountId } = {}) => {
    if (accountId !== ctx.activeId) return { error: '当前账号变了，请重新翻译', kind: 'input' };
    const mode = typeof modeId === 'string' ? ctx.modeStore.get(modeId) : null;
    return userTranslate({ text, mode, target, context: floatCore.contextOf(ctx.activeId) }); // 带上当前对话最近几条当上下文
  });
  handleFloat('float:cancel', () => userCancel());
  handleFloat('float:insert', ({ accountId, text } = {}) => insertText(accountId, text));
  handleFloat('float:copy', (text) => { if (typeof text === 'string') clipboard.writeText(text.slice(0, 4000)); return true; });
  handleFloat('float:lang', ({ accountId, lang } = {}) => { if (accountId === ctx.activeId && findAcc(accountId)) ctx.translator.setAccountLang(accountId, lang); pushFloat(); return true; });
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
  // 关于页：译文存在哪、占多大
  handleShell('trdir:info', async () => {
    if (!trStore) return null;
    const dir = trStore.dir;
    return { dir, ...(await trDirInfo(dir)) };
  });
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
    // MCP translate_text 用：和用户点的翻译同一条队列
    userTranslate,
    // 轻量号的对话有变化（新消息、换对话）：马上读一次，不等 2 秒
    liteChanged(id) { if (id === ctx.activeId && readerOn() && !floatBusy) scheduleFloat(50); },
    get floatOpen() { return floatOpen; },
    get floatCore() { return floatCore; },
    get trStore() { return trStore; },
  };
}

module.exports = { setupTranslateIpc };
