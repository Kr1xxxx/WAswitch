// basic_text 只做混淆，不能保护登录密钥、代理密码或设备令牌。
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
