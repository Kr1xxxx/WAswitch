# AGENTS.md

给改这个仓库的 AI（Codex、Claude 等）和人看。改任何界面之前先读完这一页：界面包括 `src/shell`、`src/popup`、`src/seltr`、`src/mcp/settings.html`、悬浮翻译窗、网页号气泡里的译文块（`src/wa-page.js` 的 `TR_CSS`）、安装包图（`build/art`）和团队后台 `server/public/admin`。

规则来自产品负责人 shen（2026-10-28）。CI 会查其中能自动查的部分，查不到的靠你自己对照。和这里冲突的旧代码，改到哪里顺手改对。

## 0. 不做深色模式

只有浅色界面，现在不做，以后也不做。

- 不写 `@media (prefers-color-scheme: dark)`、`color-scheme: dark`、`data-theme`、`nativeTheme.themeSource = 'dark'`，不生成深色色阶，不加「深色模式」开关。
- 设计稿、截图、harness 只做浅色一套。
- **唯一例外**：放进 WhatsApp 页面里的译文块（`src/wa-page.js` 的 `TR_CSS`）跟着 WhatsApp 自己的主题。WhatsApp 是深色时，这一块用 `src/colors/radix.js` 里的 `dark`（Radix 深色色阶，只收这一块用到的 4 个），浅色时和以前一样。判断看原文的字色，不看软件自己的任何设置。软件自己的界面（侧栏、工作台、设置、悬浮窗、轻量号聊天页）仍然只有浅色。`dark` 和 `RADIX.hexDark` 只许 `src/translate-ipc.js` 的 `inlineLook` 取，`check:agents` 会查。

## 1. 颜色：只用 Radix UI Colors

- 色值的唯一来源是 `src/colors/radix.js`（Radix UI Colors 3.0.0）。`npm run make:colors` 生成 `src/colors/radix.css`。
- CSS 写变量，比如 `var(--slate-11)`、`var(--green-9)`、`var(--slate-a3)`；JS 写 `RADIX.hex('slate', 11)`、`RADIX.WHITE`、`RADIX.TRANSPARENT`；`RADIX.hexDark` 见第 0 节的例外。
- 界面代码里不许直接写颜色：不写 `#hex`、`rgb()`、`hsl()`、颜色名。
- 按 Radix 的分阶用：1–2 页面底色，3–5 控件底色（3 常态、4 悬停、5 按下或选中），6–8 边框和分割线，9–10 实心色块，11–12 文字（11 次要，12 主要）。
- 焦点环全软件一种：`outline: 2px solid var(--focus)`（`--focus` = blue 8）。

## 2. 字号：四种，最小 12px

只用 `src/fonts/fonts.css` 里的四个变量，不加第五种：

| 变量 | 大小 | 用在 |
| --- | --- | --- |
| `--fs-s` | 12px | 次要文字、标签、角标 |
| `--fs-m` | 14px | 正文、按钮、输入框 |
| `--fs-l` | 16px | 小标题 |
| `--fs-xl` | 20px | 页面标题 |

`font-size` 只能写 `var(--fs-*)` 或 `inherit`。层级先靠字重、颜色和间距，能用三种就别用四种。字体用 `var(--font-ui)`。

## 3. 圆角：四档，内外同心

`src/tokens.css`：

| 变量 | 大小 | 用在 |
| --- | --- | --- |
| `--r-s` | 6px | 标签、小控件 |
| `--r-m` | 10px | 输入框、按钮、列表行 |
| `--r-l` | 14px | 卡片、面板 |
| `--r-full` | 999px | 角标、开关、进度条、转圈 |

圆角只能写 `0`、`inherit` 或这四个变量。套在里面、贴着外框角的圆角要同心：内圆角 = 外圆角 − 内边距（14 − 8 = 6，10 − 4 = 6）。按视觉对齐，不只按盒子对齐（图标、圆形按钮要看起来居中）。

## 4. 线：0.5px

边框、分割线、描边一律 `var(--hair)`：高分屏 0.5px，普通屏 1px（Windows 100% 缩放下 0.5px 会变淡或消失）。焦点环、选项卡下划线、选中环、转圈、图标线条可以粗一些。

## 5. 动效：只有一种

