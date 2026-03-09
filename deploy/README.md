# QQ 农场智能助手 - 部署说明

本部署包对应当前标准运行栈：

- `qq-farm-bot`：主程序
- `qq-farm-mysql`：MySQL 8.0
- `qq-farm-redis`：Redis 7
- `qq-farm-ipad860`：微信扫码协议服务

后续版本迭代默认只更新主程序，MySQL / Redis / ipad860 复用现有部署。

文档入口：

- 标准部署：[deploy/README.md](README.md)
- 国内网络部署：[deploy/README.cn.md](README.cn.md)

## 环境要求

- Docker 24+
- Docker Compose v2+
- 推荐系统：Ubuntu 22.04+ / Debian 12+
- 推荐资源：2C / 2G / 20G+

## 场景 1：全新服务器完整部署

### 一键脚本

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/smdk000/qq-farm-ui-pro-max/main/scripts/deploy/fresh-install.sh)
```

自 `v4.5.17` 起，部署目录会固定带上两类修复脚本：

- `repair-mysql.sh`：修复旧 MySQL 结构、补齐缺失表/列并回填历史数据
- `repair-deploy.sh`：修复旧部署目录缺脚本、缺 `docker-compose.yml`、缺 `init-db`、缺 `/opt/qq-farm-bot-current` 链接的问题

脚本会自动：

- 安装或检查 Docker / Docker Compose
- 检查 Web 端口占用，必要时切换到新的可用端口
- 在 `/opt/YYYY_MM_DD/qq-farm-bot` 创建部署目录，并维护 `/opt/qq-farm-bot-current` 当前版本链接
- 下载 `docker-compose.yml`、`.env.example`、初始化 SQL、README、一键部署/更新/修复脚本
- 启动全部 4 个容器并等待健康检查
- 默认使用 GitHub 官方源和 Docker Hub 官方仓库
- 主程序镜像或 `ipad860` 镜像仍不可拉取时，自动下载 GitHub 源码包并在服务器本地构建
- 启动完成后自动执行一次 `repair-mysql.sh`

无交互部署示例：

```bash
WEB_PORT=3080 ADMIN_PASSWORD='你的强密码' NON_INTERACTIVE=1 \
bash <(curl -fsSL https://raw.githubusercontent.com/smdk000/qq-farm-ui-pro-max/main/scripts/deploy/fresh-install.sh)
```

可选镜像配置（写入 `.env`）：

```bash
APP_IMAGE=smdk000/qq-farm-bot-ui:4.5.17
MYSQL_IMAGE=mysql:8.0
REDIS_IMAGE=redis:7-alpine
IPAD860_IMAGE=smdk000/ipad860:latest
```

### 手动部署

```bash
mkdir -p /opt/$(date +%Y_%m_%d)/qq-farm-bot
cd /opt/$(date +%Y_%m_%d)/qq-farm-bot

cp /path/to/deploy/docker-compose.yml .
cp /path/to/deploy/.env.example .env
mkdir -p init-db
cp /path/to/deploy/init-db/01-init.sql init-db/
cp /path/to/scripts/deploy/update-app.sh .
cp /path/to/scripts/deploy/repair-mysql.sh .
cp /path/to/scripts/deploy/repair-deploy.sh .
cp /path/to/scripts/deploy/fresh-install.sh .
cp /path/to/scripts/deploy/quick-deploy.sh .
chmod +x update-app.sh repair-mysql.sh repair-deploy.sh fresh-install.sh quick-deploy.sh

# 按需修改密码、端口、第三方扫码参数
vi .env

bash fresh-install.sh --non-interactive
```

## 场景 2：已部署环境只更新主程序

此模式不会重启 MySQL / Redis / ipad860，也不会清理数据卷。

### 一键更新

```bash
/opt/qq-farm-bot-current/update-app.sh
```

### 手动更新

```bash
cd /opt/qq-farm-bot-current
bash update-app.sh

# 如需切到指定版本
bash update-app.sh --image smdk000/qq-farm-bot-ui:4.5.17

# 仅执行历史数据库修复
bash repair-mysql.sh --backup
```

说明：

- `update-app.sh` 会先执行 `repair-mysql.sh`，再更新主程序镜像。
- `update-app.sh` 会同步更新部署目录里的 `docker-compose.yml`、`.env.example`、README 和修复脚本。
- `update-app.sh` 会重新维护 `/opt/qq-farm-bot-current` 链接，避免旧服软链接丢失。

## 场景 3：旧服务器先修复部署包，再升级到最新版本

适用于这些情况：

- 部署目录里没有 `repair-mysql.sh` / `update-app.sh`
- `docker-compose.yml`、`init-db/01-init.sql`、`.env.example` 已经很旧
- `/opt/qq-farm-bot-current` 丢失或指向错误目录
- 需要先把旧服务器修到最新部署结构，再升级主程序

```bash
cd /opt/qq-farm-bot-current 2>/dev/null || cd /opt
curl -fsSLo repair-deploy.sh https://raw.githubusercontent.com/smdk000/qq-farm-ui-pro-max/main/scripts/deploy/repair-deploy.sh
chmod +x repair-deploy.sh

# 先修部署包
./repair-deploy.sh --backup

# 再升级主程序
./update-app.sh --image smdk000/qq-farm-bot-ui:4.5.17
```

可选参数：

- `./repair-deploy.sh --backup`：先打包备份当前部署文件
- `./repair-deploy.sh --run-db-repair`：修部署包后顺带执行一次 `repair-mysql.sh`
- `./repair-deploy.sh --preserve-compose`：只补脚本和 `.env.example`，不覆盖现有 `docker-compose.yml`

## 验证部署

```bash
docker compose ps
docker compose logs -f qq-farm-bot
curl http://localhost:3080/api/ping
```

预期状态：

- `qq-farm-bot` 为 `Up (healthy)`
- `qq-farm-mysql` 为 `Up (healthy)`
- `qq-farm-redis` 为 `Up`
- `qq-farm-ipad860` 为 `Up`

默认登录信息：

- 用户名：`admin`
- 密码：`.env` 中的 `ADMIN_PASSWORD`

## 目录结构

```text
qq-farm-bot/
├── docker-compose.yml
├── .env
├── .env.example
├── update-app.sh
├── repair-mysql.sh
├── repair-deploy.sh
├── README.md
└── init-db/
    └── 01-init.sql
```

## 常用命令

```bash
# 查看状态
docker compose ps

# 查看日志
docker compose logs -f qq-farm-bot

# 停止服务
docker compose down

# 重启服务
docker compose restart

# 只更新主程序
./update-app.sh

# 修复旧部署包
./repair-deploy.sh --backup
```

## 说明

- `deploy/init-db/01-init.sql` 仅用于 MySQL 空数据卷首次初始化。
- 已部署环境更新主程序时不会重新执行 `init-db/01-init.sql`，而是依赖 `repair-mysql.sh` 和主程序自动迁移补齐缺失结构。
- 如果服务器仍在运行旧版 `qq-farm-bot` 镜像，单独替换脚本文件无法彻底修复旧结构问题，仍需执行 `update-app.sh` 升级主程序镜像。
- 默认管理员会在首次启动时自动创建，不会写死在 SQL 里。
- `REDIS_PASSWORD` 默认为空；如启用密码，主程序与 ipad860 会使用同一值。
- ARM64 服务器上，`ipad860` 以 `linux/amd64` 方式运行，依赖宿主机的 QEMU 兼容能力。
