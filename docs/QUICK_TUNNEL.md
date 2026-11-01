# 临时双人联机

**当前已停用。** 用户于 2026-10-27 因公网穿透延迟选择局域网直连，隧道进程已关闭，下列旧网址不再提供游戏服务。当前用法见 [LAN.md](LAN.md)。以下保留为历史测试与备用方案。

2026-10-27 已启动并验证：

**https://again-unions-tune-lamp.trycloudflare.com/**

这个地址仅对本次隧道进程有效。两位玩家各自在自己的电脑打开，一人创建房间，把房间码发给另一人加入，选不同角色即可开始。不要把 `localhost` 地址发给其他电脑。

## 当前连接

玩家浏览器 → Cloudflare HTTPS → 本机 cloudflared → `127.0.0.1:3000` 游戏服务 → 本机 PostgreSQL。

游戏服务提供 `dist/web` 中的构建网页。数据库和开发预览端口没有通过隧道公开。只允许配置中的精确网站 Origin；公网会话 Cookie 已启用 Secure、HttpOnly 和 SameSite=Lax。试玩不需要 Docker、云服务器或 Cloudflare 账号。

当前使用官方 cloudflared 2026.10.4，便携程序在 `.local/tools/cloudflared.exe`，日志在 `.local/cloudflared.log`。SHA256 已与官方发布元数据核对：`411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8`。

## 下次重新启动

在 `D:\coding\ph` 操作。先启动数据库并保持终端运行：

```powershell
npm run db:local
```

另一个终端构建并启动游戏；如果已有游戏服务占用 3000，直接使用已有服务，不再启动第二个进程：

```powershell
npm run build
npm start
```

再开一个终端启动隧道，保持运行：

```powershell
.\.local\tools\cloudflared.exe tunnel --no-autoupdate --url http://127.0.0.1:3000 --logfile .local/cloudflared.log
```

复制输出中的新 `https://….trycloudflare.com` 地址，在 `.env` 的 `PUBLIC_ORIGIN` 中替换旧的隧道域名（多个 Origin 用逗号分隔），确保 `COOKIE_SECURE=true`，然后重启游戏服务。不要改动 `APP_SECRET` 或数据库配置，也不要允许所有 Origin。隧道地址与 localhost 的浏览器身份相互独立；换域名或换设备后，可用原房间码及各自席位恢复码找回进度。

可验证新地址：

```powershell
npm run test:public -- https://这里替换为新域名.trycloudflare.com
```

这个命令会新建测试房间，不动已有存档；通过 HTTPS 验证双人通信、同步、题面、锁和重连。

## 保持与停止

- 主机保持开机、联网、不要睡眠；数据库、游戏服务和隧道均需运行。关掉浏览器不会停止服务器。
- 在隧道终端按 Ctrl+C 即停止对外访问，数据库存档仍保留；不要删除 `.local/postgres` 或 `.env`。
- 本次由助手启动的隧道，其进程号记录在 `.local/tunnel-state.json`。也可以让助手停止此次隧道。
- Quick Tunnel 每次重建会更换域名，没有可用性保证。已完成公网自动化联机和浏览器首页验证；另外两台电脑的实际网络仍需各自打开地址确认。

参考：[Cloudflare Quick Tunnels 官方说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。
