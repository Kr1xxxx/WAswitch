# 内置字体

只给 WAswitch 自己的界面用（主窗口、浮窗、MCP 设置页），不注入 WhatsApp 页面。

| 文件 | 字体 | 用在 | 许可 |
| --- | --- | --- | --- |
| `inter/InterVariable.woff2` | Inter 4（可变字重 400–700，只留拉丁字符） | Mac 和 Windows 的英文、数字 | SIL OFL 1.1，见 `inter/OFL.txt` |
| `misans/*.woff2` | 小米 MiSans VF（按官方切片分成 56 块） | Windows 的中文 | 小米 MiSans 免费商用许可；可嵌入软件，需在软件中注明使用了 MiSans（已写在“关于”页） |

- Mac 中文用系统自带的苹方，所以 Mac 安装包不带 `misans/`（见 package.json 的 `build.mac.files`）。
- MiSans 切片来自 npm 包 `misans@5.0.0`（字体版本 4.009），没有改动字形，只把字体名改成 `WAswitch MiSans`。
- Inter 来自 google/fonts，用 fonttools 固定 opsz=14、字重限制在 400–700 并只保留拉丁字符。
- 中文引号、省略号、破折号故意不交给 Inter，让它们跟中文字体走，排版更整齐。
