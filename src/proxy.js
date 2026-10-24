// 每个账号单独的代理。
//   socks5://127.0.0.1:7891          Clash 本地端口（推荐，DNS 也走代理）
//   http://127.0.0.1:7890
//   http://用户名:密码@1.2.3.4:8080  带密码的代理（Chromium 只支持 http 代理的密码验证）
// 留空表示直连。
//
// 安全原则：代理配置了就必须走代理。代理连不上时请求直接失败，绝不悄悄改成直连，
// 否则会在用户不知情的情况下暴露真实 IP。
const { net, safeStorage, session } = require('electron');

// 地址写错时用的“黑洞”代理：所有请求都会失败，而不是直连
const BLACKHOLE = 'socks5://127.0.0.1:9';

function parse(raw) {
  const text = (raw || '').trim();
  if (!text) return null;
  // 没写协议时不猜：Clash 说明里开的是 socks 端口，按 http 去连会一直失败，报错又看不出原因
  if (!text.includes('://')) return { error: `请写上代理类型，例如 socks5://${text}（Clash 的端口一般用 socks5://）` };
  let url;
  try { url = new URL(text); } catch { return { error: '代理地址格式不对' }; }
  const scheme = url.protocol.replace(':', '');
  if (!['http', 'https', 'socks4', 'socks5'].includes(scheme)) return { error: `不支持的代理类型：${scheme}` };
  if (!url.hostname || !url.port) return { error: '代理地址需要包含 IP 和端口，例如 socks5://127.0.0.1:7891' };
  const username = decodeURIComponent(url.username || '');
  const password = decodeURIComponent(url.password || '');
  if (scheme.startsWith('socks') && (username || password)) {
    return { error: 'socks 代理不支持用户名密码，请改用 http:// 代理，或在 Clash 里转成本地端口' };
  }
  return {
    scheme,
    host: url.hostname,
    port: Number(url.port),
    rules: `${scheme}://${url.hostname}:${url.port}`,
    username,
    password,
    // 保存到 accounts.json 的形式：不含密码
    display: `${scheme}://${username ? `${encodeURIComponent(username)}@` : ''}${url.hostname}:${url.port}`,
  };
}

// 密码用系统钥匙串（Windows DPAPI / macOS Keychain / Linux Secret Service）加密后再写盘
function encryptPassword(password) {
  if (!password) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('这台电脑不支持加密保存密码，请改用不带密码的代理');
  return safeStorage.encryptString(password).toString('base64');
}

function decryptPassword(enc) {
  if (!enc) return '';
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return ''; }
}

// 把代理应用到账号的会话。返回 { ok } 或 { error }，出错时会话被设成黑洞，不会直连。
async function apply(ses, raw) {
  const p = parse(raw);
  try {
    if (!p) {
      await ses.setProxy({ mode: 'direct' });
    } else if (p.error) {
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: BLACKHOLE });
      return { error: p.error };
    } else {
      // 规则里不写 DIRECT，代理不通时不会回落直连
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: p.rules, proxyBypassRules: '<local>' });
    }
    await ses.closeAllConnections();
    return { ok: true };
  } catch (e) {
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: BLACKHOLE }).catch(() => {});
    return { error: e.message };
  }
}

// 通过某个会话访问查询出口 IP 的网址，返回出口 IP、国家、时区
function queryExit(ses, onLogin) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url: 'https://ipinfo.io/json', session: ses, useSessionCookies: false });
    const timer = setTimeout(() => { req.abort(); reject(new Error('连接超时（10 秒）')); }, 10000);
    req.on('login', (authInfo, callback) => onLogin(authInfo, callback));
    req.on('response', (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { clearTimeout(timer); res.statusCode === 200 ? resolve(data) : reject(new Error(`HTTP ${res.statusCode}`)); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// 测试代理：通过它访问一个查询出口 IP 的网址，返回出口 IP、国家、时区。
// 用一个临时的内存会话，不影响任何账号。
// 所有测试共用一个临时分区，一次只跑一个，免得两个测试互相改代理、结果串号
let testQueue = Promise.resolve();
function test(raw, password) {
  const run = testQueue.then(() => testOnce(raw, password));
  testQueue = run.catch(() => {});
  return run;
}

async function testOnce(raw, password) {
  const p = parse(raw);
  if (!p) return { error: '没有填代理地址（直连无需测试）' };
  if (p.error) return { error: p.error };
  // 固定用一个内存分区，每次测试后清理
  const ses = session.fromPartition('proxytest', { cache: false });
  await ses.setProxy({ mode: 'fixed_servers', proxyRules: p.rules, proxyBypassRules: '<local>' });
  const started = Date.now();
  try {
    const body = await queryExit(ses, (authInfo, callback) => {
      if (authInfo.isProxy && p.username) callback(p.username, password || p.password);
      else callback();
    });
    const info = JSON.parse(body);
    return { ok: true, ip: info.ip, country: info.country, city: info.city, timezone: info.timezone, ms: Date.now() - started };
  } catch (e) {
    return { error: `代理连不上：${e.message}` };
  } finally {
    ses.clearStorageData().catch(() => {});
    ses.closeAllConnections().catch(() => {});
  }
}

// 查本机直连时的出口 IP（主号没设代理时，用来确认轻量小号和主号不在同一个 IP）。
// 只访问 ipinfo.io，不访问 WhatsApp。
async function testDirect() {
  const ses = session.fromPartition('proxytest-direct', { cache: false });
  await ses.setProxy({ mode: 'direct' });
  try {
    const info = JSON.parse(await queryExit(ses, (_a, callback) => callback()));
    return { ok: true, ip: info.ip, country: info.country };
  } catch (e) {
    return { error: e.message };
  } finally {
    ses.clearStorageData().catch(() => {});
    ses.closeAllConnections().catch(() => {});
  }
}

module.exports = { parse, apply, test, testDirect, encryptPassword, decryptPassword };
