// 发验证码邮件。现在用 Resend；以后换发信渠道只改这个文件。
// 码和正文不写日志。
const DEFAULT_FROM = 'WAswitch <no-reply@laicrm.com>';

// 发出去返回 true；没配置或对方报错返回 false（调用方回 503）
export async function sendCode(env, to, code) {
  const key = typeof env.RESEND_API_KEY === 'string' ? env.RESEND_API_KEY.trim() : '';
  if (!key) return false;
  const from = typeof env.MAIL_FROM === 'string' && env.MAIL_FROM.trim() ? env.MAIL_FROM.trim() : DEFAULT_FROM;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      // Workers 不支持 redirect: 'error'（构造请求时直接抛 TypeError）；用 manual，3xx 算失败
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from, to: [to],
        subject: `WAswitch 验证码 ${code}`,
        text: `验证码 ${code}，10 分钟内有效。不是你本人操作，可以不理会。`,
      }),
    });
    if (!res.ok) { console.error('mail send failed', res.status); return false; }
    return true;
  } catch (e) {
    console.error('mail send error', e && e.name);
    return false;
  }
}
