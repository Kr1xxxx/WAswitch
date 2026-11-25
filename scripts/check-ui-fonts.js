// 界面字体自检（src/ui-fonts.js + 关于页那一行）。本机假服务器给清单、zip 包、字体和授权文件，假注册表，临时字体目录。
// 查：没登录、不空闲、不是 Windows 都不装；装好后文件名带哈希、注册表指着它、授权文件在；再查一次哈希一致就不下载；
// 清单里哈希变了装新的、删掉旧的；旧文件删不掉留到下次；校验值对不上、文件太大、不是字体都不装、1 小时后再试；
// 清单里坏的条目（http、路径、注册名带反斜杠）不要；关于页 900×600 下有「已安装界面字体」一行，没装时没有。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-ui-fonts.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const assert = require('assert');
const { app, BrowserWindow, session } = require('electron');
const { UiFonts, parseManifest, unzipEntry, electronFetcher, IDLE_S } = require('../src/ui-fonts');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const done = (code, msg) => { fs.writeSync(2, `${msg}\n`); app.exit(code); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fakeFont = (seed) => Buffer.concat([Buffer.from([0, 1, 0, 0]), crypto.createHash('sha512').update(seed).digest(), Buffer.alloc(4000, seed.length)]);

// 最小的 zip：一个 deflate 文件 + 一个不压缩的文件
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let off = 0;
  for (const [name, data, deflate] of files) {
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(zlib.crc32(data), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(zlib.crc32(data), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, body);
    centrals.push(ch, n);
    off += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

app.whenReady().then(async () => {
  // ---- 清单校验
  const good = { id: 'a', name: 'Sans A', url: 'https://example.com/a.ttf', sha256: 'a'.repeat(64), size: 10, file: 'SansA', reg: 'Sans A (TrueType)' };
  const one = (f, opt) => parseManifest(JSON.stringify({ version: 1, fonts: [f] }), opt);
  assert.strictEqual(one(good).length, 1);
  assert.strictEqual(one({ ...good, url: 'http://example.com/a.ttf' }).length, 0, '不收 http');
  assert.strictEqual(one({ ...good, url: 'http://127.0.0.1:1/a.ttf' }).length, 0, '本机地址只给自检');
  assert.strictEqual(one({ ...good, url: 'http://127.0.0.1:1/a.ttf' }, { loopback: true }).length, 1);
  assert.strictEqual(one({ ...good, file: '..\\evil' }).length, 0, '文件名不能带路径');
  assert.strictEqual(one({ ...good, reg: 'X\\Y (TrueType)' }).length, 0, '注册名不能带反斜杠');
  assert.strictEqual(one({ ...good, sha256: 'xyz' }).length, 0, 'sha256 格式');
  assert.strictEqual(one({ ...good, size: 200 * 1024 * 1024 }).length, 0, '太大的字体');
  assert.strictEqual(one({ ...good, extras: [{ url: good.url, sha256: good.sha256, file: 'a.exe' }] })[0].extras.length, 0, '附带文件只收 .txt');
  assert.throws(() => parseManifest('{"version":2,"fonts":[]}'), /格式不对/);
  assert.throws(() => parseManifest('<html>'), /格式不对/);

  // ---- 假服务器
  let fontA = fakeFont('A1');
  const fontB = fakeFont('B1');
  const lic = Buffer.from('SIL Open Font License 1.1\n');
  let zip = makeZip([['Pkg/License.txt', Buffer.from('notice'), false], ['Pkg/Sans A.ttf', fontA, true]]);
  assert.ok(unzipEntry(zip, 'Pkg/Sans A.ttf').equals(fontA), 'zip 解出来和原来一样');
  assert.throws(() => unzipEntry(zip, 'Pkg/none.ttf'), /没有要的文件/);
  const hits = {};
  let serveB = fontB;
  let manifest = null;
  const srv = http.createServer((q, res) => {
    hits[q.url] = (hits[q.url] || 0) + 1;
    const body = { '/m.json': () => Buffer.from(JSON.stringify(manifest)), '/a.zip': () => zip, '/b.ttf': () => serveB, '/OFL.txt': () => lic, '/big': () => Buffer.alloc(2 * 1024 * 1024) }[q.url];
    if (!body) { res.statusCode = 404; res.end(); return; }
    res.end(body());
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const mf = () => ({ version: 1, fonts: [
    { id: 'sans-a', name: 'Sans A', url: `${base}/a.zip`, zipEntry: 'Pkg/Sans A.ttf', size: fontA.length, sha256: sha(fontA), file: 'SansA', reg: 'Sans A (TrueType)' },
    { id: 'serif-b', name: 'Serif B', url: `${base}/b.ttf`, size: fontB.length, sha256: sha(fontB), file: 'SerifB', reg: 'Serif B (TrueType)',
      extras: [{ url: `${base}/OFL.txt`, sha256: sha(lic), file: 'SerifB-OFL.txt' }] },
  ] });
  manifest = mf();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uifonts-'));
  const fontsDir = path.join(tmp, 'Fonts');
  const reg = new Map();
  const registry = { get: async (n) => (reg.has(n) ? reg.get(n) : null), set: async (n, v) => { reg.set(n, v); }, remove: async (n) => { reg.delete(n); } };
  let now = 1e12;
  let enrolled = false;
  let idle = 0;
  let changes = 0;
  const logs = [];
  const mk = (platform = 'win32') => new UiFonts({ userData: tmp, fontsDir, platform, registry, enrolled: () => enrolled, idleSeconds: () => idle, now: () => now,
    fetch: electronFetcher(session.fromPartition('uifonts-check', { cache: false })), manifestUrl: `${base}/m.json`, loopback: true,
    onChange: () => { changes++; }, log: (m) => logs.push(m) });
  let f = mk();

  // 不该装的时候不装
  assert.strictEqual(f.tick(), null, '没登录不装');
  enrolled = true;
  idle = IDLE_S - 1;
  assert.strictEqual(f.tick(), null, '有人在用电脑不装');
  idle = IDLE_S;
  assert.strictEqual(mk('darwin').tick(), null, 'Mac 不装');
  assert.deepStrictEqual(mk('darwin').installed(), []);
  assert.strictEqual(hits['/m.json'], undefined, '不该装时一个请求都不发');

  // 装
  let r = await f.tick();
  assert.deepStrictEqual(r, { installed: ['Sans A', 'Serif B'] }, JSON.stringify(r));
  const pa = path.join(fontsDir, `SansA-${sha(fontA).slice(0, 12)}.ttf`);
  const pb = path.join(fontsDir, `SerifB-${sha(fontB).slice(0, 12)}.ttf`);
  assert.ok(fs.readFileSync(pa).equals(fontA) && fs.readFileSync(pb).equals(fontB), '字体原样装进字体目录，文件名带哈希');
  assert.ok(fs.readFileSync(path.join(fontsDir, `SerifB-OFL-${sha(lic).slice(0, 12)}.txt`)).equals(lic), 'OFL 授权文件一起放着');
  assert.strictEqual(reg.get('Sans A (TrueType)'), pa);
  assert.strictEqual(reg.get('Serif B (TrueType)'), pb);
  assert.deepStrictEqual(f.installed(), ['Sans A', 'Serif B']);
  assert.strictEqual(changes, 1, '装好后刷新关于页');
  assert.strictEqual(fs.readdirSync(fontsDir).filter((n) => n.endsWith('.tmp')).length, 0, '没留临时文件');

  // 一天内不再查；过一天查清单，哈希一致不下载
  assert.strictEqual(f.tick(), null, '装好后一天内不再查');
  now += 25 * 3600 * 1000;
  f = mk(); // 重启软件后也认得已经装过
  assert.deepStrictEqual(f.installed(), ['Sans A', 'Serif B']);
  r = await f.tick();
  assert.deepStrictEqual(r, { installed: [] });
  assert.strictEqual(hits['/m.json'], 2);
  assert.strictEqual(hits['/a.zip'], 1, '哈希一致不重下');
  assert.strictEqual(hits['/b.ttf'], 1, '哈希一致不重下');

  // 注册表被删了：重装（不用重下的文件也照样补注册表）
  reg.delete('Serif B (TrueType)');
  now += 25 * 3600 * 1000;
  r = await f.tick();
  assert.deepStrictEqual(r, { installed: ['Serif B'] });
  assert.strictEqual(reg.get('Serif B (TrueType)'), pb);
  assert.strictEqual(hits['/b.ttf'], 1, '文件还在就不重下，只补注册表');
  assert.strictEqual(hits['/OFL.txt'], 1, '授权文件也不重下');

  // 清单里哈希变了：装新的，删旧的
  fontA = fakeFont('A2');
  zip = makeZip([['Pkg/Sans A.ttf', fontA, true]]);
  manifest = mf();
  now += 25 * 3600 * 1000;
  r = await f.tick();
  assert.deepStrictEqual(r, { installed: ['Sans A'] });
  const pa2 = path.join(fontsDir, `SansA-${sha(fontA).slice(0, 12)}.ttf`);
  assert.strictEqual(reg.get('Sans A (TrueType)'), pa2, '注册表指向新文件');
  assert.ok(fs.existsSync(pa2) && !fs.existsSync(pa), '旧文件删掉了');

  // 旧文件删不掉（被占用）：留到下次再删，不报错
  const locked = path.join(fontsDir, 'Old-000000000000.ttf');
  fs.mkdirSync(path.join(locked, 'x'), { recursive: true }); // 目录删不掉，当作被占用的文件
  f.state.stale.push(locked);
  f.save();
  now += 25 * 3600 * 1000;
  r = await f.tick();
  assert.deepStrictEqual(r, { installed: [] });
  assert.deepStrictEqual(f.state.stale, [locked], '删不掉的留着');
  fs.rmSync(locked, { recursive: true });
  fs.writeFileSync(locked, 'old');
  now += 25 * 3600 * 1000;
  await f.tick();
  assert.ok(!fs.existsSync(locked) && f.state.stale.length === 0, '下次删掉');

  // 校验值对不上：不装，1 小时后再试
  serveB = fakeFont('tampered');
  manifest = mf();
  manifest.fonts[1].sha256 = sha(fakeFont('B9'));
  now += 25 * 3600 * 1000;
  r = await f.tick();
  assert.ok(/校验值对不上/.test(r.error), JSON.stringify(r));
  assert.strictEqual(reg.get('Serif B (TrueType)'), pb, '注册表没被改');
  assert.ok(!fs.readdirSync(fontsDir).some((n) => n.startsWith(`SerifB-${manifest.fonts[1].sha256.slice(0, 12)}`)), '没写坏文件');
  assert.ok(logs.some((l) => /Serif B 没装好/.test(l)), logs.join('\n'));
  assert.strictEqual(f.tick(), null, '失败后 1 小时内不再试');
  now += 61 * 60 * 1000;
  assert.ok(f.tick(), '1 小时后再试');
  await f.running;

  // 不是字体（哈希和大小都对，但文件头不对）
  const notFont = Buffer.alloc(100, 7);
  serveB = notFont;
  manifest = mf();
  Object.assign(manifest.fonts[1], { size: notFont.length, sha256: sha(notFont) });
  now += 25 * 3600 * 1000;
  r = await f.tick();
  assert.ok(/不是字体/.test(r.error), JSON.stringify(r));

  // 太大：下载中途停下
  const fetch = electronFetcher(session.fromPartition('uifonts-check', { cache: false }));
  await assert.rejects(fetch(`${base}/big`, 1024 * 1024), /文件太大/);
  await assert.rejects(fetch(`${base}/none`, 1024), /下载返回 404/);
  srv.close();

  // ---- 关于页
  const w = new BrowserWindow({ show: true, width: 900, height: 600, webPreferences: { preload: path.join(__dirname, 'fixtures', 'update-card-fake-preload.js'), contextIsolation: false, sandbox: false } });
  w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) fs.writeSync(2, `[console] ${msg}\n`); });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const js = (fn, ...a) => w.webContents.executeJavaScript(`(${fn})(${a.map((x) => JSON.stringify(x)).join(',')})`);
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  const st = (about) => ({ accounts: [{ id: 'a1', name: 'Lukas', color: '#3b82f6', proxyLabel: '直连', mode: 'web', groupId: '' }], groups: [], activeId: 'a1', page: 'settings',
    platform: 'win32', collapsed: false, settings: {}, update: { status: 'none', version: '', current: '1.0.20', lastResult: '已是最新版本' },
    about: { version: '1.0.20', chrome: '152.0.0.0', ...about }, mcp: { status: 'dev', version: '1.0.20' } });
  const state = async (s) => { await js((x) => window.__cbs.state(x), s); await wait(300); };
  await state(st({ uiFonts: [] }));
  await js(() => [...document.querySelectorAll('#side .tab')].find((b) => b.innerText.trim() === '关于').click());
  await wait(300);
  const row = () => js(() => {
    const spans = [...document.querySelectorAll('.kv > span')];
    const i = spans.findIndex((s) => s.innerText.trim() === '已安装界面字体');
    if (i < 0) return null;
    const v = spans[i + 1];
    return { label: spans[i].getBoundingClientRect().height, value: v.innerText.trim(), h: v.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(v).lineHeight) || 20 };
  });
  assert.strictEqual(await row(), null, '没装时没有这一行');
  await state(st({ uiFonts: ['OPPO Sans 4.0', 'Noto Serif SC'] }));
  const rr = await row();
  assert.ok(rr && rr.value === 'OPPO Sans 4.0、Noto Serif SC', JSON.stringify(rr));
  assert.ok(rr.h < rr.lh * 1.5 && rr.label < rr.lh * 1.5, `900×600 下一行放得下：${JSON.stringify(rr)}`);
  if (process.env.SHOT_DIR) fs.writeFileSync(path.join(process.env.SHOT_DIR, 'about-ui-fonts.png'), (await w.webContents.capturePage()).toPNG());
  done(0, 'check-ui-fonts: ok');
}).catch((e) => done(1, `check-ui-fonts 失败：${e && e.stack || e}`));
