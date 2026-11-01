# 共行 · 双人 Puzzlehunt

可在浏览器中联机的占位试玩版。React + Vite 前端，Node.js 24 + Socket.IO 服务端，PostgreSQL 18 持久化存档。玩法以 [PLAN.md](PLAN.md) 为准。

协同开发的分支、提交流程和内容版本约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

已实现两席位房间、独立选角与操作、推动、格间墙、五图共同传送、私人题面和 NPC 窗口、共享答案与锁、双解 final、首次通关记录、刷新和断线恢复。题面与答案目前都是明示答案的功能测试内容；剧本、正式关卡和贴图以后替换。

新房间默认使用 `demo-v3` 区域布局：大厅放北／东／南三个 meta，西区放 final，三个 meta 首次同时解开后永久开放西区。北区两间题室各放一道独立普通题；东区放置左右成对的占位题；南区使用水池与步道占位。正式镜像表达、水机制与小游戏等题例确定后再实现。旧房间仍使用原 `demo-v2`，**请创建新房间查看新地图**。设计见 [PLAN.md](PLAN.md) 第 1.1–1.5 节。

## 本机启动

在项目目录安装依赖：

```powershell
npm install
```

工程安装本地 Node.js 24，npm 脚本会使用它，不需要改系统 Node。首次安装时若系统是其他版本，npm 可能提示 engines 警告。

Windows 开发可启动项目自带 PostgreSQL，**保留这个终端**：

```powershell
npm run db:local
```

另一个终端启动网页和服务：

```powershell
npm run dev
```

打开 **http://127.0.0.1:5173/**。第一次启动自动生成仅本地保存的 `.env` 和随机 `APP_SECRET`；数据库在 `.local/postgres`。终端 Ctrl+C 停止各自服务；数据库也可用 `npm run db:local:stop` 停止。

如果 Docker 引擎可用，可以用 `npm run db:up` 替代 `db:local`。两种方式共用端口 55432，选择其中一种；其存档分别存在 Docker 卷和 `.local/postgres`，不会自动互相转换。本机此次使用原生 PostgreSQL 18.4，因为 Docker 引擎未能启动。

## 两个人如何试玩

1. 第一位玩家创建房间，分享房间码或邀请链接。
2. 第二位玩家用另一台电脑的网页加入同一房间。两人各选一个角色，地图自动开始。
3. WASD / 方向键移动；在题号格按 **V** 开题；面对相邻旅人按 **X** 对话。Esc 关题，X 或 Esc 结束交谈。
4. 保存各自侧栏中的席位恢复码，用于换设备续玩。邀请链接只用于加入，不会接管已有角色；相同席位的另一标签需要主动点击“接管此角色”。

本机检查时，可分别打开 `127.0.0.1:5173` 与 `localhost:5173`，这两个主机名有独立 Cookie，可以模拟两名玩家。也可以使用两个独立浏览器配置。**同一主机名的普通标签页共享身份，不能模拟两个人。**

当前按用户决定采用局域网直连，入口为 **http://10.7.252.91:3000/**。两台玩家电脑与主机接入能互通的同一局域网，一人创建房间，另一人用房间码加入；主机保持开机运行。换网络或重启后的配置方法见 [局域网联机说明](docs/LAN.md)。Cloudflare 隧道已停止；长期公网托管方案仅作备用。

## 占位关卡

| 地点 | 内容 | 测试答案 |
| --- | --- | --- |
| 大厅 (5,2) | MN：北区 Meta | `NORTH` |
| 大厅 (8,4) | ME：东区 Meta | `EAST` |
| 大厅 (5,6) | MS：南区 Meta | `SOUTH` |
| 北区 (3,2) | N1-A：第一部分，独立通过 | `LEAF` |
| 北区 (7,2) | N1-B：第二部分，独立通过 | `STONE` |
| 东区 (3,2)、(7,2) | E1-A、E1-B：镜像题对位置占位 | `LEFT`、`RIGHT`（分别提交） |
| 南区 (3,5)、(7,5) | S1、S2：水主题题目占位 | `WATER`、`FLOW`（分别提交） |
| 西区 (5,3) | F：final meta，两种正确解 | `DONE` 或 `AGAIN` |
| 大厅 (5,4) | 旅人对话 | 面向相邻旅人按 X |

坐标从左上角 (0,0) 开始。四组门分别连接中图与四方地图，两人站齐一组的两个门才会传送。落地后先离开门再站齐，才能返回。

