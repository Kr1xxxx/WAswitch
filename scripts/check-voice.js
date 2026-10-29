// 语音转文字的界面部分自检：
// 1) 真的 shell 预加载 + voice.js：主进程发 OGG/Opus（合成的 2 秒单音，scripts/fixtures/voice-tone.ogg），
//    界面解码成 16 kHz 单声道 16 位还回来（Int16Array 经 IPC 原样到主进程），切段、编码 wav 正常
// 2) 翻译页语音行：「语音 0:23」「转文字」「转文字中…」、转好后译文和可展开的原文、报错和「重试」；380px 宽的工作台里不换行、不被裁
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-voice.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { app, BrowserWindow, ipcMain } = require('electron');
const asr = require('../src/asr');


async function decodeCheck() {
  const w = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, '..', 'src', 'shell', 'preload.js'), contextIsolation: true, sandbox: false } });
  const html = path.join(app.getPath('temp'), `voice-check-${process.pid}.html`);
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><script src="${path.join(__dirname, '..', 'src', 'shell', 'voice.js')}"></script>`);
  await w.loadFile(html);
  const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'voice-tone.ogg')));
  const ask = (n, b) => new Promise((resolve) => {
    const on = (_e, k, r) => { if (k !== n) return; ipcMain.removeListener('voice:decoded', on); resolve(r); };
    ipcMain.on('voice:decoded', on);
    w.webContents.send('voice:decode', { n, bytes: b });
  });
  const r = await ask(1, bytes);
  assert(r && r.pcm instanceof Int16Array, `解码结果应是 Int16Array：${Object.prototype.toString.call(r && r.pcm)}`);
  const sec = r.pcm.length / asr.RATE;
  assert(sec > 1.8 && sec < 2.2, `2 秒的语音解出 ${sec} 秒`);
  let peak = 0;
  for (const v of r.pcm) peak = Math.max(peak, Math.abs(v));
  assert(peak > 3000, `解出来是静音（峰值 ${peak}）`);
  const chunks = asr.splitPcm(r.pcm);
  assert.strictEqual(chunks.length, 1);
  const wav = asr.wavOf(chunks[0]);
  assert.strictEqual(wav.length, 44 + r.pcm.length * 2);
  // 坏数据：报错，不卡住
  const bad = await ask(2, new Uint8Array([1, 2, 3, 4, 5]));
  assert(bad && bad.error === true && !bad.pcm, '坏数据要报错');
  w.destroy();
  fs.rmSync(html, { force: true });
  return sec;
}

// 在页面里跑：翻译页显示几条语音，返回各行的文字、按钮、尺寸
const scenario = async () => {
  const base = { accountId: 'a1', readable: 'ok', title: 'Sophie Martin', paused: '', auto: false, dailyCap: 500, hasProvider: true, needKey: null, lite: true,
    primaryId: 'z', fallbackId: '', providers: [{ id: 'z', name: '智谱', model: 'glm-4-flash' }], modes: { out: [{ id: 'o', name: '商务' }], in: [{ id: 'i', name: '收到' }] }, inModeId: 'i',
    langs: ['英语', '法语'], target: '法语', targetSrc: 'detected', autoTarget: '法语', canRemember: true };
  const it = (h, x) => ({ h, text: '', t: '09:41', state: 'manual', tr: '', err: '', errPid: '', warn: [], note: '', edited: false, fixed: false, suggest: '', voice: 23, ...x });
  const items = [
    it('v1', {}),
    it('v2', { state: 'running' }),
    it('v3', { state: 'done', text: 'Bonjour, est-ce que la perruque est encore disponible ?', tr: '你好，这顶假发还有货吗？' }),
    it('v4', { state: 'error', err: '智谱余额不足，语音转文字要先充值' }),
    it('v5', { voice: 412, note: 'long' }),
    it('v6', { state: 'error', err: '智谱还没填密钥', errPid: 'z' }),
  ];
  window.__dock = { ...base, items };
  window.__cbs.state({ accounts: [{ id: 'a1', name: 'Sophie', color: '#3b82f6', lite: true }], groups: [], activeId: 'a1', page: 'account', panelOpen: true, panelTab: 'translate', platform: 'linux', collapsed: false });
  window.__cbs.dock(JSON.parse(JSON.stringify(window.__dock)));
  await new Promise((r) => setTimeout(r, 300));
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const row = (h) => document.querySelector(`.dk-item[data-h="${h}"]`);
  const info = (h) => {
    const el = row(h);
    if (!el) return null;
    const tag = el.querySelector('.dk-voice');
    const btns = [...el.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean);
    const lineH = (n) => (n ? Math.round(n.getBoundingClientRect().height) : 0);
    const clipped = [...el.querySelectorAll('.dk-voice, .dk-link')].some((n) => n.scrollWidth > n.clientWidth + 1);
    return { tag: tag ? tag.textContent : '', tagH: lineH(tag), text: el.textContent, btns, clipped, linkH: [...el.querySelectorAll('.dk-link')].map(lineH) };
  };
  const out = {};
  for (const x of items) out[x.h] = info(x.h);
  const panel = document.querySelector('.dk-list');
  out.panelW = panel ? Math.round(panel.getBoundingClientRect().width) : 0;
  // 点「转文字」：叫主进程翻这一条
  row('v1').querySelector('.dk-link').click();
  return out;
};

async function rowsCheck() {
  const w = new BrowserWindow({ show: true, width: 900, height: 600, webPreferences: { preload: path.join(__dirname, 'fixtures', 'dock-fake-preload.js'), contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const errs = [];
  w.webContents.on('console-message', (e) => { const m = e.message || ''; if (e.level === 'error' || /Error/.test(m)) errs.push(m); });
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const r = await w.webContents.executeJavaScript(`(${scenario})()`);
  assert.deepStrictEqual(errs, [], `页面没有报错：${errs.join('\n')}`);
  assert(r.panelW > 200 && r.panelW <= 400, `工作台宽度 ${r.panelW}`);
  const lineH = r.v1.tagH;
  assert(lineH > 0 && lineH <= 20, `「语音 0:23」一行高 ${lineH}`);
  assert.strictEqual(r.v1.tag, '语音 0:23');
  assert.deepStrictEqual(r.v1.btns, ['转文字']);
  assert(r.v2.text.includes('转文字中…') && !r.v2.text.includes('翻译中'), r.v2.text);
  assert(r.v3.text.includes('你好，这顶假发还有货吗？') && r.v3.btns.includes('纠错') && r.v3.btns.includes('编辑'), JSON.stringify(r.v3));
  assert(r.v3.text.includes('Bonjour'), '转出来的原文可展开（在页面上，默认收起）');
  assert(r.v4.text.includes('余额不足') && r.v4.btns.includes('重试'), JSON.stringify(r.v4));
  assert.strictEqual(r.v5.tag, '语音 6:52');
  assert.deepStrictEqual(r.v5.btns, ['转文字（太长，只转前 5 分钟）']);
  assert(r.v6.btns.includes('去填密钥') && r.v6.btns.includes('重试'), JSON.stringify(r.v6));
  for (const h of ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']) {
    assert(!r[h].clipped, `${h} 的文字被裁了`);
    assert.strictEqual(r[h].tagH, lineH, `${h} 的「语音」换行了`);
  }
  for (const h of ['v1', 'v5']) for (const x of r[h].linkH) assert(x <= lineH + 8, `${h} 的按钮换行了（${x}px）`);
  w.destroy();
}

app.on('window-all-closed', () => {}); // 换窗口时不退出
app.whenReady().then(async () => {
  const sec = await decodeCheck();
  await rowsCheck();
  console.log(`语音转文字界面自检通过（OGG/Opus 解码 ${sec.toFixed(2)} 秒 → 16 kHz Int16Array；语音行文字、按钮、报错，380px 工作台不换行）`);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
