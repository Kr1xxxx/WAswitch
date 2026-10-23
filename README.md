# WAswitch

在一个窗口里同时登录多个 WhatsApp 账号的桌面软件（Windows / macOS / Linux）。

## 原理

基于 Electron。每个账号加载 `https://web.whatsapp.com`，并使用独立的 session 分区
（`persist:wa-<id>`），所以每个账号的 cookie、本地存储和登录状态完全隔离，关掉软件再打开也不用重新扫码。

为什么不做成纯网页：WhatsApp Web 禁止被 iframe 嵌入，而且同一个浏览器里的多个标签页共享同一份登录状态，
网页版无法真正“多开”。桌面应用没有这个限制。

## 功能（当前版本）

- 左侧账号栏，点击切换账号
- `+` 添加新账号（扫码登录）
- 双击改名，右键删除（会清除该账号的登录数据）
- 未读消息数角标

## 本地运行

需要 Node.js 18+。

```bash
npm install
npm start
```

## 打包安装包

```bash
npm run dist
```

产物在 `dist/` 目录。

## 后续计划

- 每个账号单独设置代理
- 桌面通知区分账号
- 托盘图标和总未读数
- 账号头像、拖动排序

## 注意

本项目只是把官方 WhatsApp Web 放在独立会话里打开，不修改、不自动化 WhatsApp 的任何功能。
请遵守 WhatsApp 的服务条款。