西区门首次集齐三道 meta 后永久开放；普通题号锁仍随控制题答案改错重新上锁，锁上有人时原地受困，直到控制题重新解开。新版布局暂未放普通锁，旧版房间保留 `OPEN` / `TWO` 的锁与救援测试。空白和超过 256 个 Unicode 码点的输入属于格式错误，不覆盖原答案。final 首次答对后永久记录通关，但继续允许移动、提交其他解或改错。

## 验证命令

```powershell
npm run validate
npm test
npm run test:integration
npm run build
```

集成测试需要正在运行的 PostgreSQL；默认连接本地开发数据库，也可设置 `TEST_DATABASE_URL`。每次创建随机测试 schema，完成后只删除本次 schema，不改开发存档。测试使用独立 Cookie 与真实 HTTP / Socket.IO / PostgreSQL，覆盖并发选角、答题、五图移动、权限隔离、事务失败、去重、接管、进程重启和备份恢复。

当前结果与尚未验收内容见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。

新增的 Bug 审查与修复记录见 [docs/BUG_REVIEW.md](docs/BUG_REVIEW.md)。约 92 秒的旧版 `demo-v2` 双视角演示视频位于 [artifacts/demo/puzzlehunt-demo.mp4](artifacts/demo/puzzlehunt-demo.mp4)，包含受困/解救、传送与 final 双解；视频不代表新版区域布局。

## 修改内容

- [题库](content/puzzle-bank/README.md)：已收录的原始题面与索引，供后续补充答案和安排区域；尚未接入游戏的题目保存在这里。
- `content/public/demo-v3/game.json`：当前新房间的地图、题号、Markdown 题面、NPC、传送门和角色定义。这里的 public 是内容分类，不是静态托管目录；服务端会移除题面正文后才发送公共地图配置。
- `content/private/demo-v3/answers.json`：服务端判题规则，绝不放入前端产物。`demo-v2` 目录继续供旧房间加载。
- `apps/web/src/style.css`：当前几何占位图形、布局和角色外观。正式贴图到位后在相同图层替换，碰撞由服务端网格规则决定。
- `apps/server/engine.ts`：纯规则计算；`store.ts`：事务和去重；`app.ts`：HTTP 与实时通信。

现有存档固定 `contentVersion`。变更关卡时新增版本目录，并更改服务端的新房默认版本；保留旧版本目录，不要原地改动已有存档使用的内容。执行 `npm run validate` 检查配置。首版没有剧情效果脚本引擎。

## 备份与恢复

```powershell
npm run backup
npm run restore -- .local-backups/<备份文件名>.json
```

备份使用 PostgreSQL 的一致性只读事务导出四张应用表，并记录内容版本哈希、校验和。备份目录默认 `.local-backups`，仅清理脚本自身生成且超过七天的备份。部署中的 backup 服务每小时执行一次。

**恢复命令的 `DATABASE_URL` 必须指向新建的空数据库**，并使用原服务器的 `APP_SECRET` 和相同内容版本。命令拒绝覆盖非空库。先恢复并验证，再停止旧服务、把应用连接切到新库并启动；保留旧库供回退。恢复会为每个房间生成新的 `saveEpoch`，旧请求不能覆盖恢复结果。备份之后的操作无法恢复。

需要一起保留的私有材料：备份文件、原 `APP_SECRET`、对应版本的 `content/` 目录及以后加入的素材。部署备份应再复制一份到开发机；不要提交 `.env`、备份或恢复码到公开仓库。本次已在隔离测试库完成恢复演练。

## 公网部署（备用）

提供了 `Dockerfile`、`compose.production.yaml` 和 `deploy/Caddyfile`。目标是一台主机运行一个应用实例与一个数据库，不支持多应用实例共享内存中的连接控制表。

1. 准备可用主机和测试域名，DNS 指向该主机，开放 80 / 443。
2. 复制 `.env.production.example` 为 `.env.production`，填写域名和两个不同的随机十六进制密钥。不要使用示例值。服务器上的备份目录需可由容器用户 uid 1000 写入。
3. 启动：

```sh
docker compose --env-file .env.production -f compose.production.yaml up -d --build
```

Caddy 使用域名申请和续签 HTTPS 证书，代理 HTTP 与 WebSocket；入口和 API 保持同源。数据库端口和应用端口不直接发布到公网。所需 DNS / 端口条件见 [Caddy HTTPS 文档](https://caddyserver.com/docs/automatic-https)，实时连接代理行为见 [reverse_proxy 文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

**尚未实际部署**：本机 Docker 引擎不可用，目前只验证 Compose 配置语法。还需要提供主机和 HTTPS 地址，再验证镜像构建、证书、双设备不同网络及 30 分钟试玩。不要直接将 Vite 开发服务器作为公网正式入口。
