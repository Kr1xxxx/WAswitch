// 轻量模式后台进程的网络护栏：这个进程只允许连代理本身，其他任何直连一律拦下。
// 这样即使 Baileys 或它的依赖哪天多了一个不走代理的请求，也只会失败，不会暴露真实 IP。
// 直连的轻量号在另一个单独的后台进程里（setAllowAll）：那里 TCP 和 DNS 放行，UDP、子进程、新线程照样禁止。
// 两种号不会在同一个进程里，走代理的号的护栏不受影响。
//
// 拦的是最底层：所有 TCP 连接（包括 http、https、WebSocket、fetch）最后都走 net.Socket.prototype.connect；
// DNS 查询也拦（socks5h 由代理解析域名，本机不需要查任何 WhatsApp 域名）；UDP 直接禁用。
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';

const allowed = new Set(); // 允许连接的代理主机（小写）
let allowAll = false; // 直连进程：放行 TCP 和 DNS
let onBlock = () => {};
let installed = false;

const norm = (h) => String(h || '').toLowerCase().replace(/^\[|\]$/g, '');

export function setAllowedHosts(hosts) {
  allowed.clear();
  for (const h of hosts) allowed.add(norm(h));
}

// 只在直连号专用的后台进程里调用
export function setAllowAll(on) {
  allowAll = !!on;
}

export function isAllowed(host) {
  return allowAll || allowed.has(norm(host));
}

// 从 connect() 的各种参数写法里取出目标主机。path（本机管道）不经过网络，放行。
function targetOf(args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0]; // Node 内部规范化后的参数
  if (opts && typeof opts === 'object') {
    if (opts.path) return { local: true };
    return { host: opts.host || 'localhost', port: opts.port };
  }
  if (typeof opts === 'string' && Number.isNaN(Number(opts))) return { local: true }; // 管道路径
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: opts };
}

function blocked(what, host) {
  const err = new Error(`WAswitch 网络护栏：禁止${what} ${host}`);
  err.code = 'EWASWITCHBLOCKED';
  try { onBlock({ what, host: String(host) }); } catch { /* 记录失败不影响拦截 */ }
  return err;
}

export function installGuard(report) {
  onBlock = report || onBlock;
  if (installed) return;
  installed = true;

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const t = targetOf(args);
    if (t.local || isAllowed(t.host)) return connect.apply(this, args);
    const err = blocked('直连', `${t.host}:${t.port}`);
    process.nextTick(() => this.destroy(err));
    return this;
  };

  // 本机 DNS：只允许查代理本身的主机名
  const lookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    if (net.isIP(String(hostname)) || isAllowed(hostname)) return lookup.call(this, hostname, options, callback);
    const err = blocked('DNS 查询', hostname);
    process.nextTick(() => cb(err));
    return {};
  };
  const plookup = dns.promises.lookup;
  dns.promises.lookup = function guardedPromiseLookup(hostname, options) {
    if (net.isIP(String(hostname)) || isAllowed(hostname)) return plookup.call(this, hostname, options);
    return Promise.reject(blocked('DNS 查询', hostname));
  };
  // dns.resolve*、dns.reverse、dns.lookupService，以及 Resolver 实例上的同名方法（走 c-ares 自己发 UDP，不经过 dgram）
  const isQuery = (name) => /^(resolve|reverse|lookupService$)/.test(name);
  const blockQuery = (isPromise, original) => function guardedResolve(hostname, ...rest) {
    if (allowAll) return original.call(this, hostname, ...rest);
    const err = blocked('DNS 查询', hostname);
    if (isPromise) return Promise.reject(err);
    const cb = rest.find((x) => typeof x === 'function');
    if (cb) process.nextTick(() => cb(err));
    return undefined;
  };
  const targets = [
    [dns, false],
    [dns.promises, true],
    [dns.Resolver.prototype, false],
    [dns.promises.Resolver.prototype, true],
  ];
  for (const [target, isPromise] of targets) {
    for (const name of Object.getOwnPropertyNames(target)) {
      if (!isQuery(name) || typeof target[name] !== 'function') continue;
      target[name] = blockQuery(isPromise, target[name]);
    }
  }

  // UDP 一律不用（包括直接 new dgram.Socket()）
  dgram.createSocket = function guardedUdp() {
    throw blocked('UDP', '');
  };
  dgram.Socket = function GuardedUdpSocket() {
    throw blocked('UDP', '');
  };

  // 新线程、子进程里没有护栏，一律禁止
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    childProcess[name] = function guardedChild() {
      throw blocked('启动子进程', name);
    };
  }
  workerThreads.Worker = function GuardedWorker() {
    throw blocked('启动新线程', 'Worker');
  };

  // 让 import { lookup } from 'node:dns' 这类写法拿到的也是加了护栏的版本
  syncBuiltinESMExports();
}
