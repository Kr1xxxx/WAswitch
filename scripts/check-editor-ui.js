// Actual editor renderer with synthetic IPC: stale tests must not authorize saving.
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
      window.__editor = { id: null, isNew: true, name: 'Synthetic lite', color: '#30a46c',
        proxy: 'http://tester@127.0.0.1:8080', hasPassword: false, region: 'auto',
        regions: [{ key: 'auto', label: '自动' }], mode: 'lite', primary: false,
        primaryName: 'Synthetic primary', otherDirect: [], otherLiteDirect: [], liteAvailable: true,
        platform: 'darwin', groups: [] };
      const old = window.wa;
      window.wa = new Proxy({}, { get: (_target, key) => {
        if (key === 'editorTest') return () => new Promise(resolve => { window.resolveTest = resolve; });
        if (key === 'editorPorts') return async () => [];
        return old[key];
      } });
      window.__cbs.state({ accounts: [], groups: [], activeId: null, page: 'editor', editorId: null,
        editorNonce: 1, platform: 'darwin', collapsed: false, settings: {} });
      return true;
    })()`);
    await wait(150);
    await js(`(() => {
      window.testButton = () => document.querySelector('#content [data-morph^="editorTest:"]');
      window.saveButton = () => [...document.querySelectorAll('#content button')].find(b => b.textContent.startsWith('保存'));
      window.editPassword = value => { const input = document.querySelector('[aria-label="代理密码"]'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
      document.querySelector('.lite-risk input').checked = true;
      window.goodTest = { ok: true, ip: '192.0.2.1', country: 'TEST', ms: 1 };
      return true;
    })()`);
    // Find by stable existing morph class; includes the success label after a completed run.
    await js("testButton().click(); editPassword('changed-in-flight'); resolveTest(goodTest); true");
    await wait(800);
    assert.equal(await js("!!document.querySelector('#content .note.ok')"), false, 'late result must not be displayed');
    await js('saveButton().click(); true'); await wait(30);
    assert.equal(await js("window.__calls.filter(c => c[0] === 'editorSave').length"), 0, 'late result cannot permit save');
    await js("testButton().click(); resolveTest(goodTest); true"); await wait(800);
    assert.equal(await js("!!document.querySelector('#content .note.ok')"), true);
    await js("editPassword('changed-after-success'); saveButton().click(); true"); await wait(30);
    assert.equal(await js("!!document.querySelector('#content .note.ok')"), false);
    assert.equal(await js("window.__calls.filter(c => c[0] === 'editorSave').length"), 0);
    console.log('PASS 4: actual editor invalidates password edits and ignores late test responses');
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
