// 把系统、Chromium、Node 和第三方库的英文报错换成看得懂的中文。
// 原话不丢：调用方把它放进 detail，界面上收在「详细信息」里，排查时还能看到。
// 这里只做文字，不依赖 electron，测试脚本可以直接 require。

const CJK = /[一-鿿]/;
const hasChinese = (s) => CJK.test(String(s || ''));

// 一个错误的原话：message 加上底层原因（undici 的 fetch failed 真正的原因在 cause 里）
function rawOf(e) {
  if (e == null) return '';
  if (typeof e !== 'object') return String(e).slice(0, 300);
  const parts = [e.message || String(e)];
  const c = e.cause;
  if (c && typeof c === 'object') parts.push(c.code || '', c.message || '');
  else if (c) parts.push(String(c));
  if (e.code && !parts.join(' ').includes(e.code)) parts.push(e.code);
  return parts.filter(Boolean).join(' · ').split('\n')[0].slice(0, 300);
}

// Chromium 的 ERR_XXX 和 Node 的 EXXX 归成几类
const KINDS = [
  ['proxyAuth', /PROXY_AUTH|AUTH_REQUESTED|\b407\b/],
  ['proxyDown', /PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|MANDATORY_PROXY|PROXY_CERTIFICATE/],
  ['proxyNode', /TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_HOST_UNREACHABLE|PROXY_HTTP_1_1_REQUIRED/],
  ['offline', /INTERNET_DISCONNECTED/],
  ['changed', /NETWORK_CHANGED|NETWORK_IO_SUSPENDED/],
  ['dns', /NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|ENOTFOUND|EAI_AGAIN|DNS_/],
  ['timeout', /TIMED_OUT|ETIMEDOUT|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|Timed Out|timeout/i],
  ['refused', /CONNECTION_REFUSED|ECONNREFUSED/],
  ['unreachable', /ADDRESS_UNREACHABLE|ENETUNREACH|EHOSTUNREACH|NETWORK_ACCESS_DENIED/],
  ['cert', /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/],
  ['reset', /CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_ABORTED|CONNECTION_FAILED|EMPTY_RESPONSE|ECONNRESET|EPIPE|UND_ERR_SOCKET|socket hang up|Connection Closed|other side closed|terminated/i],
];

function netKind(raw) {
  const s = String(raw || '');
  for (const [kind, re] of KINDS) if (re.test(s)) return kind;
  return 'other';
}

const isLocal = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'].includes(String(host || '').toLowerCase());

// 一句话的原因，不带账号名。proxy：{ host, port } 表示这次是走代理连的
function netReason(raw, { proxy } = {}) {
  const kind = netKind(raw);
  const local = proxy && isLocal(proxy.host);
  const where = proxy ? (local ? `Clash 的 ${proxy.port} 端口` : `代理服务器 ${proxy.host}:${proxy.port}`) : '';
  if (proxy) {
    switch (kind) {
      case 'proxyDown':
      case 'refused':
        return local ? `${where}没有回应：Clash 没开，或者 Clash 里没开这个端口` : `${where}没有回应：代理可能停了，或者地址、端口不对`;
      case 'proxyNode':
      case 'dns':
        return local ? 'Clash 开着，但当前节点打不开网站：在 Clash 里换个节点试试' : '代理连上了，但通过它打不开网站：代理那边的网络可能有问题';
      case 'proxyAuth': return '代理的用户名或密码不对';
      case 'timeout': return `连接超时：${local ? 'Clash 当前节点' : '代理'}太慢或不通，换个节点再试`;
      case 'reset': return `连接被中断：${local ? 'Clash 当前节点' : '代理'}不稳定，稍后再试或换个节点`;
      default: break;
    }
  }
  switch (kind) {
    case 'offline': return '这台电脑没联网';
    case 'changed': return '网络刚切换过，稍后会自动重试';
    case 'dns': return '找不到网站地址：可能没联网，或者要开着 Clash 的系统代理';
    case 'timeout': return '连接超时：网络太慢或不通';
    case 'refused': return '对方拒绝了连接';
    case 'unreachable': return '网络不通';
    case 'cert': return '安全连接出错：可能是网络被拦截，或者电脑时间不对';
    case 'reset': return '连接被中断';
    case 'proxyDown': case 'proxyNode': return '代理连不上';
    case 'proxyAuth': return '代理的用户名或密码不对';
    default: return '网络有问题';
  }
}

// 查出口 IP 的网站（ipinfo.io）返回了非 200
function ipinfoStatus(status) {
  if (status === 429) return '查 IP 的网站暂时限流了，代理可能是通的，过一分钟再测';
  if (status === 403) return '查 IP 的网站拒绝了这个出口 IP，代理可能是通的，换个节点或过一会儿再测';
  return `查 IP 的网站暂时出错（${status}），过一会儿再测`;
}

// 已经是中文的原样用；英文的换成 fallback（或按网络错误归类），原话放 detail
function friendly(e, fallback, opts) {
  const raw = rawOf(e);
  if (hasChinese(raw)) return { text: raw, detail: '' };
  return { text: fallback || netReason(raw, opts), detail: raw };
}

module.exports = { hasChinese, rawOf, netKind, netReason, ipinfoStatus, friendly, isLocal };
