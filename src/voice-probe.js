// 网页号语音诊断（语音转文字计划第 2 步，shen 2026-10-29 同意 W2）。
// 在当前打开的对话里找最新一条语音，试两条路，只报告「能 / 不能」：
//   W2：在隔离环境里只读 WhatsApp 本机存储（IndexedDB model-storage）里这条语音的下载信息，
//       主进程用这个号自己的会话（走它的代理）下载加密文件，在内存里解密，看是不是 OGG。
//   W1：页面里有没有播放后留下的 blob: 音频（要用户先点过播放）。
// 只读：不点击、不滚动、不改页面，不建新的数据库；只看最近 30 条消息。
// 音频只在内存里解密后看前 4 个字节，不存盘，不发到任何地方。报告里没有号码、消息编号和内容。
const crypto = require('crypto');
const { SELECTORS } = require('./wa-page');

const ISOLATED_WORLD = 1001;
const MAX_IDS = 30;

// 在隔离环境里运行。返回 { report, key }：report 只有是否、个数、字段名；key 是下载信息，只给主进程用
const PROBE_CODE = `(async (S, MAX) => {
  const report = { chat: false, w1: {}, w2: {} };
  let key = null;
  const shape = (s) => String(s).replace(/\\d/g, '9').replace(/[A-Za-z0-9]{12,}/g, 'X').slice(0, 60);
  const main = document.querySelector(S.chatMain);
  if (!main) return { report };
  report.chat = true;
  const ids = [...new Set([...main.querySelectorAll(S.message)].map((el) => el.getAttribute('data-id') || '')
    .filter((id) => /^(true|false)_/.test(id)))].slice(-MAX);
  report.ids = ids.length;
  report.idShape = ids.length ? shape(ids[ids.length - 1]) : '';
  // 页面上看得到的语音气泡（只数个数，用来判断这个对话里有没有语音）
  report.voiceMarks = main.querySelectorAll(S.voiceMark).length;

  // W1：播放过的语音会不会留下 blob: 地址的 <audio>
  const audios = [...document.querySelectorAll('audio')];
  report.w1.audio = audios.length;
  const blob = audios.map((a) => a.currentSrc || a.src || '').find((u) => u.startsWith('blob:'));
  report.w1.blob = !!blob;
  if (blob) {
    try {
      const buf = new Uint8Array(await (await fetch(blob)).arrayBuffer());
      report.w1.bytes = buf.length;
      report.w1.ogg = String.fromCharCode(...buf.slice(0, 4)) === 'OggS';
    } catch (e) { report.w1.error = String(e && e.name || 'error'); }
  }

  // W2：只读 IndexedDB。先用 databases() 看有没有，没有就不打开（打开不存在的库会新建一个）
  const w2 = report.w2;
  if (!indexedDB.databases) { w2.why = 'no_databases_api'; return { report }; }
  const names = (await indexedDB.databases()).map((d) => d.name || '');
  w2.dbs = names.filter((n) => /^[A-Za-z_-]{1,40}$/.test(n)).slice(0, 30);
  if (!names.includes('model-storage')) { w2.why = 'no_model_storage'; return { report }; }
  const db = await new Promise((ok, bad) => {
    const r = indexedDB.open('model-storage');
    r.onupgradeneeded = () => { try { r.transaction.abort(); } catch {} };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
    r.onblocked = () => bad(new Error('blocked'));
  }).catch((e) => { w2.why = 'open_failed'; w2.error = String(e && e.name || e); return null; });
  if (!db) return { report };
  try {
    w2.stores = [...db.objectStoreNames].slice(0, 60);
    if (!w2.stores.includes('message')) { w2.why = 'no_message_store'; return { report }; }
    const store = db.transaction('message', 'readonly').objectStore('message');
    const req = (r) => new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
    w2.keyPath = typeof store.keyPath === 'string' ? store.keyPath : JSON.stringify(store.keyPath);
    w2.count = await req(store.count());
    const bytesB64 = (v) => {
      if (typeof v === 'string') return v;
      const u = v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null;
      if (!u) return '';
      let s = ''; for (const b of u) s += String.fromCharCode(b);
      return btoa(s);
    };
    const kind = (v) => v == null ? 'none' : typeof v === 'string' ? 'string' : v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? 'bytes' : typeof v;
    let found = 0; let voice = null; const types = {};
    for (const id of ids) {
      const rec = await req(store.get(id));
      if (!rec || typeof rec !== 'object') continue;
      found += 1;
      const t = typeof rec.type === 'string' ? rec.type.slice(0, 20) : '(none)';
      types[t] = (types[t] || 0) + 1;
      if (t === 'ptt' || t === 'audio') voice = rec;
    }
    w2.found = found;
    w2.types = types;
    // 一条也没对上：取存储里第一条的编号形状和字段名，看是编号格式不同还是内容整条加密了
    if (!found && w2.count) {
      const cur = await req(store.openCursor());
      if (cur) { w2.sampleKeyShape = shape(cur.key); w2.sampleFields = Object.keys(cur.value || {}).slice(0, 80); }
    }
    if (!voice) { w2.why = found ? 'no_voice_in_last_msgs' : 'ids_not_found'; return { report }; }
    w2.voice = true;
    w2.fields = Object.keys(voice).slice(0, 80);
    w2.mediaKey = kind(voice.mediaKey);
    w2.directPath = typeof voice.directPath === 'string' && voice.directPath.startsWith('/');
    const url = typeof voice.deprecatedMms3Url === 'string' ? voice.deprecatedMms3Url : typeof voice.clientUrl === 'string' ? voice.clientUrl : '';
    w2.url = !!url;
    w2.seconds = Number.isFinite(voice.duration) ? voice.duration : Number(voice.duration) || null;
    w2.mimetype = typeof voice.mimetype === 'string' ? voice.mimetype.slice(0, 40) : '';
    const mk = bytesB64(voice.mediaKey);
    if (mk && (w2.directPath || url)) key = { mediaKey: mk, directPath: w2.directPath ? voice.directPath : '', url };
    else w2.why = 'no_media_fields';
  } finally { db.close(); }
  return { report, key };
})(${JSON.stringify({ chatMain: SELECTORS.chatMain, message: SELECTORS.message, voiceMark: SELECTORS.voiceMark })}, ${MAX_IDS})`;

