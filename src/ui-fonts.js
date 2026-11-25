// 界面字体（只在 Windows 上）：团队登录后、电脑空闲时，把团队网页用的中文字体按当前用户装进系统，
// 网页优先用电脑上装好的字体（local()），清浏览器数据、换浏览器都不用重下。
//
// - 字体清单（下载地址、sha256、注册名）在仓库的 remote/ui-fonts.json，软件每天从 GitHub 读一次，
//   改清单不用发新版。字体文件不进仓库、不放我们自己的下载地址：只从清单里的官方地址下载，校验 sha256 后原样安装。
// - 装到 %LOCALAPPDATA%\Microsoft\Windows\Fonts（文件名带哈希，旧字体被占用时不冲突），
//   再写 HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts。不需要管理员权限。
// - 已装且哈希一致就跳过；清单里哈希变了就装新的，旧文件删得掉就删，被占用就下次再删。
// - 装完不用重启浏览器：约 1 秒后新开的标签页就认得（Windows 上试过 Chrome、Edge、Electron）；装之前已经打开的页面刷新也不行，要关掉重开。
// - Mac 不装：Safari 不认用户自己装的字体，Mac 正文本来就是系统自带的苹方。
// - 卸载 WAswitch 时字体留着。
// - 网络：专用的内存会话，跟电脑的系统代理（GitHub 直连常连不上），不用任何账号的代理，不带任何 cookie。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { writeFileAtomic, writeJsonAtomic } = require('./atomic');

const MANIFEST_URL = 'https://raw.githubusercontent.com/Kr1xxxx/WAswitch/main/remote/ui-fonts.json';
const STATE_FILE = 'ui-fonts.json';
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
const TICK_MS = 5 * 60 * 1000; // 每 5 分钟看一次该不该装
const IDLE_S = 2 * 60; // 键盘鼠标 2 分钟没动才下载、安装
const RECHECK_MS = 24 * 3600 * 1000; // 装好以后每天看一次清单
const RETRY_MS = 3600 * 1000; // 失败后 1 小时再试
const MAX_MANIFEST = 256 * 1024;
const MAX_DOWNLOAD = 80 * 1024 * 1024;
const MAX_FONT = 64 * 1024 * 1024;
const MAX_EXTRA = 1024 * 1024;
const IDLE_TIMEOUT_MS = 60 * 1000; // 下载这么久没收到数据就算失败
const ID_RE = /^[a-z0-9-]{1,40}$/;
const FILE_RE = /^[A-Za-z0-9._-]{1,40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const REG_RE = /^[A-Za-z0-9 ._-]{1,80} \((TrueType|OpenType)\)$/;
const NAME_RE = /^[A-Za-z0-9 ._-]{1,60}$/;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// 清单只认这几个字段，格式不对的字体整条不要
function okUrl(raw, loopback) {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return !!loopback && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  } catch { return false; }
}
function parseManifest(text, { loopback = false } = {}) {
  let m;
  try { m = JSON.parse(text); } catch { throw new Error('字体清单格式不对'); }
  if (!m || m.version !== 1 || !Array.isArray(m.fonts)) throw new Error('字体清单格式不对');
  const fonts = [];
  for (const f of m.fonts.slice(0, 10)) {
    if (!f || !ID_RE.test(f.id) || !NAME_RE.test(f.name) || !okUrl(f.url, loopback) || !SHA_RE.test(f.sha256)
      || !FILE_RE.test(f.file) || !REG_RE.test(f.reg) || !Number.isInteger(f.size) || f.size <= 0 || f.size > MAX_FONT) continue;
    if (f.zipEntry !== undefined && (typeof f.zipEntry !== 'string' || !f.zipEntry || f.zipEntry.length > 200)) continue;
    const extras = [];
    for (const x of Array.isArray(f.extras) ? f.extras.slice(0, 3) : []) {
      if (x && okUrl(x.url, loopback) && SHA_RE.test(x.sha256) && FILE_RE.test(x.file) && /\.txt$/.test(x.file)) extras.push({ url: x.url, sha256: x.sha256, file: x.file });
    }
    fonts.push({ id: f.id, name: f.name, url: f.url, zipEntry: f.zipEntry, sha256: f.sha256, size: f.size, file: f.file, reg: f.reg, extras });
  }
  return fonts;
}

