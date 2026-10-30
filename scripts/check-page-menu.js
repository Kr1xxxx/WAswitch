// 账号页面的右键菜单（src/page-menu.js）。模板用假的 params 测各种情况；真页面用和账号页面一样的 WebContentsView
// （sandbox、contextIsolation、缩放 0.9），页面里放 blob: 图片（WhatsApp 的聊天图就是 blob:），右键后拿真的 params 建模板，
// 点「复制图片」，剪贴板里要有 image/png。右键没图的文字处，菜单为空。
// 用法：xvfb-run -a npx electron --no-sandbox scripts/check-page-menu.js
const assert = require('assert');
const { app, BrowserWindow, WebContentsView, clipboard } = require('electron');
const { pageMenuTemplate } = require('../src/page-menu');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const done = (code, msg) => { require('fs').writeSync(2, `${msg}\n`); app.exit(code); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const flags = { canCut: true, canCopy: true, canPaste: false, canSelectAll: true };
const params = (o) => ({ misspelledWord: '', dictionarySuggestions: [], isEditable: false, mediaType: 'none', hasImageContents: false, selectionText: '', editFlags: flags, x: 10, y: 10, ...o });
const calls = [];
const act = {
  replaceMisspelling: (w) => calls.push(['replace', w]),
  addWord: (w) => calls.push(['add', w]),
  copyImage: () => calls.push(['copyImage']),
  translate: () => calls.push(['translate']),
};
const labels = (items) => items.map((i) => (i.type === 'separator' ? '-' : i.label));

function checkTemplates() {
  const t = (o) => labels(pageMenuTemplate(params(o), act));
  assert.deepStrictEqual(t({ mediaType: 'image', hasImageContents: true }), ['复制图片'], '右键图片只有「复制图片」');
  assert.deepStrictEqual(t({ mediaType: 'image', hasImageContents: true, selectionText: 'Guten Tag' }), ['复制图片', '-', '复制', '翻译'], '图片加选中文字：复制图片、分隔线、复制、翻译');
  assert.deepStrictEqual(t({ mediaType: 'image', hasImageContents: true, selectionText: '  ' }), ['复制图片', '-', '复制'], '选中的只有空白时不出翻译');
  assert.deepStrictEqual(t({ mediaType: 'image', hasImageContents: false }), [], '图片还没加载出来：不弹菜单');
  assert.deepStrictEqual(t({ mediaType: 'video', hasImageContents: false }), [], '视频不出菜单');
  assert.deepStrictEqual(t({}), [], '没选中的文字：不弹菜单');
  assert.deepStrictEqual(t({ selectionText: 'Hola' }), ['复制', '翻译'], '选中文字：复制、翻译');
  assert.deepStrictEqual(t({ isEditable: true }), ['剪切', '复制', '粘贴', '全选'], '输入框：剪切复制粘贴全选');
  assert.deepStrictEqual(t({ isEditable: true, mediaType: 'image', hasImageContents: true }), ['剪切', '复制', '粘贴', '全选'], '输入框里不加复制图片');
  assert.deepStrictEqual(pageMenuTemplate(params({ isEditable: true }), act).map((i) => i.enabled), [true, true, false, true], '输入框各项的可用状态跟 editFlags 走');
  assert.deepStrictEqual(t({ misspelledWord: 'helo', dictionarySuggestions: ['hello', 'help'], isEditable: true }), ['hello', 'help', '把“helo”加入词典', '-', '剪切', '复制', '粘贴', '全选'], '拼写建议在最前面');
  assert.deepStrictEqual(t({ misspelledWord: 'helo' }), ['没有拼写建议', '把“helo”加入词典', '-'], '没有建议时的提示照旧');
  const withSpell = t({ misspelledWord: 'helo', dictionarySuggestions: ['hello'], mediaType: 'image', hasImageContents: true });
  assert.deepStrictEqual(withSpell, ['hello', '把“helo”加入词典', '-', '复制图片'], '拼写建议之后才是复制图片');
  // click 接到对应的动作
  const items = pageMenuTemplate(params({ mediaType: 'image', hasImageContents: true, selectionText: 'Bonjour' }), act);
  items[0].click();
  items[items.length - 1].click();
  assert.deepStrictEqual(calls, [['copyImage'], ['translate']]);
}

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px sans-serif">
<p id="t" style="margin:0;padding:20px;width:300px">Hello, is the wig still available?</p>
<img id="im" style="display:block;margin:20px;width:120px;height:80px">
<script>
const c = document.createElement('canvas'); c.width = 120; c.height = 80;
const g = c.getContext('2d'); g.fillStyle = '#3b82f6'; g.fillRect(0, 0, 120, 80); g.fillStyle = '#fff'; g.fillRect(20, 20, 40, 40);
c.toBlob((b) => { const im = document.getElementById('im'); im.onload = () => { document.title = 'ready'; }; im.src = URL.createObjectURL(b); });
</script>`;

async function checkRealPage() {
  const win = new BrowserWindow({ show: true, width: 700, height: 500 });
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 700, height: 500 });
  const wc = view.webContents;
  wc.setZoomFactor(0.9);
  win.focus();
  wc.focus();
  await wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  for (let i = 0; i < 40 && wc.getTitle() !== 'ready'; i += 1) await wait(100);
  assert.strictEqual(wc.getTitle(), 'ready', '页面里的 blob: 图片没加载出来');
  const rectOf = (id) => wc.executeJavaScript(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const rightClick = async (id) => {
    const pt = await rectOf(id);
    const x = Math.round(pt.x * 0.9);
    const y = Math.round(pt.y * 0.9);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`右键 #${id} 没触发 context-menu`)), 5000);
      wc.once('context-menu', (_e, p) => { clearTimeout(timer); resolve(p); });
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
    });
  };

  // 右键图片：真 params 里是 image，模板只有「复制图片」，点了剪贴板里有 image/png
  clipboard.clear();
  const pImg = await rightClick('im');
  assert.strictEqual(pImg.mediaType, 'image', `右键图片的 mediaType 不是 image：${pImg.mediaType}`);
  assert.strictEqual(pImg.hasImageContents, true);
  const items = pageMenuTemplate(pImg, { ...act, copyImage: () => wc.copyImageAt(pImg.x, pImg.y) });
  assert.deepStrictEqual(labels(items), ['复制图片']);
  items[0].click();
  let types = [];
  for (let i = 0; i < 20 && !types.includes('image/png'); i += 1) {
    await wait(100);
    types = (await clipboard.read()).flatMap((it) => it.types || []);
  }
  assert(types.includes('image/png'), `剪贴板里没有图片：${JSON.stringify(types)}`);

  // 右键没选中的文字：菜单为空，和以前一样
  const pTxt = await rightClick('t');
  assert.strictEqual(pTxt.mediaType, 'none');
  assert.deepStrictEqual(pageMenuTemplate(pTxt, act), [], '右键没选中的文字不弹菜单');
  win.destroy();
}

app.whenReady().then(async () => {
  setTimeout(() => done(1, 'check-page-menu FAILED: 30 秒内没跑完'), 30000).unref();
  checkTemplates();
  await checkRealPage();
  done(0, 'check-page-menu: ok');
}).catch((e) => done(1, `check-page-menu FAILED: ${e.stack || e.message}`));