- 时长只用 `var(--fx)`（250ms），曲线只用 `var(--fx-ease)`（ease-out）。动哪个属性不限。
- 系统开了「减少动态效果」时 `--fx` 自动变 0ms。
- 唯一例外是加载转圈 `spin .9s linear infinite`。
- 能不动就不动：不做弹簧、过冲、扫光、交错入场这类装饰动效。

## 6. 阴影和装饰

- 少用阴影和圆角，不随手加。
- 卡片不加彩色左边线。
- 不加装饰性的图标、渐变、插画。

## 7. 文字

- 界面是中文，读者是做外贸的业务员：好懂，但不口语化；长度合适它的位置；不造词。
- 不加解释性的文字。标题和按钮说得清的，不再加一行说明、副标题或占位提示。
- 不用中点「·」当分隔符。几段并排用间距（`shell.js` 的 `segs()`）、换行或标点。
- 示例、默认值、演示数据用欧美客户：英、德、法、西等语言，欧美时区和号码。

## 8. 少让用户做决定

- 能撤回的操作直接做，不弹确认框，事后在底部给「撤销」（主进程 `offerUndo()`，见 `src/undo.js`）。
- 只有撤不回的才确认：删除账号、给 AI 读聊天的授权、放弃没保存的编辑。
- 必须让用户选的，放在用户本来就在选的地方；能自动判断的，不做成设置项。
- 按重要程度排元素，次要的往后放或收起来。

## 9. 输入框

文本框上判断回车时一定带输入法守卫，选字时的回车不算提交：

```js
if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
```

`npm run check:ime-enter` 会查：判断回车的 keydown/keyup/keypress 处理里没有这两个判断就报错。

## 10. 只有一个仓库，私有

源码和安装包都在 `Kr1xxxx/WAswitch`，仓库是私有的（2026-11-03 定下不拆仓库，没有单独的公开安装包仓库）。`release.yml` 打包后把安装包发到本仓库的 Releases，再传到来财（`scripts/upload-cloud-release.mjs`）。已装的软件（1.0.7 起）只从来财 `laicrm.com/api/device/update/` 检查更新、下载 MCP 文件，带团队登录的设备令牌（`src/updater.js`、`package.json` 的 `build.publish`）；GitHub Releases 只留历史。

私有不等于可以放敏感内容：代码、注释、测试数据、截图里不放密钥、令牌、真实客户的名字、号码和聊天内容（协作者、AI 和 CI 都看得到，仓库将来也可能再公开）。安装包会装到每台业务电脑上，里面的代码是明文，也按公开的东西写。

## 11. 按所在区域的大小排版

- 样式里不按窗口宽高写 `@media (max-width…)`、`@media (max-height…)`，用容器查询：`@container card`（右侧整张卡片的宽高）、`@container tp-pane`（翻译页一栏的宽）。`npm run check:container` 会查。
- 窗口窄时收侧栏、收工作台由主进程判断（`src/main.js` 的 `NARROW_SIDE`、`NARROW_PANEL`），样式层不管。
- 顶栏放不下时按优先级整块藏起（`shell.js` 的 `fitTop`），不用省略号；它看顶栏自己的宽度。
- 中文标签、按钮、角标不能被挤成一字一行：加 `white-space: nowrap`，需要缩时给 `min-width: 0`，不要 `word-break: break-all`。

## 提交前

改了界面至少跑这些（全部列表在 `.github/workflows/ci.yml`）：

```sh
npm run check:agents        # 本页提到的变量都存在；没有新的深色模式写法
npm run check:middot        # 没有中点「·」
npm run check:ime-enter     # 回车处理带输入法守卫
npm run check:font-sizes    # 只有四种字号
npm run check:radius-motion # 圆角四档、动效 250ms ease-out
npm run check:colors        # 只用 Radix 颜色
npm run check:container     # 没有按窗口宽高写的 @media
xvfb-run -a -s "-screen 0 1920x2000x24" npm run check:visual   # 组件总览页和基准图逐像素一致
```

`check:visual` 把组件总览页（`scripts/visual/components.html`）按 1 倍、2 倍缩放截图，和 `scripts/visual/baseline` 里的图比，差一个像素也会红。有意改了控件的样子：在 Linux 上加 `-- --update` 重新生成，看一眼新图没问题，和改动放在同一个 PR 里提交。新加的控件或状态，放进总览页里最合适的那一块再更新基准图。Mac、Windows 上这个检查会直接跳过。

