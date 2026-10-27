// 自检：顶栏“客户当地时间”——按客户号码认时区（src/customer-time.js）和主进程推给界面的内容（src/peer-clock.js）。
// 运行：node scripts/check-customer-time.js
const { peerZone, zoneOfNumber, fromChatId, fromText, customerPhone } = require('../src/customer-time');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const z = (tz, place, approx = false) => ({ tz, place, approx });

// 德国：一个时区
check(same(peerZone({ chat: '4915112345678@c.us', title: 'Lena Fischer' }), z('Europe/Berlin', 'Berlin')), '德国 +49 手机：Berlin');
check(same(peerZone({ chat: '', title: '+49 30 1234567' }), z('Europe/Berlin', 'Berlin')), '德国：没存名字的联系人，标题就是号码');

// 美国：多时区，按区号
check(same(peerZone({ chat: '12125550142@c.us', title: 'John Miller' }), z('America/New_York', 'New York')), '美国 212（纽约）：New York');
check(same(peerZone({ chat: '13105550199@c.us' }), z('America/Los_Angeles', 'Los Angeles')), '美国 310（洛杉矶）：Los Angeles');
check(same(peerZone({ chat: '13125550100@c.us' }), z('America/Chicago', 'Chicago')), '美国 312（芝加哥）：Chicago');
check(same(peerZone({ chat: '13035550100@c.us' }), z('America/Denver', 'Denver')), '美国 303（丹佛）：Denver');
check(same(peerZone({ title: '+1 (602) 555-0100' }), z('America/Phoenix', 'Phoenix')), '美国 602（凤凰城，不过夏令时）：Phoenix');
check(same(peerZone({ chat: '19995550100@c.us' }), z('America/New_York', 'New York', true)), '美国区号认不出：按主要时区 New York，标“约”');
check(same(peerZone({ chat: '14165550100@c.us' }), z('America/Toronto', 'Toronto')), '加拿大 416（多伦多）：Toronto');

// 英国：几个时区名但钟点一样，不算“约”
check(same(peerZone({ chat: '447700900123@c.us' }), z('Europe/London', 'London')), '英国 +44 手机：London，不标“约”');
check(same(peerZone({ title: '00 44 20 7946 0958' }), z('Europe/London', 'London')), '英国：00 开头的写法也认');

// 其它多时区国家：认不出就标“约”
check(same(zoneOfNumber('61412345678'), z('Australia/Sydney', 'Sydney', true)), '澳洲手机号（全国通用）：约 Sydney');
check(same(zoneOfNumber('61733334444'), z('Australia/Brisbane', 'Brisbane')), '澳洲 07（昆士兰）：Brisbane');
check(same(zoneOfNumber('79161234567'), z('Europe/Moscow', 'Moscow', true)), '俄罗斯手机号（全国通用）：约 Moscow');
check(same(zoneOfNumber('5511912345678'), z('America/Sao_Paulo', 'Sao Paulo')), '巴西 11（圣保罗）：Sao Paulo');
check(same(zoneOfNumber('34922123456'), z('Atlantic/Canary', 'Canary')), '西班牙 922（加那利）：Canary');
check(same(zoneOfNumber('353851234567'), z('Europe/Dublin', 'Dublin')), '爱尔兰：Dublin（不是 London）');
check(same(zoneOfNumber('33612345678'), z('Europe/Paris', 'Paris')), '法国：Paris');

// 没号码 / 群聊：返回 null，顶栏照旧
check(peerZone({ chat: '', title: 'Anna Schmidt' }) === null, '没号码（只有名字）：null');
check(peerZone({ chat: '123456789012345@lid', title: 'Anna Schmidt' }) === null, '隐私编号 @lid、标题是名字：null');
check(same(peerZone({ chat: '123456789012345@lid', title: '+49 151 23456789' }), z('Europe/Berlin', 'Berlin')), '隐私编号 @lid、标题是号码：按标题');
check(peerZone({ chat: '120363012345678901@g.us', title: '+49 151 23456789' }) === null, '群聊：null（就算群名像号码）');
check(peerZone({}) === null, '什么都没有：null');
check(peerZone({ title: '0151 23456789' }) === null, '本地写法（没国家码）：认不出国家，null');
check(fromText('+86 abc') === '' && fromText('+12') === '', '不像号码的标题不认');
check(zoneOfNumber('0000000000') === null, '国家码不存在：null');

