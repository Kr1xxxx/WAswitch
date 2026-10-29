// 网页号客户发来的语音：在后台拿到音频，给语音转文字用（见 translate-ipc.js 的 transcribeVoice）。
// W2：在隔离环境里只读 WhatsApp 本机存储（IndexedDB model-storage 的 message 表）里这一条语音的下载信息，
// 主进程用这个号自己的会话（它的代理、它的 UA）从 *.whatsapp.net 下载加密文件，在内存里校验、解密成 OGG。
// 不打扰用户：不点击、不滚动、不聚焦、不改页面；数据库不存在就不打开（不会新建），只读事务，只取这一条，读完马上关，
// WhatsApp 要升级数据库时马上让开。音频、钥匙、密文只在内存里，用完清零。号码、编号、钥匙不进日志。
const crypto = require('crypto');

const ISOLATED_WORLD = 1001;
const DB = 'model-storage';
const TIMEOUT = 20000;
const MAX_BYTES = 16 * 1024 * 1024;
const NOT_YET_WAIT = [3000, 10000]; // 消息刚到时可能还没写进存储：3 秒、10 秒后各再查一次

// 在隔离环境里运行，只取这一条消息的下载信息。返回 { why, key?, seconds, info }：
// why 为空表示拿到了；info 只有表名、字段名和类型（排查用，不含内容）
const READ_CODE = (dataId) => `(async (ID, DB) => {
  const out = { why: '', seconds: 0, info: {} };
  const req = (r) => new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
  const b64 = (v) => {
    if (typeof v === 'string') return v;
    const u = v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null;
    if (!u) return '';
    let s = ''; for (const b of u) s += String.fromCharCode(b);
    return btoa(s);
  };
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB.databases) { out.why = 'no_idb'; return out; }
    // 先确认库在：不存在时 open 会新建一个空库
    if (!(await indexedDB.databases()).some((d) => d && d.name === DB)) { out.why = 'no_model_storage'; return out; }
    const db = await new Promise((ok, bad) => {
      const r = indexedDB.open(DB);
      r.onupgradeneeded = () => { try { r.transaction.abort(); } catch {} };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
      r.onblocked = () => bad(new Error('blocked'));
    }).catch(() => null);
    if (!db) { out.why = 'open_failed'; return out; }
    db.onversionchange = () => db.close(); // WhatsApp 要升级数据库：马上让开
    try {
      const stores = Array.from(db.objectStoreNames);
      if (!stores.includes('message')) { out.why = 'no_message_store'; out.info.stores = stores.slice(0, 60); return out; }
      const rec = await req(db.transaction('message', 'readonly').objectStore('message').get(ID));
      if (!rec || typeof rec !== 'object') { out.why = 'not_found'; return out; }
      out.info.fields = Object.keys(rec).slice(0, 80);
      out.info.type = typeof rec.type === 'string' ? rec.type.slice(0, 20) : '';
      const sec = Number(rec.duration);
      out.seconds = Number.isFinite(sec) && sec > 0 && sec < 36000 ? Math.round(sec) : 0;
      const mk = b64(rec.mediaKey);
      const dp = typeof rec.directPath === 'string' && rec.directPath.startsWith('/') ? rec.directPath : '';
      const url = typeof rec.deprecatedMms3Url === 'string' ? rec.deprecatedMms3Url : '';
      out.info.mediaKey = rec.mediaKey == null ? 'none' : typeof rec.mediaKey === 'string' ? 'string' : mk ? 'bytes' : typeof rec.mediaKey;
      if (!mk || (!dp && !url)) { out.why = 'no_media_fields'; return out; }
      out.key = { mediaKey: mk, directPath: dp, url };
      return out;
    } finally { db.close(); }
  } catch (e) {
    out.why = 'error';
    out.info.error = String((e && e.name) || 'error').slice(0, 40);
    return out;
  }
})(${JSON.stringify(String(dataId))}, ${JSON.stringify(DB)})`;

// WhatsApp 媒体解密（和 Baileys 同一套）：HKDF-SHA256 → iv(16) + 加密钥匙(32) + 校验钥匙(32)，
// 文件 = AES-256-CBC 密文 + HMAC-SHA256(iv + 密文) 的前 10 字节
function mediaKeys(mediaKey, info = 'WhatsApp Audio Keys') {
  const k = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from(info), 112));
  return { iv: k.subarray(0, 16), cipherKey: k.subarray(16, 48), macKey: k.subarray(48, 80), all: k };
}
function decryptMedia(file, mediaKey) {
  const keys = mediaKeys(mediaKey);
  try {
    if (file.length < 26) return { ok: false, why: 'too_short' };
    const enc = file.subarray(0, -10);
    const mac = crypto.createHmac('sha256', keys.macKey).update(keys.iv).update(enc).digest().subarray(0, 10);
    if (!crypto.timingSafeEqual(mac, file.subarray(-10))) return { ok: false, why: 'bad_mac' };
    try {
      const d = crypto.createDecipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
      return { ok: true, data: Buffer.concat([d.update(enc), d.final()]) };
    } catch { return { ok: false, why: 'bad_cipher' }; }
  } finally { keys.all.fill(0); }
}

