// 直连网页号的时区跟着系统代理出口走；代理号、轻量号不动。出口要连续两次一样才改。
const assert = require('node:assert/strict');
const { createDirectTz } = require('../src/direct-tz');

(async () => {
  const fp = (region) => ({ region });
  const accs = [
    { id: 'a', name: 'Emma', proxy: '', mode: 'web', fingerprint: fp('US_W') },
    { id: 'b', name: 'Lukas', proxy: '', mode: 'web', fingerprint: fp('DE') },
    { id: 'c', name: 'Chloe', proxy: 'socks5://127.0.0.1:7891', mode: 'web', fingerprint: fp('US') },
    { id: 'd', name: 'Mateo', proxy: '', mode: 'lite', fingerprint: fp('auto') },
    { id: 'e', name: 'Sofia', proxy: '', mode: 'web', fingerprint: fp('auto') },
  ];
  let exit = { ok: true, timezone: 'Asia/Hong_Kong' };
  let tests = 0;
  let saves = 0;
  let gate = null;
  const sent = [];
  const wc = { isDestroyed: () => false, debugger: { isAttached: () => true, sendCommand: async (m, p) => { sent.push([m, p.timezoneId]); } } };
  const tz = createDirectTz({
    accounts: () => accs,
    isDirectWeb: (a) => a.mode !== 'lite' && !a.proxy,
    testSystem: async () => { tests++; if (gate) await gate; return exit; },
    save: () => { saves++; },
    viewOf: (id) => (id === 'a' ? wc : null),
    onChange: () => {},
    confirmMs: 1e9,
  });
  const regions = () => accs.map((a) => a.fingerprint.region);
  assert.deepEqual(await tz.sync(), [], '第一次看到新出口先不改');
  assert.deepEqual(regions(), ['US_W', 'DE', 'US', 'auto', 'auto']);
  const changed = await tz.sync();
  assert.deepEqual(changed.map((a) => a.id), ['a', 'b', 'e'], '第二次还是这个出口才改');
  assert.deepEqual(regions(), ['HK', 'HK', 'US', 'auto', 'HK']);
  assert.deepEqual(sent, [['Emulation.setTimezoneOverride', 'Asia/Hong_Kong']], '打开着的页面直接换时区');
  assert.equal(saves, 1);
  assert.deepEqual(await tz.sync(), [], '出口没变不重复改');
  assert.equal(saves, 1);

  exit = { ok: false, error: 'x' };
  await tz.sync(); await tz.sync();
  assert.equal(accs[0].fingerprint.region, 'HK', '查不到出口时不动');

  // 节点来回切：两次读数不一样就不改
  exit = { ok: true, timezone: 'America/New_York' };
  await tz.sync();
  exit = { ok: true, timezone: 'Asia/Hong_Kong' };
  await tz.sync();
  assert.equal(accs[0].fingerprint.region, 'HK');

  // 正在查时又被叫：查完补一次，用的是新出口
  exit = { ok: true, timezone: 'America/Toronto' };
  await tz.sync(); // 看到 Toronto，等确认
  let open;
  gate = new Promise((r) => { open = r; });
  const before = tests;
  const p1 = tz.sync();
  const p2 = tz.sync();
  const p3 = tz.sync();
  gate = null; open();
  await Promise.all([p1, p2, p3]);
  assert.equal(tests - before, 2, '中途的多次触发合成一次补查');
  assert.equal(accs[0].fingerprint.region, 'tz:America/Toronto');

  // 自检里的「改成和出口一致」走同一条路
  sent.length = 0;
  await tz.apply(accs[0], 'GB');
  assert.equal(accs[0].fingerprint.region, 'GB');
  assert.deepEqual(sent, [['Emulation.setTimezoneOverride', 'Europe/London']]);
  console.log('PASS: 直连网页号时区跟随系统代理出口');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
