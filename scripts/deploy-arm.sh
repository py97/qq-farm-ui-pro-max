#!/bin/bash

# QQ 农场助手 - ARM 服务器极简全栈一键部署脚本
# 适用于树莓派、鲲鹏、飞腾等 ARM64 架构服务器
# 本脚本将自动拉起完整体系：App + MySQL(自动初始化) + Redis + Web微信协议引擎

set -e

VERSION="4.2.0"
DOCKER_COMPOSE_URL="https://raw.githubusercontent.com/smdk000/qq-farm-ui-pro-max/main/docker-compose.prod.yml"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

echo "=========================================================="
echo "  QQ 农场助手 - ARM 服务器 一键极速全栈部署体系"
echo "  体系包含：Core App + MySQL 8.0 + Redis 7 + Ipad860"
echo "  版本：${VERSION}"
echo "  架构：ARM64 (aarch64)"
echo "=========================================================="
echo ""

# 1. 检查 Docker 与 Compose V2
print_info "检查 Docker 与 Compose 运行时生态..."
if ! command -v docker &> /dev/null; then
    print_error "Docker 未安装，请先安装 Docker"
    echo "推荐安装命令 (Ubuntu/Debian): curl -fsSL https://get.docker.com | sh"
    exit 1
fi
if ! docker compose version &> /dev/null; then
    print_error "Docker Compose V2 插件未安装，不支持新版部署方案"
    echo "请升级您的 Docker 或安装 Docker Compose Plugin"
    exit 1
fi
print_success "生态健壮：$(docker --version) | $(docker compose version)"

# 2. 检查架构
print_info "检查服务器安全指令集架构..."
ARCH=$(uname -m)
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
    print_error "当前架构为 $ARCH，此脚本仅适用于 ARM64 架构"
    print_info "如果是 x86_64 架构，请使用 deploy-x86.sh 脚本"
    exit 1
fi
print_success "服务器架构匹配：$ARCH (ARM64)"

# ARM 特定：Redis 内存超售策略
print_info "执行 ARM 内核资源特调限制释放 (针对 Redis)..."
if sysctl vm.overcommit_memory | grep -q "0\|1\|2"; then
     CURRENT_OVERCOMMIT=$(sysctl -n vm.overcommit_memory 2>/dev/null || echo "0")
     if [ "$CURRENT_OVERCOMMIT" != "1" ]; then
         print_warning "检测到当前的 overcommit_memory=$CURRENT_OVERCOMMIT，可能会导致 Redis bgsave 时宕机"
         print_info "尝试自动修复该设置 (需要sudo越权)..."
         sudo sysctl -w vm.overcommit_memory=1 || print_warning "调整失败，如果您的 Redis 闪退，请手动切为 Root 执行 sudo sysctl -w vm.overcommit_memory=1"
     else
         print_success "内存策略正常 (overcommit_memory=1)"
     fi
fi

# 3. 创建极简化目录与下卸编排文件
print_info "创建运行时全栈依赖矩阵目录..."
mkdir -p ./data ./logs ./backup ./mysql-data ./redis-data

print_info "动态拉取远端服务基底谱列..."
if ! curl -sS -f -O "$DOCKER_COMPOSE_URL"; then
    print_warning "在线抓取 docker-compose.prod.yml 失败或网络不可达"
    echo "您可以手动新建一个该配置文件后重试！"
    exit 1
fi

# 4. 生成或补全 .env 环保安全壳
if [ ! -f .env ]; then
    print_info "侦测为初次部署，生成系统级环境鉴权阀..."
    cat > .env <<EOF
# QQ 农场智能助手 - 服务矩阵系统密钥
# ------------------------------------
# 面板全局管理员最高权限密匙（强烈建议更改）
ADMIN_PASSWORD=qq007qq008

# 极简 MySQL 系统私链凭证
MYSQL_ROOT_PASSWORD=qq007qq008
MYSQL_USER=qq_farm_user
MYSQL_PASSWORD=qq007qq008
MYSQL_DATABASE=qq_farm

# 宿主机映射 Web 暴露端口
PORT=3080
EOF
    print_success ".env 环境阀创建成功！"
else
    print_info ".env 环境阀已存在，使用保留配置。"
fi

# 5. 阻断重启保护
print_info "下放挂起与重建挂起保护（无损重建更新）..."
docker compose -f docker-compose.prod.yml down || true

# 6. 一键点火拉起引擎！
print_info "开始并发拉取与交织启动 4 大集群并热同步数据..."
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --remove-orphans

print_info "等待初始化信号... (包含 MySQL 创表等大约20秒，请不要退出)"
sleep 15

# 7. 检查核心运行状态
if docker ps | grep -q qq-farm-bot-ui; then
    source .env
    echo ""
    echo "================================================================"
    print_success "🎉 农机方阵多引擎联动配置上线全部就绪 - 部署成功！"
    echo "================================================================"
    echo ""
    echo "📊 Web 控制台访问：http://<服务器IP>:${PORT}"
    echo "🔑 控制中心管理密码：${ADMIN_PASSWORD} (请留意修改您的 .env 文件)"
    echo "📱 WX 扫码引擎：已绑定挂起 (由 QEMU 转义)"
    echo "🗄️ MySQL & Redis：冷端启动并处于内网私有连结中"
    echo ""
    echo "💡 常用容器运维命令:"
    echo "  >> 主板实时日志查阅：docker logs -f qq-farm-bot-ui"
    echo "  >> 快速终止方阵运转：docker compose -f docker-compose.prod.yml down"
    echo "  >> 热更新挂机程序版本：docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d"
    echo ""
    echo "📝 数据保险库:"
    echo "  为确保数据不受损坏且能够平滑跨云，请勿随意抹去以下目录："
    echo "  - 用户身份数据：./data/"
    echo "  - MySQL 固化挂载：./mysql-data/"
    echo ""
else
    echo ""
    print_error "核心中控节点部署可能存在滞后失败，请调阅排查日志"
    docker logs qq-farm-bot-ui
    exit 1
fi
