# WAswitch 团队后台

Cloudflare Worker + D1。老板和主管在 `/admin/` 填邮箱收验证码登录后台网页；员工在 WAswitch 里用自己的工作邮箱收验证码登录，软件通过 `/api/device/*` 同步。没有密码。
不上传聊天内容（聊天同步到来财另说，见下面）、通讯录、代理地址和密码，也不采集员工活动。

## 登录怎么工作

- 每个人在后台有名字和工作邮箱。没填邮箱的人登录不了。
- 要码：软件 `POST /api/device/code`，后台网页 `POST /api/admin/code`。6 位数字，10 分钟有效，最多试 5 次，用一次就作废；库里只存哈希，同一个邮箱同一用途只留最新一个。软件的码和后台的码互相不通用。
- 邮箱查不到时明说（软件 404「这个邮箱还没加入团队」，后台 404「这个邮箱没有后台权限」），员工打错邮箱能马上知道；代价是能试出哪些邮箱是员工，靠限速挡住。
- 限速：同一邮箱 60 秒 1 次、1 小时 5 次；同一 IP 1 小时最多要 50 次码；验证时同一 IP 10 分钟 10 次。登录成功的那次不占 IP 的额度（一个办公室共用出口 IP）。码和邮件正文不写日志，操作记录只记邮箱和结果。
- 软件登录：`POST /api/device/login`，换一个设备令牌（库里只存 SHA-256）。带上次的 `device_id` 且是本人的、没被停用，就沿用这台电脑，团队号的坐席不丢；带的是本人被停用的电脑，回 403 `revoked`。退出登录（`POST /api/device/logout`）或管理员点「让他重新登录」后，令牌失效（401）。
- 后台网页登录：`POST /api/admin/session`，换一个 7 天的会话令牌，网页放 `localStorage`，每个请求带 `Authorization: Bearer`。只有老板、主管和 `OWNER_EMAIL` 能登录后台。`OWNER_EMAIL` 一定是老板：第一次登录时自动建档，以后登录时也会确保是老板、没被停用。老板换邮箱或进不去，改这个 secret 就行。
- 登录策略在后台 › 设置 › 登录：不用登录 / 提示登录（默认）/ 必须登录。软件每次同步都会拿到最新的，改了立刻生效，不用发版。没登录时也可以 `GET /api/device/policy` 查。
- 发信在 `src/mail.js`（现在用 Resend），以后换渠道只改这个文件。
- 可选：再加一道 Cloudflare Access。在 Worker 里设了 `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD` 后，设备接口以外的所有地址都要先过 Access，再要邮箱验证码。只设了一个或设错时，后台一律拒绝。

## 本地自检

```
node server/test/run.mjs        # 后台接口（发信是假的）
node scripts/check-team.mjs     # WAswitch 同步模块对着后台跑一遍
```

## 部署（老板做，一次）

D1 数据库 `waswitch-team` 已经建好，`wrangler.jsonc` 里填了它的 ID，迁移也跑完了。剩下 5 步：

1. Cloudflare 控制台 › Workers & Pages › Create › Import a repository，选这个仓库（第一次会让你给 Cloudflare 的 GitHub App 授权，只勾这个仓库），Root directory 填 `server`，Production branch 选 `main`，关掉非 main 分支的构建，部署。
2. 这个 Worker › Settings › Domains & Routes › Add › Custom domain，填 `wa.laicrm.com`（`workers.dev` 和预览网址已在配置里关掉）。
3. 登录 resend.com（没有就注册），Domains › Add Domain 填 `laicrm.com`，按提示把 DNS 加到 Cloudflare，等它变成 Verified；然后 API Keys › Create，权限选 Sending access，复制出来。如果 Resend 里已经验证过别的域名，就用那个，下一步多加一个 `MAIL_FROM`（比如 `WAswitch <no-reply@你的域名>`）。
4. Worker › Settings › Variables and Secrets › Add，类型都选 **Secret**：`RESEND_API_KEY` 粘上一步的 key；`OWNER_EMAIL` 填你自己的邮箱。key 不要发到聊天里。
5. 打开 https://wa.laicrm.com/admin/ ，填你的邮箱收码登录；到「人员与电脑」给每个员工建账号（名字 + 工作邮箱）。先拿自己和一个员工的邮箱各收一次码，确认没进垃圾箱。

以后加新的迁移：`npx wrangler d1 migrations apply waswitch-team --remote`（`d1_migrations` 表里记着已经跑过的）。

## 聊天同步到来财（第 2 步）

团队里每个号都同步，没有按号的开关（私人号不在团队里，不同步）：员工电脑每 10 分钟把团队号单聊里的文字传上来，后台加密暂存，每 30 分钟推给来财（带员工姓名和邮箱，来财按邮箱对上员工），推完就删，最多留 7 天。对不上来财客户的号码，来财也先收下，放在来财的「沟通 › 未匹配的 WhatsApp」里，由那边匹配到客户、建成新客户或不要；来财没收下的（比如格式不对）这边只计数。格式见交接说明文档。

**真实客户上云、来财接收入口验收通过之前不要开。** 没开时员工电脑不上传，聊天留在本机（最多 7 天）。

开的步骤（老板做）：

1. 来财 `laicrm-app` 做好命名入口 `WaswitchIngest` 后，取消 `wrangler.jsonc` 里 `services` 那行的注释。
2. 自己生成两个随机密钥，用 `npx wrangler secret put` 放进这个 Worker，不要发在聊天里：
   - `CRM_KEY`：32 字节随机数的 base64（`openssl rand -base64 32`），加密暂存的聊天、算消息编号。换了它，还没推出去的聊天会作废。
   - `LAICRM_SECRET`：推送签名密钥（`openssl rand -hex 32`），和来财的 `WASWITCH_INGEST_SECRET` 放同一个。
3. 执行迁移（`0004_crm_push.sql` 到 `0006_crm_all_numbers.sql`，`npx wrangler d1 migrations apply waswitch-team --remote`）。
4. 把 `wrangler.jsonc` 里的 `CRM_PUSH` 改成 `"1"`，部署。

Cloudflare 免费版每个账号最多 5 个定时任务，这个 Worker 只用 1 个（每 30 分钟：推送；每天 UTC 19:00 那次顺便清理旧记录），和来财、mailflare 共用。后台“账号”页显示每个号已写入和来财没收下的条数；来财拒绝签名时页面顶上会提示。
