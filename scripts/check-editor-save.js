// 编辑页保存（src/editor-ipc.js 的 editor:save）什么时候去测代理出口。
// 审计第 5 条：网页版 + 代理 + 地区“跟随本机”时，只改名字也每次都测一遍，保存要等几秒。
// 不开 Electron：假的 electron 模块 + 假的 ctx，数 proxy.test 被调了几次。
const assert = require('assert');
const Module = require('module');

const fakeElectron = {
  // 编辑页保存不再弹任何对话框：一调用就算失败
  dialog: { showMessageBox: async () => { throw new Error('editor:save 不该弹对话框'); } },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (b) => b.toString().replace(/^enc:/, ''),
  },
  net: {},
  session: {},
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

const proxy = require('../src/proxy');
const { setupEditorIpc } = require('../src/editor-ipc');

let tests = 0;
proxy.test = async () => { tests++; return { ok: true, ip: '9.9.9.9', country: 'US', timezone: 'America/New_York' }; };

const handlers = {};
const COLORS = ['#25d366'];
const ctx = {
  accounts: [],
  groups: [],
  handleShell: (name, fn) => { handlers[name] = fn; },
  findAcc: (id) => ctx.accounts.find((a) => a.id === id),
  isParked: () => false,
  isLite: (a) => a.mode === 'lite',
  visibleAccounts: () => ctx.accounts,
  nextName: () => '新账号',
  nextColor: () => COLORS[0],
  cleanNote: (s) => String(s || ''),
  cleanPhone: (s) => String(s || ''),
  applyPhone: (acc, phone) => { acc.phone = phone; },
  COLORS,
  LITE_SCHEMES: ['socks5', 'http'],
  newLiteKey: () => 'k',
  regionName: (c) => c,
  exitIps: new Map(),
  exitChanges: new Map(),
  recordExit: (acc, ip) => { acc.lastExit = { ip, at: 1 }; },
  problems: new Map(),
  saveAccounts: () => {},
  startAccount: async () => {},
  startLite: () => {},
  createView: async () => {},
  destroyView: () => {},
  refresh: () => {},
  notifier: { refresh: () => {} },
  primaryClash: new Map(),
  comparePrimary: () => { compared++; },
};
let compared = 0;
setupEditorIpc(ctx);
const save = handlers['editor:save'];

function webAcc(extra) {
  return {
    id: 'a1', name: '旧名字', note: '', phone: '', color: COLORS[0], proxy: 'socks5://127.0.0.1:7891', proxyPassword: '',
    exitLabel: 'US', fingerprint: { region: 'auto' }, mode: 'web', primary: true, allowCalls: false, ...extra,
  };
}
const form = (extra) => ({ id: 'a1', name: '新名字', color: COLORS[0], proxy: 'socks5://127.0.0.1:7891', region: 'auto', mode: 'web', ...extra });

