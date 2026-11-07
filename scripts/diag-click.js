// 临时诊断（不合并）：真鼠标点击主窗口里的按钮，数第一下有没有生效。
// 主窗口 = BaseWindow + 两个 WebContentsView（像软件界面和账号页面），通知弹窗用 src/popup.js 原样。
// 运行：Windows  node_modules\electron\dist\electron.exe scripts/diag-click.js
//       Linux    xvfb-run -a npx electron --no-sandbox scripts/diag-click.js
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { app, BaseWindow, WebContentsView, BrowserWindow, ipcMain, screen } = require('electron');
const { PopupWindow } = require('../src/popup');

const log = (...a) => fs.writeSync(1, `${a.join(' ')}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});

// ---- 真鼠标 ----
let ps = null;
let psQueue = [];
function psStart() {
  const src = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
[void][M]::SetProcessDPIAware()
$sw = [M]::GetSystemMetrics(0); $sh = [M]::GetSystemMetrics(1)
[Console]::Out.WriteLine('ready')
while (($l = [Console]::In.ReadLine()) -ne $null) {
  $p = $l.Split(' ')
  if ($p[0] -eq 'move') {
    # 真的鼠标移动（走系统输入，低级鼠标钩子看得到），坐标换成 0..65535
    $nx = [int]([double]$p[1] * 65535 / ($sw - 1)); $ny = [int]([double]$p[2] * 65535 / ($sh - 1))
    [M]::mouse_event(0x8001, [uint32]$nx, [uint32]$ny, 0, [UIntPtr]::Zero)
  }
  elseif ($p[0] -eq 'down') { [M]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero) }
  elseif ($p[0] -eq 'up') { [M]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
  [Console]::Out.WriteLine('ok')
}`;
  const file = path.join(require('os').tmpdir(), `diag-click-${process.pid}.ps1`);
  fs.writeFileSync(file, src);
  ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  ps.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { buf = buf.slice(i + 1); const r = psQueue.shift(); if (r) r(); }
  });
  return new Promise((r) => psQueue.push(r));
}
function op(...a) {
  if (process.platform === 'win32') return new Promise((r) => { psQueue.push(r); ps.stdin.write(`${a.join(' ')}\n`); });
  const args = a[0] === 'move' ? ['move', a[1], a[2]] : [a[0], 1];
  execFileSync('python3', [process.env.XT || '/mnt/project-files/review/copy-fails/xt.py', ...args.map(String)]);
  return Promise.resolve();
}
async function click(x, y) {
  await op('move', x - 6, y - 4); await wait(30);
  await op('move', x - 2, y - 1); await wait(30);
  await op('move', x, y); await wait(60);
  await op('down'); await wait(70);
  await op('up'); await wait(250);
}

const PAGE = (name, color) => `data:text/html,${encodeURIComponent(`<!doctype html><html><body style="margin:0;font:14px sans-serif;background:${color}">
<div id="g" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px"></div>
<script>
window.__n = {};
window.__ev = [];
for (let i = 0; i < 24; i++) {
  const b = document.createElement('button');
  b.id = '${name}' + i; b.textContent = '${name}' + i; b.style.height = '60px';
  b.onclick = () => { window.__n[b.id] = (window.__n[b.id] || 0) + 1; };
  document.getElementById('g').append(b);
}
for (const t of ['mousedown','mouseup','click']) document.addEventListener(t, (e) => window.__ev.push(t + ':' + (e.target.id || e.target.tagName)), true);
</script></body></html>`)}`;

