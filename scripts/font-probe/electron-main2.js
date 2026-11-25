const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const dir = process.argv[process.argv.length - 1];
const url = fs.readFileSync(path.join(dir, 'url'), 'utf8');
const probeSrc = fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf8');
const run = (win, spec) => win.webContents.executeJavaScript(`(${probeSrc})(${JSON.stringify(spec)})`);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1400, height: 300 });
  await win.loadURL(url);
  fs.writeFileSync(path.join(dir, 'ready'), '1');
  let n = 0; let busy = false;
  setInterval(async () => {
    const f = path.join(dir, `cmd-${n}.json`);
    if (busy || !fs.existsSync(f)) return;
    busy = true;
    const { mode, spec } = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (mode === 'quit') app.exit(0);
    let out;
    try {
      if (mode === 'reload') { await win.loadURL(url); out = await run(win, spec); }
      else if (mode === 'new') { const w2 = new BrowserWindow({ show: true, width: 1400, height: 300 }); await w2.loadURL(url); out = await run(w2, spec); w2.destroy(); }
      else out = await run(win, spec);
    } catch (e) { out = String(e); }
    fs.writeFileSync(path.join(dir, `res-${n}.json`), JSON.stringify(out));
    n++; busy = false;
  }, 200);
});
app.on('window-all-closed', () => {});
