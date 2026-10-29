// 报错说人话（src/errtext.js）：英文错误码换成中文，原话留着给“详细信息”
const assert = require('assert');
const E = require('../src/errtext');

const local = { host: '127.0.0.1', port: 7891 };
const remote = { host: '1.2.3.4', port: 8080 };
const zh = (s) => /[一-鿿]/.test(s) && !/ERR_|net::|fetch failed|Connection Closed/i.test(s);

// 归类
assert.equal(E.netKind('net::ERR_PROXY_CONNECTION_FAILED'), 'proxyDown');
assert.equal(E.netKind('ERR_SOCKS_CONNECTION_FAILED'), 'proxyDown');
assert.equal(E.netKind('ERR_TUNNEL_CONNECTION_FAILED'), 'proxyNode');
assert.equal(E.netKind('ERR_INTERNET_DISCONNECTED'), 'offline');
assert.equal(E.netKind('ERR_NAME_NOT_RESOLVED'), 'dns');
assert.equal(E.netKind('fetch failed; ENOTFOUND; getaddrinfo ENOTFOUND team.example.com'), 'dns');
assert.equal(E.netKind('ERR_CONNECTION_TIMED_OUT'), 'timeout');
assert.equal(E.netKind('Timed Out'), 'timeout');
assert.equal(E.netKind('Connection Closed'), 'reset');
assert.equal(E.netKind('net::ERR_CONNECTION_RESET'), 'reset');
assert.equal(E.netKind('ERR_CERT_DATE_INVALID'), 'cert');
assert.equal(E.netKind('something odd'), 'other');

// 走代理时：本机端口说 Clash，远程代理说代理服务器
const r1 = E.netReason('net::ERR_PROXY_CONNECTION_FAILED', { proxy: local });
assert(zh(r1) && r1.includes('7891') && r1.includes('Clash'), r1);
const r2 = E.netReason('net::ERR_PROXY_CONNECTION_FAILED', { proxy: remote });
assert(zh(r2) && r2.includes('1.2.3.4:8080') && !r2.includes('Clash'), r2);
assert(zh(E.netReason('ERR_TUNNEL_CONNECTION_FAILED', { proxy: local })));
assert(zh(E.netReason('ERR_INTERNET_DISCONNECTED')));
assert(zh(E.netReason('whatever English')));

// 查 IP 网站限流：不算代理坏了
assert(/限流/.test(E.ipinfoStatus(429)) && /通/.test(E.ipinfoStatus(429)));

// 原话：带上 fetch failed 的真正原因
const err = new TypeError('fetch failed');
err.cause = Object.assign(new Error('getaddrinfo ENOTFOUND x.example'), { code: 'ENOTFOUND' });
const raw = E.rawOf(err);
assert(raw.includes('fetch failed') && raw.includes('ENOTFOUND'), raw);

// friendly：中文原样，英文换掉、原话进 detail
assert.deepEqual(E.friendly(new Error('还没连上，暂时不能发送')), { text: '还没连上，暂时不能发送', detail: '' });
const f = E.friendly(new Error('net::ERR_CONNECTION_RESET'));
assert(zh(f.text) && f.detail === 'net::ERR_CONNECTION_RESET', JSON.stringify(f));

// 翻译：服务商的英文原话不进正文，写明是哪个服务商
const T = require('../src/translate');
assert.equal(T.statusError(401, 'OpenRouter').text, 'OpenRouter 的密钥不对或没有权限');
assert.equal(T.statusError(401, '智谱').text, '智谱的密钥不对或没有权限');
assert.equal(T.statusError(401).text, '服务商的密钥不对或没有权限');
assert.equal(T.statusError(429, '智谱').text, '智谱请求太频繁，请重试');
assert.equal(T.statusError(429, 'DeepL').text, 'DeepL 请求太频繁，请重试');

console.log('check-errtext: ok');

// 轻量号发消息：等 130 秒（Baileys 查设备、补会话各最多 60 秒），超时的错误带 code TIMEOUT，主进程据此提示“可能已经发出”
(async () => {
  const { LiteHost, SEND_TIMEOUT_MS } = require('../src/lite/host');
  assert.equal(SEND_TIMEOUT_MS, 130000);
  const host = new LiteHost({ dataDir: require('os').tmpdir() });
  host.directProc.sessions.set('1', {});
  host.directProc.send = () => {}; // 不启动后台进程，回复永远不来
  const real = global.setTimeout;
  const waits = [];
  global.setTimeout = (fn, ms, ...a) => { waits.push(ms); return real(fn, 0, ...a); }; // 到点立刻触发，记下要等多少毫秒
  let err;
  try { await host.sendText('1', '4915112345678@s.whatsapp.net', 'Hallo'); } catch (e) { err = e; } finally { global.setTimeout = real; }
  assert(err && err.code === 'TIMEOUT', '发送超时带 TIMEOUT');
  assert.deepEqual(waits, [SEND_TIMEOUT_MS]);
  assert.equal(host.directProc.pending.size, 0, '超时后不留在等待表里');
  console.log('check-errtext: lite send timeout ok');
})().catch((e) => { console.error(e); process.exit(1); });
