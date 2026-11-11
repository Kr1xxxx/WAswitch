// 自检：src/web-voice.js 网页号语音在后台拿音频，和 wa-page.js 读页面时认出语音。
// 用模仿 WhatsApp 的本地测试页（假号码、德国客户，@lid 私聊 + 群里的语音）和假的媒体服务器，不联网、不用账号。
// 查：找到这一条并解密；钥匙错 → 读不到；404/410 → 过期；还没写进存储 → 重试后才报；没有 model-storage 时不新建；
// 页面 HTML 和点击/滚动/聚焦/DOM 变动前后一致；读的同时页面自己升级数据库不被卡住；只连 *.whatsapp.net；日志里没有号码和钥匙。
// 运行：xvfb-run -a npx electron --no-sandbox scripts/check-web-voice.js
const { app, BrowserWindow } = require('electron');
const crypto = require('crypto');
const path = require('path');
const wv = require('../src/web-voice');
const waPage = require('../src/wa-page');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const fixture = path.join(__dirname, 'fixtures', 'wa-voice.html');

const VOICE = 'false_271828182845@lid_CCCC3333';
const GROUP = 'false_120363000000000001@g.us_DDDD4444_4930111222@c.us';
const LONG = 'false_271828182845@lid_LLLL7777';
const BARE = 'false_271828182845@lid_NNNN8888';
const LATE = 'false_271828182845@lid_GGGG9999';
const MP3 = 'false_271828182845@lid_MMMM1212';

