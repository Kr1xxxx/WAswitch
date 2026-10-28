// 选中文字后的「翻译」小按钮能调用的接口（只有这两个）。WhatsApp 页面拿不到这些。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seltr', {
  go: () => ipcRenderer.send('seltr:go'),
  hide: () => ipcRenderer.send('seltr:hide'),
});