// 轻量号 jid 带设备号
check(same(fromChatId('4915112345678:12@s.whatsapp.net'), { group: false, digits: '4915112345678' }), '轻量号 jid（带设备号）认出号码');

// 客户名单：名字对上、填了带国家码的电话
const customers = [
  { name: 'Anna Schmidt', phone: '+1 212 555 0142', accountId: 'b' },
  { name: 'Anna Schmidt', phone: '+49 151 23456789', accountId: 'a' },
  { name: 'Pierre Martin', phone: '06 12 34 56 78', accountId: 'a' },
];
check(customerPhone(customers, 'a', 'anna  schmidt') === '+49 151 23456789', '客户名单：同一个号下的同名客户优先');
check(same(peerZone({ chat: '123@lid', title: 'Anna Schmidt', customerPhone: customerPhone(customers, 'a', 'Anna Schmidt') }), z('Europe/Berlin', 'Berlin')), '对话没号码时用客户名单里的电话');
check(peerZone({ title: 'Pierre Martin', customerPhone: customerPhone(customers, 'a', 'Pierre Martin') }) === null, '客户名单里的电话没国家码：不猜');

// peer-clock：主进程只把时区和城市名发给界面，不带号码；锁着、看不见时不读
async function clockChecks() {
  const Module = require('module');
  const fakeWaPage = { readChatPeer: async (wc) => wc.page };
  const origLoad = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === './wa-page' && parent && /peer-clock\.js$/.test(parent.filename)) return fakeWaPage;
    return origLoad.call(this, req, parent, ...rest);
  };
  const { setupPeerClock } = require('../src/peer-clock');
  Module._load = origLoad;
  const sent = [];
  const accs = [{ id: 'a' }, { id: 'l', mode: 'lite' }];
  const wc = (page) => ({ isDestroyed: () => false, page });
  const views = new Map([['a', { webContents: wc({ title: 'Lena Fischer', chat: '4915112345678@c.us' }) }]]);
  const win = { visible: true, isVisible() { return this.visible; }, isMinimized: () => false };
  const ctx = {
    page: 'account', locked: false, activeId: 'a', win,
    shellView: { webContents: { isDestroyed: () => false, send: (ch, msg) => sent.push({ ch, msg }) } },
    customerStore: { list: () => [] },
    findAcc: (id) => accs.find((x) => x.id === id), isLite: (x) => x.mode === 'lite', views, problems: new Set(),
    liteChat: () => ({ jid: '12125550142@s.whatsapp.net', view: { jid: '12125550142@s.whatsapp.net', title: 'John Miller' } }),
    parkedCustomer: () => false,
  };
  const pc = setupPeerClock(ctx);
  pc.stop();
  await pc.tick();
  check(sent.length === 1 && sent[0].ch === 'peer:zone' && same(sent[0].msg, { accountId: 'a', zone: z('Europe/Berlin', 'Berlin') }), '网页号：推给界面 Berlin');
  check(!JSON.stringify(sent).includes('4915112345678'), '推给界面的内容里没有客户号码');
  await pc.tick();
  check(sent.length === 1, '没变化不重复推');
  views.get('a').webContents.page = { title: 'Team DACH', chat: '120363012345678901@g.us' };
  await pc.tick();
  check(sent.length === 2 && sent[1].msg.zone === null, '切到群聊：推 null，顶栏回到原来的时间');
  ctx.activeId = 'l';
  await pc.tick();
  check(sent.length === 3 && same(sent[2].msg, { accountId: 'l', zone: z('America/New_York', 'New York') }), '轻量号：按打开的对话 jid 推 New York');
  ctx.locked = true;
  ctx.activeId = 'a';
  await pc.tick();
  check(sent.length === 3, '锁着时不读');
  ctx.locked = false;
  win.visible = false;
  await pc.tick();
  check(sent.length === 3, '窗口看不见时不读');
}

clockChecks().then(() => {
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
});