// 只放行 WhatsApp 自己的媒体服务器
function mediaUrl(key) {
  const raw = key.directPath ? `https://mmg.whatsapp.net${key.directPath}` : key.url;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /(^|\.)whatsapp\.net$/.test(u.hostname) ? u.href : '';
  } catch { return ''; }
}

// 读回应，超过上限就停
async function readCapped(res) {
  const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
  if (len > MAX_BYTES) return null;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > MAX_BYTES) { try { await reader.cancel(); } catch {} parts.forEach((p) => p.fill(0)); return null; }
      parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(parts, n);
  }
  const b = Buffer.from(await res.arrayBuffer());
  return b.length > MAX_BYTES ? null : b;
}

// 下载、解密。fetch：这个号会话的 fetch（走它自己的代理）。返回 { ok, data } 或 { kind, why }
async function download(fetch, key) {
  const url = mediaUrl(key);
  if (!url) return { kind: 'nomedia', why: 'bad_host' };
  const mediaKey = Buffer.from(String(key.mediaKey || ''), 'base64');
  try {
    if (mediaKey.length !== 32) return { kind: 'nomedia', why: 'bad_key' };
    let res;
    try { res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) }); } catch (e) { return { kind: 'network', why: 'network', error: e }; }
    // 链接过期：用户在 WhatsApp 里播放一次，WhatsApp 会重新要文件，再重试就能下
    if ([403, 404, 410].includes(res.status)) return { kind: 'expired', why: `http_${res.status}` };
    if (!res.ok) return { kind: 'network', why: `http_${res.status}`, error: new Error(`HTTP ${res.status}`) };
    let file;
    try { file = await readCapped(res); } catch (e) { return { kind: 'network', why: 'network', error: e }; }
    if (!file) return { kind: 'nomedia', why: 'too_big' };
    const d = decryptMedia(file, mediaKey);
    file.fill(0);
    if (!d.ok) return { kind: 'nomedia', why: d.why };
    if (d.data.subarray(0, 4).toString('latin1') !== 'OggS') { d.data.fill(0); return { kind: 'nomedia', why: 'not_ogg' }; }
    return { ok: true, data: d.data };
  } finally { mediaKey.fill(0); }
}

// 同一个号同一种原因只往日志写一行（表名、字段名，没有号码、编号、钥匙）
const logged = new Set();
function note(accId, why, info) {
  const k = `${accId}|${why}`;
  if (logged.has(k)) return;
  logged.add(k);
  console.warn(`网页号语音读不到（账号 ${accId}）：W2 ${why} ${JSON.stringify(info || {})}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 读一次这条语音的下载信息。wc：这个号的页面
async function readMedia(wc, dataId) {
  if (!wc || wc.isDestroyed() || wc.isLoading()) return { why: 'loading', seconds: 0, info: {} };
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: READ_CODE(dataId) }]);
    return r && typeof r === 'object' ? { why: String(r.why || ''), seconds: Number(r.seconds) || 0, key: r.key || null, info: r.info || {} } : { why: 'bad', seconds: 0, info: {} };
  } catch { return { why: 'script_error', seconds: 0, info: {} }; }
}

// 拿一条语音的音频。opts: { wait?: [ms…], sleep?, maxSeconds?: 超过就不下载（自动转时用）, accId }
// 返回 { ok, data, seconds } 或 { kind: 'nomedia' | 'expired' | 'network' | 'long' | 'other', code, seconds, error? }
async function fetchVoice(wc, fetch, dataId, opts = {}) {
  const wait = opts.wait || NOT_YET_WAIT;
  const nap = opts.sleep || sleep;
  if (!/^(true|false)_/.test(String(dataId))) return { kind: 'nomedia', code: 'W2 bad_id', seconds: 0 };
  let r = await readMedia(wc, dataId);
  for (const ms of wait) {
    if (r.why !== 'not_found') break;
    await nap(ms);
    r = await readMedia(wc, dataId);
  }
  if (r.why === 'loading') return { kind: 'other', code: 'W2 loading', seconds: 0 };
  if (r.why) { note(opts.accId || '', r.why, r.info); return { kind: 'nomedia', code: `W2 ${r.why}`, seconds: r.seconds }; }
  if (opts.maxSeconds && r.seconds > opts.maxSeconds) return { kind: 'long', code: '', seconds: r.seconds };
  const d = await download(fetch, r.key);
  r.key.mediaKey = '';
  if (d.ok) return { ok: true, data: d.data, seconds: r.seconds };
  if (d.kind === 'nomedia') note(opts.accId || '', d.why, r.info);
  return { kind: d.kind, code: `W2 ${d.why}`, seconds: r.seconds, error: d.error };
}

module.exports = { fetchVoice, readMedia, download, decryptMedia, mediaKeys, mediaUrl, READ_CODE, NOT_YET_WAIT, MAX_BYTES };
