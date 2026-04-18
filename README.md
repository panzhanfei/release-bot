# release-bot

在本地拉取 **发布仓**（如 monorepo）、按模块 **构建**、通过 **SSH + rsync** 同步到生产机并执行 **postDeploy / PM2 重启** 的小型服务。支持 **飞书群指令** 与 **HTTP `/run` 接口** 触发。

## 依赖环境

- **Node.js** ≥ 18  
- **pnpm**（见 `packageManager`）  
- 本机已配置 **SSH 公钥** 登录目标服务器  
- 本机有 **git**、**rsync**  
- 发布机构建依赖由你的 monorepo 决定（常见：`pnpm`、`turbo`）

## 快速开始

```bash
cp .env.example .env
# 编辑 .env：RELEASE_REPO_URL、RELEASE_WORKDIR、DEPLOY_*、RELEASE_MODULES_JSON 等
pnpm install
pnpm exec tsx agent.ts
# 或：pnpm run restart:env   # PM2 托管
```

健康检查：

```bash
curl -fsS http://127.0.0.1:8787/health
# {"ok":true,"service":"release-bot"}
```

本地常用 **Makefile**：`make up` / `make down` / `make logs` / `make health`（具体见 `scripts/dev-*.sh`）。

## 配置说明

核心变量在 **`.env`**，模板见 **`.env.example`**（含 Sentinel / Prisma / main-next 等说明）。

| 类别 | 说明 |
|------|------|
| `RELEASE_REPO_URL` / `RELEASE_WORKDIR` / `RELEASE_BRANCH` | 发布仓克隆目录与分支 |
| `RELEASE_MODULES_JSON` | 多模块 JSON：`installCmd`、`buildCmd`、`artifactPath`、`deployPath`、`remoteRestartCmd`、`postDeployCmd`、`rsyncExtras` 等 |
| `RELEASE_PACKAGES_BUILD_CMD` | 可选；发布流水线在「安装依赖后、各应用构建前」执行一次（如 `pnpm exec turbo run build --filter=./packages/*`） |
| `DEPLOY_HOST` / `DEPLOY_USER` / `SSH_PORT` | SSH 与 rsync 目标 |
| `FEISHU_*` | 飞书机器人（Webhook） |
| `AGENT_TOKEN` | 调用 `POST /run` 时请求头 `x-agent-token` |
| `RELEASE_CONFIRM_TOKEN` | 可选；设置后「发布」「回滚」需附带确认码 |
| `RELEASE_AUTO_ROLLBACK_ON_DEPLOY_FAIL` | 默认开启；设为 `false` 时关闭部署前远端快照与失败自动恢复（见下节） |

修改 **`src/`、`agent.ts`、`.env`、`package.json`** 等影响运行行为后，建议执行 **`pnpm run restart:env`** 并再次请求 `/health`。

## 部署失败与回滚

**自动恢复快照（文件级）**

- 当 `RELEASE_AUTO_ROLLBACK_ON_DEPLOY_FAIL` 不为 `false` 时，每次 **部署** 在 rsync 覆盖远端目录前，若该 `deployPath` 下已有内容，会先把当前目录完整镜像到同级目录 **`<deployPath>.release-bot-prev`**（`rsync --delete`）。
- 若 **rsync / rsyncExtras / postDeployCmd / remoteRestartCmd** 任一步失败：
  - **单模块**：自动把 `<deployPath>.release-bot-prev` 拷回 `deployPath`，并再次执行该模块的 `remoteRestartCmd`，错误信息中会说明已尝试回滚。
  - **多模块一键发布**：当前模块会按上一条自救；此前已成功部署的模块会按 **逆序** 用各自的 `.release-bot-prev` 恢复并执行对应重启命令。
- **首次部署**（远端目录为空）不会生成快照，失败时无法做文件级恢复，需改用 **git 回滚** 或手工处理。
- 快照目录与 `deployPath` 并列，例如 `deployPath` 为 `/root/sentinel-infra/server` 时，快照为 `/root/sentinel-infra/server.release-bot-prev`。磁盘会多保留一份上一版产物，可按需定期清理旧快照或接受占用。

