// basic_text 只做混淆，不能保护登录密钥、代理密码或设备令牌。
// 软件只发 Windows 和 macOS；下面的 Linux 判断只在开发机和 CI（Ubuntu）上起作用，保留是为了失败即关闭。
function canEncrypt(storage, platform = process.platform) {
  try {
    if (!storage || !storage.isEncryptionAvailable()) return false;
    if (platform === 'linux' && storage.getSelectedStorageBackend && storage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = { canEncrypt };
