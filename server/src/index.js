// WAswitch 团队后台 Worker 入口。
// 默认拒绝：只有设备接口不需要 Access；其它所有路径（管理接口和管理页面）都必须先验过 Access JWT。
import { fail, HttpError } from './util.js';
import { verifyAccess } from './access.js';
import { handleDevice } from './device.js';
import { handleAdmin } from './admin.js';
import { pushCrm } from './crm.js';

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

function withHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

// 路径必须是规范形式：不允许编码字符、重复斜杠、点段。不规范一律 404，不去猜
function cleanPath(url) {
  const p = url.pathname;
  if (!/^\/[A-Za-z0-9._\/-]*$/.test(p) || p.includes('//') || /(^|\/)\.\.?(\/|$)/.test(p)) return null;
  return p;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = cleanPath(url);
      if (!path) return withHeaders(fail(404, '没有这个地址'));
      if (path.startsWith('/api/device/')) return withHeaders(await handleDevice(request, env, path));
      const identity = await verifyAccess(request, env);
      if (!identity) return withHeaders(fail(403, '请先通过 Cloudflare Access 登录'));
      if (path.startsWith('/api/admin/')) return withHeaders(await handleAdmin(request, env, path, identity));
      if (path === '/' ) return Response.redirect(`${url.origin}/admin/`, 302);
      if (!path.startsWith('/admin/') && path !== '/admin') return withHeaders(fail(404, '没有这个地址'));
      if (request.method !== 'GET' && request.method !== 'HEAD') return withHeaders(fail(405, '只支持 GET'));
      return withHeaders(await env.ASSETS.fetch(request));
    } catch (e) {
      if (e instanceof HttpError) return withHeaders(fail(e.status, e.message, e.extra));
      console.error('unhandled', e && e.stack ? e.stack : e);
      return withHeaders(fail(500, '后台出错了'));
    }
  },

  // 每天清理：状态变化记录留 30 天，操作记录留 180 天，过期登记码和限速记录
  async scheduled(event, env) {
    // 每 30 分钟：把聊天推给来财
    if (event && event.cron === '*/30 * * * *') { await pushCrm(env); return; }
    const t = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM status_events WHERE at < ?').bind(t - 30 * 864e5),
      env.DB.prepare('DELETE FROM audit_log WHERE at < ?').bind(t - 180 * 864e5),
      env.DB.prepare('DELETE FROM enroll_codes WHERE expires_at < ?').bind(t - 864e5),
      env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(t - 864e5),
    ]);
  },
};
