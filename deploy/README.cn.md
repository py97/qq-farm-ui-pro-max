# QQ 农场智能助手 - 国内网络部署说明

本文档用于中国大陆或访问 GitHub / Docker Hub 不稳定的服务器环境。

默认部署脚本仍以官方源为准：

- GitHub：`raw.githubusercontent.com` / `codeload.github.com`
- Docker：`docker.io`

如果你的服务器已经可以稳定访问官方源，请直接使用 [deploy/README.md](README.md) 的标准部署流程；本文重点说明国内网络下更稳的离线交付和旧服修复方式。

## 推荐方式

优先级建议如下：

1. 使用维护者提前打好的离线一体包
2. 手动传输部署文件和镜像包，再在服务器本地启动
3. 旧服务器先修部署包，再执行本地镜像升级
4. 只有在服务器能直接访问官方源时，才使用在线一键脚本

## 方案 1：离线一体包部署

这是国内网络最稳的方式。维护者先在网络正常的环境中生成离线包，再上传到服务器执行。

维护者在本地执行：

```bash
cd deploy/scripts
bash build-all-and-push.sh 4.5.17
```

脚本中选择：

- `1`：全部构建（主程序 + ipad860 + 离线包）
- 或 `4`：仅导出离线包（前提是镜像已提前构建完成）

生成结果在：

```bash
deploy/offline/qq-farm-bot-v4.5.17-offline.tar.gz
```

上传到服务器后执行：

```bash
tar xzf qq-farm-bot-v4.5.17-offline.tar.gz
cd qq-farm-bot-release
cp .env.example .env
vi .env
chmod +x install.sh
./install.sh
```

完成后再检查：

```bash
docker compose ps
curl http://127.0.0.1:3080/api/ping
```

## 方案 2：部署文件 + 镜像包分开传输

如果你不想传整包，可以把部署文件和镜像文件分开上传。

维护者在本地准备：

```bash
cd deploy/scripts
bash build-all-and-push.sh 4.5.17
```

需要的文件：

- `deploy/offline/qq-farm-bot-images.tar.gz`
- `deploy/offline/qq-farm-bot-deploy.tar.gz`

服务器执行：

```bash
mkdir -p /opt/$(date +%Y_%m_%d)/qq-farm-bot
cd /opt/$(date +%Y_%m_%d)/qq-farm-bot

tar xzf /path/to/qq-farm-bot-deploy.tar.gz
cp .env.example .env
vi .env

docker load < /path/to/qq-farm-bot-images.tar.gz
docker compose up -d

ln -sfn "$(pwd)" /opt/qq-farm-bot-current
```

验证：

```bash
docker compose ps
docker compose logs -f qq-farm-bot
curl http://127.0.0.1:3080/api/ping
```

## 方案 3：已部署服务器只更新主程序

国内网络下更新主程序，建议也走“预载镜像 + 跳过在线拉取”的方式。

先把新的主程序镜像导入服务器，然后执行：

```bash
cd /opt/qq-farm-bot-current
SKIP_DOCKER_PULL=1 ./update-app.sh --image smdk000/qq-farm-bot-ui:4.5.17

# 如果只想先补旧数据库结构
./repair-mysql.sh --backup
```

这个模式只更新主程序，不会重启：

- `qq-farm-mysql`
- `qq-farm-redis`
- `qq-farm-ipad860`

## 方案 4：旧服务器先修复部署包，再升级

适用于老机器上的部署目录已经缺脚本、缺 `docker-compose.yml`、缺 `/opt/qq-farm-bot-current` 链接，或者你准备先把部署骨架修好再升级主程序。

如果服务器可以访问 GitHub：

```bash
cd /opt/qq-farm-bot-current 2>/dev/null || cd /opt
curl -fsSLo repair-deploy.sh https://raw.githubusercontent.com/smdk000/qq-farm-ui-pro-max/main/scripts/deploy/repair-deploy.sh
chmod +x repair-deploy.sh
./repair-deploy.sh --backup
./update-app.sh --image smdk000/qq-farm-bot-ui:4.5.17
```

如果服务器不能访问 GitHub，就把本地生成的部署包中的 `repair-deploy.sh`、`update-app.sh`、`repair-mysql.sh` 一并传上去执行。

补充说明：

- 从 `v4.5.17` 开始，部署目录会额外提供 `repair-deploy.sh`，用于补齐旧部署目录缺失的脚本、编排文件、初始化 SQL 和 current 链接。
- `repair-deploy.sh` 只修部署包本身；需要修数据库结构时，用 `repair-mysql.sh`。
- 所以旧服务器要彻底消除“添加账号后切换/刷新消失”、体验卡异常，以及卡密管理结构缺失问题，关键是修完部署包后再把主程序镜像升级到 `v4.5.17+`。

## 如果服务器可以直连官方源

可以直接使用标准部署文档：

- 标准部署说明：[deploy/README.md](README.md)
- 根 README 部署章节：[README.md](../README.md)

在线一键命令：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/smdk000/qq-farm-ui-pro-max/main/scripts/deploy/fresh-install.sh)
```

## 说明

- 本文档不改变默认部署脚本行为，只提供更适合国内网络的交付方式。
- 国内网络最稳定的方案仍然是“离线包”或“预载镜像后再启动”。
- 如果你后续要频繁给客户部署，建议每次发布版本时同步产出离线包。
