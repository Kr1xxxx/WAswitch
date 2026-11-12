// 自检用的假来财：照 #209 的「Desktop ↔ cloud contract」回答 /api/device/ai/chat、ai/transcribe、ai/status。
// 只在内存里，不发任何真实请求。用法：
//   const cloud = fakeCloud();                     // cloud.session 交给 Translator 的 sessionFor
//   new Translator({ dir, sessionFor: () => cloud.session, cloud: cloud.login })
//   cloud.calls：每次请求 { route, url, opt, body }；cloud.next(...)：下几次请求怎么回答
// 请求不合约定（没带令牌、v 不是 1、messages 不对、音频太大……）就按约定回 400 / 401 / 426，自检会因此失败。
const SERVER = 'https://cloud.example';
const TOKEN = 'device-token-123';
const json = (status, body, headers = {}) => ({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

function checkChat(b) {
  const roles = ['system', 'user', 'assistant'];
  if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > 4) return 'messages';
  let total = 0;
  for (const m of b.messages) {
    if (!m || !roles.includes(m.role) || typeof m.content !== 'string') return 'message';
    total += m.content.length;
  }
  if (total > 24000) return 'too_long';
  if (b.temperature !== undefined && !(Number.isFinite(b.temperature) && b.temperature >= 0 && b.temperature <= 1.5)) return 'temperature';
  if (b.max_tokens !== undefined && !(Number.isInteger(b.max_tokens) && b.max_tokens >= 16 && b.max_tokens <= 8192)) return 'max_tokens';
  if (b.purpose !== undefined && !['translate', 'fix', 'test'].includes(b.purpose)) return 'purpose';
  return '';
}
function checkAudio(b) {
  if (typeof b.audio !== 'string' || !b.audio || b.audio.length > 1.4 * 1024 * 1024) return 'audio';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b.audio)) return 'base64';
  if (!Number.isFinite(b.seconds) || b.seconds <= 0 || b.seconds > 30) return 'seconds';
  return '';
}

// 默认回答：翻译回 Hola，转写回「第 n 段」，状态是开通了、没超额
function defaultAnswer(route, body, n) {
  if (route === 'ai/chat') return json(200, { ok: true, text: 'Hola', usage: { input_tokens: 12, output_tokens: 3 } });
  if (route === 'ai/transcribe') return json(200, { ok: true, text: `第${n}段` });
  if (route === 'ai/status') return json(200, { ok: true, ready: true, over_budget: false });
  return json(404, { ok: false, error: 'not_found' });
}

function fakeCloud({ token = TOKEN, server = SERVER } = {}) {
  const st = { loggedIn: true, calls: [], plan: [], n: { 'ai/chat': 0, 'ai/transcribe': 0, 'ai/status': 0 } };
  // plan 里的一项：'net'（连不上）| 'hang'（不回答，等取消）| { status, body?, error?, headers?, delay? } | (req) => 上面那些
  const answer = async (route, body, opt) => {
    const max = { 'ai/chat': 64 * 1024, 'ai/transcribe': 1.5 * 1024 * 1024, 'ai/status': 4 * 1024 }[route] || 0;
    if (opt.headers.Authorization !== `Bearer ${token}`) return json(401, { ok: false, error: 'login_required' });
    if (String(opt.body).length > max) return json(413, { ok: false, error: 'too_large' });
    if (!body || body.v !== 1) return json(426, { ok: false, error: 'old_version' });
    const bad = route === 'ai/chat' ? checkChat(body) : route === 'ai/transcribe' ? checkAudio(body) : '';
    if (bad) return json(400, { ok: false, error: 'bad_input', why: bad });
    st.n[route] = (st.n[route] || 0) + 1;
    let p = st.plan.length ? st.plan.shift() : null;
    if (typeof p === 'function') p = p({ route, body, opt });
    if (p === 'net') throw new Error('net::ERR_CONNECTION_REFUSED');
    if (p === 'hang') return new Promise((_res, rej) => opt.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    if (!p) return defaultAnswer(route, body, st.n[route]);
    if (p.delay) await new Promise((r, rej) => { const t = setTimeout(r, p.delay); opt.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }); });
    if (p.ok) return defaultAnswer(route, body, st.n[route]);
    if (p.body !== undefined) return { status: p.status || 200, body: typeof p.body === 'string' ? p.body : JSON.stringify(p.body), headers: { 'content-type': 'application/json', ...(p.headers || {}) } };
    return json(p.status, { ok: false, error: p.error || 'x', ...(p.extra || {}) }, p.headers);
  };
  const session = {
    async fetch(url, opt) {
      const u = new URL(url);
      const route = u.pathname.replace(/^\/api\/device\//, '');
      let body = null;
      try { body = JSON.parse(opt.body); } catch { body = null; }
      const call = { route, url, opt, body };
      st.calls.push(call);
      if (opt.method !== 'POST' || opt.redirect !== 'error' || opt.headers['Content-Type'] !== 'application/json' || u.origin !== server) {
        throw new Error(`fake cloud: bad request ${opt.method} ${url} redirect=${opt.redirect}`);
      }
      const r = await answer(route, body, opt);
      const hd = r.headers || {};
      return { ok: r.status >= 200 && r.status < 300, status: r.status, body: null, headers: { get: (k) => hd[String(k).toLowerCase()] ?? null }, text: async () => r.body };
    },
  };
  return {
    session,
    get calls() { return st.calls; },
    reset() { st.calls.length = 0; st.plan.length = 0; },
    next(...plan) { st.plan.push(...plan); },
    logout() { st.loggedIn = false; },
    loginAgain() { st.loggedIn = true; },
    // Translator 的 deps.cloud
    login: () => (st.loggedIn ? { server, token } : null),
    server,
    token,
  };
}

module.exports = { fakeCloud, SERVER, TOKEN };
