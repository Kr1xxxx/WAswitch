// 临时：在 Windows 上用真注册表、真字体目录、真清单（本分支的 remote/ui-fonts.json）跑 src/ui-fonts.js
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { UiFonts, electronFetcher } = require('../../src/ui-fonts');
const out = (m) => fs.writeSync(1, m + '\n');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let now = Date.now();
  const mk = () => new UiFonts({ userData: app.getPath('userData'), enrolled: () => true, idleSeconds: () => 9999, now: () => now,
    fetch: electronFetcher(session.fromPartition('waswitch-fonts', { cache: false })),
    manifestUrl: 'https://raw.githubusercontent.com/Kr1xxxx/WAswitch/claude/project-thread-ex4h1e/remote/ui-fonts.json', log: out });
  const f = mk();
  let t = Date.now();
  out('first: ' + JSON.stringify(await f.tick()) + ` ${(Date.now() - t) / 1000}s`);
  out('installed: ' + JSON.stringify(f.installed()));
  out(execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts']).toString());
  out(fs.readdirSync(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')).join(' | '));
  now += 25 * 3600 * 1000;
  t = Date.now();
  out('second: ' + JSON.stringify(await mk().tick()) + ` ${(Date.now() - t) / 1000}s`);
  const w = new BrowserWindow({ show: true });
  await w.loadURL('data:text/html,<body></body>');
  out('local(): ' + await w.webContents.executeJavaScript(`Promise.all(['OPPO Sans 4.0 Regular','Noto Serif SC Bold'].map(n => new FontFace('x'+n.length, 'local("'+n+'")', {weight:'100 900'}).load().then(()=>n+' ok', e=>n+' '+e.name))).then(a=>a.join(', '))`));
  app.exit(0);
}).catch((e) => { out('E2E FAIL ' + (e && e.stack || e)); app.exit(1); });
