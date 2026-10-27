// 翻译页“收到的消息”列表：翻译过程中不能上下跳（shen 2026-10-27）。
// 用真的 shell 页面 + 假的主进程，模拟慢翻译：每条消息 翻译中 → 译文，有时同一时刻推两次状态。
// 检查：1) 滚到中间时，看着的那条消息一直在原处；2) 停在最底下时，新消息来了照样跟到底。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-dock-scroll.js（窗口要显示出来，不然没有动画帧；xvfb 下看不见）
const path = require('path');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

// 在页面里跑：建 14 条消息，按 mode 滚好，逐条翻译，每一帧记下第一条看得见的消息和它离列表顶部的距离
const scenario = async (mode) => {
  const base = 'Hallo! Ich habe Ihre Anzeige gesehen. Ist das Modell noch verfügbar und wie lange dauert der Versand nach München?';
  const zh = '你好！我看到了你的广告。这个型号还有货吗？发货到慕尼黑要多久？';
  const items = Array.from({ length: 14 }, (_, i) => ({ h: `h${i}`, text: `#${i} ${base.slice(0, 30 + (i * 23) % 90)}`, t: `10:${String(i).padStart(2, '0')}`, state: 'queued', tr: '' }));
  const d = { accountId: 'a1', readable: 'ok', title: 'Lukas Becker', items, paused: '', auto: true, dailyCap: 500, hasProvider: true, needKey: null,
    primaryId: 'z', fallbackId: '', providers: [{ id: 'z', name: '智谱', model: 'glm-4-flash' }], modes: { out: [{ id: 'o', name: '商务' }], in: [{ id: 'i', name: '收到' }] }, inModeId: 'i',
    langs: ['英语', '德语'], target: '德语', targetSrc: 'detected', autoTarget: '德语', canRemember: true };
  window.__dock = d;
  const push = () => window.__cbs.dock(JSON.parse(JSON.stringify(d)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__cbs.state({ accounts: [{ id: 'a1', name: 'Lukas', color: '#3b82f6' }], groups: [], activeId: 'a1', page: 'account', panelOpen: true, panelTab: 'translate', platform: 'linux', collapsed: false });
  push();
  await wait(300);
  // 字体（fonts.css）加载完行高才定下来；CI 上字体晚到会让每行矮/高一行，看起来像“消息上下跳了 -28px”。
  // 等字体就绪、再等两帧让布局稳定后再开始记位置
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const list = () => document.querySelector('.dk-list');
  if (list().scrollHeight - list().clientHeight < 200) return { error: '列表太短，测不出滚动' };
  if (mode === 'middle') { list().scrollTop = Math.round((list().scrollHeight - list().clientHeight) / 2); await wait(100); }
  const frames = [];
  let on = true;
  const watch = () => {
    const l = list();
    const rows = [...l.querySelectorAll('.dk-item')];
    const top = l.getBoundingClientRect().top;
    const vis = rows.find((r) => r.getBoundingClientRect().bottom > top + 1);
    frames.push({ top: l.scrollTop, gap: l.scrollHeight - l.scrollTop - l.clientHeight, first: vis ? vis.dataset.h : '', off: vis ? Math.round(vis.getBoundingClientRect().top - top) : 0 });
    if (on) requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
  for (let i = 0; i < items.length; i++) {
    items[i].state = 'running'; push();
    await wait(80);
    items[i].state = 'done'; items[i].tr = zh.slice(0, 10 + (i * 17) % 40); push();
    if (i + 1 < items.length) { items[i + 1].state = 'running'; push(); } // 同一时刻连推两次
  }
  await wait(400);
  // 新消息到了（最老的一条被挤掉）
  items.shift();
  items.push({ h: 'new1', text: '#N Können Sie mir bitte ein Angebot schicken?', t: '11:00', state: 'running', tr: '' }); push();
  await wait(150);
  items[items.length - 1].state = 'done'; items[items.length - 1].tr = '能给我发个报价吗？'; push();
  await wait(400);
  on = false;
  const l = list();
  if (!frames.length) return { error: '一帧都没记到（窗口没在画动画帧）' };
  return { frames, end: { top: l.scrollTop, gap: l.scrollHeight - l.scrollTop - l.clientHeight, first: frames[frames.length - 1].first } };
};

// 一个窗口跑两轮，每轮重新加载页面（关掉再开新窗口，第二次加载会失败）
let w = null;
const errs = [];
async function run(mode) {
  if (!w) {
    w = new BrowserWindow({ show: true, width: 1200, height: 760, webPreferences: { preload: path.join(__dirname, 'fixtures', 'dock-fake-preload.js'), contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    w.webContents.on('console-message', (e) => { const m = e.message || ''; if (e.level === 'error' || /Error/.test(m)) errs.push(m); });
  }
  await w.loadFile(path.join(__dirname, '..', 'src', 'shell', 'index.html'));
  const r = await w.webContents.executeJavaScript(`(${scenario})(${JSON.stringify(mode)})`);
  assert(!r.error, r.error);
  assert.deepStrictEqual(errs, [], '页面没有报错');
  return r;
}

app.whenReady().then(async () => {
  // 1) 滚到中间：看着的那条消息（和它的位置）在整个翻译过程中都不变，新消息来了也不变
  const mid = await run('middle');
  const f0 = mid.frames[0];
  assert(f0.top > 0 && f0.gap > 24, `开始时在中间 ${JSON.stringify(f0)}`);
  for (const f of mid.frames) {
    assert.strictEqual(f.first, f0.first, `看着的消息被换掉了（跳了）${JSON.stringify(f)}`);
    assert(Math.abs(f.off - f0.off) <= 1, `看着的消息上下跳了 ${f.off - f0.off}px`);
  }
  assert(mid.end.gap > 24, '在中间时新消息来了不该被拉到底');
  // 2) 停在最底下：翻译过程中和新消息来了以后都在最底下
  const bot = await run('bottom');
  assert(bot.end.gap <= 1, `新消息来了应该跟到底，还差 ${bot.end.gap}px`);
  assert.strictEqual(bot.end.first === 'h0', false, '没有被打回顶部');
  assert(bot.frames.every((f) => f.top > 0), '翻译过程中不能被打回顶部');
  console.log(`翻译页滚动自检通过（中间：${mid.frames.length} 帧位置不变；底部：跟到最新）`);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
