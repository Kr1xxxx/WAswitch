// 编辑页：直连网页号不显示时区下拉，标签写「跟随系统代理出口」；填了代理就出现下拉。
const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1000, height: 760, webPreferences: {
    preload: path.join(__dirname, 'fixtures/add-menu-fake-preload.js'), contextIsolation: false, sandbox: false,
  } });
  try {
    await win.loadFile(path.join(__dirname, '../src/shell/index.html'));
    const js = code => win.webContents.executeJavaScript(code);
    await js(`(() => {
      window.__editor = { id: 'a1', isNew: false, name: 'Emma', color: '#30a46c', proxy: '', hasPassword: false,
        region: 'US_W', regions: [{ key: 'auto', label: '跟随本机' }, { key: 'US_W', label: '美国（洛杉矶）' }, { key: 'HK', label: '香港' }],
        mode: 'web', primary: true, primaryName: 'Emma', otherDirect: [], otherLiteDirect: [], liteAvailable: true,
        platform: 'darwin', groups: [] };
      const old = window.wa;
      window.wa = new Proxy({}, { get: (_t, key) => (key === 'editorPorts' ? async () => [] : old[key]) });
      window.__cbs.state({ accounts: [], groups: [], activeId: null, page: 'editor', editorId: 'a1',
        editorNonce: 1, platform: 'darwin', collapsed: false, settings: {} });
      return true;
    })()`);
    await wait(150);
    const look = () => js(`({ hidden: document.querySelector('[aria-label="地区"]').hidden,
      tag: [...document.querySelectorAll('#content .tags .tag')].map((t) => t.textContent).find((t) => t.startsWith('时区')) })`);
    let r = await look();
    assert.equal(r.hidden, true, '直连网页号不显示时区下拉');
    assert.equal(r.tag, '时区：跟随系统代理出口');
    await js(`(() => { const i = document.querySelector('[aria-label="代理地址"]'); i.value = 'socks5://127.0.0.1:7891'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await wait(50);
    r = await look();
    assert.equal(r.hidden, false, '填了代理出现下拉');
    assert.equal(r.tag, '时区：美国（洛杉矶）');
    console.log('PASS: 直连网页号编辑页时区跟随系统代理出口');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
