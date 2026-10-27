// 每个账号单独的代理。
//   socks5://127.0.0.1:7891          Clash 本地端口（推荐，DNS 也走代理）
//   http://127.0.0.1:7890
//   http://用户名:密码@1.2.3.4:8080  带密码的代理（Chromium 只支持 http 代理的密码验证）
// 留空表示直连：网页号跟随电脑的系统代理（Clash 开系统代理时走 Clash，关了就是本机网络）。
//
// 安全原则：代理配置了就必须走代理。代理连不上时请求直接失败，绝不悄悄改成直连，
// 否则会在用户不知情的情况下暴露真实 IP。
const { net, safeStorage, session } = require('electron');
const { canEncrypt } = require('./secure-storage');
const errtext = require('./errtext');
const { parse, passwordPlan, keepOldPassword } = require('./proxy-parse');

// 地址写错时用的“黑洞”代理：所有请求都会失败，而不是直连
const BLACKHOLE = 'socks5://127.0.0.1:9';

// 密码用系统钥匙串（Windows DPAPI / macOS Keychain）加密后再写盘
function encryptPassword(password) {
  if (!password) return '';
  if (!canEncrypt(safeStorage)) throw new Error('系统没有安全钥匙环，不能保存代理密码');
  return safeStorage.encryptString(password).toString('base64');
}

function decryptPassword(enc) {
  if (!enc) return '';
  if (!canEncrypt(safeStorage)) return '';
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return ''; }
}

// 候选账号必须先按请求所属 session 筛选。无法归属的后台请求仅在凭据完全一致时放行。
function credentialsFor(authInfo, accounts) {
  const choices = new Map();
  for (const acc of accounts) {
    const p = parse(acc.proxy);
    if (!p || p.error || !p.username || p.host !== authInfo.host || p.port !== authInfo.port) continue;
    if (acc.proxyPassword && !canEncrypt(safeStorage)) return null;
    const password = decryptPassword(acc.proxyPassword);
    if (acc.proxyPassword && !password) return null;
    const value = { username: p.username, password };
    choices.set(JSON.stringify(value), value);
  }
  return choices.size === 1 ? [...choices.values()][0] : null;
}

// 把代理应用到账号的会话。返回 { ok } 或 { error }，出错时会话被设成黑洞，不会直连。
async function apply(ses, raw) {
  const p = parse(raw);
  try {
    if (!p) {
      // 直连号跟随系统代理：Clash 只开“系统代理”（没开 TUN）时也能连上 WhatsApp
      await ses.setProxy({ mode: 'system' });
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
      res.on('end', () => { clearTimeout(timer); res.statusCode === 200 ? resolve(data) : reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

function parseExit(body) {
  try { return JSON.parse(body); } catch { throw Object.assign(new Error(`ipinfo 返回的不是 JSON：${String(body).slice(0, 80)}`), { bad: true }); }
}

// 测出口失败：中文说明 + 原话（放进“详细信息”）。原话不带代理密码
function exitError(e, p) {
  const raw = errtext.rawOf(e);
  if (e && e.status) return { error: errtext.ipinfoStatus(e.status), detail: raw };
  if (e && e.bad) return { error: '查 IP 的网站返回的内容不对，过一会儿再测', detail: raw };
  if (errtext.hasChinese(raw)) return { error: p ? `代理连不上：${raw}` : raw };
  return { error: errtext.netReason(raw, { proxy: p }), detail: p ? `${raw} · ${p.rules}` : raw };
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
    const info = parseExit(body);
    return { ok: true, ip: info.ip, country: info.country, city: info.city, timezone: info.timezone, ms: Date.now() - started };
  } catch (e) {
    return exitError(e, p);
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
    const info = parseExit(await queryExit(ses, (_a, callback) => callback()));
    return { ok: true, ip: info.ip, country: info.country };
  } catch (e) {
    return exitError(e, null);
  } finally {
    ses.clearStorageData().catch(() => {});
    ses.closeAllConnections().catch(() => {});
  }
}

// 测试/连接时实际要用的明文密码：按 passwordPlan 决定，沿用旧密码时才解密已保存的那份
function passwordFor(oldRaw, oldEnc, newRaw, typed) {
  const plan = passwordPlan(oldRaw, newRaw, typed);
  if (plan.kind === 'new') return plan.password;
  if (plan.kind === 'old') return decryptPassword(oldEnc);
  return '';
}

module.exports = { parse, passwordPlan, keepOldPassword, passwordFor, apply, test, testDirect, encryptPassword, decryptPassword, credentialsFor };

