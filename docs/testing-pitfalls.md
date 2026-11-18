# 测试的坑

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
- 测断开连接（`ses.closeAllConnections()`，网络切换时会调）的假服务要用 HTTP/2：HTTP/1.1 正在下的请求不会被打断，测不出页面脚本被掐断（`check-blank-view.js`）。开发版设 `WASWITCH_TEST_NET_SIGNAL` 后给主进程发 SIGUSR2 就当网络变了。
- 往输入框填字要一个个加（`value += 'x'`），整段赋值会藏住 bug。
- 整个列表跟着状态重画会清掉用户的选区，复制就失败（#293 修过，#291 又带回来）：只改变了的节点，选区在里面时先不重画，并加一条检查「更新之后选区还在」。Electron fixture 没有 `#content{user-select:text}`，测选区前先设 `host.style.userSelect = 'text'`。
- 点击后会禁用的按钮，别用「内容没变就不重画」的守卫：重试失败、文字没变时按钮会一直灰着（#296）。记住点过，主进程下一条消息来时一定重画。
- 弹层会盖住旁边的气泡，点击测试挑没被盖住的目标。900×600 下工作台里的列表只有约 199px 高，弹层上下都可能放不下：选空间大的一边，限制在面板里。
- FloatCore 用假时钟测会碰到每分钟 20 次的自动上限（`PER_MINUTE`）：每次 ingest 把时间往前拨 61 秒。
- 测设置先调 publicConfig()（懒加载）。默认关的设置如果 save() 每次都写进文件，默认改成开以后就成了「用户选了关」：用一次性标记（#237）。
- 截图里选形变按钮用 `[data-morph^=key]`，morphBtn 的 key 保存前后不能变，不然忙、成功、失败的状态会丢。原生菜单截图：替换 Menu.buildFromTemplate，或者 CDP 加 `import -window root`。
- 新调用了 `window.wa.X`，用替身 preload 的自检就会坏：可选的 wa 接口先判断有没有。

**WhatsApp 页面的 fixture**

- 读写 WhatsApp 页面的改动，要用真实结构的 fixture 测（照 `check-tr-inline.js` 的 `realText`、`realVoice`；`scripts/fixtures/wa-*.html` 还是旧的简化结构）：data-id 在外层包裹上、有 `span[data-icon=tail-in]`、有带 aria-label 的发送人 span、有语音行、有 `@lid` 的会话，不只是 `@c.us`。旧的简化假页面上全过，真 WhatsApp 上语音转写却一字一行。能用真账号看一眼的就看。
- 多账号的 harness 会往错的 WhatsApp 视图里输入：注入每个视图，或者只注入当前显示的那个。
- 记录「对不上」时别只测状态机：模拟输入层变化（同一条消息两次读出来，不可见字符、emoji 不一样），按字母和数字的骨架比较；LRU 重读时要刷新。

**翻译和提示词**

- 改了提示词，用假来财（`scripts/fixtures/fake-cloud.js`）跑；要看真模型的效果，请 shen 在软件里试。
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
- windows-latest 能收真实鼠标：PowerShell 调 user32 的 mouse_event。Electron 的转发钩子不认 SetCursorPos，用 mouse_event(0x8001, 绝对坐标) 移动（代码已删，要用时看 #324 的提交记录）。

**合并前**

- 界面 PR 基本都改 shell.js、shell.css；有冲突的 PR 不跑 CI，大合并后面的审计会漏：合并或审计前先合进最新 main，把 CI 每一项重跑一遍。