// zip 里取一个文件（只支持不压缩和 deflate，够官方字体包用）
function unzipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('字体压缩包坏了');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('字体压缩包坏了');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (entry !== name) continue;
    if (usize > MAX_FONT || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('字体压缩包坏了');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (data.length !== csize) throw new Error('字体压缩包坏了');
    if (method === 0) return Buffer.from(data);
    if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_FONT });
    throw new Error('字体压缩包的压缩方式不支持');
  }
  throw new Error('字体压缩包里没有要的文件');
}

// TrueType / OpenType 文件头
function looksLikeFont(buf) {
  if (buf.length < 12) return false;
  const tag = buf.readUInt32BE(0);
  return tag === 0x00010000 || tag === 0x74727565 /* true */ || tag === 0x4f54544f /* OTTO */;
}

// Electron 会话下载：跟系统代理，跟着 https 跳转，大小有上限，60 秒没数据就停
function electronFetcher(ses) {
  return async (url, maxBytes) => {
    const ac = new AbortController();
    let timer = null;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(), IDLE_TIMEOUT_MS); };
    arm();
    try {
      const res = await ses.fetch(url, { signal: ac.signal, redirect: 'follow', credentials: 'omit', cache: 'no-store' });
      if (!okUrl(res.url || url, /^http:\/\/127\.0\.0\.1[:/]/.test(url))) throw new Error('下载地址被跳转到了不安全的地址');
      if (res.status !== 200) throw Object.assign(new Error(`下载返回 ${res.status}`), { statusCode: res.status });
      if (Number(res.headers.get('content-length')) > maxBytes) throw new Error('文件太大');
      const chunks = [];
      let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        got += value.length;
        if (got > maxBytes) { ac.abort(); throw new Error('文件太大'); }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch (e) {
      if (ac.signal.aborted && !/文件太大/.test(e.message)) throw new Error('下载超时');
      throw e;
    } finally { clearTimeout(timer); }
  };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30 * 1000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

