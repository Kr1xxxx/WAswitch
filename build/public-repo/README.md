# WAswitch

在一个窗口里同时登录多个 WhatsApp 账号的桌面软件，支持 Windows 和 macOS（Mac 只支持 Apple 芯片）。

## 下载

在 [Releases](https://github.com/Kr1xxxx/WAswitch/releases) 下载最新的安装包：

- **Windows**：`WAswitch-Setup-版本号.exe`
- **macOS**：`WAswitch-版本号-arm64.dmg`

已经装好的 WAswitch 登录团队后会自己检查并更新，不用重新下载。1.0.6 和更早的版本要手动装一次 1.0.7（直接覆盖安装，数据都在），之后就能自动更新。

## 第一次打开

安装包没有代码签名，第一次打开时系统会拦一下：

- **Windows**：出现“Windows 已保护你的电脑”时，点“更多信息”，再点“仍要运行”。
- **macOS**：把 WAswitch 拖进“应用程序”后，在“应用程序”里右键点 WAswitch，选“打开”，再点“打开”。macOS 15 及以后右键打开不再放行：先双击一次（会提示无法打开），然后去 系统设置 › 隐私与安全性，在页面下方点“仍要打开”。如果提示“已损坏”，在终端运行 `xattr -cr /Applications/WAswitch.app` 后再打开。

## 使用说明

- [用 Clash 给每个账号分配不同的线路](docs/clash.md)
