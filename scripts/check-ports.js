// 编辑页代理端口检测（src/ports.js）：开着的 socks5 端口、被别的程序占着的端口、没开的端口、被别的号用着的端口
const assert = require('assert');
const net = require('net');
const http = require('http');
const ports = require('../src/ports');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

(async () => {
  // 假 socks5：收到 05 01 00 回 05 00
  const socks = net.createServer((c) => c.once('data', () => c.write(Buffer.from([5, 0]))));
  // 不说话的程序：连得上但不回
  const silent = net.createServer(() => {});
  // http 服务：会回 HTTP/1.1 400
  const web = http.createServer((q, s) => s.end('x'));
  // 要密码的 socks5：回 05 FF
  const auth = net.createServer((c) => c.once('data', () => c.write(Buffer.from([5, 0xff]))));
  const [pSocks, pSilent, pWeb, pAuth] = await Promise.all([socks, silent, web, auth].map(listen));
  // 没开的端口：开一个再关掉
  const tmp = net.createServer();
  const pClosed = await listen(tmp);
  await new Promise((r) => tmp.close(r));

  const t0 = Date.now();
  const res = await ports.probeAll([pSocks, pSilent, pWeb, pAuth, pClosed], { timeout: 500 });
  const by = Object.fromEntries(res.map((r) => [r.port, r]));
  assert.deepStrictEqual(by[pSocks], { port: pSocks, open: true, socks: true });
  assert.deepStrictEqual(by[pSilent], { port: pSilent, open: true, socks: false });
  assert.deepStrictEqual(by[pWeb], { port: pWeb, open: true, socks: false });
  assert.deepStrictEqual(by[pAuth], { port: pAuth, open: true, socks: false });
  assert.deepStrictEqual(by[pClosed], { port: pClosed, open: false, socks: false });
  assert(Date.now() - t0 < 2000, '并行检测，不会一个个等');

  // 默认范围是 7890–7899
  assert.deepStrictEqual(ports.PORTS, [7890, 7891, 7892, 7893, 7894, 7895, 7896, 7897, 7898, 7899]);

  assert.strictEqual(ports.localPort('socks5://127.0.0.1:7891'), 7891);
  assert.strictEqual(ports.localPort(' http://localhost:7890 '), 7890);
  assert.strictEqual(ports.localPort('socks5://10.0.0.2:7891'), null);
  assert.strictEqual(ports.localPort('http://user@1.2.3.4:8080'), null);
  assert.strictEqual(ports.localPort('127.0.0.1:7891'), null);
  assert.strictEqual(ports.localPort(''), null);

  const accounts = [
    { id: 'a', name: '美国号', proxy: 'socks5://127.0.0.1:7891' },
    { id: 'b', name: '德国号', proxy: 'socks5://127.0.0.1:7892' },
    { id: 'c', name: '法国号', proxy: 'socks5://localhost:7891' },
    { id: 'd', name: '直连号', proxy: '' },
    { id: 'e', name: '住宅 IP', proxy: 'http://u@5.6.7.8:8080' },
  ];
  assert.deepStrictEqual(ports.usage(accounts, 'b'), { 7891: ['美国号', '法国号'] });
  assert.deepStrictEqual(ports.usage(accounts, null), { 7891: ['美国号', '法国号'], 7892: ['德国号'] });

  for (const s of [socks, silent, web, auth]) s.close();
  console.log('check-ports: ok');
})().catch((e) => { console.error(e); process.exit(1); });