app.whenReady().then(async () => {
  if (process.platform === 'win32') await psStart();
  const d = screen.getPrimaryDisplay();
  log('display', JSON.stringify({ bounds: d.bounds, workArea: d.workArea, scale: d.scaleFactor }));
  const win = new BaseWindow({ show: false, width: 900, height: 600, title: 'diag-main' });
  win.setBounds(d.workArea);
  const shell = new WebContentsView({ webPreferences: { sandbox: true } });
  win.contentView.addChildView(shell);
  const acc = new WebContentsView({ webPreferences: { sandbox: true } });
  win.contentView.addChildView(acc);
  const lay = () => {
    const { width, height } = win.getContentBounds();
    shell.setBounds({ x: 0, y: 0, width, height });
    acc.setBounds({ x: 220, y: 60, width: Math.max(0, width - 220 - 8), height: Math.max(0, height - 68) });
  };
  lay();
  win.on('resize', lay);
  await shell.webContents.loadURL(PAGE('s', '#eee'));
  await acc.webContents.loadURL(PAGE('a', '#cfc'));
  win.show();
  win.focus();
  await wait(800);

  // 通知弹窗：和软件一样（src/popup.js）
  const popup = new PopupWindow({
    getWindow: () => win,
    account: () => ({ name: '德国号', color: '#3b82f6', emoji: '' }),
    locked: () => false,
    settings: () => ({ popupSeconds: 0, popupSound: false, popupDnd: false }),
    onOpen: () => log('popup open clicked'),
    onLater: () => log('popup later clicked'),
    idleSeconds: () => 0,
  });
  ipcMain.on('popup:ready', (e) => popup.onReady(e.sender));
  ipcMain.on('popup:hover', (e, on) => { log(`  popup hover ${on} t=${Date.now() % 100000}`); popup.onHover(e.sender, on === true); });
  ipcMain.on('popup:act', (e, { uid, action } = {}) => popup.onAction(e.sender, uid, action));

  // 屏幕坐标：按钮中心（DIP），Windows 上换成物理像素
  const centers = async (view, ids) => {
    const vb = view.getBounds();
    const cb = win.getContentBounds();
    const rects = await view.webContents.executeJavaScript(`(${JSON.stringify(ids)}).map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, r.left + r.width / 2, r.top + r.height / 2]; })`);
    return rects.map(([id, x, y]) => {
      const p = { x: Math.round(cb.x + vb.x + x), y: Math.round(cb.y + vb.y + y) };
      const s = process.platform === 'win32' ? screen.dipToScreenPoint(p) : p;
      return { id, view, x: Math.round(s.x), y: Math.round(s.y), dip: p };
    });
  };
  const counts = async () => {
    const a = await shell.webContents.executeJavaScript('window.__n');
    const b = await acc.webContents.executeJavaScript('window.__n');
    return { ...a, ...b };
  };
  const evs = async (view) => view.webContents.executeJavaScript('window.__ev.splice(0)');
  const popupRect = () => (popup.win && !popup.win.isDestroyed() ? popup.win.getBounds() : null);
  const inside = (t, r) => r && t.dip.x >= r.x && t.dip.x < r.x + r.width && t.dip.y >= r.y && t.dip.y < r.y + r.height;

  const targets = [
    ...(await centers(shell, ['s0', 's3', 's20'])),
    ...(await centers(acc, ['a0', 'a3', 'a7', 'a11', 'a15', 'a23'])),
  ];
  let total = { ok: 0, lost: 0 };
  async function scenario(name, prep) {
    await prep();
    await wait(500);
    const pr = popupRect();
    log(`\n== ${name}  popup=${pr ? JSON.stringify(pr) : 'none'} visible=${!!(popup.win && !popup.win.isDestroyed() && popup.win.isVisible())}`);
    for (const t of targets) {
      const before = (await counts())[t.id] || 0;
      await click(t.x, t.y);
      await wait(150);
      const after = (await counts())[t.id] || 0;
      const ev = await evs(t.view);
      const ok = after - before === 1;
      if (ok) total.ok += 1; else total.lost += 1;
      log(`  ${ok ? 'OK  ' : 'LOST'} ${t.id} at ${t.x},${t.y} underPopup=${inside(t, pr)} clicks+${after - before} ev=${ev.join(' ')}`);
    }
  }

  await scenario('A 没有弹窗', async () => {});
  await scenario('B 弹窗显示中（一张卡，永不消失），点穿+转发', async () => {
    popup.show({ key: 'k1', kind: 'msg', accId: 'a', chat: 'Emma Schmidt', text: 'Hello, is the order shipped?' });
    await wait(1500);
  });
  const reshow = async (k) => { if (!popup.queue.size) { popup.show({ key: k, kind: 'msg', accId: 'a', chat: 'Emma Schmidt', text: 'Hello again' }); await wait(1200); } };
  // 记下弹窗什么时候变成能点、什么时候变回点穿
  const wrapIgnore = () => {
    const w = popup.win;
    if (!w || w.__wrapped) return;
    const orig = w.setIgnoreMouseEvents.bind(w);
    w.setIgnoreMouseEvents = (ig, o) => { log(`    popup ignore=${ig} t=${Date.now() % 100000}`); return orig(ig, o); };
    w.__wrapped = true;
  };
  // B2：鼠标先经过卡片（弹窗变成能点），再去点卡片下面透明处盖着的主窗口按钮
  {
    const card = popupRect();
    const cx = Math.round(card.x + card.width / 2); const cy = Math.round(card.y + 60);
    const cs = process.platform === 'win32' ? screen.dipToScreenPoint({ x: cx, y: cy }) : { x: cx, y: cy };
    await reshow('k-b2'); wrapIgnore();
    log('\n== B2 先经过卡片再点卡片下面的主窗口按钮');
    const cardBottom = card.y + 140;
    for (const t of targets.filter((x) => inside(x, card) && x.dip.y > cardBottom)) {
      for (const pause of [400, 120, 30]) {
        const before = (await counts())[t.id] || 0;
        await op('move', cs.x, cs.y); await wait(60); await op('move', cs.x + 2, cs.y + 2); await wait(pause);
        await click(t.x, t.y); await wait(150);
        const after = (await counts())[t.id] || 0;
        const ok = after - before === 1;
        if (ok) total.ok += 1; else total.lost += 1;
        log(`  ${ok ? 'OK  ' : 'LOST'} ${t.id} pause=${pause} clicks+${after - before} ignore? ev=${(await evs(t.view)).join(' ')}`);
      }
    }
  }
  // G：主进程忙（同步卡 400 ms）时点击，弹窗在转发鼠标
  log('\n== G 主进程忙的时候点（弹窗在转发）');
  for (const t of targets.slice(0, 5)) {
    const before = (await counts())[t.id] || 0;
    await op('move', t.x, t.y); await wait(60);
    const p = op('down').then(() => wait(70)).then(() => op('up'));
    const until = Date.now() + 400; while (Date.now() < until) { /* busy */ }
    await p; await wait(400);
    const after = (await counts())[t.id] || 0;
    const ok = after - before === 1;
    if (ok) total.ok += 1; else total.lost += 1;
    log(`  ${ok ? 'OK  ' : 'LOST'} ${t.id} clicks+${after - before} ev=${(await evs(t.view)).join(' ')}`);
  }
  // H：鼠标停在卡片上时，弹窗窗口被挪走（像拔掉显示器时系统把窗口挪到另一块屏幕上），鼠标没动
  {
    await reshow('k-h'); wrapIgnore();
    const card = popupRect();
    const cx = Math.round(card.x + card.width / 2); const cy = Math.round(card.y + 60);
    const cs = process.platform === 'win32' ? screen.dipToScreenPoint({ x: cx, y: cy }) : { x: cx, y: cy };
    await op('move', cs.x, cs.y); await wait(80); await op('move', cs.x + 3, cs.y + 2); await wait(400);
    log(`\n== H 鼠标停在卡上时弹窗被挪到 (200,120)  hoverSince=${popup.queue.hoverSince ? 'yes' : 'no'}`);
    popup.win.setPosition(200, 120);
    await wait(500);
    const pr = popupRect();
    log(`  popup now ${JSON.stringify(pr)} hoverSince=${popup.queue.hoverSince ? 'yes' : 'no'}`);
    const hs = [...(await centers(shell, ['s1', 's5', 's9', 's13', 's17', 's21'])), ...(await centers(acc, ['a1', 'a5', 'a9', 'a13', 'a17']))].filter((t) => inside(t, pr) && (t.view === acc || !inside(t, { ...acc.getBounds(), ...{ x: acc.getBounds().x + win.getContentBounds().x, y: acc.getBounds().y + win.getContentBounds().y } })));
    for (const t of hs) {
      const before = (await counts())[t.id] || 0;
      // 直接点（鼠标从远处一下跳过去，中间不经过）
      await op('move', t.x, t.y); await wait(60);
      await op('down'); await wait(70); await op('up'); await wait(300);
      const after = (await counts())[t.id] || 0;
      const ok = after - before === 1;
      if (ok) total.ok += 1; else total.lost += 1;
      log(`  ${ok ? 'OK  ' : 'LOST'} ${t.id} at ${t.x},${t.y} clicks+${after - before} hoverSince=${popup.queue.hoverSince ? 'yes' : 'no'} ev=${(await evs(t.view)).join(' ')}`);
    }
    popup.render(); // 弹窗放回右上角
    await wait(300);
  }
  await scenario('C 弹窗收起（窗口藏着，1 分钟内还在）', async () => {
    popup.queue.removeWhere(() => true);
    popup.render();
    await wait(300);
  });
  await scenario('D 弹窗显示中，但不转发鼠标（forward:false）', async () => {
    popup.show({ key: 'k2', kind: 'msg', accId: 'a', chat: 'Lukas Weber', text: 'Guten Tag' });
    await wait(1500);
    popup.win.setIgnoreMouseEvents(true);
  });
  await scenario('E 弹窗关掉（窗口销毁）', async () => {
    popup.queue.removeWhere(() => true);
    popup.render();
    popup.closeWindow();
    await wait(300);
  });
  // F：主窗口不在前台时点一下
  const other = new BrowserWindow({ width: 300, height: 160, x: d.workArea.x + 400, y: d.workArea.y + d.workArea.height - 180, show: true, title: 'other' });
  await other.loadURL('data:text/html,other');
  for (const t of targets.slice(0, 4)) {
    other.focus(); await wait(400);
    const before = (await counts())[t.id] || 0;
    await click(t.x, t.y); await wait(150);
    const after = (await counts())[t.id] || 0;
    log(`  F 先点到别的窗口再回来点 ${after - before === 1 ? 'OK  ' : 'LOST'} ${t.id} ev=${(await evs(t.view)).join(' ')}`);
  }
  log(`\n合计 OK ${total.ok} LOST ${total.lost}`);
  if (ps) ps.stdin.end();
  app.exit(0);
});
