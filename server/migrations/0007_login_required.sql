-- 公司规定：WAswitch 必须先登录团队才能用（2026-11-03）。登录设置改成「必须登录」，后台不再提供开关。
-- 私人号同样不许有，那个是代码里写死的（device.js allowPrivate），不改数据。
UPDATE meta SET value = 2 WHERE key = 'login_policy';
