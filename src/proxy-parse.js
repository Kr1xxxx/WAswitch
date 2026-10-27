// 代理地址解析和“旧密码还能不能用”的判断。不依赖 Electron，自检脚本可以直接用 node 跑。

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

// 决定这次用哪个代理密码（保存和测试共用）。
//   typed：编辑页密码框里新填的；oldRaw：账号原来保存的代理地址（不含密码）。
// 返回 { kind: 'new', password }（用新填的或地址里带的）、{ kind: 'old' }（沿用已保存的）或 { kind: 'none' }。
// 旧密码只在 主机、端口、用户名 都没变时才沿用，否则会把一个代理的密码发给另一个代理。
function passwordPlan(oldRaw, newRaw, typed) {
  const p = parse(newRaw);
  if (!p || p.error || !p.username) return { kind: 'none' };
  const fresh = String(typed || '') || p.password;
  if (fresh) return { kind: 'new', password: fresh };
  const o = parse(oldRaw);
  const same = !!o && !o.error && o.host.toLowerCase() === p.host.toLowerCase() && o.port === p.port && o.username === p.username;
  return same ? { kind: 'old' } : { kind: 'none' };
}

module.exports = { parse, passwordPlan };
