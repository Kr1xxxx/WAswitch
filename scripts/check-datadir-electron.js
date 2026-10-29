// 整机自检：老电脑的账号数据搬到 D 盘以后，号还是登录着的。node scripts/check-datadir-electron.js
// （Linux 上套 xvfb-run -a；Windows CI 上直接跑，safeStorage 走真的 DPAPI）
//
// 1. 写（旧版本的样子，不加载 datadir.js）：userData 在 C，给一个 persist: 分区写 cookie、IndexedDB、localStorage，
//    再用 safeStorage 加密一串字（翻译密钥、代理密码就是这么存的）
// 2. 搬：datadir.move（和 --move-data 那次启动一样）
// 3. 读（新版本：datadir.apply 在 ready 之前把 userData 指到 D）：三样都读得出来，safeStorage 解得开；C 盘没被 Chromium 写新东西
// 另外：新装的电脑 Chromium 直接写在 D；D 盘打不开时用 C 启动
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const PHASE = process.env.DD_PHASE;

if (!PHASE) {
  // ---------- 调度（普通 node） ----------
  const dd = require('../src/datadir');
  const electron = require('electron');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'datadir-e2e-'));
  const home = path.join(base, 'C', 'WAswitch');
  const root = path.join(base, 'D', 'WAswitch');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const run = (phase, extra = {}) => {
    const r = spawnSync(electron, ['--no-sandbox', __filename], {
      env: { ...process.env, DD_PHASE: phase, DD_HOME: home, DD_ROOT: root, ...extra },
      encoding: 'utf8', timeout: 90000,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const m = out.match(/DD_RESULT (.*)/);
    if (!m) { console.error(out); throw new Error(`${phase} 没有结果（退出码 ${r.status}）`); }
    return JSON.parse(m[1]);
  };

  const w = run('write');
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.ok(fs.existsSync(path.join(home, 'Local State')), '旧版本在 C 盘写了 Local State');
  assert.ok(fs.existsSync(path.join(home, 'Partitions', 'wa-t1')), '旧版本在 C 盘有分区');
  fs.writeFileSync(path.join(home, 'accounts.json'), JSON.stringify([{ id: 't1', name: 'London' }]));
  console.log('ok 旧版本在 C 盘写好 cookie、IndexedDB、localStorage、safeStorage');

  const m = dd.move({ home, root, wait: () => {} });
  assert.equal(m.ok, true, JSON.stringify(m));
  const data = path.join(root, 'data');
  console.log(`ok 搬到 D（${m.files} 个文件）`);

  const cBefore = fs.readdirSync(home).sort().join(',');
  const r = run('read');
  assert.equal(r.userData, data, 'userData 指到 D');
  assert.equal(r.sessionData, data, 'sessionData 也指到 D');
  assert.equal(r.cookie, 'logged-in', 'cookie 还在（号还登录着）');
  assert.equal(r.idb, 'wa-keys', 'IndexedDB 还在');
  assert.equal(r.ls, 'wa-local', 'localStorage 还在');
  if (w.enc) assert.equal(r.secret, 'proxy-pass', 'safeStorage 加密的字解得开');
  else if (process.platform === 'win32') throw new Error('Windows 上 safeStorage 应该能用');
  else console.log('（这台 Linux 没有 safeStorage，跳过解密）');
  assert.equal(fs.readdirSync(home).sort().join(','), cBefore, 'C 盘没被写新东西');
  console.log('ok 新版本从 D 盘读到 cookie、IndexedDB、localStorage' + (w.enc ? '、safeStorage' : ''));

  // 删 C 盘旧数据以后再开一次，还是好的
  dd.cleanOld(home).then(async (cleaned) => {
    assert.equal(cleaned, true);
    assert.ok(!fs.existsSync(path.join(home, 'Local State')));
    const r2 = run('read');
    assert.equal(r2.cookie, 'logged-in');
    assert.equal(r2.idb, 'wa-keys');
    if (w.enc) assert.equal(r2.secret, 'proxy-pass');
    console.log('ok 删掉 C 盘旧数据后，D 盘那份照样能用');

    // D 盘打不开：用 C 启动（C 盘那份已删，就是空的），指针不改；插回来又是 D
    fs.renameSync(root, `${root}-x`);
    const f = run('read');
    assert.equal(f.userData, home, 'D 盘打不开时用 C');
    assert.equal(f.fallback, true);
    assert.equal(f.cookie, '', '对照：C 盘那份已删，这里读不到 cookie（证明上面读到的确实来自 D）');
    assert.equal(dd.readPointer(home).dir, data, '指针没改');
    fs.renameSync(`${root}-x`, root);
    const back = run('read');
    assert.equal(back.userData, data);
    assert.equal(back.cookie, 'logged-in', 'D 盘回来，号还在');
    console.log('ok D 盘打不开时用 C 启动；插回来回到 D，号还在');

    // 新装的电脑：C 盘空的，Chromium 直接写在 D
    const home2 = path.join(base, 'C2', 'WAswitch');
    const root2 = path.join(base, 'D2', 'WAswitch');
    fs.mkdirSync(home2, { recursive: true });
    fs.mkdirSync(root2, { recursive: true });
    const n = run('read', { DD_HOME: home2, DD_ROOT: root2 });
    assert.equal(n.userData, path.join(root2, 'data'));
    assert.ok(fs.existsSync(path.join(root2, 'data', 'Local State')), 'Local State 写在 D');
    assert.ok(!fs.existsSync(path.join(home2, 'Local State')), 'C 盘没有 Local State');
    assert.ok(!fs.existsSync(path.join(home2, 'Partitions')), 'C 盘没有分区');
    console.log('ok 新装的电脑：Chromium 的数据直接写在 D');

    // 没有 D 盘：新装的电脑全在 C
    const home3 = path.join(base, 'C3', 'WAswitch');
    fs.mkdirSync(home3, { recursive: true });
    const nod = run('read', { DD_HOME: home3, DD_ROOT: path.join(base, 'nope', 'WAswitch') });
    assert.equal(nod.userData, home3);
    assert.ok(fs.existsSync(path.join(home3, 'Local State')));
    assert.ok(!fs.existsSync(path.join(base, 'nope')), '没有建 D:\\WAswitch');
    console.log('ok 没有 D 盘：全在 C');

    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    console.log('check-datadir-electron: 全部通过');
  }).catch((e) => { console.error(e); process.exit(1); });
} else {
  // ---------- Electron 里 ----------
  const { app, session, safeStorage, BrowserWindow } = require('electron');
  const home = process.env.DD_HOME;
  const root = process.env.DD_ROOT;
  const done = (obj) => { process.stderr.write(`DD_RESULT ${JSON.stringify(obj)}\n`); app.exit(0); };
  let start = null;
  if (PHASE === 'write') {
    app.setPath('userData', home); // 旧版本：userData 就是 %APPDATA%\WAswitch
    app.setPath('sessionData', home);
  } else {
    app.setPath('userData', home); // 先装成 Electron 的默认位置，再让 datadir 选
    start = require('../src/datadir').apply(app, { platform: 'win32', packaged: true, root, home });
  }
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  setTimeout(() => done({ ok: false, error: 'timeout' }), 60000).unref();
  const PORT = 39771; // 同一个来源（端口也算），写和读要一样
  const page = '<!doctype html><title>t</title>';
  app.whenReady().then(async () => {
    const server = http.createServer((_q, res) => { res.setHeader('content-type', 'text/html'); res.end(page); });
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
    const url = `http://127.0.0.1:${PORT}/`;
    const ses = session.fromPartition('persist:wa-t1');
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses } });
    await win.loadURL(url);
    const js = (code) => win.webContents.executeJavaScript(code);
    try {
      if (PHASE === 'write') {
        await ses.cookies.set({ url, name: 'wa', value: 'logged-in', expirationDate: Math.floor(Date.now() / 1000) + 86400 * 30 });
        await ses.cookies.flushStore();
        await js(`new Promise((ok, bad) => { const r = indexedDB.open('wawc', 1); r.onupgradeneeded = () => r.result.createObjectStore('keys');
          r.onsuccess = () => { const tx = r.result.transaction('keys', 'readwrite'); tx.objectStore('keys').put('wa-keys', 'k'); tx.oncomplete = () => { r.result.close(); ok(); }; tx.onerror = bad; }; r.onerror = bad; })`);
        await js(`localStorage.setItem('wa', 'wa-local')`);
        const enc = safeStorage.isEncryptionAvailable();
        if (enc) fs.writeFileSync(path.join(home, 'secret.bin'), safeStorage.encryptString('proxy-pass'));
        win.destroy();
        await ses.flushStorageData?.();
        setTimeout(() => done({ ok: true, enc }), 1500);
      } else {
        const cookies = await ses.cookies.get({ name: 'wa' });
        const idb = await js(`new Promise((ok) => { const r = indexedDB.open('wawc', 1); r.onupgradeneeded = () => r.result.createObjectStore('keys');
          r.onsuccess = () => { try { const g = r.result.transaction('keys').objectStore('keys').get('k'); g.onsuccess = () => ok(g.result || ''); g.onerror = () => ok(''); } catch { ok(''); } }; r.onerror = () => ok(''); })`);
        const ls = await js(`localStorage.getItem('wa') || ''`);
        let secret = '';
        try { secret = safeStorage.decryptString(fs.readFileSync(path.join(app.getPath('userData'), 'secret.bin'))); } catch { /* 没有或解不开 */ }
        done({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), fallback: !!start?.fallback, cookie: cookies[0]?.value || '', idb, ls, secret });
      }
    } catch (e) { done({ ok: false, error: String(e && e.stack || e) }); }
  });
}
