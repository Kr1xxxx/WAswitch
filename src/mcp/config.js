// MCP 设置和连接文件。
//   mcp.json        是否开启、端口（普通设置）
//   mcp-token.json  端口和 token，只有本人可读（0600）。stdio 桥接程序从这里读取。
//                   关闭 MCP 时删除，重新开启时换新 token。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomic } = require('../atomic');

const DEFAULT_PORT = 39393;
const TOKEN_FILE = 'mcp-token.json';

function settingsPath(dir) { return path.join(dir, 'mcp.json'); }
function tokenPath(dir) { return path.join(dir, TOKEN_FILE); }

function loadSettings(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(dir), 'utf8'));
    return {
      enabled: s.enabled === true,
      port: Number.isInteger(s.port) && s.port > 1024 && s.port < 65536 ? s.port : DEFAULT_PORT,
      layer2: s.layer2 === true, // 第二层：读对话列表，默认关
      preview: s.preview === true, // 第二层里是否允许读最后一条消息预览，默认关
      layer2Acknowledged: s.layer2Acknowledged === true, // 看过隐私提示
      drafts: s.drafts === true, // 起草回复：把 AI 写的回复放进输入框（不发送），默认关
      helpers: s.helpers === true, // 辅助工具：读话术、翻译文字、查客户当地时间，默认关
      customerEdit: s.customerEdit === true, // 修改客户资料（update_customer），默认关；改动记进 AI 操作记录，可撤销
    };
  } catch {
    return { enabled: false, port: DEFAULT_PORT, layer2: false, preview: false, layer2Acknowledged: false, drafts: false, helpers: false, customerEdit: false };
  }
}

function saveSettings(dir, settings) {
  const file = settingsPath(dir);
  writeJsonAtomic(file, settings, 2);
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// 先写临时文件再改名，保证其他程序读到的要么是旧的完整文件，要么是新的完整文件
function writeTokenFile(dir, { port, token }) {
  const file = tokenPath(dir);
  writeJsonAtomic(file, { url: `http://127.0.0.1:${port}/mcp`, port, token }, 2, { mode: 0o600 });
  return file;
}

function readTokenFile(dir) {
  try {
    const t = JSON.parse(fs.readFileSync(tokenPath(dir), 'utf8'));
    return typeof t.token === 'string' && t.token.length >= 32 ? t : null;
  } catch {
    return null;
  }
}

function removeTokenFile(dir) {
  try { fs.unlinkSync(tokenPath(dir)); } catch { /* 本来就没有 */ }
}

module.exports = { DEFAULT_PORT, TOKEN_FILE, tokenPath, loadSettings, saveSettings, newToken, writeTokenFile, readTokenFile, removeTokenFile };
