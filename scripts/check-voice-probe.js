// 自检：src/voice-probe.js 网页号语音诊断。用模仿 WhatsApp 的本地测试页和假的媒体服务器，不联网、不用账号。
// 查：W2 能从 IndexedDB 读到下载信息并解密出 OGG；只读（不改页面、不新建数据库）；报告里没有号码和钥匙；W1 能认出播放过的语音。
// 运行：npx electron scripts/check-voice-probe.js（Linux 无界面环境用 xvfb-run）
const { app, BrowserWindow } = require('electron');
const crypto = require('crypto');
const path = require('path');
const vp = require('../src/voice-probe');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };
const fixture = path.join(__dirname, 'fixtures', 'wa-voice.html');

// 按 WhatsApp 的办法加密一段假的 OGG
const mediaKey = crypto.randomBytes(32);
const ogg = Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(2000)]);
function encrypt(data, key) {
  const { iv, cipherKey, macKey } = vp.mediaKeys(key);
  const c = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
  const enc = Buffer.concat([c.update(data), c.final()]);
  const mac = crypto.createHmac('sha256', macKey).update(iv).update(enc).digest().subarray(0, 10);
  return Buffer.concat([enc, mac]);
}
const file = encrypt(ogg, mediaKey);
const fetched = [];
const fakeFetch = async (url) => {
  fetched.push(url);
  return { ok: true, status: 200, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.length) };
};

// 测试页自己的环境里建 IndexedDB（相当于 WhatsApp 自己存的）
const seed = (mk, opts = {}) => `new Promise((ok, bad) => {
  const r = indexedDB.open('model-storage', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('message', { keyPath: 'id' }); r.result.createObjectStore('chat', { keyPath: 'id' }); };
  r.onsuccess = () => {
    const tx = r.result.transaction('message', 'readwrite');
    const s = tx.objectStore('message');
    s.put({ id: 'false_4930111222@c.us_AAAA1111', type: 'chat', body: 'Hello!' });
    s.put({ id: 'true_4930111222@c.us_BBBB2222', type: 'chat', body: 'Hi Emma' });
    ${opts.noVoice ? '' : `s.put({ id: 'false_4930111222@c.us_CCCC3333', type: 'ptt', duration: 7, mimetype: 'audio/ogg; codecs=opus', mediaKey: new Uint8Array(${JSON.stringify([...mk])}), directPath: '/v/t62.7117-24/fake.enc', body: 'SECRETBODY' });`}
    tx.oncomplete = () => { r.result.close(); ok(true); };
    tx.onerror = () => bad(tx.error);
  };
  r.onerror = () => bad(r.error);
})`;
const dropDb = `new Promise((ok) => { const r = indexedDB.deleteDatabase('model-storage'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const wc = win.webContents;
  const page = (code) => wc.executeJavaScript(code);
  await win.loadFile(fixture);

  // 1. 没有 model-storage：报告「没有」，而且不会因为诊断新建一个
  await page(dropDb);
  let { report } = await vp.probe(wc, fakeFetch);
  check(report.chat && report.w2.why === 'no_model_storage', `没有本机存储时报告 no_model_storage（${report.w2.why}）`);
  const names = await page('indexedDB.databases().then((l) => l.map((d) => d.name))');
  check(!names.includes('model-storage'), '诊断没有新建 model-storage');

  // 2. 有语音：W2 读到下载信息，下载、解密出 OGG
  await page(seed(mediaKey));
  await page('Object.assign(window.__events, { clicks: 0, scrolls: 0, mutations: 0, focus: 0 })');
  const before = await page('document.documentElement.outerHTML');
  ({ report } = await vp.probe(wc, fakeFetch));
  check(report.ids === 3 && report.voiceMarks === 1, `读到 3 条消息、1 个语音气泡（${report.ids}、${report.voiceMarks}）`);
  check(report.w2.found === 3 && report.w2.voice === true, 'W2：3 条都在存储里对上，找到语音');
  check(report.w2.mediaKey === 'bytes' && report.w2.directPath && report.w2.seconds === 7, 'W2：认出 mediaKey、directPath、时长');
  check(fetched[0] === 'https://mmg.whatsapp.net/v/t62.7117-24/fake.enc', `只去 WhatsApp 媒体服务器下载（${fetched[0]}）`);
  check(report.w2.download && report.w2.download.ok === true && report.w2.download.bytes === file.length, 'W2：下载、解密出 OGG');
  check(vp.verdict(report).w2 === true, '结论：W2 能走通');
  const text = JSON.stringify(report);
  check(!/4930111222|AAAA1111|CCCC3333|SECRETBODY|Hello|Emma/.test(text), '报告里没有号码、消息编号、内容和名字');
  check(!text.includes(mediaKey.toString('base64')) && !/fake\.enc/.test(text), '报告里没有钥匙和下载地址');
  const ev = await page('window.__events');
  check(ev.clicks === 0 && ev.scrolls === 0 && ev.focus === 0 && ev.mutations === 0, '诊断没有点击、滚动、改页面');
  check(await page('document.documentElement.outerHTML') === before, '诊断前后页面 HTML 完全相同');

  // 3. 钥匙不对：校验失败，不当成能走通
  ({ report } = await vp.probe(wc, async () => ({ ok: true, status: 200, arrayBuffer: async () => encrypt(ogg, crypto.randomBytes(32)).buffer })));
  check(report.w2.download.ok === false && report.w2.download.why === 'bad_mac', `钥匙不对时报告 bad_mac（${report.w2.download.why}）`);

  // 4. 链接过期
  ({ report } = await vp.probe(wc, async () => ({ ok: false, status: 404 })));
  check(report.w2.download.why === 'http_404', '下载 404 时如实报告');

  // 5. 最近的消息里没有语音
  await page(dropDb); await page(seed(mediaKey, { noVoice: true }));
  ({ report } = await vp.probe(wc, fakeFetch));
  check(report.w2.why === 'no_voice_in_last_msgs', `没有语音时报告 no_voice_in_last_msgs（${report.w2.why}）`);

  // 6. W1：页面上有播放过的 blob: 音频
  await page(`(() => { const a = document.createElement('audio'); a.src = URL.createObjectURL(new Blob([new Uint8Array([79,103,103,83,1,2,3])], { type: 'audio/ogg' })); document.body.appendChild(a); })()`);
  ({ report } = await vp.probe(wc, fakeFetch));
  check(report.w1.blob && report.w1.ogg && report.w1.bytes === 7, 'W1：认出播放过的语音，读出是 OGG');

  // 7. 只放行 WhatsApp 的服务器
  check(vp.mediaUrl({ url: 'https://evil.example/x' }) === '' && vp.mediaUrl({ url: 'https://mmg.whatsapp.net.evil.example/x' }) === '', '别的网站的下载地址不放行');
  check(vp.mediaUrl({ url: 'https://media-fra3-1.cdn.whatsapp.net/v/x' }) !== '', 'WhatsApp CDN 地址放行');

  // 8. 没打开对话
  await page(`document.getElementById('main').id = 'gone'`);
  ({ report } = await vp.probe(wc, fakeFetch));
  check(report.chat === false && /没有打开对话/.test(vp.verdict(report).text), '没打开对话时提示先点开一个对话');

  await page(dropDb);
  console.error(failures ? `语音诊断自检：${failures} 项失败` : 'VOICE_PROBE_PASS');
  app.exit(failures ? 1 : 0);
});