改了哪个界面，就把对应的 Electron 自检也跑一遍（`xvfb-run -a npx electron --no-sandbox scripts/check-*.js`）。窗口最小 900×600，右侧工作台 380px 宽，在这两个尺寸下文字不能被裁掉或换行变形。

## 测试的坑

以前的 PR 踩过的坑。写测试、跑自检之前看一眼，每条后面是该怎么做。

**环境**

- 沙箱里 `npm ci` 装不上 Electron（postinstall 下载会崩）：用 curl 把 GitHub Release 的 zip 下到 `node_modules/electron/dist` 解开，再 `printf electron > node_modules/electron/path.txt`。path.txt 只写 `electron`，写成 `dist/electron` 时 `npx electron` 会说没装好并重新下载。
- xvfb-run 默认屏幕 640×480，会卡住窗口宽度：截图、量布局时加 `-s "-screen 0 3000x2000x24"`。
- 自检要端口就 listen(0) 拿（`check-qr-watch.js` 的 `freePort`），不要在 40000–60000 里随机挑：会撞上 Linux 临时端口，TIME_WAIT 里的连接让 listen() 报 EADDRINUSE 约 60 秒。
- 后台还在跑 Electron 自检时不要切分支、不要改源码：自检会加载到旧文件，看起来像 PR 的 bug。要比几种情况，在一条命令里按顺序跑。

**Electron 自检**

- xvfb 下窗口要 `show: true`（不显示就没有 requestAnimationFrame），并调 `app.disableHardwareAcceleration()`（不然 capturePage 会抛错）。
- 窗口崩了自检照样退出 0：`window-all-closed` 里什么都不做，通过的标记写到 stderr，由外面判断。
- 窗口最小宽 900 时页脚会被裁：自检里先 `win.setSize(900, 600)` 再量。
- Electron 44 的剪贴板全是异步的（read、write、readText、writeText、has、clear，没有 readImage、availableFormats）：先 `await writeText` 再 paste()；查图片用 `await clipboard.read()` 看 item.types（如 image/png）。xvfb 下读到没有类型的项就跳过。
- `sendInputEvent` 不触发 `before-mouse-event`，也不移动焦点：测按下鼠标的逻辑时手动 `wc.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseDown' })`。焦点、复制这类问题它测不出来，用 XTest（python ctypes 调 libXtst）在 xvfb 里发真实输入；想知道一次点击里事件的真实顺序也用 XTest 探。
- 新建的 WebContentsView 在 did-start-loading 时就抢键盘焦点（隐藏的也抢），用到时才建的浮层会抢走页面的 Ctrl+C：浮层没收到 mouseDown 就把焦点还回去，用 XTest 测。
- `sendInputEvent` 可能比后面的 executeJavaScript 晚到：等页面确实收到事件再往下。`ipcRenderer.invoke` 的回复也可能比后面的 `webContents.send` 晚到（探了 3000 次，505 次如此）：别让 invoke 结果直接盖掉推送来的状态，主进程给状态编号，留最新的（#310 工作台的 `seq`）。
- xvfb 下查 focus-visible 要先 `win.focus()` 再 `webContents.focus()`。
- 往输入框填字要一个个加（`value += 'x'`），整段赋值会藏住 bug。
- 整个列表跟着状态重画会清掉用户的选区，复制就失败（#293 修过，#291 又带回来）：只改变了的节点，选区在里面时先不重画，并加一条检查「更新之后选区还在」。Electron fixture 没有 `#content{user-select:text}`，测选区前先设 `host.style.userSelect = 'text'`。
- 点击后会禁用的按钮，别用「内容没变就不重画」的守卫：重试失败、文字没变时按钮会一直灰着（#296）。记住点过，主进程下一条消息来时一定重画。
- 弹层会盖住旁边的气泡，点击测试挑没被盖住的目标。900×600 下工作台里的列表只有约 199px 高，弹层上下都可能放不下：选空间大的一边，限制在面板里。
- FloatCore 用假时钟测会碰到每分钟 20 次的自动上限（`PER_MINUTE`）：每次 ingest 把时间往前拨 61 秒。
- 测设置先调 publicConfig()（懒加载）。默认关的设置如果 save() 每次都写进文件，默认改成开以后就成了「用户选了关」：用一次性标记（#237）。
- 截图里选形变按钮用 `[data-morph^=key]`，morphBtn 的 key 保存前后不能变，不然忙、成功、失败的状态会丢。原生菜单截图：替换 Menu.buildFromTemplate，或者 CDP 加 `import -window root`。
- 新调用了 `window.wa.X`，用替身 preload 的自检就会坏：可选的 wa 接口先判断有没有，本地把 CI 列表全跑一遍。

