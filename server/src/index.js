// WAswitch 团队后台 Worker 入口。默认拒绝：
// - /api/device/*：设备令牌（登录、看策略这两个不要令牌）
// - /api/admin/session、/api/admin/setup：不要会话（登录、初始化）
// - 其它 /api/admin/*：后台会话
// - /admin/*：静态页面，里面没有数据，直接给
// 配了 Cloudflare Access（ACCESS_TEAM_DOMAIN 或 ACCESS_AUD 任何一个）时，设备接口以外的所有地址还要先过 Access。
import { fail, HttpError } from './util.js';
import { verifyAccess } from './access.js';
import { resolveSession, handleOpenAdmin } from './session.js';
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
      // 只配了一半或配错也算配了：一律拒绝，不悄悄退回只靠密码
      if ((env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD) && !(await verifyAccess(request, env))) return withHeaders(fail(403, '请先通过 Cloudflare Access 登录'));
      if (path === '/api/admin/session' || path === '/api/admin/setup') return withHeaders(await handleOpenAdmin(request, env, path));
      if (path.startsWith('/api/admin/')) {
        const user = await resolveSession(request, env.DB);
        return withHeaders(await handleAdmin(request, env, path, user));
      }
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

  // 定时任务只有一个（每 30 分钟）：免费版一个账号最多 5 个，和来财共用。
  // 每次都推聊天（CRM_PUSH 没开时只删过期的）；每天 UTC 19:00 那一次顺便清理旧记录
  async scheduled(event, env) {
    const at = event && Number.isFinite(event.scheduledTime) ? event.scheduledTime : Date.now();
    const errors = [];
    try { await pushCrm(env); } catch (e) { errors.push(e); }
    if (isCleanupSlot(at)) {
      try { await cleanup(env.DB); } catch (e) { errors.push(e); }
    }
    if (errors.length) throw errors[0];
  },
};

export const isCleanupSlot = (ms) => { const d = new Date(ms); return d.getUTCHours() === 19 && d.getUTCMinutes() < 30; };

// 状态变化记录留 30 天，操作记录留 180 天，过期的登记码、限速记录和后台会话
export async function cleanup(db) {
  const t = Date.now();
  await db.batch([
    db.prepare('DELETE FROM status_events WHERE at < ?').bind(t - 30 * 864e5),
    db.prepare('DELETE FROM audit_log WHERE at < ?').bind(t - 180 * 864e5),
    db.prepare('DELETE FROM enroll_codes WHERE expires_at < ?').bind(t - 864e5),
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(t - 864e5),
    db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(t),
  ]);
}
