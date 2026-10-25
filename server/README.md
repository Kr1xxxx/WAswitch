# WAswitch 团队后台

Cloudflare Worker + D1。管理员网页在 `/admin/`（Cloudflare Access 登录），WAswitch 通过 `/api/device/*` 同步。
设计和审计：见项目里的设计文档。第一阶段只有登记、坐席分配和状态监控；不上传聊天内容、通讯录、代理地址和密码，也不采集员工活动。

## 本地自检

```
node server/test/run.mjs        # 后台接口
node scripts/check-team.mjs     # WAswitch 同步模块对着后台跑一遍
```

## 部署（老板在 Cloudflare 控制台做，一次）

1. 建 D1 数据库 `waswitch-team`，把它的 ID 填进 `wrangler.jsonc` 的 `database_id`，按文件名顺序执行 `migrations/` 下所有尚未执行的迁移（也可以运行 `npx wrangler d1 migrations apply waswitch-team --remote`）。已有部署要先执行 `0003_atomic_seats.sql`，再部署新版 Worker；迁移会清理历史重复坐席并补发隐藏版本。
2. Workers 里从 GitHub 导入本仓库，根目录填 `server`，只从 `main` 分支部署，关掉非生产分支的构建。
3. 给 Worker 绑一个自定义域名（`workers.dev` 和预览网址已在配置里关掉）。可以用已有域名下单独一个子域名，比如来财域名下的 `wa.<来财域名>`，同一个 Cloudflare 账号即可，不影响来财本身。
4. Zero Trust 里加“一次性验证码”登录方式，再加一个 Access 应用，只保护这个子域名下的两个路径：`/admin` 和 `/api/admin`，策略只写允许的邮箱列表。**不要**把 `/api/device/` 放进 Access：WAswitch 用自己的设备令牌登录，被 Access 拦住就同步不了。Access 只罩这个子域名的这两个路径，来财的其它地址不受影响。
5. Worker 的环境变量：`OWNER_EMAIL`（老板邮箱）、`ACCESS_TEAM_DOMAIN`（如 `xxx.cloudflareaccess.com`）、`ACCESS_AUD`（Access 应用的 AUD 标签）。

没配好 Access 变量时，除了设备接口，所有地址一律拒绝。