(async () => {
  // 1. 只改名字：出口所在地已知，不发请求
  ctx.accounts = [webAcc()];
  tests = 0;
  assert.deepStrictEqual(await save(form()), { ok: true });
  assert.strictEqual(tests, 0, '只改名字不该测代理');
  assert.strictEqual(ctx.accounts[0].name, '新名字');
  assert.strictEqual(ctx.accounts[0].fingerprint.region, 'auto');

  // 2. 改了代理：要测，并按出口填好时区
  ctx.accounts = [webAcc()];
  tests = 0;
  await save(form({ proxy: 'socks5://127.0.0.1:7892' }));
  assert.strictEqual(tests, 1, '改了代理要测');
  assert.strictEqual(ctx.accounts[0].exitLabel, 'US');
  assert.notStrictEqual(ctx.accounts[0].fingerprint.region, 'auto');

  // 3. 代理没变，但还不知道出口所在地（上次测失败）：要测
  ctx.accounts = [webAcc({ exitLabel: '' })];
  tests = 0;
  await save(form());
  assert.strictEqual(tests, 1, '出口所在地为空要测');

  // 4. 填了新密码：要测
  ctx.accounts = [webAcc({ proxy: 'http://bob@1.2.3.4:8080' })];
  tests = 0;
  await save(form({ proxy: 'http://bob@1.2.3.4:8080', password: 'pw2' }));
  assert.strictEqual(tests, 1, '换了密码要测');

  // 5. 刚从别的地区改回“跟随本机”：要测
  ctx.accounts = [webAcc({ fingerprint: { region: 'DE' } })];
  tests = 0;
  await save(form());
  assert.strictEqual(tests, 1, '改回跟随本机要测');

  // 6. 自己选了地区：不测
  ctx.accounts = [webAcc({ fingerprint: { region: 'DE' } })];
  tests = 0;
  await save(form({ region: 'DE' }));
  assert.strictEqual(tests, 0, '自己选了地区不该测');

  // 7. 新建网页版 + 代理 + 跟随本机：要测
  ctx.accounts = [];
  tests = 0;
  await save({ name: '新号', color: COLORS[0], proxy: 'socks5://127.0.0.1:7893', region: 'auto', mode: 'web' });
  assert.strictEqual(tests, 1, '新建账号要测');

  // 8. 有轻量小号时改了主号的代理：不弹窗，后台和主号比一次出口
  ctx.accounts = [webAcc(), { id: 'l1', name: '小号', mode: 'lite', proxy: 'socks5://127.0.0.1:7895', proxyPassword: '', fingerprint: { region: 'auto' } }];
  compared = 0;
  assert.deepStrictEqual(await save(form({ proxy: 'socks5://127.0.0.1:7899' })), { ok: true });
  assert.strictEqual(compared, 1, '主号改了代理要在后台比一次');

  // 9. 只改主号名字：不比
  ctx.accounts = [webAcc(), { id: 'l1', name: '小号', mode: 'lite', proxy: 'socks5://127.0.0.1:7895', proxyPassword: '', fingerprint: { region: 'auto' } }];
  compared = 0;
  await save(form());
  assert.strictEqual(compared, 0, '只改名字不该比');

  // Audited proxy identity: endpoint alone cannot authorize changed credentials.
  const success = () => ({ ok: true, ip: '9.9.9.9', country: 'US', timezone: 'America/New_York' });
  const test = handlers['editor:test'];
  const load = handlers['editor:load'];
  const lf = { name: 'Lite', color: COLORS[0], proxy: 'http://alice@127.0.0.1:8080', password: 'test-one', mode: 'lite', liteConfirm: true };
  ctx.accounts = [];
  await test(lf);
  assert.ok((await save({ ...lf, proxy: 'http://bob@127.0.0.1:8080' })).error, 'different username requires test');
  assert.ok((await save({ ...lf, password: 'test-two' })).error, 'different password requires test');
  assert.deepStrictEqual(await save(lf), { ok: true }, 'exact tested identity saves');
  ctx.accounts = [];
  await test(lf);
  proxy.test = async () => ({ ok: false, error: 'synthetic failed test' });
  await test(lf);
  assert.ok((await save(lf)).error, 'failed retest invalidates prior success');
  let finishOld;
  proxy.test = () => new Promise(resolve => { finishOld = resolve; });
  const oldTest = test(lf);
  proxy.test = async () => ({ ok: false, error: 'synthetic newer failure' });
  await test(lf);
  finishOld(success()); await oldTest;
  assert.ok((await save(lf)).error, 'late success cannot replace newer failed test');
  proxy.test = () => new Promise(resolve => { finishOld = resolve; });
  const closing = test(lf);
  load(); finishOld(success()); await closing;
  assert.ok((await save(lf)).error, 'reopening editor invalidates in-flight test');
  proxy.test = async () => success();
  await test({ ...lf, mode: 'web' });
  assert.ok((await save(lf)).error, 'mode changes invalidate tested identity');
  ctx.accounts = [webAcc({ id: 'l1', mode: 'lite', primary: false }), webAcc({ id: 'l2', mode: 'lite', primary: false })];
  await test({ ...lf, id: 'l1' });
  assert.ok((await save({ ...lf, id: 'l2' })).error, 'test cannot transfer between accounts');
  ctx.accounts = [webAcc({ id: 'l1', mode: 'lite', primary: false, proxy: lf.proxy, proxyPassword: proxy.encryptPassword('test-one') })];
  assert.ok((await save({ ...lf, id: 'l1', proxy: 'http://alice:changed-inline@127.0.0.1:8080', password: '' })).error, 'inline password changes also require a matching test');

  // 直连网页号：时区跟着系统代理出口走，编辑页传来的地区不算数
  let sysTests = 0;
  proxy.testSystem = async () => { sysTests++; return { ok: true, ip: '8.8.8.8', country: 'HK', timezone: 'Asia/Hong_Kong' }; };
  ctx.accounts = [webAcc({ proxy: '', fingerprint: { region: 'HK' } })];
  await save(form({ proxy: '', region: 'US_W' }));
  assert.strictEqual(ctx.accounts[0].fingerprint.region, 'HK', '老的直连号保持现有时区');
  assert.strictEqual(sysTests, 0, '老的直连号保存不测');
  ctx.accounts = [webAcc({ fingerprint: { region: 'US' } })];
  await save(form({ proxy: '', region: 'US' }));
  assert.strictEqual(ctx.accounts[0].fingerprint.region, 'HK', '代理号改成直连：按系统代理出口定时区');
  assert.strictEqual(sysTests, 1);

  console.log('check-editor-save: ok');
})().catch((e) => { console.error(e); process.exit(1); });
