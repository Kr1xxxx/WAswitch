// MCP 修改客户资料（update_customer）和「AI 操作记录」撤销的自检。
// 不需要 Electron：用真的客户名单存储（src/records.js）+ 主进程真的接口（src/customer-mcp.js），
// 假的账号列表，走官方 SDK 客户端。
// 检查：默认关、开关、新建、按电话找、按 id 改、参数校验、不返回其他资料、限速、
// 撤销（改回、部分改回、撤销新建、被改过不删、已删除、重复撤销、重启后还能撤销）、不能删除客户。
// 运行：node scripts/check-mcp-customers.js（npm run check:mcp 里也会跑）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpController } = require('../src/mcp/server');
const { AiLog, RATE_MAX } = require('../src/mcp/customer-edit');
const { Records } = require('../src/records');
const { customerHooks } = require('../src/customer-mcp');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { ToolListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const json = (res) => JSON.parse(res.content[0].text);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-mcp-cust-'));
  const port = 40000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ enabled: true, port }));

  // 两个号在用，一个停用（团队收回）
  const accounts = [
    { id: 'a1', name: 'Sales DE', parked: false },
    { id: 'a2', name: 'Sales FR', parked: false },
    { id: 'a3', name: '已收回', parked: true },
  ];
  const store = new Records(dir, 'customers');
  const findAcc = (id) => accounts.find((a) => a.id === id && !a.parked);
  let changes = 0;
  const hooks = {
    listAccounts: () => accounts.filter((a) => !a.parked).map((a) => ({ id: a.id, name: a.name, active: a.id === 'a1', unread: 0, muted: false, status: 'ready', problem: '' })),
    regions: () => [{ key: 'auto', label: '自动' }],
    ...customerHooks({
      store: () => store,
      findAcc,
      parked: (c) => !!c.accountId && accounts.some((a) => a.id === c.accountId && a.parked),
      onChange: () => { changes += 1; },
    }),
  };
  // 已有客户：一个带语言（AI 改的时候不能丢），一个在停用的号名下
  const anna = store.upsert({ accountId: 'a1', name: 'Anna Müller', phone: '+49 151 2345678', tags: ['Lead'], note: 'Asked for price list', followUpAt: 0, lang: 'de' });
  const hidden = store.upsert({ accountId: 'a3', name: 'Hidden GmbH', phone: '+49 30 111222', note: 'secret' });

  const ctl = new McpController({ dataDir: dir, version: '0.0.0-test', hooks });
  await ctl.init();
  const s = ctl.status();
  const client = new Client({ name: 'check-cust', version: '1.0.0' });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged += 1; });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { Authorization: `Bearer ${s.token}` } } }));
  const names = async () => (await client.listTools()).tools.map((t) => t.name);

  // ---------- 开关 ----------
  check(!(await names()).includes('update_customer') && s.customerEdit === false, '修改客户资料默认关：工具列表里没有 update_customer');
  check((await names()).length === 7, `默认还是 7 个工具（${(await names()).length} 个）`);
  const ch0 = listChanged;
  ctl.setCustomerEdit(true);
  await wait(200);
  check(listChanged > ch0 && (await names()).includes('update_customer'), '打开后通知客户端，出现 update_customer');
  check(JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')).customerEdit === true, '开关存进 mcp.json');
  const tool = (await client.listTools()).tools.find((t) => t.name === 'update_customer');
  const props = Object.keys(tool.inputSchema.properties);
  check(!props.some((p) => /delete|remove_customer|send/.test(p)) && tool.annotations.destructiveHint === false, '没有删除客户、发送之类的参数，标注为非破坏性');
  check(/撤销/.test(tool.description) && /不能删除客户/.test(tool.description), '工具说明写明可撤销、不能删除客户');

  const call = (args) => client.callTool({ name: 'update_customer', arguments: args });

  // ---------- 新建 ----------
  const c1 = json(await call({ account_id: 'a2', name: 'Pierre Dubois', phone: '+33 6 12 34 56 78', tags: ['VIP'], follow_up_at: '2026-11-03T10:00:00+01:00' }));
  const pierre = store.get(c1.customer_id);
  check(c1.ok && c1.created === true && pierre && pierre.accountId === 'a2' && pierre.name === 'Pierre Dubois', '新建客户：存进客户名单，挂在指定账号下');
  check(pierre.followUpAt === Date.parse('2026-11-03T09:00:00Z') && pierre.reminded === false, '跟进时间按带时区的 ISO 时间存，没标成已提醒');
  check(changes === 1, '改完通知界面刷新客户名单');

  // ---------- 按电话找（格式不同也算同一个） ----------
  const c2 = json(await call({ account_id: 'a1', phone: '+49-151-234 5678', add_tags: ['Quoted', 'lead'], append_note: 'Sent offer 120 EUR' }));
  let a = store.get(anna.id);
  check(c2.created === false && c2.customer_id === anna.id && store.list().length === 3, '按 account_id + phone 找到已有客户，不重复新建');
  check(JSON.stringify(a.tags) === '["Lead","Quoted"]' && a.note === 'Asked for price list\nSent offer 120 EUR', 'add_tags 只加（大小写不同算同一个）、append_note 另起一行追加');
  check(a.phone === '+49 151 2345678' && a.lang === 'de', '按电话找到时不改写电话格式，语言等没给的字段不变');
  check(!/Asked for price|Anna|Lead/.test(JSON.stringify(c2)) && JSON.stringify(c2.changed) === JSON.stringify(['tags', 'note']), '返回里只有 id 和改了哪些字段，不带客户的其他资料');

  // ---------- 按 id 改 ----------
  const c3 = json(await call({ customer_id: anna.id, tags: ['Customer'], follow_up_at: '2026-12-01' }));
  a = store.get(anna.id);
  check(JSON.stringify(a.tags) === '["Customer"]' && a.followUpAt === new Date(2026, 11, 1, 9, 0).getTime() && c3.changed.join() === 'tags,followUpAt', 'tags 整体替换；只写日期按当天 9 点（电脑时区）');
  const c4 = json(await call({ customer_id: anna.id, tags: ['Customer'] }));
  check(c4.changed.length === 0 && ctl.status().aiLog.length === 3, '内容一样时不改、不记录');

  // ---------- 参数校验 ----------
  const errs = [
    [{ customer_id: anna.id, tags: ['a'], add_tags: ['b'] }, /不能和 add_tags/],
    [{ customer_id: anna.id, note: 'x', append_note: 'y' }, /不能和 append_note/],
    [{ customer_id: anna.id, follow_up_at: 'next tuesday' }, /ISO 8601/],
    [{ customer_id: anna.id, follow_up_at: '2099-01-01T00:00:00Z' }, /5 年/],
    [{ customer_id: 'nope', name: 'x' }, /没有 id 为 nope/],
    [{ customer_id: hidden.id, note: 'leak?' }, /没有 id/],
    [{ account_id: 'a3', phone: '+49 30 111222', note: 'x' }, /没有 id 为 a3 的账号/],
    [{ account_id: 'zz', name: 'New' }, /没有 id 为 zz 的账号/],
    [{ name: 'Nobody' }, /account_id/],
    [{ account_id: 'a1', tags: ['only tags'] }, /name 或 phone/],
    [{ customer_id: anna.id, account_id: 'a2', name: 'x' }, /不在 account_id/],
    [{ customer_id: anna.id, add_tags: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] }, /最多 10 个/],
    [{ customer_id: anna.id, append_note: 'y'.repeat(490) }, /500 字/],
  ];
  const before = JSON.stringify(store.list());
  let allBad = true;
  for (const [args, re] of errs) {
    const r = await call(args);
    if (!(r.isError && re.test(r.content[0].text))) { allBad = false; console.log('  没按预期报错：', JSON.stringify(args), r.content[0].text); }
  }
  check(allBad && JSON.stringify(store.list()) === before, `${errs.length} 种错误参数都被拒绝，客户名单没变`);
  check(store.get(hidden.id).note === 'secret', '停用账号名下的客户看不到、改不了');

  // ---------- 撤销 ----------
  const log = () => ctl.status().aiLog;
  check(log().length === 3 && log()[0].op === 'update' && log()[2].op === 'create', '每次修改记进 AI 操作记录（新的在前）');
  const v = log()[1];
  check(v.customer === 'Anna Müller' && v.account === 'Sales DE' && v.client.startsWith('check-cust') && v.changes.find((c) => c.field === 'note').before === 'Asked for price list', '记录里有客户、账号、客户端和改之前 → 之后');

  // 撤销最新一条（tags + 跟进时间）：都改回去
  const u1 = ctl.aiLog.undo(log()[0].id);
  a = store.get(anna.id);
  check(u1.ok && JSON.stringify(a.tags) === '["Lead","Quoted"]' && a.followUpAt === 0 && a.lang === 'de', '撤销：标签和跟进时间改回去，语言不受影响');
  check(log()[0].undone === true && !ctl.aiLog.undo(log()[0].id).ok, '撤销过的标成已撤销，不能再撤一次');

  // 用户在界面上手动改了备注，再撤销上一条（标签 + 备注）：只改回标签，备注保留用户的
  store.upsert({ ...store.get(anna.id), note: 'User edited by hand' });
  const u2 = ctl.aiLog.undo(log()[1].id);
  a = store.get(anna.id);
  check(u2.ok && JSON.stringify(a.tags) === '["Lead"]' && a.note === 'User edited by hand' && /备注」之后又被改过/.test(u2.message), '部分撤销：之后被人改过的字段不动，并说明');

  // 撤销跟进时间时一起还原“提醒过没有”，免得已过去的时间又提醒一次
  const past = Date.now() - 3600 * 1000;
  store.upsert({ ...store.get(anna.id), followUpAt: past });
  store.patch(anna.id, { reminded: true });
  json(await call({ customer_id: anna.id, follow_up_at: '2026-12-24T10:00:00Z' }));
  check(store.get(anna.id).reminded === false, '改了跟进时间会重新提醒');
  ctl.aiLog.undo(log()[0].id);
  check(store.get(anna.id).followUpAt === past && store.get(anna.id).reminded === true, '撤销后跟进时间和“已提醒”一起还原，不会补弹提醒');

  // 撤销新建：删掉这个客户
  const c5 = json(await call({ account_id: 'a1', name: 'Lukas Weber', phone: '+49 160 9876543' }));
  const u3 = ctl.aiLog.undo(log()[0].id);
  check(u3.ok && !store.get(c5.customer_id) && /删除/.test(u3.message), '撤销新建：客户被删除');
  // 新建后被人改过：不删
  const c6 = json(await call({ account_id: 'a2', name: 'Marie Leroy' }));
  store.upsert({ ...store.get(c6.customer_id), note: 'met at fair' });
  const u4 = ctl.aiLog.undo(log()[0].id);
  check(!u4.ok && store.get(c6.customer_id) && /没有删除/.test(u4.message) && log()[0].undone === false, '新建后被人改过：不删除，提示去客户名单删');
  // 客户已经被删了
  json(await call({ customer_id: c6.customer_id, add_tags: ['Fair'] }));
  store.remove(c6.customer_id);
  const u5 = ctl.aiLog.undo(log()[0].id);
  check(!u5.ok && /不在客户名单/.test(u5.message), '客户已被删除：撤销说明原因，不报错');

  // 撤销 Pierre 的新建（他的账号之后停用了）：看不到，不动
  accounts[1].parked = true;
  const pierreEntry = log().find((e) => e.op === 'create' && e.customer === 'Pierre Dubois');
  check(!ctl.aiLog.undo(pierreEntry.id).ok && store.load().find((r) => r.id === c1.customer_id && !r.deleted), '账号停用后不能通过撤销动它名下的客户');
  accounts[1].parked = false;

  // 重启后记录还在，还能撤销
  const reread = new AiLog({ dir, hooks });
  const pe = reread.entries.find((e) => e.id === pierreEntry.id);
  check(reread.entries.length === log().length && pe && !pe.undone, `AI 操作记录存在本机，重启后还在（${reread.entries.length} 条）`);
  check(reread.undo(pe.id).ok && !store.get(c1.customer_id), '重启后还能撤销');

  // ---------- 限速 ----------
  let limited = null;
  for (let i = 0; i < RATE_MAX + 2 && !limited; i += 1) {
    const r = await call({ customer_id: anna.id, name: `Anna ${i}` });
    if (r.isError) limited = r.content[0].text;
  }
  check(limited && /每分钟最多改 20 次/.test(limited), '同一个连接每分钟最多改 20 次');

  // ---------- 关掉 ----------
  const ch1 = listChanged;
  ctl.setCustomerEdit(false);
  await wait(200);
  check(listChanged > ch1 && !(await names()).includes('update_customer'), '关掉后通知客户端，工具消失');
  const last = log().find((e) => !e.undone);
  check(ctl.aiLog.undo(last.id).ok, '开关关着也能撤销');

  await client.close();
  await ctl.setEnabled(false);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
