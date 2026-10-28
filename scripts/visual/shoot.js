// 组件总览页截图比对（由 scripts/check-visual.js 启动，一次一个缩放系数）。
// 每个 <section data-shot> 截一张，和 scripts/visual/baseline/<名字>-<缩放>x.png（不用 @2x 写法：Electron 会把它当成 2 倍图读，尺寸减半） 逐像素比；不一样就把实际图和差异图写到 VISUAL_OUT。
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const DSF = Number(process.env.VISUAL_DSF || 1);
// 字体配置必须是绝对路径：相对路径 fontconfig 找不到，会悄悄用回系统字体，出的图和 CI 不一样
if (!process.env.FONTCONFIG_FILE || !path.isAbsolute(process.env.FONTCONFIG_FILE)) {
  process.stderr.write('FONTCONFIG_FILE 要设成 scripts/visual/fonts.conf 的绝对路径（用 npm run check:visual 启动）\nVISUAL FAIL\n');
  process.exit(1);
}
// 升级 Electron（Chromium、Skia 跟着变）以后，字形和抗锯齿可能整体变一点：全部重出基准图（--update）再提交
const UPDATE = process.env.VISUAL_UPDATE === '1';
const OUT = process.env.VISUAL_OUT || '';
const BASE = path.join(__dirname, 'baseline');
// 一个像素算「变了」：任一通道差超过 TOL（抗锯齿的细小抖动不算）。一张图里变了的像素超过 MAX_PX 就算失败
const TOL = 3;
const MAX_PX = 0;

// 缩放系数写死；颜色按 sRGB；软件渲染（xvfb 下没有 GPU）
app.commandLine.appendSwitch('force-device-scale-factor', String(DSF));
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-lcd-text');
app.commandLine.appendSwitch('hide-scrollbars');
// 和 Chromium 自己的像素测试一样：Skia 不按 CPU 挑优化指令（CI 的机器和本机 CPU 不同），单线程光栅、整块重画，出图才稳定
app.commandLine.appendSwitch('disable-skia-runtime-opts');
app.commandLine.appendSwitch('num-raster-threads', '1');
app.commandLine.appendSwitch('disable-partial-raster');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const fail = (msg) => { process.stderr.write(`${msg}\n`); };

function compare(actual, expected) {
  const a = actual.getSize();
  const e = expected.getSize();
  if (a.width !== e.width || a.height !== e.height) return { sizeDiff: `${a.width}x${a.height}，基准 ${e.width}x${e.height}` };
  const A = actual.toBitmap();
  const E = expected.toBitmap();
  const D = Buffer.alloc(A.length);
  let n = 0;
  let box = null;
  for (let i = 0; i < A.length; i += 4) {
    const d = Math.max(Math.abs(A[i] - E[i]), Math.abs(A[i + 1] - E[i + 1]), Math.abs(A[i + 2] - E[i + 2]), Math.abs(A[i + 3] - E[i + 3]));
    if (d > TOL) {
      n++;
      const p = i / 4;
      const x = p % a.width;
      const y = Math.floor(p / a.width);
      box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
      // 差异图：变了的像素标红（BGRA）
      D[i] = 0; D[i + 1] = 0; D[i + 2] = 255; D[i + 3] = 255;
    } else {
      // 没变的像素淡成灰色底图，方便看出红点在哪个控件上
      const g = Math.round((E[i] + E[i + 1] + E[i + 2]) / 3 * 0.3 + 178);
      D[i] = g; D[i + 1] = g; D[i + 2] = g; D[i + 3] = 255;
    }
  }
  return { n, box, diff: D, size: a };
}

