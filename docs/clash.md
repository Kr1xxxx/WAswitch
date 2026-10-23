# 用 Clash 给每个账号分配不同的线路

思路：在 Clash 里为每个节点开一个本地端口，每个 WhatsApp 账号填一个不同的端口。
这样每个账号从不同的节点出去，互不影响，也不用开多个 VPN。

需要支持 `listeners` 的 Clash 内核，也就是 **mihomo（Clash Meta）**。
Clash Verge Rev、Clash Nyanpasu、FlClash、Clash Party 等客户端都内置了 mihomo。
老的 Clash Premium / Clash for Windows 内核不支持这个写法。

## 第 1 步：在配置里加上 listeners

打开客户端的“配置覆写 / 扩展配置 / Merge”（不同客户端叫法不同），加上下面这段。
`proxy:` 后面填你订阅里**节点的完整名称**，要一字不差（可以从客户端的节点列表里复制）。

```yaml
listeners:
  - name: wa-1
    type: socks
    port: 7891
    listen: 127.0.0.1
    udp: true
    proxy: "🇺🇸 美国 01"

  - name: wa-2
    type: socks
    port: 7892
    listen: 127.0.0.1
    udp: true
    proxy: "🇸🇬 新加坡 02"

  - name: wa-3
    type: socks
    port: 7893
    listen: 127.0.0.1
    udp: true
    proxy: "🇯🇵 日本 03"
```

说明：

- 每个账号一段，端口不要重复，也不要和 Clash 自己的 7890 冲突。
- `listen: 127.0.0.1` 表示只有本机能用这些端口，局域网里的其他设备连不上。
- 用 `proxy:` 直接绑定节点，不受 Clash 当前“全局 / 规则”模式和你在界面上选了哪个节点的影响。
- 不要绑定到“自动选择”“故障转移”这类会自己切换的节点组，否则账号的 IP 会变来变去，容易触发 WhatsApp 的风控。

保存后重启 Clash 内核（或点“重新加载配置”）。

## 第 2 步：在 WAswitch 里填端口

右键左边的账号 → “编辑” → 代理填：

```
socks5://127.0.0.1:7891
```

然后点“测试”。成功时会显示出口 IP、国家和时区，并自动把“地区”选好，使时区和语言跟 IP 所在地一致。最后点“保存”。

第二个账号填 `socks5://127.0.0.1:7892`，以此类推。

## 常见问题

**测试显示“代理连不上”**
Clash 没开、端口写错，或者配置里的节点名称不对。在 Clash 的日志里能看到 listener 有没有启动成功。

**Clash 关掉后，账号会不会自动改成直连？**
不会。代理连不上时，这个账号会断网，左边头像会出现黄色的感叹号，而不会悄悄用你本机的真实 IP 连接 WhatsApp。

**语音和视频通话打不通**
通过 socks5 代理时，WhatsApp 网页版的通话可能不可用，这是已知限制。

**可以几个账号共用一个节点吗？**
技术上可以，但它们的 IP 会一样，等于没有做网络隔离。建议一个账号一个节点，而且长期不换。

**机场节点的 IP 很多人共用**
共用 IP 更容易被 WhatsApp 标记。如果对账号安全要求高，可以买静态住宅 IP，在 Clash 里加成节点后同样按上面的方法绑定端口，或者直接在 WAswitch 里填 `http://用户名:密码@IP:端口`。
