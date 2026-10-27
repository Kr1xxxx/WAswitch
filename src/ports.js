// 编辑账号页用：看本机 7890–7899 哪些端口开着、能不能当 socks5 代理用、有没有被别的号占了。
// 只连 127.0.0.1，不出本机；不改任何设置。
const net = require('net');

const PORTS = [7890, 7891, 7892, 7893, 7894, 7895, 7896, 7897, 7898, 7899];
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// 连上后发 socks5 握手（05 01 00 = 版本 5、1 种认证、不要密码），回 05 00 才算能用。
// 结果：{ port, open, socks }。open=false 是没开；open 但 socks=false 是被别的程序占着或要密码。
function probe(port, { host = '127.0.0.1', timeout = 800 } = {}) {
  return new Promise((resolve) => {
    let open = false;
    let done = false;
    const sock = net.connect({ host, port });
    const finish = (socks) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ port, open, socks });
    };
    sock.setTimeout(timeout, () => finish(false));
    sock.once('connect', () => { open = true; sock.write(Buffer.from([5, 1, 0])); });
    sock.once('data', (d) => finish(d.length >= 2 && d[0] === 5 && d[1] === 0));
    sock.on('error', () => finish(false));
    sock.once('close', () => finish(false));
  });
}

const probeAll = (ports = PORTS, opts) => Promise.all(ports.map((p) => probe(p, opts)));

// 本机端口代理（socks5://127.0.0.1:7891 这类）的端口号，别的地址返回 null
function localPort(raw) {
  const text = String(raw || '').trim();
  if (!text.includes('://')) return null;
  try {
    const u = new URL(text);
    if (!LOCAL.has(u.hostname) || !u.port) return null;
    return Number(u.port);
  } catch { return null; }
}

// 哪些端口已经被别的号用了：{ 7891: ['美国号'], ... }
function usage(accounts, exceptId) {
  const out = {};
  for (const a of accounts || []) {
    if (a.id === exceptId) continue;
    const port = localPort(a.proxy);
    if (port == null) continue;
    (out[port] = out[port] || []).push(a.name);
  }
  return out;
}

module.exports = { PORTS, probe, probeAll, localPort, usage };
