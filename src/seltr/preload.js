// 选中文字后的「翻译」按钮 / 悬浮译文窗能调用的接口（只有这几个）。WhatsApp 页面拿不到这些。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seltr', {
  onState: (cb) => ipcRenderer.on('seltr:state', (_e, st) => cb(st)),
  ready: () => ipcRenderer.send('seltr:ready'),
  go: () => ipcRenderer.send('seltr:go'),
  retry: () => ipcRenderer.send('seltr:retry'),
  copy: (text) => ipcRenderer.send('seltr:copy', typeof text === 'string' ? text : ''),
  size: (h) => ipcRenderer.send('seltr:size', Number(h) || 0),
  hide: () => ipcRenderer.send('seltr:hide'),
});
