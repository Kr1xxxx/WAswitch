// 把一个版本的更新文件传到来财（laicrm.com），已装的软件从那里更新（src/updater.js、src/mcp-module.js）。
// release.yml 的 publish 这一步在发 GitHub Release 之后运行：
//   node scripts/upload-cloud-release.mjs dist v1.0.7
//
// 传哪些：目录里的 *.exe、*.zip、waswitch-mcp-*.js、mcp-module.json，最后传 latest.yml 和 latest-mac.yml，
// 全部传完再 publish（来财这时才换成新版本，并只留新旧两个版本）。不传 dmg 和 blockmap（更新用不到）。
// 认证：GitHub Actions 的 OIDC 令牌（audience laicrm-waswitch-release），不用密钥。job 要有 id-token: write。
// 令牌超过 4 分钟或来财回 401 时重新取。
// 每个文件分块传（块大小按来财回的 part_size，现在是 6 MiB：Caddy 只收 8 MB 以内的请求），
// 每个请求最多试 3 次（等 2、4 秒），还不行就取消这个文件的上传，退出码非 0，整个 job 失败。
// 只打印文件名和大小，不打印令牌。
// 本地自检（scripts/check-upload-cloud-release.js）用 WASWITCH_RELEASE_API 换成本机的假后台，
// 只认 https://laicrm.com/ 或 http://127.0.0.1:<端口>/，令牌不会发到别处。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE = 'https://laicrm.com/api/release/waswitch/';
const AUDIENCE = 'laicrm-waswitch-release';
const TOKEN_MAX_AGE_MS = 4 * 60 * 1000;
const TRIES = 3;
const BACKOFF_S = [2, 4, 8];
const MAX_PART = 8 * 1000 * 1000; // Caddy 的请求体上限；来财给的 part_size 比这个大就不对
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const YMLS = ['latest.yml', 'latest-mac.yml'];

// 重试等待的单位（毫秒）；自检时调小
const backoffUnitMs = /^\d+$/.test(process.env.WASWITCH_RELEASE_BACKOFF_MS || '') ? Number(process.env.WASWITCH_RELEASE_BACKOFF_MS) : 1000;

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

function baseUrl() {
  const raw = process.env.WASWITCH_RELEASE_API || DEFAULT_BASE;
  let u;
  try { u = new URL(raw); } catch { fail('WASWITCH_RELEASE_API 不是有效地址'); }
  const ok = (u.protocol === 'https:' && u.hostname === 'laicrm.com' && !u.port) || (u.protocol === 'http:' && u.hostname === '127.0.0.1');
  if (!ok || u.username || u.password || u.search || u.hash) fail('WASWITCH_RELEASE_API 只能是 https://laicrm.com/ 或本机 http://127.0.0.1');
  return u.href.endsWith('/') ? u.href : `${u.href}/`;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ---------- OIDC 令牌 ----------
let oidc = { value: '', at: 0 };
async function oidcToken(force = false) {
  if (!force && oidc.value && Date.now() - oidc.at < TOKEN_MAX_AGE_MS) return oidc.value;
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !reqToken) throw new Error('取不到 OIDC 令牌：job 要有 permissions: id-token: write');
  const full = `${url}${url.includes('?') ? '&' : '?'}audience=${encodeURIComponent(AUDIENCE)}`;
  let lastErr;
  for (let i = 0; i < TRIES; i += 1) {
    try {
      const res = await fetch(full, { headers: { authorization: `bearer ${reqToken}`, accept: 'application/json' }, redirect: 'error' });
      if (!res.ok) throw new Error(`取 OIDC 令牌失败：HTTP ${res.status}`);
      const data = await res.json();
      if (!data || typeof data.value !== 'string' || !data.value) throw new Error('取 OIDC 令牌失败：回的内容不对');
      oidc = { value: data.value, at: Date.now() };
      return oidc.value;
    } catch (e) {
      lastErr = e;
      if (i < TRIES - 1) await sleep(BACKOFF_S[i] * backoffUnitMs);
    }
  }
  throw lastErr;
}

// ---------- 来财的上传接口 ----------
class ApiError extends Error {}

