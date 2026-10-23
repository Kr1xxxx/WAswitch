// 轻量模式的联网通道：WebSocket（收发消息）和 HTTP（下载聊天记录同步包）都只走账号自己的代理。
//   socks5h://127.0.0.1:7891  域名交给代理解析，本机不做 DNS 查询
//   http://user:pass@1.2.3.4:8080
// 不提供直连：没有代理就不启动。
import tls from 'node:tls';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksClient } from 'socks';
import { Agent, ProxyAgent } from 'undici';

export function proxyHost(proxyUrl) {
  return new URL(proxyUrl).hostname;
}

// HTTP 请求（fetch）用的连接器：先经 socks5 代理连到目标域名，https 再在上面套 TLS
function socksConnector(host, port) {
  return (opts, callback) => {
    const https = opts.protocol === 'https:';
    const target = opts.hostname;
    const targetPort = Number(opts.port) || (https ? 443 : 80);
    SocksClient.createConnection({
      proxy: { host, port, type: 5 },
      command: 'connect',
      destination: { host: target, port: targetPort },
      timeout: 20000,
    }).then(({ socket }) => {
      if (!https) { callback(null, socket); return; }
      const secure = tls.connect({ socket, servername: opts.servername || target, ALPNProtocols: ['http/1.1'] });
      secure.once('secureConnect', () => callback(null, secure));
      secure.once('error', (e) => callback(e));
    }, (e) => callback(e));
  };
}

// 返回 { agent（给 WebSocket 和上传用）, dispatcher（给 fetch 用） }
export function makeTransport(proxyUrl) {
  const u = new URL(proxyUrl);
  const port = Number(u.port);
  if (u.protocol === 'socks5h:' || u.protocol === 'socks5:') {
    const clean = `socks5h://${u.hostname}:${port}`; // 一律 socks5h：域名由代理解析
    return {
      agent: new SocksProxyAgent(clean),
      dispatcher: new Agent({ connect: socksConnector(u.hostname, port) }),
    };
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    return {
      agent: new HttpsProxyAgent(proxyUrl),
      dispatcher: new ProxyAgent(proxyUrl),
    };
  }
  throw new Error(`轻量模式不支持这种代理：${u.protocol}`);
}
