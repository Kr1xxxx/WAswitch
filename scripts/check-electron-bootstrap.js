// Test-only entry point: isolate Electron data and restore the user's clipboard.
const fs = require('node:fs');
const path = require('node:path');
const { app, clipboard, ClipboardItem } = require('electron');
const profile = process.env.WASWITCH_TEST_PROFILE;
if (!profile || !fs.existsSync(profile)) throw new Error('Missing isolated test profile');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.disableHardwareAcceleration();
app.disableHardwareAcceleration = () => {}; // Fixture scripts repeat this; it was applied before readiness.
const originalExit = app.exit.bind(app);
let exiting = false;
app.whenReady().then(async () => {
  const saved = [];
  for (const item of await clipboard.read()) {
    const formats = {};
    for (const type of item.types) formats[type] = await item.getType(type);
    saved.push(new ClipboardItem(formats));
  }
  app.exit = code => {
    if (exiting) return;
    exiting = true;
    (async () => {
      try { if (saved.length) await clipboard.write(saved); else clipboard.clear(); }
      catch { console.error('Test clipboard restoration failed'); code = 1; }
      originalExit(code);
    })();
  };
  require(path.resolve(process.argv.at(-1)));
}).catch(error => { console.error(error); originalExit(1); });
