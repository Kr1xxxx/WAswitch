// MCP「打开对话」（open_chat）自检：不需要 Electron、不需要 WhatsApp 账号，用假的数据跑一遍。
// 检查：
//   MCP 这边：默认关（工具列表还是 7 个）、和起草回复共用开关、只有 id 和 phone 两个参数、号码整理和拒绝、
//            登录检查、每 5 秒一次、各种结果给 AI 的说明、设置页记录只有号码后 4 位、关掉开关工具消失。
//   主进程这边（src/chat-open.js）：用户在打字时只在顶部问、不切号不跳转；网页版已经开着不刷新；
//            输入框里有没发的字先问；正常时切号 + 跳到 /send?phone=号码（网址里没有文字）并确认对话出现；
//            看不出号码时算“没确认”；等不到对话时报失败；轻量模式选中已有对话、没有时开空对话、不选群；
//            横幅里点“打开”/“忽略”；起草草稿在等时不覆盖；页面有问题时不开；代码里没有注入、按键、发送。
// 运行：node scripts/check-open-chat.js（npm run check:mcp 会一起跑）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpController } = require('../src/mcp/server');
const { createChatOpener, sendUrl, WEB_WAIT_MS } = require('../src/chat-open');
const { normalizePhone, maskPhone } = require('../src/mcp/open-chat');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const json = (r) => JSON.parse(r.content[0].text);

// ---------- 主进程这边：chat-open.js ----------

// 假的 main.js：记录切号、跳转、选中、横幅；页面读到的“当前对话”和“输入框”由测试设置
function fakeDeps(opts = {}) {
  const st = {
    accounts: { w1: { id: 'w1', mode: 'web' }, l1: { id: 'l1', mode: 'lite' } },
    busy: false,
    problems: new Set(),
    peer: null, // 网页版当前打开的对话 { title, chat }
    peerAfterNav: null, // 跳转后出现的对话
    compose: { box: true, empty: true },
    liteChats: [],
    activated: [], userActivated: [], navigated: [], liteOpened: [], reads: 0,
    request: null, requestMs: 0,
    clock: 1_000_000,
    loaded: true,
    ...opts,
  };
  const wc = { id: 'wc' };
  const deps = {
    findAcc: (id) => st.accounts[id] || null,
    isLite: (acc) => acc.mode === 'lite',
    userBusy: () => st.busy,
    problem: (id) => st.problems.has(id),
    activate: (id) => st.activated.push(id),
    activateForUser: async (id) => { st.userActivated.push(id); },
    webContents: () => (st.loaded ? wc : null),
    waPage: {
      readChatPeer: async () => { st.reads += 1; return st.peer; },
      composeState: async () => st.compose,
    },
    navigate: (id, url) => {
      st.navigated.push({ id, url });
      st.peer = null; // 页面刷新
      setImmediate(() => { st.peer = st.peerAfterNav; });
      return true;
    },
    liteChats: () => st.liteChats,
    liteOpen: (id, jid) => st.liteOpened.push({ id, jid }),
    request: () => st.request,
    setRequest: (req, ms) => { st.request = req; st.requestMs = ms; },
    clearRequest: () => { st.request = null; },
    wait: async (ms) => { st.clock += ms; await new Promise((r) => setImmediate(r)); },
    now: () => st.clock,
  };
  return { st, opener: createChatOpener(deps) };
}

const NUM = '4915123456789';

