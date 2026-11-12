// 自检：scripts/upload-cloud-release.mjs（发版时把更新文件传到来财）。
// 用本机的假后台（node:http）当来财的上传接口和 GitHub 的 OIDC 令牌接口，不联网。
// 查：传哪些文件（不传 blockmap）、ymls 最后传、全部传完才 publish、分块拼回来和原文件一样、
// 每个请求带 OIDC 令牌（audience 对）、401 时换新令牌、5xx 重试、一直失败时取消上传并非 0 退出、
// 4xx 不重试、缺 yml 时不传、上传地址只认来财或本机、输出里没有令牌；
// --mac-only 时不传 exe 和 latest.yml、publish 带 mac_only，release.yml 的 WINDOWS 开关关着时只打 Mac（2026-11-12 起开着）。
// 运行：node scripts/check-upload-cloud-release.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

let failures = 0;
const check = (ok, text) => { console.log(`${ok ? '通过' : '失败'}：${text}`); if (!ok) failures += 1; };

const SCRIPT = path.join(__dirname, 'upload-cloud-release.mjs');
const PART = 4096;
const API = '/api/release/waswitch/';

// ---------- 假后台 ----------
let st;
function reset(opts = {}) {
  st = {
    opts, calls: [], oidc: [], tokensIssued: 0, uploads: new Map(), files: new Map(), published: null, aborted: [],
    fail: { ...opts.fail }, // 路由 -> 还要失败几次（{ status, times }）
  };
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (u.pathname === '/oidc') {
      st.oidc.push({ audience: u.searchParams.get('audience'), apiVersion: u.searchParams.get('api-version'), auth: req.headers.authorization });
      if (req.headers.authorization !== 'bearer req-tok') { json(res, 403, {}); return; }
      st.tokensIssued += 1;
      json(res, 200, { value: `jwt-secret-${st.tokensIssued}` });
      return;
    }
    if (!u.pathname.startsWith(API)) { json(res, 404, { error: 'not_found' }); return; }
    const route = u.pathname.slice(API.length);
    const auth = req.headers.authorization || '';
    st.calls.push({ route, method: req.method, auth, n: u.searchParams.get('n') });
    // 第一次用的令牌“过期”：回 401，脚本要换新令牌
    if (st.opts.expireFirst && auth === 'Bearer jwt-secret-1') { json(res, 401, { ok: false, error: 'bad_token' }); return; }
    if (!/^Bearer jwt-secret-\d+$/.test(auth)) { json(res, 401, { ok: false, error: 'bad_token' }); return; }
    const f = st.fail[route];
    if (f && f.times > 0) { f.times -= 1; json(res, f.status, { ok: false, error: 'boom' }); return; }
    let data = null;
    if (req.method === 'POST') { try { data = JSON.parse(body.toString('utf8')); } catch { json(res, 400, { ok: false, error: 'bad_json' }); return; } }
    if (route === 'start' && req.method === 'POST') {
      if (data.v !== 1 || data.version !== '1.0.7' || !Number.isInteger(data.size)) { json(res, 400, { ok: false, error: 'bad_request' }); return; }
      const id = `up-${st.uploads.size + 1}`;
      const key = /^latest/.test(data.name) ? `waswitch/stage/1.0.7/${data.name}` : `waswitch/files/${data.name}`;
      st.uploads.set(id, { key, name: data.name, size: data.size, parts: new Map() });
      json(res, 200, { ok: true, key, upload_id: id, part_size: PART });
      return;
    }
    if (route === 'part' && req.method === 'PUT') {
      const up = st.uploads.get(u.searchParams.get('upload_id'));
      if (!up || up.key !== u.searchParams.get('key')) { json(res, 400, { ok: false, error: 'bad_upload' }); return; }
      if (req.headers['content-type'] !== 'application/octet-stream' || Number(req.headers['content-length']) !== body.length || body.length > PART) { json(res, 400, { ok: false, error: 'bad_part' }); return; }
      const n = Number(u.searchParams.get('n'));
      up.parts.set(n, body);
      json(res, 200, { ok: true, etag: `etag-${n}-${crypto.createHash('md5').update(body).digest('hex')}` });
      return;
    }
    if (route === 'complete' && req.method === 'POST') {
      const up = st.uploads.get(data.upload_id);
      if (!up || up.key !== data.key || !Array.isArray(data.parts)) { json(res, 400, { ok: false, error: 'bad_upload' }); return; }
      const buf = Buffer.concat(data.parts.map((p) => up.parts.get(p.n)));
      const etagsOk = data.parts.every((p) => p.etag === `etag-${p.n}-${crypto.createHash('md5').update(up.parts.get(p.n) || '').digest('hex')}`);
      if (!etagsOk) { json(res, 400, { ok: false, error: 'bad_etag' }); return; }
      st.files.set(up.name, buf);
      json(res, 200, { ok: true, size: buf.length });
      return;
    }
    if (route === 'abort' && req.method === 'POST') { st.aborted.push(data.upload_id); json(res, 200, { ok: true }); return; }
    if (route === 'publish' && req.method === 'POST') {
      st.published = { version: data.version, files: [...st.files.keys()], body: data };
      json(res, 200, { ok: true, version: data.version, pruned: ['WAswitch-Setup-1.0.5.exe'] });
      return;
    }
    json(res, 404, { ok: false, error: 'not_found' });
  });
});

