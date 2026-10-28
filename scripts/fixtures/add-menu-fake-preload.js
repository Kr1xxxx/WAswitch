// 侧栏 + 号自检用：假的主进程接口。记下调用；addMenu 转给自检脚本的主进程去弹真的菜单
const { ipcRenderer } = require('electron');
window.__cbs = {};
window.__calls = [];
window.__editor = null;
window.wa = new Proxy({}, { get: (_t, k) => {
  if (k === 'onState') return (cb) => { window.__cbs.state = cb; };
  if (k === 'editorLoad') return async () => window.__editor;
  if (k === 'editorSave') return async (data) => { window.__calls.push(['editorSave', data]); return { ok: true }; };
  if (k === 'addMenu') return (x, y) => { window.__calls.push(['addMenu', x, y]); ipcRenderer.send('add:menu', { x, y }); };
  if (k === 'add') return () => window.__calls.push([k]);
  if (k === 'moveAccount') return (...a) => window.__calls.push([k, ...a]);
  if (k.startsWith('on')) return () => {};
  return async () => null;
} });
