// 选中文字后的「翻译」按钮 / 悬浮译文窗能调用的接口（只有这几个）。WhatsApp 页面拿不到这些。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seltr', {
  onState: (cb) => ipcRenderer.on('seltr:state', (_e, st) => cb(st)),
  ready: () => ipcRenderer.send('seltr:ready'),
  go: () => ipcRenderer.send('seltr:go'),
  retry: () => ipcRenderer.send('seltr:retry'),
  copy: (text) => ipcRenderer.invoke('seltr:copy', typeof text === 'string' ? text : ''),
  size: (h) => ipcRenderer.send('seltr:size', Number(h) || 0),
  hide: () => ipcRenderer.send('seltr:hide'),
  // 气泡译文的编辑小窗（mode tr）：改哪一条由主进程记着，这里只传文字
  trSave: (text) => ipcRenderer.send('seltr:tr-save', typeof text === 'string' ? text : ''),
  trFix: (text) => ipcRenderer.send('seltr:tr-fix', typeof text === 'string' ? text : ''),
  trTake: (yes) => ipcRenderer.send('seltr:tr-take', yes === true),
  trDraft: (text) => ipcRenderer.send('seltr:tr-draft', typeof text === 'string' ? text : ''),
  trKey: () => ipcRenderer.send('seltr:tr-key'),
});