async function checkOpener() {
  // 用户在打字：只在顶部问
  {
    const { st, opener } = fakeDeps({ busy: true });
    const r = await opener.open({ accountId: 'w1', phone: NUM, client: 'Claude' });
    check(r.result === 'pending' && /打字/.test(r.why), '用户在打字：返回 pending，说明原因');
    check(st.request && st.request.kind === 'open' && st.request.phone === NUM && !st.request.warn, '用户在打字：窗口顶部出现“AI 想打开对话”');
    check(!st.activated.length && !st.navigated.length && st.reads === 0, '用户在打字：不切号、不跳转、不读页面');
    const r2 = await opener.open({ accountId: 'w1', phone: NUM, client: 'Claude' });
    check(r2.result === 'busy', '顶部已有打开请求在等：新的直接拒绝，不覆盖');
    // 用户点“打开”：输入框是空的 → 切号（给焦点）+ 跳转
    st.peerAfterNav = { title: '+49 151 23456789', chat: `${NUM}@c.us` };
    await opener.answer(true);
    check(st.userActivated[0] === 'w1' && st.navigated.length === 1 && st.request === null, '用户点“打开”：切到这个号并跳转，横幅消失');
  }
  // 用户点“忽略”
  {
    const { st, opener } = fakeDeps({ busy: true });
    await opener.open({ accountId: 'w1', phone: NUM });
    await opener.answer(false);
    check(st.request === null && !st.userActivated.length && !st.navigated.length, '用户点“忽略”：什么都不做');
  }
  // 因为打字才问的，点“打开”时输入框有字：再问一次，提醒会丢字
  {
    const { st, opener } = fakeDeps({ busy: true });
    await opener.open({ accountId: 'w1', phone: NUM });
    st.compose = { box: true, empty: false };
    await opener.answer(true);
    check(!st.navigated.length && st.request && st.request.warn === true, '点“打开”时输入框有字：不跳转，横幅改成提醒会丢字');
    st.peerAfterNav = { title: 'Anna', chat: `${NUM}@c.us` };
    await opener.answer(true);
    check(st.navigated.length === 1 && st.request === null, '提醒后用户再点“打开”：跳转');
  }
  // 起草回复的横幅在等：不覆盖
  {
    const { st, opener } = fakeDeps({ request: { kind: 'draft', id: 'w1' } });
    const r = await opener.open({ accountId: 'w1', phone: NUM });
    check(r.result === 'busy' && st.request.kind === 'draft' && !st.navigated.length, '起草草稿在顶部等着：不覆盖，返回 busy');
  }
  // 切换账号的横幅可以被换掉
  {
    const { st, opener } = fakeDeps({ request: { kind: 'switch', id: 'w1' }, peerAfterNav: { title: 'x', chat: `${NUM}@c.us` } });
    const r = await opener.open({ accountId: 'w1', phone: NUM });
    check(r.result === 'opened' && st.navigated.length === 1, '顶部只有切换账号的询问时照常打开');
  }
  // 账号不存在、页面有问题、页面没加载、号码不对
  {
    const { st, opener } = fakeDeps();
    st.problems.add('w1');
    check((await opener.open({ accountId: 'nope', phone: NUM })).result === 'gone', '账号不存在：gone');
    const r = await opener.open({ accountId: 'w1', phone: NUM });
    check(r.result === 'failed' && r.reason === 'problem' && !st.navigated.length && !st.activated.length, '页面有问题（代理连不上等）：不开');
    st.problems.clear();
    st.loaded = false;
    const r2 = await opener.open({ accountId: 'w1', phone: NUM });
    check(r2.result === 'failed' && r2.reason === 'not_loaded' && !st.navigated.length, '页面还没加载：不开');
    st.loaded = true;
    const r3 = await opener.open({ accountId: 'w1', phone: '49&text=hi' });
    check(r3.result === 'failed' && r3.reason === 'bad_phone' && !st.navigated.length, '号码里有别的字符：主进程这边也拒绝');
  }
  // 网页版已经开着这个对话：不刷新
  {
    const { st, opener } = fakeDeps({ peer: { title: 'Anna Müller', chat: `${NUM}@c.us` } });
    const r = await opener.open({ accountId: 'w1', phone: NUM });
    check(r.result === 'already' && !st.navigated.length && st.activated[0] === 'w1', '对话已经开着：不刷新页面，只切到这个号');
    // AI 少写了开头的国家码也认
    const { st: st2, opener: o2 } = fakeDeps({ peer: { title: '+49 151 23456789', chat: '' } });
    const r2 = await o2.open({ accountId: 'w1', phone: NUM });
    check(r2.result === 'already' && !st2.navigated.length, '标题是号码时也能认出已经开着');
  }
  // 输入框里有没发的字：先问，不刷新
  {
    const { st, opener } = fakeDeps({ peer: { title: 'Bob', chat: '4930111111@c.us' }, compose: { box: true, empty: false } });
    const r = await opener.open({ accountId: 'w1', phone: NUM });
    check(r.result === 'pending' && /没发的字/.test(r.why) && st.request.warn === true, '输入框有字：在顶部问，提醒会丢字');
    check(!st.navigated.length && !st.activated.length, '输入框有字：不切号、不跳转');
  }
  // 正常打开
  {
    const { st, opener } = fakeDeps({ peer: { title: 'Bob', chat: '4930111111@c.us' }, peerAfterNav: { title: 'Anna', chat: `${NUM}@c.us` } });
    const r = await opener.open({ accountId: 'w1', phone: NUM });
    check(r.result === 'opened' && !r.unconfirmed, '正常：打开并确认是这个号码');
    check(st.activated[0] === 'w1' && st.navigated.length === 1, '正常：切到这个号（不抢焦点）并跳转一次');
    const url = st.navigated[0].url;
    check(url === `https://web.whatsapp.com/send?phone=${NUM}` && url === sendUrl(NUM), `跳转的是 WhatsApp 自己的打开对话网址（${url}）`);
    const u = new URL(url);
    check(u.hostname === 'web.whatsapp.com' && [...u.searchParams.keys()].join() === 'phone', '网址里只有号码，没有 text（不会预填或发送文字）');
  }
  // 看不出号码（已存成联系人、隐藏号码 id）：算打开了，但没确认
  {
    const { opener } = fakeDeps({ peerAfterNav: { title: 'Anna Müller', chat: '123456789012345@lid' } });
    const r = await opener.open({ accountId: 'w1', phone: NUM });
    check(r.result === 'opened' && r.unconfirmed === true && r.title === 'Anna Müller', '对话开了但看不出号码：opened + unconfirmed');
  }
  // 等不到对话（号码没注册 WhatsApp 等）
  {
    const { st, opener } = fakeDeps({ peerAfterNav: null });
    const t0 = st.clock;
    const r = await opener.open({ accountId: 'w1', phone: NUM });
    check(r.result === 'failed' && r.reason === 'no_chat' && st.clock - t0 >= WEB_WAIT_MS, `等 ${WEB_WAIT_MS / 1000} 秒没看到对话：报失败`);
  }
  // 轻量模式
  {
    const chats = [
      { jid: '4930999999@s.whatsapp.net', name: 'Bob' },
      { jid: `${NUM}@g.us`, name: '同号的群' },
      { jid: `${NUM}@s.whatsapp.net`, name: 'Anna Müller' },
    ];
    const { st, opener } = fakeDeps({ liteChats: chats });
    const r = await opener.open({ accountId: 'l1', phone: NUM });
    check(r.result === 'opened' && r.found === true && r.title === 'Anna Müller', '轻量模式：找到本机已有的对话');
    check(st.liteOpened.length === 1 && st.liteOpened[0].jid === `${NUM}@s.whatsapp.net` && st.activated[0] === 'l1', '轻量模式：切到这个号并选中这个对话（不选同号的群）');
    check(!st.navigated.length && st.reads === 0, '轻量模式：不碰网页');
    const { st: st2, opener: o2 } = fakeDeps({ liteChats: [] });
    const r2 = await o2.open({ accountId: 'l1', phone: '4930123456' });
    check(r2.result === 'opened' && r2.found === false && st2.liteOpened[0].jid === '4930123456@s.whatsapp.net', '轻量模式：本机没有这个号码的对话时开一个空对话');
  }

  // 代码里没有注入、按键、粘贴、发送
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat-open.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const bad = ['executeJavaScript', 'sendInputEvent', 'insertText', 'paste', 'liteSend', 'send(', 'text='].filter((w) => src.includes(w));
  check(!bad.length, `chat-open.js 没有注入、按键、粘贴、发送（${bad.join(', ') || '无'}）`);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const nav = main.slice(main.indexOf('const chatOpener = createChatOpener'), main.indexOf('const regionName'));
  check(/isWhatsAppUrl\(url\)/.test(nav) && /loadURL\(url\)/.test(nav), 'main.js 只让页面跳到 WhatsApp 的网址');
}

