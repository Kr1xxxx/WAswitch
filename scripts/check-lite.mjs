// 轻量模式离线自检（不需要联网，也不需要 WhatsApp 账号）。
// 运行：npm run check:lite
//
// 用本机假代理（socks5 和 http）代替真代理，再把 DNS 和网络连接打桩记录，证明：
//   1. WebSocket 和 HTTP 下载都只连代理，域名交给代理解析（本机不查 WhatsApp 的域名）
//   2. 绕过代理的请求会被网络护栏拦下，不会直连
//   3. 代理不通时不改用直连
//   4. 凭据加密写盘，换密钥读不出来
//   5. 每分钟最多发 10 条；只在打开对话时发已读回执
//   6. 被退出登录或拒绝连接后不再重连
//   7. 聊天里的链接只放行 http、https、mailto、tel
//   8. 代码里没有调用 fetchLatestBaileysVersion / fetchLatestWaWebVersion
import net from 'node:net';
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  return false;
}

// ---------- 网络护栏 + 打桩 ----------
const { installGuard, setAllowedHosts } = await import('../src/lite/guard.mjs');
let deliberate = false; // 第 3 步故意发起的测试请求不计入汇总
const blocked = [];
installGuard((b) => blocked.push({ ...b, deliberate }));
setAllowedHosts(['127.0.0.1']);

// 在护栏外面再包一层，记录所有“尝试”过的 DNS 查询和连接
const lookups = [];
const guardedLookup = dns.lookup;
dns.lookup = function (hostname, ...rest) { if (!deliberate) lookups.push(String(hostname)); return guardedLookup.call(this, hostname, ...rest); };
const plookup = dns.promises.lookup;
dns.promises.lookup = function (hostname, ...rest) { lookups.push(String(hostname)); return plookup.call(this, hostname, ...rest); };
const connects = [];
const guardedConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  if (o && typeof o === 'object' && !o.path) connects.push(`${o.host || 'localhost'}:${o.port}`);
  return guardedConnect.apply(this, args);
};

