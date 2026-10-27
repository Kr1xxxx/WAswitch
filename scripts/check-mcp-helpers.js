// MCP 辅助工具自检：list_quick_replies、translate_text、get_customer_time。不需要 Electron，用假的话术、翻译数据跑一遍。
// 检查：默认关（工具列表还是 7 个）、打开后出现三个工具并通知客户端、不弹确认框、
// 话术搜索和条数、翻译走软件设置（语言名换算、模式、失败说明、同时一段、每分钟限速）、客户时间（时区、夏令时、工作时间、认不出的号码）、
// 关掉后工具消失、开关存进 mcp.json。
// 运行：node scripts/check-mcp-helpers.js（npm run check:mcp 里也会跑）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpController } = require('../src/mcp/server');
const { normLang, phoneDigits, localNow, daypart, LANG_NAMES, TR_PER_MIN } = require('../src/mcp/helpers');
const { LANGS } = require('../src/translate');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { ToolListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const json = (r) => JSON.parse(r.content[0].text);

function fakeHooks() {
  const state = { trCalls: [], trAnswers: [], trDelay: 0, confirmCalls: 0 };
  return {
    state,
    listAccounts: () => [{ id: 'a1', name: '工作号', muted: false, unread: 0, status: 'ready', problem: '', active: true }],
    regions: () => [{ key: 'auto', label: '自动' }],
    activate: () => 'done',
    openAddAccount: () => 'done',
    renameAccount: () => true,
    removeAccount: async () => 'cancelled',
    checkLogin: async () => 'logged_in',
    readChatList: async () => ({ ok: true, chats: [] }),
    confirmRead: async () => { state.confirmCalls += 1; return 'deny'; },
    placeDraft: async () => ({ result: 'placed' }),
    listQuickReplies: () => [
      { id: 'r1', title: 'Greeting', text: 'Hi, thanks for reaching out!', updatedAt: 100 },
      { id: 'r2', title: '报价', text: 'Our price for 500 units is EUR 4,200 incl. shipping to Berlin.', updatedAt: 300 },
      { id: 'r3', title: 'Follow-up', text: 'Just checking in on the quote I sent last week.', updatedAt: 200 },
    ],
    translateModes: () => [
      { id: 'm1', name: '标准', direction: 'out', prompt: '把用户的文字忠实地翻译成{目标语言}。', temperature: 0.3 },
      { id: 'm2', name: '商务正式', direction: 'out', prompt: '翻译成{目标语言}，语气礼貌专业。', temperature: 0.3 },
    ],
    translate: async (args) => {
      state.trCalls.push(args);
      if (state.trDelay) await new Promise((r) => setTimeout(r, state.trDelay));
      return state.trAnswers.shift() || { text: `[${args.target}] ${args.text}`, provider: '智谱', fallback: false, ms: 5, warn: [] };
    },
  };
}

async function main() {
  // ---------- 纯函数 ----------
  check(LANG_NAMES.every((n) => LANGS.includes(n)) && LANGS.every((n) => LANG_NAMES.includes(n)), '语言表和 设置 › 翻译 的语言一一对应');
  check(normLang('de') === '德语' && normLang('German') === '德语' && normLang('EN-us') === '英语' && normLang('法语') === '法语' && normLang('Klingon') === null && normLang('') === '',
    '语言名：代码、英文名、中文名都认得，不认识的返回 null');
  check(phoneDigits('+49 151 1234 5678') === '4915112345678' && phoneDigits('0049 30 1234567') === '49301234567' && phoneDigits('4915112345678') === '4915112345678',
    '号码：+、00 开头和纯数字都按国际号码');
  check(phoneDigits('0151 12345678') === '' && phoneDigits('abc') === '', '号码：0 开头的本地写法和乱写的认不出');
  // 2026-07-01 12:00 UTC：柏林夏令时 +02:00 14:00；纽约 -04:00 08:00
  const july = new Date(Date.UTC(2026, 6, 1, 12, 0));
  const b = localNow('Europe/Berlin', july);
  const ny = localNow('America/New_York', july);
  check(b.time === '14:00' && b.utcOffset === '+02:00' && b.weekday === 'Wednesday' && b.date === '2026-07-01', `柏林夏令时（${b.date} ${b.time} ${b.utcOffset} ${b.weekday}）`);
  check(ny.time === '08:00' && ny.utcOffset === '-04:00', `纽约夏令时（${ny.time} ${ny.utcOffset}）`);
  const dec = localNow('Europe/Berlin', new Date(Date.UTC(2026, 11, 1, 23, 30)));
  check(dec.time === '00:30' && dec.utcOffset === '+01:00' && dec.date === '2026-12-02', `柏林冬令时跨天（${dec.date} ${dec.time} ${dec.utcOffset}）`);
  check(daypart(3) === 'night' && daypart(8) === 'morning' && daypart(9) === 'working_hours' && daypart(17) === 'working_hours' && daypart(18) === 'evening' && daypart(22) === 'night',
    '时段：夜里 / 早上 / 工作时间 / 晚上');

  // ---------- 接到 MCP 服务器上 ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-mcp-helpers-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ enabled: false, port }));
  const hooks = fakeHooks();
  const st = hooks.state;
  const ctl = new McpController({ dataDir: dir, version: '0.0.0-test', hooks });
  await ctl.init();
  await ctl.setEnabled(true);
  const s = ctl.status();
  check(s.running && s.helpers === false, '辅助工具默认关');

  const client = new Client({ name: 'check-mcp-helpers', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { Authorization: `Bearer ${s.token}` } } }));
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });
  const names = async () => (await client.listTools()).tools.map((t) => t.name);
  const HELPERS = ['list_quick_replies', 'translate_text', 'get_customer_time'];
  const before = await names();
  check(before.length === 7 && !HELPERS.some((n) => before.includes(n)), `默认工具列表还是 7 个，没有辅助工具（${before.length} 个）`);
  const hidden = await client.callTool({ name: 'translate_text', arguments: { text: 'hi', target: 'de' } }).catch((e) => ({ isError: true, content: [{ text: String(e.message) }] }));
  check(hidden.isError && st.trCalls.length === 0, '关着时调用不到 translate_text');

  ctl.setHelpers(true);
  await new Promise((r) => setTimeout(r, 200));
  const after = await names();
  check(listChanged >= 1 && HELPERS.every((n) => after.includes(n)) && after.length === 10, `打开后出现三个工具并通知客户端（${after.length} 个）`);
  check(JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')).helpers === true, '开关存进 mcp.json');
  const tools = (await client.listTools()).tools;
  check(!/send|发送消息/.test(HELPERS.join()) && tools.filter((t) => HELPERS.includes(t.name)).every((t) => t.annotations && t.annotations.readOnlyHint === true), '三个工具都标为只读');
  const call = (name, args) => client.callTool({ name, arguments: args });

  // ---------- 话术 ----------
  const q1 = json(await call('list_quick_replies', {}));
  check(q1.total === 3 && q1.replies.map((r) => r.id).join() === 'r2,r3,r1', '话术按最近修改排在前面');
  check(q1.replies.every((r) => Object.keys(r).sort().join() === 'id,text,title'), '话术只返回 id、标题和内容');
  const q2 = json(await call('list_quick_replies', { query: 'QUOTE' }));
  check(q2.total === 1 && q2.replies[0].id === 'r3', '搜索不分大小写，标题和内容都搜');
  const q3 = json(await call('list_quick_replies', { limit: 1 }));
  check(q3.total === 3 && q3.returned === 1, 'limit 限制返回条数，total 还是全部');
  const q4 = json(await call('list_quick_replies', { query: 'zzz' }));
  check(q4.total === 0 && /没有找到/.test(q4.note), '搜不到时说明');

  // ---------- 翻译 ----------
  const t1 = json(await call('translate_text', { text: 'Thanks, I will send the invoice today.', target: 'de' }));
  const c1 = st.trCalls[st.trCalls.length - 1];
  check(t1.text === '[德语] Thanks, I will send the invoice today.' && t1.target === '德语' && t1.provider === '智谱', '翻译走软件设置，de 换成 德语');
  check(c1.mode.name === '标准' && /\{目标语言\}/.test(c1.mode.prompt) && c1.source === '' && !('context' in c1), '没给模式时忠实直译，不带对话上下文');
  await call('translate_text', { text: 'Bonjour', target: 'English', source: 'fr', mode: '商务正式' });
  const c2 = st.trCalls[st.trCalls.length - 1];
  check(c2.mode.id === 'm2' && c2.target === '英语' && c2.source === '法语', '可以用设置里的翻译模式和原文语言');
  const n0 = st.trCalls.length;
  const t3 = await call('translate_text', { text: 'x', target: 'Klingon' });
  const t4 = await call('translate_text', { text: 'x', target: 'de', mode: '不存在' });
  const t5 = await call('translate_text', { text: '   ', target: 'de' });
  check(t3.isError && /不认识目标语言/.test(t3.content[0].text) && t4.isError && /商务正式/.test(t4.content[0].text) && t5.isError && st.trCalls.length === n0,
    '语言、模式不对或文字是空的直接说明，不去翻译');
  st.trAnswers.push({ error: '智谱还没填密钥', kind: 'auth', providerId: 'p1' });
  const t6 = await call('translate_text', { text: 'Hello', target: 'de' });
  check(t6.isError && /智谱还没填密钥/.test(t6.content[0].text) && /设置 › 翻译/.test(t6.content[0].text), '密钥没填时说明去 设置 › 翻译 填');
  st.trAnswers.push({ text: 'Rufen Sie mich an: +49 30 1234567', provider: '智谱', warn: ['+49 30 1234567'] });
  const t7 = json(await call('translate_text', { text: 'Call me', target: 'de' }));
  check(/\+49 30 1234567/.test(t7.warning || ''), '译文多出原文没有的联系方式时提醒');

  // 同一个连接同时只翻一段
  st.trDelay = 300;
  const [p1, p2] = await Promise.all([
    call('translate_text', { text: 'one', target: 'de' }),
    new Promise((r) => setTimeout(r, 50)).then(() => call('translate_text', { text: 'two', target: 'de' })),
  ]);
  st.trDelay = 0;
  check(!p1.isError && p2.isError && /还在翻译/.test(p2.content[0].text), '同一个连接同时只翻一段');
  // 每分钟限速
  let clock = Date.now() + 120 * 1000; // 前面几次翻译已经过了一分钟
  ctl.trLimit.now = () => clock;
  let ok = 0;
  let last = null;
  for (let i = 0; i < TR_PER_MIN + 2; i += 1) {
    last = await call('translate_text', { text: `n${i}`, target: 'en' });
    if (!last.isError) ok += 1;
  }
  check(ok === TR_PER_MIN && last.isError && /每分钟最多/.test(last.content[0].text), `每分钟最多翻 ${TR_PER_MIN} 次（这一轮成功 ${ok} 次）`);
  clock += 61 * 1000;
  check(!(await call('translate_text', { text: 'later', target: 'en' })).isError, '过一分钟又能翻');

  // ---------- 客户时间 ----------
  const g1 = json(await call('get_customer_time', { phone: '+49 151 12345678' }));
  check(g1.timezone === 'Europe/Berlin' && g1.place === 'Berlin' && g1.approx === false && /^\d\d:\d\d$/.test(g1.local_time) && /^[+-]\d\d:\d\d$/.test(g1.utc_offset),
    `德国号码 → 柏林 ${g1.local_time} ${g1.utc_offset} ${g1.daypart}`);
  check(!JSON.stringify(g1).includes('12345678'), '返回里不带号码');
  const g2 = json(await call('get_customer_time', { phone: '+1 212 555 0100' }));
  check(g2.timezone === 'America/New_York', `纽约区号 212 → ${g2.timezone}`);
  const g3 = json(await call('get_customer_time', { phone: '+1 415 555 0100' }));
  check(g3.timezone === 'America/Los_Angeles', `旧金山区号 415 → ${g3.timezone}`);
  const g4 = json(await call('get_customer_time', { phone: '447700900123' }));
  check(g4.timezone === 'Europe/London', `纯数字英国号码 → ${g4.timezone}`);
  const g5 = await call('get_customer_time', { phone: '0151 12345678' });
  check(g5.isError && /国家码/.test(g5.content[0].text), '本地写法说明要带国家码');

  check(st.confirmCalls === 0, '三个工具都不弹确认框');

  // ---------- 关掉 ----------
  listChanged = 0;
  ctl.setHelpers(false);
  await new Promise((r) => setTimeout(r, 200));
  const off = await names();
  check(listChanged >= 1 && off.length === 7 && !HELPERS.some((n) => off.includes(n)), '关掉后三个工具从列表里消失');
  check(JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')).helpers === false, '关掉也存进 mcp.json');

  await client.close();
  await ctl.setEnabled(false);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