// 发一个请求，最多试 3 次：网络错误、429、5xx 重试；401 换个新令牌再试；别的 4xx 直接失败
async function api(base, method, route, { json, body, query } = {}) {
  const url = new URL(route, base);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  let lastErr;
  let forceToken = false;
  for (let i = 0; i < TRIES; i += 1) {
    let retry = true;
    try {
      const token = await oidcToken(forceToken);
      forceToken = false;
      const headers = { authorization: `Bearer ${token}` };
      let payload;
      if (json !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(json); }
      else if (body !== undefined) { headers['content-type'] = 'application/octet-stream'; headers['content-length'] = String(body.length); payload = body; }
      const res = await fetch(url, { method, headers, body: payload, redirect: 'error' });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      if (res.ok && data && data.ok) return data;
      const code = (data && data.error) || `HTTP ${res.status}`;
      if (res.status === 401) forceToken = true;
      else if (res.status === 429 || res.status >= 500 || (res.ok && !data)) retry = true;
      else retry = false;
      lastErr = new ApiError(`${method} ${route} 失败：${res.status} ${code}`);
      if (res.status === 429 && data && Number(data.retry_after_s) > 0 && i < TRIES - 1) {
        await sleep(Math.min(60, Number(data.retry_after_s)) * backoffUnitMs);
        continue;
      }
    } catch (e) {
      lastErr = e instanceof ApiError ? e : new ApiError(`${method} ${route} 失败：${e.message}`);
    }
    if (!retry) break;
    if (i < TRIES - 1) await sleep(BACKOFF_S[i] * backoffUnitMs);
  }
  throw lastErr;
}

function readPart(fd, offset, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, offset + got);
    if (n === 0) throw new Error('文件读到一半变短了');
    got += n;
  }
  return buf;
}

async function uploadFile(base, version, file) {
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  if (!size) throw new Error(`${name} 是空文件`);
  const start = await api(base, 'POST', 'start', { json: { v: 1, version, name, size } });
  const { key, upload_id: uploadId } = start;
  const partSize = Number(start.part_size);
  if (typeof key !== 'string' || !key || typeof uploadId !== 'string' || !uploadId || !Number.isInteger(partSize) || partSize <= 0 || partSize > MAX_PART) {
    throw new Error(`${name}：来财回的上传信息不对`);
  }
  const fd = fs.openSync(file, 'r');
  try {
    const parts = [];
    const count = Math.ceil(size / partSize);
    for (let n = 1; n <= count; n += 1) {
      const offset = (n - 1) * partSize;
      const body = readPart(fd, offset, Math.min(partSize, size - offset));
      const r = await api(base, 'PUT', 'part', { body, query: { key, upload_id: uploadId, n } });
      if (typeof r.etag !== 'string' || !r.etag) throw new Error(`${name} 第 ${n} 块：来财没回 etag`);
      parts.push({ n, etag: r.etag });
    }
    const done = await api(base, 'POST', 'complete', { json: { v: 1, key, upload_id: uploadId, parts } });
    if (Number(done.size) !== size) throw new Error(`${name}：来财收到 ${done.size} 字节，应该是 ${size}`);
    console.log(`已上传 ${name}（${size} 字节，${count} 块）`);
  } catch (e) {
    try { await api(base, 'POST', 'abort', { json: { v: 1, key, upload_id: uploadId } }); } catch { /* 取消不了也照样报原来的错 */ }
    throw new Error(`${name} 没传成功：${e.message}`);
  } finally {
    fs.closeSync(fd);
  }
}

// 要传的文件：先安装包和 MCP 文件，最后 latest.yml、latest-mac.yml
function pickFiles(dir) {
  const names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile());
  const want = names.filter((n) => /\.(exe|zip)$/i.test(n) || /^waswitch-mcp-.+\.js$/.test(n) || n === 'mcp-module.json').sort();
  const missing = YMLS.filter((y) => !names.includes(y));
  if (missing.length) throw new Error(`缺少 ${missing.join('、')}`);
  const bad = [...want, ...YMLS].filter((n) => !NAME_RE.test(n));
  if (bad.length) throw new Error(`文件名不合规：${bad.join('、')}`);
  return [...want, ...YMLS];
}

async function main() {
  const [dir, tag] = process.argv.slice(2);
  if (!dir || !tag) fail('用法：node scripts/upload-cloud-release.mjs <目录> <tag，例如 v1.0.7>');
  const version = String(tag).replace(/^v/, '');
  if (!VERSION_RE.test(version)) fail(`版本号不对：${tag}`);
  const base = baseUrl();
  let files;
  try { files = pickFiles(dir); } catch (e) { fail(e.message); }
  console.log(`上传 ${version} 到来财：${files.length} 个文件`);
  try {
    for (const name of files) await uploadFile(base, version, path.join(dir, name));
    const r = await api(base, 'POST', 'publish', { json: { v: 1, version } });
    const pruned = Array.isArray(r.pruned) ? r.pruned.length : Number(r.pruned) || 0;
    console.log(`来财已换成 ${r.version || version}，删掉了 ${pruned} 个旧文件`);
  } catch (e) {
    fail(e.message);
  }
}

await main();
