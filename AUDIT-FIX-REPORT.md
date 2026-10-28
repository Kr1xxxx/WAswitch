# WAswitch 审计修复与验证记录

日期：2026-10-28。原审计修复及后续两处回归修复均已完成本地测试和复审。用户随后授权提交独立分支并开 PR；实际分支、PR 和 CI 状态以 GitHub 记录为准。未授权合并或发布版本。真实账号及安装包尚未验收。

## 隔离与 Claude 基线

- 仓库：`Kr1xxxx/WAswitch`。
- 修复在单独的本地克隆中完成，与 Claude 工作目录隔离。
- 本地分支：`codex/fix-audit-20261028`。
- 基线：`3ad4b32ae9353bc26b15bec3616d3be10f58b9b4`，包含 Claude 已合并的 PR #214、#218、#219。
- 已保留选中文字翻译、睫毛术语纠正及输出裁剪。对应翻译与选区测试通过。
- 后续修复开始时 main 为 `cda9b82`（新增 PR #221 动画时长变量、#222 安装器字号），收尾检查又前进至 `a264e7bcb58575d05a3711c7fa118063746f1624`（PR #220 假发词汇默认开启、#223 编辑页状态清理、#225 翻译页独立通道和忙碌/取消状态）。最新快照与旧修复在 `shell.js`、`translate-ipc.js`、`package.json`、CI 文件上重叠；已完成下述临时副本兼容性验证。当前工作分支仍基于 `3ad4b32`，没有合并或 rebase。所检查的 `claude/project-thread-u7i8e3` 仍为 `06806bb354e9627bfc23afaf4a67bc271cd8661b`，`claude/project-thread-u294e1` 仍为 `d3e9c8b03a64cb5850af707b5e6ad20f9f03d67a`。
- 原审计克隆工作区保持干净。未改 Claude 的分支、目录或远端记录。Git 记录无法证明 Claude 是否仍在编辑尚未推送的内容。

## 逐项修复

| 编号 | 问题 | 修复与回归证据 |
| --- | --- | --- |
| 1 | 轻量模式共用草稿导致串聊天 | 按 JID 保存独立草稿；真实 Electron 页面点击切换验证 A/B 草稿互不混入。 |
| 2 | 历史发出消息清空新未读 | 历史同步不清未读；旧 append 也不清；在线发送继续正常清零。真实 ChatStore 与 Session 未读测试通过。 |
| 3 | CRM 大批次 base64 参数溢出 | 使用分块编码；超过 280 KB 的中文/表情请求上传、AES 解密逐项相等、拆批推送均通过。 |
| 4 | 代理旧测试结果用于新凭据 | 测试绑定账号、模式、地址、用户名及实际密码；失败重测、乱序返回、重新打开编辑页都作废旧结果。真实编辑界面验证修改密码后不能凭旧测试保存，迟到结果不显示成功。 |
| 5 | 发送完成清空后来输入 | 仅清除提交时的同一份草稿快照；发送期间改字、切换聊天、发送失败/异常及重试均验证。 |
| 6 | 重名聊天绕过 MCP 读取核对 | 确认前保存聊天编号，读取消息时同一 DOM 快照再次核对；重名换人和混合编号页面均拒绝。 |
| 7 | 主管权限检查存在竞态 | 在 UPDATE 中原子核对目标角色/组及主管当前授权；目标提升、目标换组、主管降级/换组/停用等 5 种交错拒绝，正常修改仍可用。 |
| 8 | 剪贴板等待期间切聊天导致错贴 | 剪贴板写完后重新核对聊天编号、输入框内容及焦点；用户输入/导航会取消操作。真实 DOM 在剪贴板写入期间换到同名聊天时不会调用粘贴；正常原生粘贴仍通过。 |
| 9 | 手动翻译插队导致删错队列任务 | 按任务对象移除已完成任务；运行期间插队后两条均完成、队列清空。 |
| 10 | 排队任务使用另一聊天上下文 | 入队时复制所属聊天的上下文；切到 B 后 A 任务仍只收到 A 的上下文。找不到原消息时不回退到其他聊天内容。 |
| 11 | 译文迁移同名文件丢独有记录 | 按记录键合并，同键较新时间优先；逐个原子落盘成功才移除对应源文件，损坏/写入失败保留来源；未写入的缓存不因切换目录被丢弃。 |
| 12 | 撤销新建忽略后续语言/账号修改 | 创建快照包括语言、账号、提醒和更新时间；人工修改后拒绝删除，历史快照不完整也拒绝；未修改的新建客户仍能撤销。 |
| 13 | MCP 下载写流错误导致崩溃 | 立即监听写流完成/失败，将目录和流错误纳入失败状态并取消下载；实际 EISDIR/EEXIST 故障测试中进程存活，错误明确为存储问题。 |

## 后续复审发现及修复

复审发现两个由最初修复引入的回归；本轮仅修改 `src/draft-place.js`、`src/read-messages.js` 两个业务模块，扩展已有 `check-audit.js` / `check-audit-ui.js` 和本 OpenSpec 变更。

1. **粘贴后立即打字，剪贴板未恢复。** 新测试先在修复前复现：返回 `placed + unconfirmed`，跳过恢复。现在粘贴后的普通输入不再阻止对同一聊天中已出现草稿的确认；导航、销毁、账号不可见或聊天编号变化仍拒绝确认。恢复前仍检查剪贴板是否为本次草稿，保留用户新复制的内容。无草稿证据时仍保留未确认状态，不提前恢复剪贴板。
2. **空标题误报聊天已切换。** 真实 Electron DOM 新测试先在修复前失败。现在定位与读完后的标题均经过同一备用标题规则，并保留独立聊天编号核对；返回标题也与确认提示一致。未放宽重名聊天、标题变化或缺失编号的保护。

