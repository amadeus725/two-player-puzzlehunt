# 协同开发

先阅读 [README.md](README.md) 完成本机启动，再阅读 [PLAN.md](PLAN.md) 了解已确认的游戏规则。每位开发者使用自己的本地数据库与 `.env`；首次运行 `npm run dev` 会创建本地配置。不要共享开发者的密钥或玩家存档。

## 分支和提交

1. 从最新 `main` 建立自己的分支，例如 `feature/north-puzzles` 或 `fix/portal-sync`。
2. 一次修改围绕一个具体任务；较大的地图或机制改动先在 Issue 中写清目标和负责范围。
3. 提交后推送个人分支，向 `main` 发起 Pull Request，说明变化、验证方法以及实际效果。建议由另一位协作者看过后再合并。
4. 两人同时修改 `game.json` 时先约定负责的区域，合并后运行配置校验，避免题号、坐标和传送门引用冲突。

```sh
git switch main
git pull --ff-only
git switch -c feature/north-puzzles
# 修改并验证后
git add <本次修改的文件>
git commit -m "Add north puzzle content"
git push -u origin feature/north-puzzles
```

## 验证

代码或关卡改动按影响范围运行以下命令：

```sh
npm ci
npm run validate
npm test
npm run build
```

涉及保存、权限或服务端通信时，在 PostgreSQL 运行后执行 `npm run test:integration`。测试使用随机 schema，不改开发房间。联机检查可运行 `npm run test:lan -- <当前局域网地址>`，会新建测试房间。实际双设备试玩仍需另外验收。

## 题库与内容版本

- 新题面先放入 [题库](content/puzzle-bank/README.md)，沿用稳定的题库编号；未提供的答案和区域保持空值。
- `content/public/` 保存地图、题面等内容，`content/private/` 保存服务端答案。仓库协作者会看到这两部分，因此仓库应保持私有，只邀请开发人员。
- 房间固定自己的 `contentVersion`。修改已经使用的关卡时，复制为新版本，并更新服务端新房默认版本；保留旧版本，使旧存档仍可加载。
- 新贴图和题面图片使用项目内的相对路径，不依赖某位开发者的本机绝对路径。

## 本地文件

`.env*` 的真实配置、本地 PostgreSQL 数据、备份、日志和依赖目录均由 `.gitignore` 排除。示例环境文件可以提交。参考站下载的前端产物也不提交；分析说明保留在 `research/PNKU3_REFERENCE.md`。

GitHub 保存代码和内容版本；玩家通过运行中的游戏服务联机。克隆项目后，各人的数据库和房间分别保存在本机。GitHub 仓库本身不会同步玩家存档，也不会自动部署游戏。