// WhatsApp 媒体解密（和 Baileys 同一套）：HKDF-SHA256 → iv(16) + 加密钥匙(32) + 校验钥匙(32)，
// 文件 = AES-256-CBC 密文 + HMAC-SHA256(iv + 密文) 的前 10 字节
function mediaKeys(mediaKey, info = 'WhatsApp Audio Keys') {
  const k = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from(info), 112));
  return { iv: k.subarray(0, 16), cipherKey: k.subarray(16, 48), macKey: k.subarray(48, 80) };
}
function decryptMedia(file, mediaKey) {
  const { iv, cipherKey, macKey } = mediaKeys(mediaKey);
  if (file.length < 26) return { ok: false, why: 'too_short' };
  const enc = file.subarray(0, -10);
  const mac = crypto.createHmac('sha256', macKey).update(iv).update(enc).digest().subarray(0, 10);
  if (!crypto.timingSafeEqual(mac, file.subarray(-10))) return { ok: false, why: 'bad_mac' };
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    return { ok: true, data: Buffer.concat([d.update(enc), d.final()]) };
  } catch { return { ok: false, why: 'bad_cipher' }; }
}

// 只放行 WhatsApp 自己的媒体服务器
function mediaUrl(key) {
  const raw = key.directPath ? `https://mmg.whatsapp.net${key.directPath}` : key.url;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /(^|\.)whatsapp\.net$/.test(u.hostname) ? u.href : '';
  } catch { return ''; }
}

// fetch：这个号会话的 fetch（走它自己的代理）。结果只有是否、大小，不含音频
async function tryDownload(fetch, key) {
  const url = mediaUrl(key);
  if (!url) return { ok: false, why: 'bad_host' };
  const mediaKey = Buffer.from(key.mediaKey, 'base64');
  if (mediaKey.length !== 32) return { ok: false, why: 'bad_key' };
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(20000) }); } catch { return { ok: false, why: 'network' }; }
  if (!res.ok) return { ok: false, why: `http_${res.status}` };
  const file = Buffer.from(await res.arrayBuffer());
  const d = decryptMedia(file, mediaKey);
  if (!d.ok) return { ok: false, why: d.why, bytes: file.length };
  const ogg = d.data.subarray(0, 4).toString('latin1') === 'OggS';
  d.data.fill(0);
  return { ok: ogg, why: ogg ? '' : 'not_ogg', bytes: file.length };
}

// 跑一次诊断。wc：这个网页号的页面；fetch：这个号会话的 fetch
async function probe(wc, fetch) {
  if (!wc || wc.isDestroyed() || wc.isLoading()) return { report: { chat: false, why: 'loading' } };
  let r;
  try { r = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: PROBE_CODE }]); } catch (e) {
    return { report: { chat: false, why: 'script_error', error: String(e && e.message || e).slice(0, 200) } };
  }
  const report = (r && r.report) || { chat: false, why: 'bad' };
  if (r && r.key) report.w2.download = await tryDownload(fetch, r.key);
  return { report };
}

// 给 shen 看的一句话结论
function verdict(report) {
  if (!report.chat) return { w2: false, w1: false, text: '没有打开对话。先点开一个有客户语音的对话再试。' };
  const w2 = !!(report.w2.download && report.w2.download.ok);
  const w1 = !!(report.w1.blob && report.w1.ogg);
  const lines = [];
  if (w2) lines.push('W2 能走通：不用点播放，后台就能拿到语音。');
  else if (report.w2.why === 'no_voice_in_last_msgs' && !report.voiceMarks) lines.push('W2 没试成：最近的消息里没有语音。换一个有客户语音的对话再试。');
  else lines.push('W2 走不通。');
  if (w1) lines.push('W1 能走通：点过播放的语音能拿到。');
  else if (!report.w1.blob) lines.push('W1 没试：页面上没有播放过的语音（要先点 ▶ 再诊断才算数）。');
  else lines.push('W1 走不通。');
  return { w2, w1, text: lines.join('\n') };
}

module.exports = { probe, verdict, decryptMedia, mediaKeys, mediaUrl, tryDownload, PROBE_CODE };