本轮新增及复跑的验证：

- `node scripts/check-audit.js`：8 组通过。新增 8 个场景覆盖正常粘贴、粘贴后打字、用户新复制、切聊天、导航、隐藏账号、草稿未出现、粘贴前输入；检查多格式剪贴板恢复和监听器清理。
- `node scripts/run-check-electron.js scripts/check-audit-ui.js`：真实原生粘贴后立即原生按键，确认草稿保留新增字符、剪贴板恢复、无消息发送。无标题的 `@c.us`、`@s.whatsapp.net`、`@g.us`、`@lid` 均能读取，编号变化/缺失仍拒绝。
- `node scripts/run-check-electron.js scripts/check-draft.js scripts/check-read-messages.js scripts/check-wa-page.js scripts/check-sel-translate.js`：全部通过，包括自动/手动放草稿、重名切换、确认期间标题改变、读取权限、选中文字翻译。
- `npm run check:translate`、`node scripts/check-float.js`、`npm run check:mcp`：全部通过，涵盖 Claude 术语/输出裁剪以及 MCP 工具、客户撤销、模块打包与加载。
- 四个本轮修改 JS 文件语法检查、`git diff --check`、`openspec validate fix-audit-findings --strict` 通过。

再次复审本轮增量：未发现新的可复现问题。原有粘贴前保护不变，普通输入仅在粘贴后已有同聊天草稿证据时允许确认；导航和身份变化仍拒绝。标题校验保留原有保护，仅统一空值降级规则。Claude 的选区翻译与术语核心文件没有被本地修复修改。

### 与持续更新的上游做兼容性验证

固定检查范围为 `a264e7bcb58575d05a3711c7fa118063746f1624`。用 `git archive` 导出到临时、无 Git 仓库的目录，把当前未提交补丁先 `git apply --check` 再应用于该副本，并复制新增测试。补丁无冲突，不改当前分支、Claude 工作目录或任何远端分支；不生成合并提交。

该临时副本中的以下检查均退出 0：

- 最新 `npm run check:translate`（含假发默认开启、独立翻译通道），`node scripts/check-float.js`，`node scripts/check-audit.js`，`node scripts/check-editor-save.js`，`npm run check:font-sizes`（含安装器 HTML）。
- 隔离 Electron 顺序执行 `check-audit-ui.js`、`check-editor-ui.js`、最新 `check-add-menu.js`（编辑页状态清理）、最新 `check-trpage-busy.js`（重翻/补翻/纠错忙碌与取消）、`check-sel-translate.js`，全部通过。

这提供了该固定上游快照与补丁共同运行的本地证据。工作分支未同步这些新提交；快照之后的新提交、真实账号和安装包仍不在本次验收范围。

## 首轮验证结果

本机环境：macOS，Node 24.15.0，项目锁定的 Electron 44.9.3。以下最终执行通过：

- `npm run check:audit`：13 项问题的定向回归，包含真实 Electron 草稿及编辑页。
- `npm run check:team`：团队 12 项、后台 33 项、CRM 16 项。
- `npm run check:review`：原有两轮回归 13 项 + 9 项。
- `npm run check:mcp`：工具、权限、客户修改/撤销、模块打包与下载/取消/加载测试。
- `npm run check:lite-unread`、`node scripts/check-lite.mjs`（72/72）。
- `npm run check:translate`、`node scripts/check-float.js`。
- `npm run check:editor`、`npm run check:records`、`npm run check:ports`、`npm run check:atomic`、`npm run check:downloads`。
- `node scripts/run-check-electron.js scripts/check-draft.js scripts/check-read-messages.js scripts/check-wa-page.js scripts/check-float.js scripts/check-sel-translate.js`：相应测试均已分别通过。统一测试入口使用临时 Electron 配置，并在正常退出时还原原剪贴板。
- `npm run check:view-race`：页面崩溃后立即保存，重建出的新页面不被旧重建请求销毁。原测试只改 HOME/XDG_CONFIG_HOME，在本 Mac 上未能启动调试端口；已改为测试入口显式设置临时 userData/sessionData，重跑通过。生产入口未因此修改。
- 所有新增/修改 JavaScript 的语法检查、CI YAML 解析、`git diff --check`。
- `openspec validate fix-audit-findings --strict`。首轮 OpenSpec 的 12 项任务均有实际验证记录；后续两处修复与复审补充 3 项，共 15 项。

新增 `check:audit` 已接入 CI 工作流文件；本文的通过结果均来自本地执行，远端 CI 状态请查看 PR。

## 验证边界

- 所有回归使用合成数据、临时目录或本地仿聊天页面；未发送真实 WhatsApp 消息，未操作生产 CRM/后台。
- 未构建或发布 Windows/macOS 安装包，未做真实 WhatsApp 在线验收。Windows 文件系统行为仍需发布前在 Windows 验收。
- 缺少可验证聊天编号的空聊天或新版 DOM，MCP 会拒绝自动读取/放入草稿；不会只凭联系人名字猜测身份。其他只读翻译功能保留原来的降级读取能力。
- 原生粘贴跨进程，不能将最后一次 DOM 核对与平台粘贴变成一个事务；已消除本次复现的等待竞态、监测用户输入及导航，并在粘贴后无法确认时保留“未确认”状态，不宣称已确认目标。
- 修复代码、测试与 OpenSpec 文件通过独立分支供审阅；没有修改版本号或发布配置。
