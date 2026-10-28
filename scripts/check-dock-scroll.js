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
  // 先等页面真的出了两帧：CI 机器忙时动画帧会晚来，不等就会一帧都没记到
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  await frame(); await frame();
  if (mode === 'middle') {
    // scroll 事件要到下一帧才发：等它真的发出来（工作台靠它知道用户不在底部），机器忙时 100ms 不一定够
    const scrolled = new Promise((r) => list().addEventListener('scroll', () => r(), { once: true }));
    list().scrollTop = Math.round((list().scrollHeight - list().clientHeight) / 2);
    await scrolled; await frame(); await wait(100);
  }
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
  watch(); // 先同步记一帧当起点，后面每一帧接着记
  for (let i = 0; i < items.length; i++) {
    items[i].state = 'running'; push();
    await wait(80);
    items[i].state = 'done'; items[i].tr = zh.slice(0, 10 + (i * 17) % 40); push();
    if (i + 1 < items.length) { items[i + 1].state = 'running'; push(); } // 同一时刻连推两次
  }
  await wait(400);
  const pill = () => !!document.querySelector('.dk-listbox .dk-newpill');
  const pillBefore = pill(); // 只是翻译中 → 译文，不算新消息
  // 新消息到了（最老的一条被挤掉）
  items.shift();
  items.push({ h: 'new1', text: '#N Können Sie mir bitte ein Angebot schicken?', t: '11:00', state: 'running', tr: '' }); push();
  await wait(150);
  items[items.length - 1].state = 'done'; items[items.length - 1].tr = '能给我发个报价吗？'; push();
  await wait(400);
  on = false;
  const l = list();
  if (!frames.length) return { error: '一帧都没记到（窗口没在画动画帧）' };
  const end = { top: l.scrollTop, gap: l.scrollHeight - l.scrollTop - l.clientHeight, first: frames[frames.length - 1].first };
  const pillAfter = pill();
  const out = { frames: frames.slice(), end, pillBefore, pillAfter }; // 拷一份：下面点按钮滚到底时，最后一帧的记录不能混进来
  if (mode !== 'middle') return out;
  // 「新消息」点了回到最底下，然后收起
  document.querySelector('.dk-newpill').click();
  await frame(); await wait(100);
  out.click = { gap: list().scrollHeight - list().scrollTop - list().clientHeight, pill: pill() };
  // 再来一条也照样跟到底，不出「新消息」
  items.push({ h: 'new2', text: '#M Danke!', t: '11:01', state: 'done', tr: '谢谢！' }); push();
  await frame(); await wait(100);
  out.follow = { gap: list().scrollHeight - list().scrollTop - list().clientHeight, pill: pill() };
  // 往上翻，客户撤回了最新一条：最后一条变成以前就有的，不算新消息
  // 滚到的位置要和上次程序恢复的位置不一样，不然会被当成程序自己滚的（用户真滚时会经过很多位置）
  const up = async (top) => {
    const scrolled = new Promise((r) => list().addEventListener('scroll', () => r(), { once: true }));
    list().scrollTop = top;
    await scrolled; await frame(); await wait(100);
  };
  await up(0);
  items.pop(); push();
  await frame(); await wait(100);
  out.revoke = pill();
  // 再来一条：出「新消息」；自己滚到底也收起
  items.push({ h: 'new3', text: '#K Wann kommt es an?', t: '11:02', state: 'done', tr: '什么时候到？' }); push();
  await frame(); await wait(100);
  out.again = pill();
  const down = new Promise((r) => list().addEventListener('scroll', () => r(), { once: true }));
  list().scrollTop = list().scrollHeight;
  await down; await frame(); await wait(100);
  out.manual = pill();
  // 往上翻着时换了对话：不带「新消息」过去
  await up(20);
  items.push({ h: 'new4', text: '#J Hallo?', t: '11:03', state: 'done', tr: '你好？' }); push();
  await frame(); await wait(100);
  const had = pill();
  d.title = 'Emma Schmidt'; push();
  await frame(); await wait(100);
  out.switchChat = { had, after: pill() };
  // 列表不够长、不用滚：就算之前记着“不在底下”，来了新消息也不出
  await up(30);
  d.items = items.slice(-2); push();
  await frame(); await wait(100);
  dk.stick = false; // 模拟“不在底下”的记录过期（比如窗口拉高后列表不用滚了）
  d.items.push({ h: 'new5', text: '#S Ok', t: '11:04', state: 'done', tr: '好' }); push();
  await frame(); await wait(100);
  out.short = { scrolls: list().scrollHeight > list().clientHeight, pill: pill() };
  return out;
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
  // 「新消息」：往上翻着时来了新消息才出，点了回到最底下（shen 2026-10-28）
  assert.strictEqual(mid.pillBefore, false, '只是翻译中 → 译文，不该出「新消息」');
  assert.strictEqual(mid.pillAfter, true, '往上翻着时来了新消息，应该出「新消息」');
  assert(mid.click.gap <= 1 && !mid.click.pill, `点「新消息」应该回到最底下并收起 ${JSON.stringify(mid.click)}`);
  assert(mid.follow.gap <= 1 && !mid.follow.pill, `回到底下后新消息照样跟到底 ${JSON.stringify(mid.follow)}`);
  assert.strictEqual(mid.revoke, false, '撤回最新一条不算新消息');
  assert.strictEqual(mid.again, true, '再往上翻时来了新消息，应该出「新消息」');
  assert.strictEqual(mid.manual, false, '自己滚到最底下，「新消息」应该收起');
  assert(mid.switchChat.had && !mid.switchChat.after, `换对话不带「新消息」过去 ${JSON.stringify(mid.switchChat)}`);
  assert(!mid.short.scrolls && !mid.short.pill, `列表不用滚时来新消息不该出「新消息」 ${JSON.stringify(mid.short)}`);
  // 2) 停在最底下：翻译过程中和新消息来了以后都在最底下
  const bot = await run('bottom');
  assert(bot.end.gap <= 1, `新消息来了应该跟到底，还差 ${bot.end.gap}px`);
  assert.strictEqual(bot.end.first === 'h0', false, '没有被打回顶部');
  assert(bot.frames.every((f) => f.top > 0), '翻译过程中不能被打回顶部');
  assert(!bot.pillBefore && !bot.pillAfter, '停在最底下时不该出「新消息」');
  // 回复框不放「用中文写要回的话」这类灰字提示（shen 2026-10-28）
  const ph = await w.webContents.executeJavaScript("(() => { const el = document.querySelector('.dk-in'); return el ? el.placeholder : null; })()");
  assert(ph !== null, '找不到回复框 .dk-in');
  assert.strictEqual(ph, '', `回复框不该有灰字提示：${ph}`);
  console.log(`翻译页滚动自检通过（中间：${mid.frames.length} 帧位置不变，新消息出「新消息」，点了回到最新；底部：跟到最新；回复框无灰字提示）`);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
