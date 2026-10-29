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
const okFetch = (body = file, status = 200) => async (url) => { fetched.push(url); return new Response(status === 200 ? new Uint8Array(body) : null, { status }); };

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
  r = await wv.fetchVoice(wc, okFetch(), GROUP, { accId: 'a1' });
  check(r.ok && r.seconds === 3, '群里的语音也能拿到');
  const ev = await page('window.__events');
  check(ev.clicks === 0 && ev.scrolls === 0 && ev.focus === 0 && ev.mutations === 0, `没有点击、滚动、聚焦、改页面（${JSON.stringify(ev)}）`);
  check(await page('document.documentElement.outerHTML') === before, '前后页面 HTML 完全相同');

  // 4. 钥匙不对：校验不过，算读不到
  r = await wv.fetchVoice(wc, okFetch(encrypt(ogg, crypto.randomBytes(32))), VOICE, { accId: 'a1' });
  check(r.kind === 'nomedia' && r.code === 'W2 bad_mac', `钥匙不对：读不到（${r.code}）`);
  // 解出来不是 OGG
  r = await wv.fetchVoice(wc, okFetch(encrypt(Buffer.from('not an ogg file at all'), mediaKey)), VOICE, { accId: 'a1' });
  check(r.kind === 'nomedia' && r.code === 'W2 not_ogg', `不是 OGG：读不到（${r.code}）`);

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
  check(r.kind === 'nomedia' && r.code === 'W2 too_big', `超过 16 MB 不要（${r.code}）`);

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

  await page(dropDb);
  console.error(failures ? `网页号语音自检：${failures} 项失败` : 'WEB_VOICE_PASS');
  app.exit(failures ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