app.whenReady().then(async () => {
  const { nativeImage } = require('electron');
  let bad = 0;
  const w = new BrowserWindow({ show: true, width: 752, height: 900, useContentSize: true, frame: false, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    // xvfb-run 默认屏幕只有 640x480，窗口会被压小，截出来的图就不对
    const [cw, ch] = w.getContentSize();
    if (cw !== 752 || ch !== 900) throw new Error(`窗口只有 ${cw}x${ch}，屏幕太小。用 xvfb-run -a -s "-screen 0 1920x2000x24" 跑`);
    await w.loadFile(path.join(__dirname, 'components.html'));
    const js = (code) => w.webContents.executeJavaScript(code);
    // 等内置字体（含按需加载的 MiSans 分块）和图片都加载完
    await js(`(async () => { await document.fonts.ready; await Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))); await document.fonts.ready; return document.fonts.size; })()`);
    const missing = await js(`[...document.fonts].filter((f) => f.status === 'error').map((f) => f.family)`);
    if (missing.length) throw new Error(`字体没加载上：${missing.join(', ')}`);

    // 悬停、焦点用 CDP 强制，不靠真鼠标
    const dbg = w.webContents.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('DOM.enable');
    await dbg.sendCommand('CSS.enable');
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
    const { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-force]' });
    for (const nodeId of nodeIds) {
      const { attributes } = await dbg.sendCommand('DOM.getAttributes', { nodeId });
      const i = attributes.indexOf('data-force');
      const states = attributes[i + 1].split(/\s+/).filter(Boolean);
      await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: states });
    }

    const shots = await js(`[...document.querySelectorAll('section[data-shot]')].map((s) => s.dataset.shot)`);
    if (!shots.length) throw new Error('组件总览页里没有 section[data-shot]');
    for (const name of shots) {
      // 滚到这一块，等两帧再截，保证画完
      const r = await js(`(() => { const s = document.querySelector('section[data-shot="${name}"]'); s.scrollIntoView({ block: 'start' }); const b = s.getBoundingClientRect(); return { px: Math.round(b.left + scrollX), py: Math.round(b.top + scrollY), width: Math.round(b.width), height: Math.round(b.height), vh: innerHeight }; })()`);
      if (r.height > r.vh) throw new Error(`「${name}」这块高 ${r.height}px，超过窗口 ${r.vh}px，拆成两块`);
      // 用 CDP 截图（按页面坐标）：它会等这一帧真的画完。capturePage 冷启动时偶尔拿到上一帧（还没滚动、悬停没画上）
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: r.px, y: r.py, width: r.width, height: r.height, scale: 1 } });
      const img = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
      const file = path.join(BASE, `${name}-${DSF}x.png`);
      if (UPDATE) {
        fs.writeFileSync(file, img.toPNG());
        process.stdout.write(`已更新 ${path.relative(process.cwd(), file)}\n`);
        continue;
      }
      if (!fs.existsSync(file)) { bad++; fail(`✗ ${name}-${DSF}x：没有基准图。跑 npm run check:visual -- --update 生成`); continue; }
      const res = compare(img, nativeImage.createFromBuffer(fs.readFileSync(file)));
      const save = () => {
        if (!OUT) return;
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, `${name}-${DSF}x.actual.png`), img.toPNG());
        fs.copyFileSync(file, path.join(OUT, `${name}-${DSF}x.expected.png`));
        if (res.diff) fs.writeFileSync(path.join(OUT, `${name}-${DSF}x.diff.png`), nativeImage.createFromBitmap(res.diff, res.size).toPNG());
      };
      if (res.sizeDiff) { bad++; fail(`✗ ${name}-${DSF}x：尺寸变了，现在 ${res.sizeDiff}`); save(); continue; }
      if (res.n > MAX_PX) {
        bad++;
        const b = res.box;
        fail(`✗ ${name}-${DSF}x：${res.n} 个像素不一样，范围 x ${b.x0}–${b.x1}、y ${b.y0}–${b.y1}（设备像素）`);
        save();
        continue;
      }
      process.stdout.write(`✓ ${name}-${DSF}x\n`);
    }
  } catch (e) {
    bad++;
    fail(`✗ ${e && e.stack || e}`);
  }
  // 结果写在 stderr 最后一行，runner 看这一行判断（Electron 窗口意外退出时进程码也可能是 0）
  fail(bad ? `VISUAL FAIL ${bad}` : 'VISUAL PASS');
  app.exit(bad ? 1 : 0);
});
