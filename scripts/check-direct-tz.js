// 直连网页号的时区跟着系统代理出口走；代理号、轻量号不动。
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
  const sent = [];
  const wc = { isDestroyed: () => false, debugger: { isAttached: () => true, sendCommand: async (m, p) => { sent.push([m, p.timezoneId]); } } };
  const tz = createDirectTz({
    accounts: () => accs,
    isDirectWeb: (a) => a.mode !== 'lite' && !a.proxy,
    testSystem: async () => { tests++; return exit; },
    save: () => { saves++; },
    viewOf: (id) => (id === 'a' ? wc : null),
    onChange: () => {},
  });
  const changed = await tz.sync();
  assert.deepEqual(changed.map((a) => a.id), ['a', 'b', 'e']);
  assert.deepEqual(accs.map((a) => a.fingerprint.region), ['HK', 'HK', 'US', 'auto', 'HK']);
  assert.deepEqual(sent, [['Emulation.setTimezoneOverride', 'Asia/Hong_Kong']], '打开着的页面直接换时区');
  assert.equal(saves, 1);
  assert.deepEqual(await tz.sync(), [], '出口没变不重复改');
  assert.equal(saves, 1);
  exit = { ok: false, error: 'x' };
  assert.deepEqual(await tz.sync(), [], '查不到出口时不动');
  assert.equal(accs[0].fingerprint.region, 'HK');
  exit = { ok: true, timezone: 'America/Toronto' };
  await Promise.all([tz.sync(), tz.sync()]);
  assert.equal(tests, 4, '同时触发只查一次');
  assert.equal(accs[0].fingerprint.region, 'tz:America/Toronto');
  console.log('PASS: 直连网页号时区跟随系统代理出口');
})().catch((e) => { console.error(e); process.exit(1); });