function run(dir, tag, env = {}, extra = []) {
  return new Promise((resolve) => {
    const port = server.address().port;
    execFile(process.execPath, [SCRIPT, dir, tag, ...extra], {
      env: {
        PATH: process.env.PATH,
        ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/oidc?api-version=2.0`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req-tok',
        WASWITCH_RELEASE_API: `http://127.0.0.1:${port}${API}`,
        WASWITCH_RELEASE_BACKOFF_MS: '1',
        ...env,
      },
      timeout: 60 * 1000,
    }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` }));
  });
}

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cloudrel-'));
  const files = {
    'WAswitch-Setup-1.0.7.exe': crypto.randomBytes(PART * 2 + 123), // 3 块
    'WAswitch-1.0.7-arm64.zip': crypto.randomBytes(PART * 2), // 正好 2 块
    'waswitch-mcp-1.0.7.js': Buffer.from('module.exports = {};\n'),
    'mcp-module.json': Buffer.from('{"version":"1.0.7"}\n'),
    'latest.yml': Buffer.from('version: 1.0.7\n'),
    'latest-mac.yml': Buffer.from('version: 1.0.7\n'),
    // 这些不传
    'WAswitch-1.0.7-arm64.dmg': crypto.randomBytes(100),
    'WAswitch-Setup-1.0.7.exe.blockmap': crypto.randomBytes(100),
    'WAswitch-1.0.7-arm64.zip.blockmap': crypto.randomBytes(100),
    'builder-debug.yml': Buffer.from('x: 1\n'),
  };
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
  return { dir, files };
}
const UPLOADED = ['WAswitch-1.0.7-arm64.dmg', 'WAswitch-1.0.7-arm64.zip', 'WAswitch-Setup-1.0.7.exe', 'mcp-module.json', 'waswitch-mcp-1.0.7.js', 'latest.yml', 'latest-mac.yml'];

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { dir, files } = makeDir();
  try {
    // 正常上传
    reset();
    let r = await run(dir, 'v1.0.7');
    check(r.code === 0, `正常上传：退出码 0（${r.code}）${r.code ? `\n${r.out}` : ''}`);
    const starts = st.calls.filter((c) => c.route === 'start').length;
    check(starts === UPLOADED.length && [...st.files.keys()].join() === UPLOADED.join(), `只传安装包、zip、MCP 文件和两个 yml，yml 最后（${[...st.files.keys()].join(' ')}）`);
    check(UPLOADED.every((n) => st.files.get(n) && st.files.get(n).equals(files[n])), '分块拼回来和原文件一模一样');
    check(st.calls.filter((c) => c.route === 'part').length === 3 + 2 + 5, '按来财给的块大小分块（3 + 2 + 每个小文件 1 块）');
    check(st.published && st.published.version === '1.0.7' && st.published.files.length === UPLOADED.length && st.calls[st.calls.length - 1].route === 'publish', '全部传完才 publish，版本号去掉了 v');
    check(st.published && JSON.stringify(st.published.body) === '{"v":1,"version":"1.0.7"}', `不带 --mac-only 时 publish 和以前一样（${st.published && JSON.stringify(st.published.body)}）`);
    check(st.oidc.length >= 1 && st.oidc.every((o) => o.audience === 'laicrm-waswitch-release' && o.apiVersion === '2.0' && o.auth === 'bearer req-tok'), 'OIDC 令牌：audience 对、原来的查询参数还在、带 GitHub 给的请求令牌');
    check(st.tokensIssued === 1 && st.calls.every((c) => c.auth === 'Bearer jwt-secret-1'), '令牌没过 4 分钟就一直用同一个，每个请求都带');
    check(!/jwt-secret|req-tok/.test(r.out) && /WAswitch-Setup-1\.0\.7\.exe/.test(r.out), '输出只有文件名和大小，没有令牌');

    // 来财说令牌过期（401）：换个新令牌接着传
    reset({ expireFirst: true });
    r = await run(dir, 'v1.0.7');
    check(r.code === 0 && st.tokensIssued === 2 && st.published, `401 时换新令牌再试（取了 ${st.tokensIssued} 次）`);

    // 一块偶尔失败（500）：重试后成功
    reset({ fail: { part: { status: 500, times: 2 } } });
    r = await run(dir, 'v1.0.7');
    check(r.code === 0 && st.published && st.files.get('WAswitch-Setup-1.0.7.exe').equals(files['WAswitch-Setup-1.0.7.exe']), '一块失败 2 次，第 3 次成功：照常传完');

    // 一直失败：试 3 次后取消这次上传，非 0 退出，不 publish
    reset({ fail: { part: { status: 503, times: 99 } } });
    r = await run(dir, 'v1.0.7');
    check(r.code !== 0 && !st.published && st.calls.filter((c) => c.route === 'part').length === 3 && st.aborted.length === 1, `一直失败：试 3 次、取消上传、非 0 退出、不 publish（part ${st.calls.filter((c) => c.route === 'part').length} 次，abort ${st.aborted.length} 次）`);

    // 4xx（除了 401、429）不重试
    reset({ fail: { start: { status: 400, times: 99 } } });
    r = await run(dir, 'v1.0.7');
    check(r.code !== 0 && st.calls.filter((c) => c.route === 'start').length === 1 && !st.published, '400 不重试，直接失败');

    // publish 失败：非 0 退出
    reset({ fail: { publish: { status: 409, times: 99 } } });
    r = await run(dir, 'v1.0.7');
    check(r.code !== 0, 'publish 失败时非 0 退出');

    // 缺 latest-mac.yml：一个都不传
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cloudrel-'));
    fs.writeFileSync(path.join(dir2, 'latest.yml'), 'version: 1.0.7\n');
    fs.writeFileSync(path.join(dir2, 'WAswitch-Setup-1.0.7.exe'), 'x');
    reset();
    r = await run(dir2, 'v1.0.7');
    check(r.code !== 0 && st.calls.length === 0 && /latest-mac\.yml/.test(r.out), '缺 latest-mac.yml 时一个都不传');
    fs.rmSync(dir2, { recursive: true, force: true });

    // 缺 latest.yml（没带 --mac-only）：一个都不传
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cloudrel-'));
    fs.writeFileSync(path.join(dir3, 'latest-mac.yml'), 'version: 1.0.7\n');
    fs.writeFileSync(path.join(dir3, 'WAswitch-1.0.7-arm64.zip'), 'x');
    reset();
    r = await run(dir3, 'v1.0.7');
    check(r.code !== 0 && st.calls.length === 0 && /latest\.yml/.test(r.out), '没带 --mac-only、缺 latest.yml 时一个都不传');

    // --mac-only：同一个目录里有 exe 和 latest.yml 也不传，publish 带 mac_only
    reset();
    r = await run(dir, 'v1.0.7', {}, ['--mac-only']);
    const MAC = UPLOADED.filter((n) => n !== 'WAswitch-Setup-1.0.7.exe' && n !== 'latest.yml');
    check(r.code === 0 && [...st.files.keys()].join() === MAC.join(), `--mac-only：只传 dmg、zip、MCP 文件和 latest-mac.yml（${[...st.files.keys()].join(' ')}）${r.code ? `\n${r.out}` : ''}`);
    check(st.published && st.published.body.mac_only === true && st.published.version === '1.0.7' && st.calls[st.calls.length - 1].route === 'publish', '--mac-only：最后 publish，带 mac_only: true');
    // --mac-only，只有 Mac 的文件（发版时就是这样）：照常传完
    reset();
    r = await run(dir3, 'v1.0.7', {}, ['--mac-only']);
    check(r.code === 0 && [...st.files.keys()].join() === 'WAswitch-1.0.7-arm64.zip,latest-mac.yml' && st.published, `--mac-only：没有 exe 和 latest.yml 也能传（${[...st.files.keys()].join(' ')}）`);
    // --mac-only 缺 latest-mac.yml：一个都不传
    fs.rmSync(path.join(dir3, 'latest-mac.yml'));
    reset();
    r = await run(dir3, 'v1.0.7', {}, ['--mac-only']);
    check(r.code !== 0 && st.calls.length === 0 && /latest-mac\.yml/.test(r.out), '--mac-only 缺 latest-mac.yml 时一个都不传');
    fs.rmSync(dir3, { recursive: true, force: true });
    // 多给参数：不传
    reset();
    r = await run(dir, 'v1.0.7', {}, ['--windows']);
    check(r.code !== 0 && st.calls.length === 0, '不认识的参数：不传');

    // 版本号不对、上传地址不是来财：不传
    reset();
    r = await run(dir, 'v1.0');
    check(r.code !== 0 && st.calls.length === 0, 'tag 不是 x.y.z 时不传');
    r = await run(dir, 'v1.0.7', { WASWITCH_RELEASE_API: 'https://evil.example/api/release/waswitch/' });
    check(r.code !== 0 && st.oidc.length === 0, '上传地址不是来财（或本机）时不取令牌、不传');
    r = await run(dir, 'v1.0.7', { ACTIONS_ID_TOKEN_REQUEST_URL: '' });
    check(r.code !== 0 && /id-token: write/.test(r.out), '没有 OIDC 权限时说清楚要 id-token: write');

    // 静态：release.yml 给了 OIDC 权限、发完 GitHub Release 后运行
    const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
    const pub = wf.slice(wf.indexOf('\n  publish:'));
    check(/id-token: write/.test(pub) && /contents: write/.test(pub), 'release.yml：publish 有 id-token: write 和 contents: write');
    const edit = pub.indexOf('gh release edit "$TAG" --repo "$PUBLIC_REPO" --draft=false');
    check(edit > 0 && pub.indexOf('upload-cloud-release.mjs dist "$TAG"') > edit, 'release.yml：发完 GitHub Release 后传到来财');
    check(!/upload-artifact|download-artifact/.test(wf), 'release.yml：job 之间不用构建产物（私有仓库存储按月累计，会满）');
    // Windows 开关（2026-11-11 起关着）：只打 Mac，草稿里不要求 exe 和 latest.yml，传来财带 --mac-only
    const sw = /^env:\n(?:\s*#.*\n)*\s+WINDOWS: '(true|false)'$/m.exec(wf);
    check(sw, `release.yml：开关 WINDOWS 在顶层，是 'true' 或 'false'（现在 ${sw && sw[1]}）`);
    check(/os: \$\{\{ fromJSON\(needs\.mcp-module\.outputs\.os\) \}\}/.test(wf) && /os=\["macos-latest"\]/.test(wf) && /os=\["windows-latest","macos-latest"\]/.test(wf), 'release.yml：打包的系统跟着开关（关着只有 macos-latest）');
    check(/need=\([^)]*latest-mac\.yml[^)]*\)/.test(pub) && !/need=\([^)]*(\.exe|'latest\.yml')[^)]*\)/.test(pub) && /\[ "\$WINDOWS" = true \] && need\+=\('WAswitch-Setup-\*\.exe' 'latest\.yml'\)/.test(pub), 'release.yml：exe 和 latest.yml 只在开关开着时才要求');
    check(/upload-cloud-release\.mjs dist "\$TAG" \$\(\[ "\$WINDOWS" = true \] \|\| echo --mac-only\)/.test(pub), 'release.yml：开关关着时传来财带 --mac-only');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    server.close();
  }
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
