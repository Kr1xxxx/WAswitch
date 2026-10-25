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


## 聊天同步到来财（第 2 步）

员工电脑每 10 分钟把开了“同步到 CRM”的号的聊天传上来，后台加密暂存，每 30 分钟推给来财，推完就删，最多留 7 天。对不上来财客户的消息直接丢掉，只计数。格式见交接说明文档。

**真实客户上云、来财接收入口验收通过之前不要开。** 没开时员工电脑不上传，聊天留在本机（最多 7 天）。

开的步骤（老板做）：

1. 来财 `laicrm-app` 做好命名入口 `WaswitchIngest` 后，取消 `wrangler.jsonc` 里 `services` 那行的注释。
2. 自己生成两个随机密钥，用 `npx wrangler secret put` 放进这个 Worker，不要发在聊天里：
   - `CRM_KEY`：32 字节随机数的 base64（`openssl rand -base64 32`），加密暂存的聊天、算消息编号。换了它，还没推出去的聊天会作废。
   - `LAICRM_SECRET`：推送签名密钥（`openssl rand -hex 32`），和来财的 `WASWITCH_INGEST_SECRET` 放同一个。
3. 执行迁移 `0004_crm_push.sql`。
4. 把 `wrangler.jsonc` 里的 `CRM_PUSH` 改成 `"1"`，部署。

Cloudflare 免费版每个账号最多 5 个定时任务，这个 Worker 用 2 个（每天清理、每 30 分钟推送），和来财、mailflare 共用。后台“账号”页显示每个号已写入和丢弃的条数；来财拒绝签名时页面顶上会提示。