// 按 WhatsApp 的办法加密一段假的 OGG
const mediaKey = crypto.randomBytes(32);
const ogg = Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(2000)]);
function encrypt(data, key) {
  const { iv, cipherKey, macKey } = wv.mediaKeys(key);
  const c = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
  const enc = Buffer.concat([c.update(data), c.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(iv).update(enc).digest().subarray(0, 10);
  return Buffer.concat([enc, mac]);
}
const file = encrypt(ogg, mediaKey);
const fetched = [];
let origin = '';
const okFetch = (body = file, status = 200) => async (url, o) => { fetched.push(url); origin = (o && o.headers && o.headers.Origin) || ''; return new Response(status === 200 ? new Uint8Array(body) : null, { status }); };

const mk = JSON.stringify([...mediaKey]);
const rec = (id, x) => `s.put(Object.assign({ id: ${JSON.stringify(id)}, type: 'ptt', mimetype: 'audio/ogg; codecs=opus', mediaKey: new Uint8Array(${mk}), directPath: '/v/t62.7117-24/fake.enc', body: 'SECRETBODY' }, ${JSON.stringify(x || {})}));`;
// 测试页自己的环境里建 IndexedDB（相当于 WhatsApp 自己存的）
const seed = `new Promise((ok, bad) => {
  const r = indexedDB.open('model-storage', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('message', { keyPath: 'id' }); r.result.createObjectStore('chat', { keyPath: 'id' }); };
  r.onsuccess = () => {
    const tx = r.result.transaction('message', 'readwrite');
    const s = tx.objectStore('message');
    s.put({ id: 'false_271828182845@lid_AAAA1111', type: 'chat', body: 'Hello!' });
    ${rec(VOICE, { duration: 7 })}
    ${rec(GROUP, { duration: 3 })}
    ${rec(LONG, { duration: 400 })}
    s.put({ id: ${JSON.stringify(BARE)}, type: 'ptt', duration: 5 });
    ${rec(MP3, { type: 'audio', duration: 9, mimetype: 'audio/mpeg' })}
    tx.oncomplete = () => { r.result.close(); ok(true); };
    tx.onerror = () => bad(tx.error);
  };
  r.onerror = () => bad(r.error);
})`;
const addLate = `new Promise((ok) => {
  const r = indexedDB.open('model-storage');
  r.onsuccess = () => { const tx = r.result.transaction('message', 'readwrite'); const s = tx.objectStore('message'); ${rec(LATE, { duration: 2 })} tx.oncomplete = () => { r.result.close(); ok(true); }; };
})`;
const dropDb = `new Promise((ok) => { const r = indexedDB.deleteDatabase('model-storage'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`;

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const wc = win.webContents;
  const page = (code) => wc.executeJavaScript(code);
  await win.loadFile(fixture);
  for (let i = 0; i < 100 && wc.isLoading(); i += 1) await new Promise((res) => setTimeout(res, 50));
  const logs = [];
  const warn = console.warn;
  console.warn = (...a) => { logs.push(a.join(' ')); };
  const noWait = { wait: [1, 1], sleep: async () => {} };

  // 1. 读页面：客户的语音带 voice（时长认不准，给 0），自己的语音、引用里的语音不算，文字照旧
  const read = await waPage.readOpenChat(wc);
  const byId = Object.fromEntries(read.msgs.map((m) => [m.id.split('_').pop(), m]));
  check(read.ok && byId.CCCC3333 && byId.CCCC3333.voice === 0 && byId.CCCC3333.text === '', '群里那样气泡顶上有发送人名字的语音也认得出');
  check(read.ok && byId.CCCC3333 && byId.CCCC3333.voice === 0 && byId.CCCC3333.text === '', `客户语音读成 voice: 0、没有文字（${JSON.stringify(byId.CCCC3333)}）`);
  check(byId.EEEE5555 && byId.EEEE5555.voice === undefined && byId.EEEE5555.out === true, '自己发的语音不算');
  check(byId.FFFF6666 && byId.FFFF6666.voice === undefined && byId.FFFF6666.text === 'Did you hear it?', '引用了语音的回复照常是文字');
  check(byId.AAAA1111.text === 'Hello!' && byId.AAAA1111.voice === undefined, '文字消息不变');

  // 2. 没有 model-storage：读不到，也不会因此新建一个
  await page(dropDb);
  let r = await wv.fetchVoice(wc, okFetch(), VOICE, { ...noWait, accId: 'a1' });
  check(r.kind === 'nomedia' && r.code === 'W2 no_model_storage', `没有本机存储：读不到（${r.code}）`);
  const names = await page('indexedDB.databases().then((l) => l.map((d) => d.name))');
  check(!names.includes('model-storage'), '没有新建 model-storage');

  // 3. 有语音：读到下载信息，下载、解密出 OGG，时长用存储里的
  await page(seed);
  await page('Object.assign(window.__events, { clicks: 0, scrolls: 0, mutations: 0, focus: 0 })');
  const before = await page('document.documentElement.outerHTML');
  r = await wv.fetchVoice(wc, okFetch(), VOICE, { accId: 'a1' });
  check(r.ok && r.data.subarray(0, 4).toString('latin1') === 'OggS' && r.data.length === ogg.length && r.seconds === 7, `解密出 OGG、时长 7 秒（${r.seconds}）`);
  check(fetched[0] === 'https://mmg.whatsapp.net/v/t62.7117-24/fake.enc', `只去 WhatsApp 媒体服务器下载（${fetched[0]}）`);
  check(origin === '', '下载不带 Origin（ses.fetch 带了会按跨域规则拦）');
  r = await wv.fetchVoice(wc, okFetch(), GROUP, { accId: 'a1' });
  check(r.ok && r.seconds === 3, '群里的语音也能拿到');
  const ev = await page('window.__events');
  check(ev.clicks === 0 && ev.scrolls === 0 && ev.focus === 0 && ev.mutations === 0, `没有点击、滚动、聚焦、改页面（${JSON.stringify(ev)}）`);
  check(await page('document.documentElement.outerHTML') === before, '前后页面 HTML 完全相同');

  // 4. 钥匙不对：校验不过，算读不到
  r = await wv.fetchVoice(wc, okFetch(encrypt(ogg, crypto.randomBytes(32))), VOICE, { accId: 'a1' });
  check(r.kind === 'badfile' && r.code === 'W2 bad_mac', `钥匙不对：这一条读不到，不算存储改版（${r.kind} ${r.code}）`);
  // 解出来不是 OGG
  r = await wv.fetchVoice(wc, okFetch(encrypt(Buffer.from('not an ogg file at all'), mediaKey)), VOICE, { accId: 'a1' });
  check(r.kind === 'badfile' && r.code === 'W2 not_ogg', `语音解出来不是 OGG：这一条读不到（${r.code}）`);
  // 客户发的音频文件（mp3）：不查 OGG，交给解码
  const mp3 = Buffer.concat([Buffer.from('ID3'), crypto.randomBytes(500)]);
  r = await wv.fetchVoice(wc, okFetch(encrypt(mp3, mediaKey)), MP3, { accId: 'a1' });
  check(r.ok && r.data.length === mp3.length && r.seconds === 9, '音频文件（mp3）照常拿到');

  // 5. 链接过期
  for (const st of [404, 410]) {
    r = await wv.fetchVoice(wc, okFetch(file, st), VOICE, { accId: 'a1' });
    check(r.kind === 'expired' && r.seconds === 7, `下载 ${st}：过期`);
  }
  // 网络不通、500：算网络问题
  r = await wv.fetchVoice(wc, async () => { throw new Error('net::ERR_PROXY_CONNECTION_FAILED'); }, VOICE, { accId: 'a1' });
  check(r.kind === 'network' && r.error, '网络不通：network');
  r = await wv.fetchVoice(wc, okFetch(file, 500), VOICE, { accId: 'a1' });
  check(r.kind === 'network', '500：network');
  // 太大
  r = await wv.fetchVoice(wc, async () => new Response(new Uint8Array(wv.MAX_BYTES + 10)), VOICE, { accId: 'a1' });
  check(r.kind === 'badfile' && r.code === 'W2 too_big', `超过 16 MB 不要（${r.code}）`);

  // 6. 还没写进存储：等一下再查，写进去了就拿到
  let naps = 0;
  r = await wv.fetchVoice(wc, okFetch(), LATE, { accId: 'a1', wait: [1, 1], sleep: async () => { naps += 1; if (naps === 1) await page(addLate); } });
  check(r.ok && naps === 1, `消息晚到存储：重试一次后拿到（等了 ${naps} 次）`);
  naps = 0;
  r = await wv.fetchVoice(wc, okFetch(), 'false_271828182845@lid_ZZZZ0000', { accId: 'a1', wait: [1, 1], sleep: async () => { naps += 1; } });
  check(r.kind === 'nomedia' && r.code === 'W2 not_found' && naps === 2, `一直没有：查 3 次后才报读不到（${r.code}，等了 ${naps} 次）`);
  check(JSON.stringify(wv.NOT_YET_WAIT) === '[3000,10000]', '默认 3 秒、10 秒后各再查一次');

  // 7. 没有下载信息；自动转时超过 5 分钟不下载
  r = await wv.fetchVoice(wc, okFetch(), BARE, { accId: 'a1' });
  check(r.kind === 'nomedia' && r.code === 'W2 no_media_fields' && r.seconds === 5, `没有 mediaKey/directPath：读不到（${r.code}）`);
  const n0 = fetched.length;
  r = await wv.fetchVoice(wc, okFetch(), LONG, { accId: 'a1', maxSeconds: 300 });
  check(r.kind === 'long' && r.seconds === 400 && fetched.length === n0, '自动转时超过 5 分钟：不下载');
  r = await wv.fetchVoice(wc, okFetch(), LONG, { accId: 'a1' });
  check(r.ok, '用户点的：照常下载（只转前 5 分钟）');

  // 8. 读的时候页面自己升级数据库：不被卡住
  const upgraded = page(`new Promise((ok) => {
    const r = indexedDB.open('model-storage', 2);
    r.onupgradeneeded = () => {};
    r.onsuccess = () => { r.result.close(); ok('ok'); };
    r.onblocked = () => ok('blocked');
    r.onerror = () => ok('error');
  })`);
  r = await wv.fetchVoice(wc, okFetch(), VOICE, { accId: 'a1' });
  const up = await Promise.race([upgraded, new Promise((res) => setTimeout(() => res('timeout'), 3000))]);
  check(up === 'ok', `页面升级数据库没被卡住（${up}）`);

  // 9. 只放行 WhatsApp 的服务器
  check(wv.mediaUrl({ url: 'https://evil.example/x' }) === '' && wv.mediaUrl({ url: 'https://mmg.whatsapp.net.evil.example/x' }) === '' && wv.mediaUrl({ url: 'http://mmg.whatsapp.net/x' }) === '', '别的网站、http 不放行');
  check(wv.mediaUrl({ url: 'https://media-fra3-1.cdn.whatsapp.net/v/x' }) !== '', 'WhatsApp CDN 地址放行');
  r = await wv.fetchVoice(wc, okFetch(), 'not-a-data-id', { accId: 'a1' });
  check(r.kind === 'nomedia', '编号不像 WhatsApp 的：不读');

  // 10. 日志：同一个号同一种原因只记一行，没有号码、编号、钥匙、内容
  const all = logs.join('\n');
  check(logs.length > 0 && logs.filter((l) => l.includes('W2 bad_mac')).length === 1, `同一种原因只记一行（${logs.length} 行）`);
  check(!/271828182845|4930111222|120363|CCCC3333|SECRETBODY|Hello|Emma|fake\.enc/.test(all) && !all.includes(mediaKey.toString('base64')), '日志里没有号码、编号、内容和钥匙');
  console.warn = warn;

  // 11. 真实结构（data-id 在外层、气泡尾巴、隐藏的发件人标签、@lid 会话）：页面上的编号带 true_/false_，或者只有消息自己的编号（十六进制），都认成语音。
  // 没有前缀时带出页面上的编号（raw），下载按它在存储里找
  const TAIL = '<span aria-hidden="true" data-icon="tail-in"><svg viewBox="0 0 8 13" width="8" height="13"><path d="M5 0H0v11z"></path></svg></span>';
  const LABEL = '<span aria-label="Emma Schneider:"></span>';
  const realVoice = (id) => `<div role="row"><div tabindex="-1" data-id="${id}"><div class="message-in">${TAIL}${LABEL}<div class="bubble"><div class="voice-row"><button aria-label="Play voice message"><span data-icon="audio-play">▶</span></button><div class="wave" role="slider"></div><span class="dur">0:07</span></div><div class="meta">10:06</div></div></div></div></div>`;
  const realText = (id, text) => `<div role="row"><div tabindex="-1" data-id="${id}"><div class="message-in">${LABEL}<div class="bubble"><div class="copyable-text" data-pre-plain-text="[10:05, 10/11/2026] Emma Schneider: "><div><span class="selectable-text copyable-text"><span>${text}</span></span></div></div><div class="meta">10:05</div></div></div></div></div>`;
  const realPage = (rows, head = '<span dir="auto" title="Emma Schneider">Emma Schneider</span>', css = '') => `<!doctype html><html><head><meta charset="utf-8"><title>WhatsApp</title><style>${css}</style></head><body><div id="app"><div id="side"><div id="pane-side"><div role="grid" aria-label="Chat list"><div role="row"><span dir="auto" title="Emma Schneider">Emma Schneider</span></div></div></div></div><div id="main"><header>${head}</header><div class="scroll"><div role="application">${rows}</div></div></div></div></body></html>`;
  const tmp = path.join(require('os').tmpdir(), `wa-voice-real-${process.pid}.html`);
  const open = async (html) => {
    require('fs').writeFileSync(tmp, html);
    await win.loadFile(tmp);
    for (let i = 0; i < 100 && wc.isLoading(); i += 1) await new Promise((res) => setTimeout(res, 50));
  };
  await open(realPage(realText('false_271828182845@lid_TTTT0001', 'Guten Morgen!') + realVoice('false_271828182845@lid_VVVV0002')));
  let real = await waPage.readOpenChat(wc);
  const pv = real.ok && real.msgs.find((m) => m.id.endsWith('VVVV0002'));
  check(pv && pv.voice === 0 && pv.text === '' && pv.raw === undefined, `真实结构、编号带前缀：认成语音（${JSON.stringify(pv)}）`);
  await open(realPage(realText('3EB0AAAA1111BBBB2222', 'Guten Morgen!') + realVoice('3EB0CCCC3333DDDD4444')));
  real = await waPage.readOpenChat(wc);
  let nv = real.ok && real.msgs.find((m) => (m.raw || '').endsWith('3EB0CCCC3333DDDD4444'));
  check(real.ok && real.msgs.length === 2 && real.msgs.some((m) => m.text === 'Guten Morgen!'), `真实结构、编号没有前缀：文字照常读到（${JSON.stringify(real.msgs || real)}）`);
  check(nv && nv.voice === 0 && nv.text === '' && nv.raw === '3EB0CCCC3333DDDD4444', `真实结构、编号没有前缀：认成语音，带页面上的编号（${JSON.stringify(nv)}）`);

  // 12. 新版 WhatsApp（2026-10 起，照别人在真号上记下的结构）：没有 .message-in/.message-out，class 都是乱码，
  // data-id 只有 32 位十六进制的消息编号（没有对方号码），气泡是 msg-container，语音有 ptt-status 图标、「播放语音消息」按钮、语音滑条
  const K_TEXT = '0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E';
  const K_VOICE = '3A5F0C2B9D8E7F6A1B2C3D4E5F6A7B8C';
  const K_GROUP = '4B6A1D3C0E9F8A7B2C3D4E5F6A7B8C9D';
  const K_OWN = '5C7B2E4D1F0A9B8C3D4E5F6A7B8C9D0E';
  const K_QUOTE = '6D8C3F5E2A1B0C9D4E5F6A7B8C9D0E1F';
  const K_GONE = '7E9D4A6F3B2C1D0E5F6A7B8C9D0E1F2A';
  const K_BARE = '8F0E5B7A4C3D2E1F6A7B8C9D0E1F2A3B';
  const NEW_CSS = `body{margin:0;font:14px sans-serif} #app{display:flex;width:1000px} #side{width:300px} #main{width:700px}
    .r{display:flex;justify-content:flex-start;padding:2px 60px} .r.o{justify-content:flex-end}
    [data-testid="msg-container"]{background:#fff;border-radius:8px;padding:6px;max-width:420px;position:relative}
    .p{display:flex;align-items:center;gap:8px} .p canvas{width:200px;height:30px} .a{width:48px;height:48px;position:relative} .m{display:flex;justify-content:space-between;font-size:11px}
    [data-icon="tail-in"]{position:absolute;left:-8px;top:0}`;
  const voiceRow = (k, label = '播放语音消息', mine = false) => `<div role="row"><div tabindex="-1" data-id="${k}" data-testid="conv-msg-${k}" class="x1n2onr6"><div data-virtualized="false" class="_amjv"><div class="r${mine ? ' o' : ''}"><div data-testid="msg-container" class="x9f619">${mine ? '' : TAIL}<div class="p"><button class="x1c4vz4f" aria-label="${label}"><span data-icon="audio-play"><svg viewBox="0 0 34 34" width="34" height="34"></svg></span></button><div role="slider" aria-label="语音消息" aria-valuetext="0:00/0:11" aria-valuemax="11"><canvas></canvas></div><button class="xspd" aria-label="播放速度">1×</button><div class="a"><img alt="" width="48" height="48"><span data-icon="ptt-status" data-testid="ptt-status"><svg viewBox="0 0 19 26" width="19" height="26"></svg></span></div></div><div class="m"><span>0:11</span><div data-testid="msg-meta"><span>06:30</span>${mine ? '<span data-icon="msg-dblcheck"></span>' : ''}</div></div></div></div></div></div></div>`;
  const textRow = (k, text, quote = '') => `<div role="row"><div tabindex="-1" data-id="${k}" data-testid="conv-msg-${k}" class="x1n2onr6"><div data-virtualized="false" class="_amjv"><div class="r"><div data-testid="msg-container" class="x9f619">${TAIL}<div class="copyable-text" data-pre-plain-text="[06:29, 11/11/2026] Emma Schneider: ">${quote}<div><span dir="ltr" data-testid="selectable-text"><span>${text}</span></span></div></div><div class="m"><span></span><div data-testid="msg-meta"><span>06:29</span></div></div></div></div></div></div></div>`;
  const quoteVoice = '<div data-testid="quoted-message" role="button" aria-label="引用的消息"><span data-icon="ptt-status"></span><span>语音消息（0:11）</span></div>';
  const head = '<div data-testid="conversation-info-header-chat-title"><span dir="auto">Emma Schneider</span></div>';
  await open(realPage(textRow(K_TEXT, 'Guten Morgen!') + voiceRow(K_VOICE) + voiceRow(K_OWN, '播放语音消息', true) + textRow(K_QUOTE, 'Hast du sie gehört?', quoteVoice) + voiceRow(K_GROUP, 'Play voice message'), head, NEW_CSS));
  real = await waPage.readOpenChat(wc);
  const of = (k) => real.ok && real.msgs.find((m) => m.raw === k);
  nv = of(K_VOICE);
  check(nv && nv.voice === 0 && nv.text === '' && nv.out === false && nv.id === `false_chat:Emma Schneider_${K_VOICE}`, `新版页面：客户的语音认成语音（${JSON.stringify(nv)}）`);
  check(of(K_GROUP) && of(K_GROUP).voice === 0, '新版页面、英文界面的语音也认得出');
  check(of(K_OWN) && of(K_OWN).out === true && of(K_OWN).voice === undefined, `新版页面：自己发的语音不算（${JSON.stringify(of(K_OWN))}）`);
  check(of(K_QUOTE) && of(K_QUOTE).voice === undefined && of(K_QUOTE).text === 'Hast du sie gehört?', `新版页面：引用了语音的回复照常是文字（${JSON.stringify(of(K_QUOTE))}）`);
  check(of(K_TEXT) && of(K_TEXT).text === 'Guten Morgen!' && of(K_TEXT).out === false, '新版页面：文字照常读到');

  // 存储里的编号还是整条（false_对方_消息编号，群里后面跟着发送人）：按页面上的编号找到这一条。
  // 前面放 1 万多条别的客户消息，要翻过几页才找得到
  await page(dropDb);
  await page(`new Promise((ok, bad) => {
    const r = indexedDB.open('model-storage', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('message', { keyPath: 'id' }); };
    r.onsuccess = () => {
      const tx = r.result.transaction('message', 'readwrite');
      const s = tx.objectStore('message');
      for (let i = 0; i < 12000; i += 1) s.put({ id: 'false_1' + String(i).padStart(11, '0') + '@c.us_' + (0x10000000 + i).toString(16).toUpperCase() + 'A0B1C2D3E4F5A6B7C8D9E0F1', type: 'chat' });
      s.put({ id: 'true_271828182845@lid_${K_OWN}', type: 'ptt' });
      ${rec(`false_271828182845@lid_${K_VOICE}`, { duration: 11 })}
      ${rec(`false_120363000000000001@g.us_${K_GROUP}_4930111222@lid`, { duration: 4 })}
      ${rec(K_BARE, { duration: 6 })}
      tx.oncomplete = () => { r.result.close(); ok(true); };
      tx.onerror = () => bad(tx.error);
    };
    r.onerror = () => bad(r.error);
  })`);
  const logs2 = [];
  console.warn = (...a) => { logs2.push(a.join(' ')); };
  const before2 = await page('document.documentElement.outerHTML');
  const t0 = Date.now();
  r = await wv.fetchVoice(wc, okFetch(), (nv && nv.raw) || K_VOICE, { accId: 'a2' });
  check(r.ok && r.data.subarray(0, 4).toString('latin1') === 'OggS' && r.seconds === 11, `新版页面：按消息编号在存储里找到、解密出 OGG（${r.ok ? r.seconds : r.code}，${Date.now() - t0} ms）`);
  r = await wv.fetchVoice(wc, okFetch(), K_GROUP, { accId: 'a2' });
  check(r.ok && r.seconds === 4, `新版页面：群里的语音（编号后面还跟着发送人）也找得到（${r.ok ? r.seconds : r.code}）`);
  r = await wv.fetchVoice(wc, okFetch(), K_BARE, { accId: 'a2' });
  check(r.ok && r.seconds === 6, `存储里也只用消息编号当编号：直接找到（${r.ok ? r.seconds : r.code}）`);
  naps = 0;
  r = await wv.fetchVoice(wc, okFetch(), K_GONE, { accId: 'a2', wait: [1, 1], sleep: async () => { naps += 1; } });
  check(r.kind === 'nomedia' && r.code === 'W2 not_found' && naps === 2, `新版页面：存储里没有这条：查 3 次后报读不到（${r.code}）`);
  r = await wv.fetchVoice(wc, okFetch(), K_OWN, { accId: 'a2', ...noWait });
  check(r.code === 'W2 not_found', '自己发的（true_ 开头）不在找的范围里');
  check(await page('document.documentElement.outerHTML') === before2, '找的时候页面 HTML 不变');
  check(logs2.length === 1 && /keyShape/.test(logs2[0]) && /"keyShape":"false_(#|KEY)@(c\.us|lid|g\.us)_KEY"/.test(logs2[0]) && !/1000000|271828|120363|4930111222|3A5F0C2B|7E9D4A6F/.test(logs2[0]), `找不到时日志只记编号的形状（${logs2.join(' | ')}）`);
  console.warn = warn;

  // 新版页面：语音的译文放在气泡（msg-container）里、播放条那一行的下面
  await waPage.paintTranslations(wc, [{ id: K_VOICE, h: '0123456789abcdef', k: 'done', t: '你好，C 色还有吗？' }], {});
  const place = await page(`(() => {
    const m = document.querySelector('[data-id="${K_VOICE}"]');
    const n = m && m.querySelector('[data-wasw-tr]');
    if (!n) return null;
    const bub = m.querySelector('[data-testid="msg-container"]');
    const row = bub.querySelector('.p');
    return { inBubble: bub.contains(n), notInRow: !row.contains(n), below: n.getBoundingClientRect().top >= row.getBoundingClientRect().bottom - 1, text: n.textContent };
  })()`);
  check(place && place.inBubble && place.notInRow && place.below && place.text.includes('你好'), `新版页面：语音译文在气泡里、播放条下面（${JSON.stringify(place)}）`);
  require('fs').rmSync(tmp, { force: true });

  await page(dropDb);
  console.error(failures ? `网页号语音自检：${failures} 项失败` : 'WEB_VOICE_PASS');
  app.exit(failures ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
