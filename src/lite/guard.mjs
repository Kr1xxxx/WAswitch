// 轻量模式后台进程的网络护栏：这个进程只允许连代理本身，其他任何直连一律拦下。
// 这样即使 Baileys 或它的依赖哪天多了一个不走代理的请求，也只会失败，不会暴露真实 IP。
//
// 拦的是最底层：所有 TCP 连接（包括 http、https、WebSocket、fetch）最后都走 net.Socket.prototype.connect；
// DNS 查询也拦（socks5h 由代理解析域名，本机不需要查任何 WhatsApp 域名）；UDP 直接禁用。
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const allowed = new Set(); // 允许连接的代理主机（小写）
let onBlock = () => {};
let installed = false;

const norm = (h) => String(h || '').toLowerCase().replace(/^\[|\]$/g, '');

export function setAllowedHosts(hosts) {
  allowed.clear();
  for (const h of hosts) allowed.add(norm(h));
}

export function isAllowed(host) {
  return allowed.has(norm(host));
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
  for (const target of [dns, dns.promises]) {
    for (const name of Object.keys(target)) {
      if (!/^resolve/.test(name) || typeof target[name] !== 'function') continue;
      target[name] = function guardedResolve(hostname, ...rest) {
        const err = blocked('DNS 查询', hostname);
        if (target === dns.promises) return Promise.reject(err);
        const cb = rest.find((x) => typeof x === 'function');
        if (cb) process.nextTick(() => cb(err));
        return undefined;
      };
    }
  }

  // UDP 一律不用
  dgram.createSocket = function guardedUdp() {
    throw blocked('UDP', '');
  };

  // 让 import { lookup } from 'node:dns' 这类写法拿到的也是加了护栏的版本
  syncBuiltinESMExports();
}
