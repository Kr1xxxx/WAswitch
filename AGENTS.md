# AGENTS.md

给改这个仓库的 AI（Codex、Claude 等）和人看。改任何界面之前先读完这一页：界面包括 `src/shell`、`src/popup`、`src/seltr`、`src/mcp/settings.html`、悬浮翻译窗、安装包图（`build/art`）和团队后台 `server/public/admin`。

规则来自产品负责人 shen（2026-10-28）。CI 会查其中能自动查的部分，查不到的靠你自己对照。和这里冲突的旧代码，改到哪里顺手改对。

## 0. 不做深色模式

只有浅色界面，现在不做，以后也不做。

- 不写 `@media (prefers-color-scheme: dark)`、`color-scheme: dark`、`data-theme`、`nativeTheme.themeSource = 'dark'`，不引入 `src/colors/radix-dark.css`，不加「深色模式」开关。
- 设计稿、截图、harness 只做浅色一套。
- 老代码里还剩两处跟系统深色走的样式：新消息弹窗（`src/popup/popup.css`、`src/popup/index.html`）和团队后台（`server/public/admin/admin.css`、`index.html`）。不要扩展它们；`npm run check:agents` 不许别的文件再出现深色写法。

## 1. 颜色：只用 Radix UI Colors

- 色值的唯一来源是 `src/colors/radix.js`（Radix UI Colors 3.0.0）。`npm run make:colors` 生成 `src/colors/radix.css`。
- CSS 写变量，比如 `var(--slate-11)`、`var(--green-9)`、`var(--slate-a3)`；JS 写 `RADIX.hex('slate', 11)`、`RADIX.WHITE`、`RADIX.TRANSPARENT`。
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

## 10. 公开仓库

仓库是公开的。代码、注释、测试数据、截图里不放密钥、令牌、真实客户的名字、号码和聊天内容。

## 11. 按所在区域的大小排版

- 样式里不按窗口宽高写 `@media (max-width…)`、`@media (max-height…)`，用容器查询：`@container card`（右侧整张卡片的宽）、`@container trpage`（翻译页的宽高）、`@container tp-pane`（翻译页一栏的宽）。`npm run check:container` 会查。
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
