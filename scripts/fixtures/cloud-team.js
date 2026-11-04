// 自检用的本机假来财（HTTP，127.0.0.1）：团队登录（policy / code / login / sync / logout）和 AI（ai/chat、ai/status、ai/transcribe），
// 照 #209 的「Desktop ↔ cloud contract」回答。不发任何真实请求。用法：
//   const cloud = await startCloud({ chat: (body) => ({ status: 200, body: { ok: true, text: '…' } }) });
//   const env = teamOn(profileDir, cloud.url);   // 启动前写好「已登录」的 team.json
//   spawn(electron, ['--no-sandbox', …, CLOUD_MAIN], { env: { ...process.env, ...env } })
// 令牌按 fixtures/login-lock-main.js 的假钥匙串加密（CI 的 xvfb 没有系统钥匙串），所以软件要用 CLOUD_MAIN 启动。
// 本机的号不加入团队（/join 回 404）：退出登录后号照常运行，只是翻译要先登录。
const fs = require('fs');
const path = require('path');
const http = require('http');

const TOKEN = 'C'.repeat(43);
const DEVICE = '11111111-2222-4333-8444-666666666666';
const EMAIL = 'emma@example.com';
const CODE = '135790';
const CLOUD_MAIN = path.join(__dirname, 'login-lock-main.js');

function startCloud({ chat, transcribe, status } = {}) {
  const st = { calls: [], loggedIn: true };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const json = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      let body = null;
      try { body = JSON.parse(raw || 'null'); } catch { body = null; }
      const route = String(req.url).replace(/^\/api\/device\//, '');
      if (route === 'policy') return json(200, { v: 1, login: 'off' });
      if (route === 'code') return json(200, { ok: true, resend_after_s: 60 });
      if (route === 'login') {
        if (!body || body.email !== EMAIL || body.code !== CODE) return json(400, { error: '验证码不对或已过期' });
        st.loggedIn = true;
        return json(200, { device_id: DEVICE, token: TOKEN, user: { name: 'Emma Schneider' }, allow_private: true, login: 'off' });
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}` || !st.loggedIn) return json(401, { ok: false, error: 'login_required' });
      if (route === 'logout') { st.loggedIn = false; return json(200, { ok: true }); }
      if (route === 'sync') return json(200, { ok: true, seats: [], cursor: 0, next_sync_s: 120, allow_private: true, login: 'off', user: { name: 'Emma Schneider' } });
      if (!route.startsWith('ai/')) return json(404, { ok: false, error: 'not_found' });
      if (!body || body.v !== 1) return json(426, { ok: false, error: 'old_version' });
      st.calls.push({ route, body });
      try {
        let r = null;
        if (route === 'ai/chat') r = chat ? await chat(body) : null;
        else if (route === 'ai/transcribe') r = transcribe ? await transcribe(body) : { status: 503, body: { ok: false, error: 'no_ai' } };
        else if (route === 'ai/status') r = status ? await status(body) : null;
        else return json(404, { ok: false, error: 'not_found' });
        if (!r) r = route === 'ai/status' ? { status: 200, body: { ok: true, ready: true, over_budget: false } } : { status: 200, body: { ok: true, text: 'Hola', usage: { input_tokens: 1, output_tokens: 1 } } };
        return json(r.status || 200, r.body);
      } catch {
        return json(500, { ok: false, error: 'internal' });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({ url, server, get calls() { return st.calls; }, close: () => server.close() });
  }));
}

// profileDir = 软件的 userData 文件夹。写成已登录（假钥匙串加密的令牌）、团队策略「不用登录」。返回启动软件要加的环境变量
function teamOn(profileDir, server) {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'team.json'), JSON.stringify({
    server, policy: 'off', deviceId: DEVICE, email: EMAIL, userName: 'Emma Schneider',
    devices: { [EMAIL]: DEVICE }, token: Buffer.from(`fake:${TOKEN}`).toString('base64'), lastOkAt: Date.now(),
  }));
  return { WASWITCH_TEST_TEAM_SERVER: server, WASWITCH_TEST_PROFILE: profileDir };
}

module.exports = { startCloud, teamOn, CLOUD_MAIN, TOKEN, EMAIL, CODE };
