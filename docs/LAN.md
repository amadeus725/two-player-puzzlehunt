# 局域网双人试玩

当前入口：**http://10.7.252.91:3000/**。2026-10-27 已切换至局域网，Cloudflare Quick Tunnel 已关闭。

## 两位玩家如何进入

主机和两台玩家电脑接入能够互相访问的同一局域网，例如同一路由器的 Wi-Fi 或有线网络。两位玩家都打开上面的地址，一人创建房间，把房间码给另一人加入，选择不同角色即可开始。主机也可以兼作其中一位玩家。

新房间默认使用 `demo-v3`：大厅三道区域 meta、西区 final、北区独立题室、东区成对题位和南区水庭。旧房间固定原内容版本；查看新版请创建新房间，旧存档无需重置。

运行游戏的主机保持开机、联网、不睡眠，数据库与游戏进程保持运行。无需云服务器、域名或 Docker。不要向其他电脑分享 localhost 或 127.0.0.1 地址。

当前使用本机 WLAN 的 IPv4 `10.7.252.91`。换网络或重新分配 IP 后可能改变，需要重新生成入口配置。

## 重新启动或换网络

在项目目录运行：

```powershell
cd D:\coding\ph
npm run lan:configure
npm run build
npm run db:local
```

保留数据库终端，再开一个终端运行：

```powershell
cd D:\coding\ph
npm start
```

配置脚本会打印当前 LAN 地址。若检测到多个物理网卡，显式选择电脑已分配的 IPv4，例如 `npm run lan:configure -- 10.7.252.91`。脚本更新 `HOST=0.0.0.0`、精确的 `PUBLIC_ORIGIN` 和 `COOKIE_SECURE=false`，保留原数据库与密钥。已有游戏进程时，修改配置后先停止旧游戏进程再启动，不要同时运行两个游戏服务。

使用 `npm run dev` 也能在 3000 端口提供最近一次构建；修改前端后需要再次 `npm run build`。5173 是仅供本机开发的入口，不需要分享。

## 验证与故障定位

```powershell
npm run test:lan -- http://10.7.252.91:3000
```

命令创建单独测试房间，验证两席位、HTTP Cookie、WebSocket、同步、题面、锁及重连，不修改已有存档。它运行在主机上，另外两台设备仍需实际打开地址确认网络可达。

2026-10-27 检查到 Windows 已允许本项目 Node 程序的 TCP 入站，本次没有新增或修改防火墙规则。数据库仍仅监听 `127.0.0.1:55432`。如果其他电脑打不开，先确认地址未变、确实处于能互通的同一网络；访客 Wi-Fi 或开启设备隔离的网络可能禁止设备互访。可先让三台电脑接入同一个允许互访的普通路由器网络。

## 保留旧存档

旧存档仍在本机数据库。域名/IP 改变后浏览器身份不会自动迁移；在首页点击“换了设备？使用恢复码继续”，输入原房间码和本人席位恢复码。保留 `.env` 和 `.local/postgres`；无需重置数据库。

HTTP 下浏览器的自动剪贴板可能不可用，复制按钮会显示待复制文本供手动复制。房间、标签页和命令 ID 已兼容局域网 HTTP：`randomUUID` 不可用时使用 `getRandomValues`。相关接口条件见 [MDN randomUUID](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)、[MDN getRandomValues](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues)。
