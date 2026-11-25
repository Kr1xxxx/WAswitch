// 一直开着的 Electron：轮询 cmd-N.json，在原窗口和新开的窗口里各量一次，结果写 res-N.json
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const dir = process.argv[process.argv.length - 1];
const probeSrc = fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf8');
const PAGE = 'data:text/html,<!doctype html><meta charset=utf-8><body></body>';
async function run(win, spec) { return win.webContents.executeJavaScript(`(${probeSrc})(${JSON.stringify(spec)})`); }
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1400, height: 300 });
  await win.loadURL(PAGE);
  fs.writeFileSync(path.join(dir, 'ready'), String(process.versions.chrome));
  let n = 0; let busy = false;
  setInterval(async () => {
    if (busy) return;
    const f = path.join(dir, `cmd-${n}.json`);
    if (!fs.existsSync(f)) return;
    busy = true;
    const spec = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (spec.quit) { app.exit(0); return; }
    const out = {};
    try { out.samePage = await run(win, spec); } catch (e) { out.samePage = String(e); }
    try {
      const w2 = new BrowserWindow({ show: true, width: 1400, height: 300 });
      await w2.loadURL(PAGE);
      out.newWindow = await run(w2, spec);
      w2.destroy();
    } catch (e) { out.newWindow = String(e); }
    fs.writeFileSync(path.join(dir, `res-${n}.json`), JSON.stringify(out));
    n++; busy = false;
  }, 200);
});
app.on('window-all-closed', () => {});
