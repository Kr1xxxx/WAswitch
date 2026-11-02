# WAswitch 团队后台

Cloudflare Worker + D1。老板和主管在 `/admin/` 用登录名和密码登录后台网页；员工在 WAswitch 里用自己的登录名和密码登录，软件通过 `/api/device/*` 同步。
不上传聊天内容（聊天同步到来财另说，见下面）、通讯录、代理地址和密码，也不采集员工活动。

## 登录怎么工作

- 每个人一个登录名（小写字母、数字和 `. _ -`，2–32 位）和密码（至少 8 位）。密码只存 PBKDF2-SHA256 哈希（16 字节随机盐，默认 100,000 次）。
- 软件登录：`POST /api/device/login`，换一个设备令牌（库里只存 SHA-256）。带上次的 `device_id` 且是本人的、没被停用，就沿用这台电脑，团队号的坐席不丢。退出登录（`POST /api/device/logout`）或管理员重置密码后，令牌失效（401）。
- 后台网页登录：`POST /api/admin/session`，换一个 12 小时的会话令牌，网页放在 `sessionStorage`，每个请求带 `Authorization: Bearer`。只有老板和主管能登录后台。
- 登录策略在后台 › 设置 › 登录：不用登录 / 提示登录（默认）/ 必须登录。软件每次同步都会拿到最新的，改了立刻生效，不用发版。没登录时也可以 `GET /api/device/policy` 查。
- 限速：同一个 IP、同一个登录名，10 分钟内各最多错 10 次（成功的不算）。失败只记登录名，不记密码。
- 初始化和找回：Worker 的 secret `SETUP_CODE`（至少 12 位）。还没有老板账号时，打开后台网页就是「初始化」，填口令建老板账号；以后忘了老板密码，在登录页点「用初始化口令重置老板密码」。没设 `SETUP_CODE` 时这两样都用不了。
- 可选：再加一道 Cloudflare Access。在 Worker 里设了 `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD` 后，设备接口以外的所有地址都要先过 Access，再要后台密码。只设了一个或设错时，后台一律拒绝。

## 本地自检

```
node server/test/run.mjs        # 后台接口
node scripts/check-team.mjs     # WAswitch 同步模块对着后台跑一遍
```

## 部署（老板做，一次）

D1 数据库 `waswitch-team` 已经建好，`wrangler.jsonc` 里填了它的 ID，迁移也跑完了。剩下 4 步：

1. Cloudflare 控制台 › Workers & Pages › Create › Import a repository，选这个仓库（第一次会让你给 Cloudflare 的 GitHub App 授权，只勾这个仓库），Root directory 填 `server`，Production branch 选 `main`，关掉非 main 分支的构建，部署。
2. 这个 Worker › Settings › Domains & Routes › Add › Custom domain，填 `wa.laicrm.com`（`workers.dev` 和预览网址已在配置里关掉）。
3. 同一页 Variables and Secrets › Add，类型选 Secret，名字 `SETUP_CODE`，值自己想一串长一点的口令（至少 12 位）记好，不要发给任何人。
4. 打开 https://wa.laicrm.com/admin/ ，填 `SETUP_CODE` 建自己的老板账号；再到「人员与电脑」给每个员工建账号（登录名 + 初始密码），把账号密码发给他们。

以后加新的迁移：`npx wrangler d1 migrations apply waswitch-team --remote`（`d1_migrations` 表里记着已经跑过的）。

如果登录时报「超出 CPU 时间」（免费版每个请求 10 ms CPU，密码哈希偶尔会超）：在 Worker 里加变量 `PASS_ITER`，比如 `50000`（最少 10000）。已有的密码在各自下次登录成功时自动换成新次数。如果设了以后还是有人登不进（旧密码按 100,000 次验证，仍然超时），由老板在后台给他重置密码；老板自己登不进就用 `SETUP_CODE` 在登录页重置。

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

Cloudflare 免费版每个账号最多 5 个定时任务，这个 Worker 只用 1 个（每 30 分钟：推送；每天 UTC 19:00 那次顺便清理旧记录），和来财、mailflare 共用。后台“账号”页显示每个号已写入和丢弃的条数；来财拒绝签名时页面顶上会提示。