// 当前用户的字体注册表：reg.exe，不要管理员
const windowsRegistry = {
  async get(name) {
    try {
      const out = await run('reg', ['query', REG_KEY, '/v', name]);
      const line = out.split(/\r?\n/).find((l) => l.trim().startsWith(name));
      const m = line && line.match(/REG_(?:EXPAND_)?SZ\s+(.*)$/);
      return m ? m[1].trim() : null;
    } catch { return null; } // 没有这个值时 reg 返回 1
  },
  async set(name, value) { await run('reg', ['add', REG_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']); },
  async remove(name) { try { await run('reg', ['delete', REG_KEY, '/v', name, '/f']); } catch { /* 本来就没有 */ } },
};

class UiFonts {
  // opts: {
  //   userData, platform, fontsDir（默认 %LOCALAPPDATA%\Microsoft\Windows\Fonts）,
  //   enrolled() -> 团队登录着, idleSeconds() -> 电脑多少秒没有键盘鼠标操作,
  //   fetch(url, maxBytes) -> Buffer, registry { get, set, remove },
  //   manifestUrl, loopback（只给自检：允许 http://127.0.0.1）, onChange(), log(msg), now()
  // }
  constructor(opts) {
    this.o = { platform: process.platform, manifestUrl: MANIFEST_URL, registry: windowsRegistry,
      log: () => {}, onChange: () => {}, now: Date.now, idleSeconds: () => 0, enrolled: () => false, ...opts };
    this.o.manifestUrl = this.o.manifestUrl || MANIFEST_URL;
    this.fontsDir = this.o.fontsDir || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts');
    this.stateFile = path.join(this.o.userData, STATE_FILE);
    this.state = this.load();
    this.running = null;
    this.nextAt = 0;
    this.timer = null;
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return { fonts: s && typeof s.fonts === 'object' && s.fonts ? s.fonts : {}, stale: Array.isArray(s && s.stale) ? s.stale.filter((x) => typeof x === 'string') : [] };
    } catch { return { fonts: {}, stale: [] }; }
  }
  save() { writeJsonAtomic(this.stateFile, this.state, 1); }

  supported() { return this.o.platform === 'win32'; }

  // 关于页：已经装好的字体名字
  installed() {
    if (!this.supported()) return [];
    return Object.values(this.state.fonts).filter((f) => f && f.path && fs.existsSync(f.path)).map((f) => f.name);
  }

  start() {
    if (!this.supported() || this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  // 该装的时候装：Windows、团队登录着、电脑空闲、到了该看清单的时间
  tick() {
    if (!this.supported() || this.running || !this.o.enrolled()) return null;
    if (this.o.now() < this.nextAt || this.o.idleSeconds() < IDLE_S) return null;
    this.running = this.sync().then((r) => { this.nextAt = this.o.now() + RECHECK_MS; return r; }, (e) => {
      this.nextAt = this.o.now() + RETRY_MS;
      this.o.log(`界面字体没装好：${e.message}`);
      return { error: e.message };
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async sync() {
    await this.cleanStale();
    const fonts = parseManifest((await this.o.fetch(this.o.manifestUrl, MAX_MANIFEST)).toString('utf8'), { loopback: this.o.loopback });
    const done = [];
    let changed = false;
    let firstErr = null;
    for (const f of fonts) {
      try {
        if (await this.upToDate(f)) continue;
        await this.install(f);
        changed = true;
        done.push(f.name);
      } catch (e) {
        this.o.log(`界面字体 ${f.name} 没装好：${e.message}`);
        firstErr = firstErr || e;
      }
    }
    if (changed) this.o.onChange();
    if (firstErr) throw firstErr;
    return { installed: done };
  }

  // 文件在、哈希对、注册表指着它
  async upToDate(f) {
    const s = this.state.fonts[f.id];
    if (!s || s.sha256 !== f.sha256 || s.reg !== f.reg || !s.path || !fs.existsSync(s.path)) return false;
    if ((await sha256File(s.path)) !== f.sha256) return false;
    if ((await this.o.registry.get(f.reg)) !== s.path) return false;
    for (const x of f.extras) if (!fs.existsSync(path.join(this.fontsDir, `${x.file.replace(/\.txt$/, '')}-${x.sha256.slice(0, 12)}.txt`))) return false;
    return true;
  }

  async install(f) {
    const dest = path.join(this.fontsDir, `${f.file}-${f.sha256.slice(0, 12)}.ttf`);
    // 同名文件在就是同一份（名字带哈希）：不重下，被占用写不了时也直接用它
    const have = fs.existsSync(dest) && (await sha256File(dest)) === f.sha256;
    let buf = null;
    if (!have) {
      const raw = await this.o.fetch(f.url, f.zipEntry ? MAX_DOWNLOAD : MAX_FONT);
      buf = f.zipEntry ? unzipEntry(raw, f.zipEntry) : raw;
      if (buf.length !== f.size || sha256(buf) !== f.sha256) throw new Error('下载的字体和清单里的校验值对不上');
      if (!looksLikeFont(buf)) throw new Error('下载的不是字体文件');
    }
    const extras = [];
    for (const x of f.extras) {
      const p = path.join(this.fontsDir, `${x.file.replace(/\.txt$/, '')}-${x.sha256.slice(0, 12)}.txt`);
      if (fs.existsSync(p)) continue;
      const b = await this.o.fetch(x.url, MAX_EXTRA);
      if (sha256(b) !== x.sha256) throw new Error('下载的授权文件和清单里的校验值对不上');
      extras.push([p, b]);
    }
    fs.mkdirSync(this.fontsDir, { recursive: true });
    if (!have) writeFileAtomic(dest, buf);
    for (const [p, b] of extras) writeFileAtomic(p, b);
    const old = this.state.fonts[f.id];
    if (old && old.reg && old.reg !== f.reg) await this.o.registry.remove(old.reg);
    await this.o.registry.set(f.reg, dest);
    this.state.fonts[f.id] = { name: f.name, sha256: f.sha256, reg: f.reg, path: dest, at: this.o.now() };
    if (old && old.path && old.path !== dest) this.state.stale.push(old.path);
    this.save();
    await this.cleanStale();
    this.o.log(`界面字体已安装：${f.name}`);
  }

  // 换下来的旧字体文件：删得掉就删，被占用就留到下次
  async cleanStale() {
    if (!this.state.stale.length) return;
    const keep = new Set(Object.values(this.state.fonts).map((f) => f && f.path));
    const left = [];
    for (const p of this.state.stale) {
      if (keep.has(p) || path.dirname(p) !== this.fontsDir) continue;
      try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') left.push(p); }
    }
    if (left.length !== this.state.stale.length) { this.state.stale = left; this.save(); }
  }
}

module.exports = { UiFonts, parseManifest, unzipEntry, looksLikeFont, electronFetcher, MANIFEST_URL, IDLE_S };