// ---------- 假代理 ----------
// socks5：记录要连的目标，然后回复“拒绝连接”，什么都不转发
function fakeSocks() {
  const seen = [];
  const server = net.createServer((c) => {
    let stage = 0;
    c.on('error', () => {});
    c.on('data', (d) => {
      if (stage === 0) { stage = 1; c.write(Buffer.from([5, 0])); return; }
      const atyp = d[3];
      let host;
      let off;
      if (atyp === 3) { const len = d[4]; host = d.subarray(5, 5 + len).toString(); off = 5 + len; seen.push({ host, type: 'domain', port: d.readUInt16BE(off) }); }
      else if (atyp === 1) { host = [...d.subarray(4, 8)].join('.'); off = 8; seen.push({ host, type: 'ip', port: d.readUInt16BE(off) }); }
      else { seen.push({ host: '?', type: 'other' }); }
      c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}
// http 代理：记录 CONNECT 的目标，回复 403
function fakeHttpProxy() {
  const seen = [];
  const server = net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', (d) => {
      const m = /^CONNECT ([^ ]+) /.exec(d.toString());
      seen.push(m ? m[1] : d.toString().split('\r\n')[0]);
      c.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

const { Session, SEND_LIMIT } = await import('../src/lite/session.mjs');
const { makeTransport } = await import('../src/lite/transport.mjs');
const { readSealed, writeSealed, makeAuthState } = await import('../src/lite/vault.mjs');
const { textOf } = await import('../src/lite/store.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waswitch-lite-'));
const newKey = () => crypto.randomBytes(32).toString('hex');
const events = [];
const post = (m) => events.push(m);
const statusOf = (id) => [...events].reverse().find((e) => e.type === 'state' && e.id === id)?.status;
const isWa = (h) => /whatsapp|facebook|fbcdn|github/i.test(h);

try {
  // 1. 真实的 Baileys 连接，经 socks5 代理
  const socks = await fakeSocks();
  const s1 = new Session({ id: '1', proxy: `socks5h://127.0.0.1:${socks.port}`, dir: path.join(tmp, '1'), key: newKey(), os: 'win32' }, post);
  await s1.start();
  const sawWs = await until(() => socks.seen.some((x) => x.host === 'web.whatsapp.com'));
  s1.stop();
  check('WebSocket 经 socks5 代理连接 web.whatsapp.com', sawWs, JSON.stringify(socks.seen.slice(0, 2)));
  check('域名交给代理解析（socks5h，不是 IP）', socks.seen.length > 0 && socks.seen.every((x) => x.type === 'domain'));

  // 2. HTTP 下载（历史同步、聊天记录同步包）经代理
  const t = makeTransport(`socks5h://127.0.0.1:${socks.port}`);
  const before = socks.seen.length;
  const r1 = await fetch('https://mmg.whatsapp.net/v/t62/test', { dispatcher: t.dispatcher }).then(() => 'ok', (e) => String(e.cause?.message || e.message));
  check('HTTP 下载经 socks5 代理（mmg.whatsapp.net）', socks.seen.slice(before).some((x) => x.host === 'mmg.whatsapp.net' && x.type === 'domain'), r1);

  // 3. 不带代理的请求被护栏拦下（这一步的请求都是故意发起的）
  deliberate = true;
  const b0 = blocked.length;
  const r2 = await fetch('https://mmg.whatsapp.net/direct').then(() => 'ok', (e) => String(e.cause?.code || e.cause?.message || e.message));
  check('绕过代理的 fetch 被网络护栏拦下', r2 !== 'ok' && blocked.slice(b0).some((b) => b.host.startsWith('mmg.whatsapp.net')), r2);
  const r3 = await new Promise((resolve) => {
    const sock = net.connect({ host: '157.240.0.53', port: 443 });
    sock.once('connect', () => { sock.destroy(); resolve('connected'); });
    sock.once('error', (e) => resolve(e.code));
  });
  check('直接连 IP 被网络护栏拦下', r3 === 'EWASWITCHBLOCKED', r3);
  const r4 = await new Promise((resolve) => dns.lookup('web.whatsapp.com', (e) => resolve(e ? e.code : 'resolved')));
  check('本机 DNS 查询 WhatsApp 域名被拦下', r4 === 'EWASWITCHBLOCKED', r4);
  const { createSocket } = await import('node:dgram');
  let udp = 'allowed';
  try { createSocket('udp4'); } catch (e) { udp = e.code; }
  check('UDP 被禁用', udp === 'EWASWITCHBLOCKED', udp);
  const dgramMod = (await import('node:dgram')).default;
  let udp2 = 'allowed';
  try { new dgramMod.Socket('udp4'); } catch (e) { udp2 = e.code; }
  check('直接 new dgram.Socket() 也被禁用', udp2 === 'EWASWITCHBLOCKED', udp2);
  const r5 = await new Promise((resolve) => new dns.Resolver().resolve4('web.whatsapp.com', (e) => resolve(e ? e.code : 'resolved')));
  const r6 = await new dns.promises.Resolver().resolve4('web.whatsapp.com').then(() => 'resolved', (e) => e.code);
  const r7 = await new Promise((resolve) => dns.reverse('157.240.0.53', (e) => resolve(e ? e.code : 'resolved')));
  check('dns.Resolver 实例的查询被拦下（c-ares 自己发 UDP）', r5 === 'EWASWITCHBLOCKED' && r6 === 'EWASWITCHBLOCKED', `${r5} / ${r6}`);
  check('dns.reverse 被拦下', r7 === 'EWASWITCHBLOCKED', r7);
  const cp = await import('node:child_process');
  const wt = await import('node:worker_threads');
  const tries = {
    spawn: () => cp.spawn('curl', ['https://web.whatsapp.com']),
    exec: () => cp.exec('curl https://web.whatsapp.com'),
    execFileSync: () => cp.execFileSync('curl'),
    fork: () => cp.default.fork('x.js'),
    Worker: () => new wt.Worker('setTimeout(()=>{},1)', { eval: true }),
  };
  const notBlocked = Object.entries(tries).filter(([, fn]) => { try { fn(); return true; } catch (e) { return e.code !== 'EWASWITCHBLOCKED'; } }).map(([n]) => n);
  check('子进程和新线程一律禁止（里面没有护栏）', !notBlocked.length, notBlocked.join(', '));

  deliberate = false;

  // 4. http 代理
  const hp = await fakeHttpProxy();
  const s2 = new Session({ id: '2', proxy: `http://127.0.0.1:${hp.port}`, dir: path.join(tmp, '2'), key: newKey(), os: 'darwin' }, post);
  await s2.start();
  const sawHttp = await until(() => hp.seen.some((x) => x.startsWith('web.whatsapp.com:443')));
  s2.stop();
  check('WebSocket 经 http 代理 CONNECT web.whatsapp.com:443', sawHttp, hp.seen.slice(0, 2).join(', '));

  // 5. 代理不通：不直连，进入重试
  const closed = await new Promise((resolve) => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const { port } = sv.address(); sv.close(() => resolve(port)); }); });
  const s3 = new Session({ id: '3', proxy: `socks5h://127.0.0.1:${closed}`, dir: path.join(tmp, '3'), key: newKey(), os: 'win32' }, post);
  await s3.start();
  const proxyDown = statusOf('3') === 'proxyDown';
  s3.stop();
  check('代理不通时显示“代理连不上”并等待重试，不改用直连', proxyDown, statusOf('3'));

  // 汇总：真实连接过程里没有任何直连和本机 DNS
  check('全程没有尝试查询 WhatsApp 相关域名', !lookups.some(isWa), lookups.filter(isWa).join(', '));
  const nonProxy = connects.filter((c) => !c.startsWith('127.0.0.1:'));
  const expected = ['mmg.whatsapp.net:443', '157.240.0.53:443']; // 上面第 3 步故意发起、并被拦下的两次
  check('除了故意测试的两次，全程只连过本机代理', nonProxy.every((c) => expected.includes(c)), nonProxy.join(', '));
  const unexpected = blocked.filter((b) => !b.deliberate);
  check('真实连接过程中护栏没有拦到任何请求（说明全程走代理）', !unexpected.length, JSON.stringify(unexpected));
  socks.server.close();
  hp.server.close();

  // 6. 加密写盘
  const key = crypto.randomBytes(32);
  const file = path.join(tmp, 'sealed.enc');
  writeSealed(file, key, { secret: 'PLAINTEXT-MARKER', buf: Buffer.from('abc') });
  const raw = fs.readFileSync(file);
  check('写盘内容是密文', !raw.includes('PLAINTEXT-MARKER'));
  const back = readSealed(file, key);
  check('用正确密钥能读回（包括二进制数据）', back.secret === 'PLAINTEXT-MARKER' && Buffer.isBuffer(back.buf) && back.buf.toString() === 'abc');
  let wrong = 'read';
  try { readSealed(file, crypto.randomBytes(32)); } catch { wrong = 'refused'; }
  check('换一个密钥读不出来', wrong === 'refused');
  if (process.platform !== 'win32') check('文件权限只有本人可读写（0600）', (fs.statSync(file).mode & 0o777) === 0o600);
  const authDir = path.join(tmp, 'auth');
  const a = makeAuthState(authDir, key, () => {});
  await a.state.keys.set({ 'pre-key': { 1: { public: Buffer.from('x'), private: Buffer.from('y') } } });
  check('Signal 密钥防抖：修改后不立刻写盘', !fs.existsSync(path.join(authDir, 'auth.enc')));
  a.flush();
  check('密钥在 flush 时写盘', fs.existsSync(path.join(authDir, 'auth.enc')));
  const credDir = path.join(tmp, 'cred');
  const c = makeAuthState(credDir, key, () => {});
  c.state.creds.registered = true;
  c.saveCreds();
  check('登录凭据（creds）一变就立即写盘', fs.existsSync(path.join(credDir, 'auth.enc')) && readSealed(path.join(credDir, 'auth.enc'), key).creds.registered === true);
  const a2 = makeAuthState(authDir, key, () => {});
  const got = await a2.state.keys.get('pre-key', ['1']);
  check('重新打开后凭据还在', got['1'] && got['1'].private.toString() === 'y');
  let corrupt = 'opened';
  fs.writeFileSync(path.join(authDir, 'auth.enc'), 'garbage-garbage-garbage-garbage-garbage');
  try { makeAuthState(authDir, key, () => {}); } catch { corrupt = 'refused'; }
  check('凭据文件损坏时报错，不当成新号覆盖', corrupt === 'refused');

  // 7. 用假的 WhatsApp 连接测试发送限速、已读回执、断线处理
  const fake = () => {
    const sock = { ev: new EventEmitter(), sent: [], reads: [], ended: false };
    sock.sendMessage = async (jid, content) => { sock.sent.push({ jid, content }); };
    sock.readMessages = async (keys) => { sock.reads.push(keys); };
    sock.groupFetchAllParticipating = async () => ({});
    sock.end = () => { sock.ended = true; };
    sock.logout = async () => {};
    return sock;
  };
  const socks2 = await fakeSocks(); // 只用来让启动前的端口探测通过
  let last;
  const s4 = new Session({ id: '4', proxy: `socks5h://127.0.0.1:${socks2.port}`, dir: path.join(tmp, '4'), key: newKey(), os: 'win32' }, post, {
    makeSocket: (config) => { last = fake(); last.config = config; return last; },
  });
  await s4.start();
  const cfg = last.config;
  check('不在上线时发“在线”状态', cfg.markOnlineOnConnect === false);
  check('不请求全部历史记录', cfg.syncFullHistory === false);
  check('WebSocket 和 HTTP 都设置了代理', !!cfg.agent && !!cfg.fetchAgent && !!cfg.options?.dispatcher);
  check('没有指定 version（用 Baileys 内置版本，不联网查询）', cfg.version === undefined);
  check('设备标识跟随本机系统（Windows → Windows）', Array.isArray(cfg.browser) && cfg.browser[0] === 'Windows');
  const sock4 = last;
  sock4.ev.emit('connection.update', { connection: 'open' });
  const jid = '10000000001@s.whatsapp.net';
  sock4.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: jid, id: 'M1', fromMe: false }, message: { conversation: '你好' }, messageTimestamp: 1700000000, pushName: '测试' }] });
  await sleep(10);
  check('收到消息时不自动发已读回执', sock4.reads.length === 0);
  await s4.read(jid);
  check('打开对话时才发已读回执', sock4.reads.length === 1 && sock4.reads[0][0].id === 'M1');
  let sentOk = 0;
  let limited = '';
  for (let i = 0; i < SEND_LIMIT + 1; i++) {
    try { await s4.send(jid, `第 ${i + 1} 条`); sentOk++; } catch (e) { limited = e.message; }
  }
  check(`每分钟最多发 ${SEND_LIMIT} 条`, sentOk === SEND_LIMIT && /太快/.test(limited), `${sentOk} 条，${limited}`);
  let unknown = '';
  try { await s4.send('20000000002@s.whatsapp.net', 'hi'); } catch (e) { unknown = e.message; }
  check('不能给没有对话的号码发消息', /已有的对话/.test(unknown), unknown);

  // 被退出登录：删凭据，不重连
  s4.auth.flush();
  sock4.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await sleep(20);
  check('被退出登录（401）后不再重连，并删掉本机凭据', statusOf('4') === 'loggedOut' && !s4.retryTimer && !fs.existsSync(path.join(tmp, '4', 'auth.enc')));
  let outMsg = '';
  try { await s4.send(jid, 'hi'); } catch (e) { outMsg = e.message; }
  check('退出登录后发消息提示重新扫码（不是报错）', /重新扫码/.test(outMsg), outMsg);
  await s4.read(jid);
  await s4.start();
  const sock5 = last;
  sock5.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 403 } } } });
  await sleep(20);
  check('被拒绝连接（403，可能被封）后不再重连', statusOf('4') === 'banned' && !s4.retryTimer);
  await s4.start();
  last.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await sleep(20);
  check('普通断线会自动重连', statusOf('4') === 'reconnecting' && !!s4.retryTimer);
  // 网络类断开连续很多次：一直重连，不放弃
  for (let i = 0; i < 9; i++) {
    clearTimeout(s4.retryTimer);
    await s4.start();
    last.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: i % 2 ? 408 : 428 } } } });
    await sleep(10);
  }
  check('网络类断开（408、428）连续 10 次仍然继续重连', statusOf('4') === 'reconnecting' && !!s4.retryTimer, statusOf('4'));
  s4.attempt = 30;
  s4.scheduleRetry();
  const retryMs = s4.retryTimer._idleTimeout;
  check('重连间隔最长 5 分钟', retryMs === 5 * 60 * 1000, String(retryMs));
  // 会话坏了（500）连续 5 次：停止重连
  for (let i = 0; i < 5; i++) {
    clearTimeout(s4.retryTimer);
    await s4.start();
    last.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
    await sleep(10);
  }
  check('会话错误（500）连续 5 次后停止重连', statusOf('4') === 'stuck', statusOf('4'));
  s4.stop();
  socks2.server.close();

  // 8. 消息显示
  check('文字消息原样显示', textOf({ conversation: 'hi' }) === 'hi');
  check('图片显示成 [图片] 加说明', textOf({ imageMessage: { caption: 'c' } }) === '[图片] c');
  check('表情回应不算一条消息', textOf({ reactionMessage: { text: '👍' } }) === null);

  // 9. 链接白名单
  const { isSafeLink } = require(path.join(root, 'src', 'links.js'));
  check('链接放行 http/https/mailto/tel', ['http://a.com', 'https://a.com', 'mailto:a@b.c', 'tel:+123'].every(isSafeLink));
  check('链接拒绝 file/javascript/自定义协议', !['file:///etc/passwd', 'javascript:alert(1)', 'whatsapp://send', 'smb://x/y', 'notaurl'].some(isSafeLink));

  // 10. 代码里没有联网查询版本号
  const liteSrc = fs.readdirSync(path.join(root, 'src', 'lite')).map((f) => fs.readFileSync(path.join(root, 'src', 'lite', f), 'utf8')).join('\n');
  check('轻量模式代码没有调用 fetchLatest…Version', !/fetchLatest\w*Version\s*\(/.test(liteSrc));
  const socketSrc = fs.readdirSync(path.join(root, 'node_modules', 'baileys', 'lib', 'Socket')).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(root, 'node_modules', 'baileys', 'lib', 'Socket', f), 'utf8')).join('\n');
  check('Baileys 建立连接时不会自己查询版本号', !/fetchLatest\w*Version/.test(socketSrc));
  const workerFiles = fs.readdirSync(path.join(root, 'src', 'lite')).filter((f) => f.endsWith('.mjs'));
  const usesElectron = workerFiles.filter((f) => /from\s+['"]electron['"]|import\(\s*['"]electron['"]|require\(\s*['"]electron['"]/.test(fs.readFileSync(path.join(root, 'src', 'lite', f), 'utf8')));
  check('后台进程的代码不使用 electron 模块（electron.net 会绕过护栏）', !usesElectron.length, usesElectron.join(', '));
  const risky = ['link-preview-js', 'sharp', 'jimp'].filter((m) => fs.existsSync(path.join(root, 'node_modules', m)));
  check('没有安装 link-preview-js、sharp、jimp（会抓网页或起原生线程）', !risky.length, risky.join(', '));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  check('baileys 版本固定为 7.0.0-rc14', pkg.dependencies.baileys === '7.0.0-rc14');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n运行环境：Node ${process.versions.node}${process.versions.electron ? `（Electron ${process.versions.electron} 内置）` : ''}`);
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