**Git 回滚（代码级）**

- 飞书：`回滚 <模块名|全部> <commit|tag|分支> [确认码 xxx]`
- HTTP：`action: rollback-release`，body 带 `gitRef`、`moduleName`（或 `all`）、`confirmToken`（若配置了确认码）
- CLI：`pnpm run release rollback <模块|all> <gitRef> --confirm=<RELEASE_CONFIRM_TOKEN>`

含义是在 **发布仓** 检出指定引用后，再走与「发布」相同的构建与部署流程，用于回到历史 **源码版本**；与「部署失败自动恢复快照」互补（快照只恢复 **上一次已成功同步到该目录的文件树**，不涉及 git 历史）。

## 发布流水线（`releasePipeline`）

一键发布时的顺序为：

1. **拉取代码**：`git fetch`、checkout、`reset --hard`、`git clean -fd`  
2. **安装依赖** + **全仓 packages 构建**（若配置了 `RELEASE_PACKAGES_BUILD_CMD`）  
3. **按模块构建**：各模块 `preBuildCmd` + `buildCmd`  
4. **按模块部署**：`vendor-sentinel`（若有）→ `server` → 其余模块；每模块依次 **rsync 主产物**（默认 `-L` 跟随软链，并排除 `.env*` 与 **infra 基线**：`ecosystem.config.cjs`、`docker-compose.yml`、`Caddyfile`、`caddy.d/`、`scripts/`）→ **rsyncExtras** → **`postDeployCmd`** → **`remoteRestartCmd`**。密钥与 PM2/Compose 等仅在服务器 **sentinel-infra** 维护；`RELEASE_RSYNC_INFRA_EXCLUDES=false` 可关闭除 `.env*` 外的 infra 排除。

CLI：

```bash
pnpm run release all --confirm=<RELEASE_CONFIRM_TOKEN>
pnpm run release server
pnpm run release rollback server abc1234 --confirm=<RELEASE_CONFIRM_TOKEN>
pnpm run release rollback all v1.2.3 --confirm=<RELEASE_CONFIRM_TOKEN>
```

## HTTP 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 存活探测 |
| `POST` | `/run` | 需头 `x-agent-token: <AGENT_TOKEN>`；Body JSON：`action` 见下表 |

`action` 取值：

- `build-release` — 仅构建（可带 `moduleName`）  
- `deploy-release` — 仅部署（需本地已有产物）  
- `release` — 完整发布（可 `moduleName` 或 `all`，可能需 `confirmToken`）  
- `rollback-release` — 在发布仓检出指定 `gitRef` 后走同一套发布（需 `confirmToken` 若已配置）；与部署失败时的 `.release-bot-prev` 自动恢复不同  
- `pause-release` / `resume-release` — 暂停/恢复发布与部署类操作  

## 飞书

配置 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 后，将事件订阅指向 **`POST /feishu/webhook`**。群内指令与「帮助」文案见 `src/utils/text.ts`（如：打包、部署、发布、回滚、暂停/恢复）。

## 目录结构（简要）

```
agent.ts                 # 入口
src/app.ts               # Express
src/routes/              # /health、/run、/feishu/webhook
src/services/release.service.ts   # 拉取、构建、部署、流水线
src/config/env.ts        # 环境变量与 RELEASE_MODULES_JSON 解析
scripts/release.ts       # CLI 发布
```

## 与业务仓的关系

release-bot **不包含**业务代码；`RELEASE_WORKDIR` 指向克隆下来的 monorepo（例如 **sentinel-monorepo**）。生产机上的 **Prisma 同步脚本**、**PM2 进程名**、**部署路径** 等需与 `RELEASE_MODULES_JSON` 及你自己的 **sentinel-infra** 布局一致，详见 `.env.example` 中的清单说明。

## 许可证

ISC（见 `package.json`）。
