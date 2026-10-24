// 一键清理缓存：只清可以重新下载的东西，不碰登录状态和本地聊天记录。
//   清：HTTP 缓存、Cache Storage（WhatsApp Web 的 service worker 存程序文件的地方）、显卡着色器缓存、V8 代码缓存
//   不清：cookies、IndexedDB、localStorage、WebSQL、service worker 注册、文件系统（登录状态和本地消息库在这些里面）
const CLEAR_STORAGES = ['cachestorage', 'shadercache'];

async function clearSessionCache(ses) {
  await ses.clearCache();
  await ses.clearStorageData({ storages: CLEAR_STORAGES });
  if (typeof ses.clearCodeCaches === 'function') await ses.clearCodeCaches({});
}

module.exports = { CLEAR_STORAGES, clearSessionCache };