**WhatsApp 页面的 fixture**

- 读写 WhatsApp 页面的改动，要用真实结构的 fixture 测（照 `check-tr-inline.js` 的 `realText`、`realVoice`；`scripts/fixtures/wa-*.html` 还是旧的简化结构）：data-id 在外层包裹上、有 `span[data-icon=tail-in]`、有带 aria-label 的发送人 span、有语音行、有 `@lid` 的会话，不只是 `@c.us`。旧的简化假页面上全过，真 WhatsApp 上语音转写却一字一行。能用真账号看一眼的就看。
- 多账号的 harness 会往错的 WhatsApp 视图里输入：注入每个视图，或者只注入当前显示的那个。
- 记录「对不上」时别只测状态机：模拟输入层变化（同一条消息两次读出来，不可见字符、emoji 不一样），按字母和数字的骨架比较；LRU 重读时要刷新。

**翻译和提示词**

- 改了提示词，用真实模型跑真句子，每种开关组合都跑一遍（只用免费模型）。只看单元测试会漏。
- 改了 translate() 的兜底，跑 `seed: true` 的情况。
- 译文里多出奇怪的文字（如【要点】），先 grep 提示词，多半是 `DEFAULT_MODES` 带的；已经种进用户数据的用 updateModes 改。

**截图和像素对比**

- Playwright 模拟缩放会把 0.5px 边框画假，setContent 不加载 file:// 字体：截图用 Electron 加 xvfb，`electron --force-device-scale-factor=2`，页面用 goto 打开文件。
- 抗锯齿边缘的像素会闪：用 Skia 参数和自己的 fonts.conf（`scripts/visual`），2 倍基准图名字带 -2x。
- 往组件总览页加元素，2 倍下后面每块会挪半个 CSS 像素（shoot.js 把截图区域取整），后面的基准图全变：新元素给整数高度，加完在 2 倍下核对各块的顶边。

**存储和数据目录**

- 改了存储格式：用旧代码（origin/main 的 worktree）写，再用新代码在同一个目录读。
- 读失败不能当成空，不然下次保存会清掉文件：ENOENT 和别的错分开，坏文件先备份，没读成功的文件不覆盖。要测读到坏文件的情况。
- 往旧位置写指针文件前先 mkdirSync（软件已经不建那个目录了），用不存在的 home 目录测。
- 放在 %APPDATA% 以外的共用路径（D:\、ProgramData）：用两个 Windows 用户对同一个根目录测，并标记归属。
- 自动同步（direct-tz）会盖掉编辑器里用户还能改的值：要么锁住这个字段，要么记一个手动标记。

**安装包和 Windows CI**

- NSIS 的警告就是错误（卸载器那一遍里没用到的函数）：customHeader 里的函数包在 `!ifndef BUILD_UNINSTALLER` 里。
- Windows 安装包测试：安装、更新后约 1 秒内系统会锁 WAswitch.exe 0.3–0.5 秒，卸载器只删一次就跳过了，看起来像卡住 240 秒。卸载前等 exe 能删；判断卸完看注册表键不看文件，注册表键最后才清，要等它。
- windows-latest 能收真实鼠标：PowerShell 调 user32 的 mouse_event。Electron 的转发钩子不认 SetCursorPos，用 mouse_event(0x8001, 绝对坐标) 移动（#324 在 `smoke-packaged.js` 里临时加过）。

**合并前**

- 界面 PR 基本都改 shell.js、shell.css；有冲突的 PR 不跑 CI，大合并后面的审计会漏：合并或审计前先合进最新 main，把 CI 每一项重跑一遍。
