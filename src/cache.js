// 一键清理缓存：只清可以重新下载的东西，不碰登录状态和本地聊天记录。
//   清：HTTP 缓存、显卡着色器缓存、V8 代码缓存
//   不清：cookies、IndexedDB、localStorage、WebSQL、service worker 注册、文件系统（登录状态和本地消息库在这些里面），
//   也不清 Cache Storage：WhatsApp 可能把程序文件或已下载的媒体放在这里，清掉后要重新下载
const CLEAR_STORAGES = ['shadercache'];

async function clearSessionCache(ses) {
  await ses.clearCache();
  await ses.clearStorageData({ storages: CLEAR_STORAGES });
  if (typeof ses.clearCodeCaches === 'function') await ses.clearCodeCaches({});
}

module.exports = { CLEAR_STORAGES, clearSessionCache };