// ---------- MCP 这边：open_chat 工具 ----------

async function checkTool() {
  check(normalizePhone('+49 151 2345678') === '491512345678', '号码整理：+49 151 2345678');
  check(normalizePhone('0049 (151) 234-5678') === '491512345678', '号码整理：0049 开头');
  check(normalizePhone('49.151.2345678') === '491512345678', '号码整理：不带 + 的国际号码');
  check(normalizePhone('0151 2345678') === '', '号码整理：0 开头的本国拨号不认');
  check(normalizePhone('+49 151 abc') === '' && normalizePhone('49151&text=hi') === '' && normalizePhone('+1 23') === '', '号码整理：有字母、符号或太短都不认');
  check(maskPhone('491512345678') === '…5678', '设置页只显示号码后 4 位');

  const st = { opens: [], answers: [], login: { a1: 'logged_in', a2: 'needs_qr', l1: 'logged_in' } };
  const hooks = {
    listAccounts: () => [
      { id: 'a1', name: '工作号', active: true, unread: 0, muted: false, mode: 'web', status: 'ready', login: 'logged_in', problem: '' },
      { id: 'a2', name: '客服号', active: false, unread: 0, muted: false, mode: 'web', status: 'ready', login: 'needs_qr', problem: '' },
      { id: 'l1', name: '小号', active: false, unread: 0, muted: false, mode: 'lite', status: 'ready', login: 'logged_in', problem: '' },
    ],
    regions: () => [{ key: 'auto', label: '自动' }],
    activate: () => 'done',
    openAddAccount: () => 'done',
    renameAccount: () => true,
    removeAccount: async () => 'cancelled',
    checkLogin: async (id) => st.login[id] || 'unknown',
    readChatList: async () => ({ ok: false, reason: 'empty' }),
    confirmRead: async () => 'deny',
    placeDraft: async () => ({ result: 'placed' }),
    openChat: async (args) => { st.opens.push(args); return st.answers.shift() || { result: 'opened' }; },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-open-'));
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ enabled: true, port: 39000 + Math.floor(Math.random() * 900) }));
  const ctl = new McpController({ dataDir: dir, version: 'test', hooks });
  await ctl.init();
  const s0 = ctl.status();
  const client = new Client({ name: 'check-open', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(s0.url), { requestInit: { headers: { Authorization: `Bearer ${s0.token}` } } }));
  const names = async () => (await client.listTools()).tools.map((t) => t.name);

  const def = await names();
  check(!def.includes('open_chat') && def.length === 7, `默认关：工具列表里没有 open_chat，还是 7 个（${def.length}）`);
  ctl.setDrafts(true);
  await new Promise((r) => setTimeout(r, 200));
  const on = await names();
  check(on.includes('open_chat') && on.includes('draft_reply'), '打开“起草回复和打开对话”：open_chat 和 draft_reply 一起出现');
  const tool = (await client.listTools()).tools.find((t) => t.name === 'open_chat');
  const props = Object.keys(tool.inputSchema.properties).sort();
  check(JSON.stringify(props) === '["id","phone"]', `open_chat 只有 id 和 phone 两个参数，没有文字或批量参数（${props.join(', ')}）`);
  check(/不发送/.test(tool.description) && /不标已读/.test(tool.description) && /pending/.test(tool.description), '工具说明写明不发送、不标已读、打字时会问');
  check(tool.annotations.destructiveHint === false && tool.annotations.readOnlyHint === false, '工具标注为非破坏性');

  let clock = 10_000_000;
  // 每个会话的限速用的是注册时传入的 now，这里换成假时钟：重新连接一次让新会话用上
  await client.close();
  const realNow = Date.now;
  Date.now = () => clock;
  const c2 = new Client({ name: 'check-open', version: '1.0.0' });
  await c2.connect(new StreamableHTTPClientTransport(new URL(s0.url), { requestInit: { headers: { Authorization: `Bearer ${s0.token}` } } }));
  const call = (args) => c2.callTool({ name: 'open_chat', arguments: args });

  const r1 = json(await call({ id: 'a1', phone: '+49 151 2345678' }));
  check(r1.opened === true && r1.confirmed === true && r1.sent === false && r1.phone === '+491512345678', '打开成功：opened、confirmed、sent: false');
  check(st.opens.length === 1 && st.opens[0].accountId === 'a1' && st.opens[0].phone === '491512345678' && /check-open/.test(st.opens[0].client), '交给主进程的是整理过的号码');
  const r2 = await call({ id: 'a1', phone: '+49 151 2345678' });
  check(r2.isError && /5 秒/.test(r2.content[0].text) && st.opens.length === 1, '同一个连接 5 秒内再打开：拒绝');
  clock += 5001;
  const bad = await call({ id: 'a1', phone: '0151 2345678' });
  check(bad.isError && /国家码/.test(bad.content[0].text) && st.opens.length === 1, '0 开头的本国号码：说明要带国家码，不打开');
  const qr = await call({ id: 'a2', phone: '+49 151 2345678' });
  check(qr.isError && /重新扫码/.test(qr.content[0].text) && st.opens.length === 1, '账号要扫码：不打开');
  const none = await call({ id: 'zz', phone: '+49 151 2345678' });
  check(none.isError && st.opens.length === 1, '账号不存在：不打开');

  const next = async (answer, args = { id: 'a1', phone: '+1 415 555 0100' }) => { clock += 5001; st.answers.push(answer); return call(args); };
  const p = json(await next({ result: 'pending', why: '用户正在打字或编辑账号' }));
  check(p.pending === true && p.opened === false && /不要重复调用/.test(p.next), 'pending：告诉 AI 已在顶部询问、不要重复调用');
  const al = json(await next({ result: 'already' }));
  check(al.already === true && al.opened === true, 'already：对话本来就开着');
  const un = json(await next({ result: 'opened', unconfirmed: true }));
  check(un.opened === true && un.confirmed === false && /没能确认/.test(un.next), '没确认号码：告诉 AI 请用户看一下');
  const bz = await next({ result: 'busy' });
  check(bz.isError && /等用户处理/.test(bz.content[0].text), 'busy：顶部已有请求');
  const fl = await next({ result: 'failed', reason: 'no_chat' });
  check(fl.isError && /没有注册 WhatsApp/.test(fl.content[0].text), '等不到对话：说明可能没注册 WhatsApp');
  const lite = json(await next({ result: 'opened', found: false }, { id: 'l1', phone: '+49 30 123456' }));
  check(lite.opened === true && lite.found === false && /空对话/.test(lite.next), '轻量模式没有聊天记录：告诉 AI 开的是空对话');

  const log = ctl.status().draftLog.filter((d) => d.kind === 'open');
  check(log.length >= 7 && log.every((d) => /^…\d{4}$/.test(d.chat)), `设置页记录打开了几次，号码只留后 4 位（${log.length} 条）`);
  check(!JSON.stringify(ctl.status()).includes('4155550100') && !JSON.stringify(ctl.status()).includes('491512345678'), '设置页数据里没有完整号码');

  ctl.setDrafts(false);
  await new Promise((r) => setTimeout(r, 200));
  const off = (await c2.listTools()).tools.map((t) => t.name);
  check(!off.includes('open_chat') && !off.includes('draft_reply') && off.length === 7, '关掉开关：open_chat 和 draft_reply 一起消失');
  Date.now = realNow;
  await c2.close();
  await ctl.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  await checkOpener();
  await checkTool();
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
