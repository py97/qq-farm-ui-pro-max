#!/bin/bash

# =====================================================
# 🌾 QQ 农场智能助手 - 一键部署脚本
# =====================================================
# 使用方法（在服务器上执行一条命令即可）：
#   curl -fsSL https://raw.githubusercontent.com/smdk000/qq-farm-ui-pro-max/main/deploy/setup.sh | bash
# =====================================================

set -e

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo "=========================================="
echo "  🌾 QQ 农场智能助手 - 一键部署"
echo "=========================================="
echo ""

# ---------- 1. 检查 Docker ----------
if ! command -v docker &>/dev/null; then
    echo -e "${YELLOW}⚠ Docker 未安装，正在自动安装...${NC}"
    curl -fsSL https://get.docker.com | sh
    sudo systemctl enable docker
    sudo systemctl start docker
    echo -e "${GREEN}✅ Docker 安装完成${NC}"
fi

if ! docker compose version &>/dev/null 2>&1; then
    echo -e "${RED}❌ Docker Compose v2 不可用，请升级 Docker${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Docker $(docker --version | awk '{print $3}')${NC}"

# ---------- 2. 创建部署目录 ----------
DEPLOY_DIR="/opt/qq-farm-bot"
mkdir -p "${DEPLOY_DIR}/init-db"
cd "${DEPLOY_DIR}"
echo -e "${GREEN}✅ 部署目录: ${DEPLOY_DIR}${NC}"

# ---------- 3. 从 GitHub 下载部署文件 ----------
# 预定义加速镜像（如果原生链接慢）
GITHUB_PROXY="https://mirror.ghproxy.com/"
REPO_BASE="https://raw.githubusercontent.com/smdk000/qq-farm-ui-pro-max/main/deploy"

echo "📦 正在下载部署文件..."

download_file() {
    local file=$1
    local target=$2
    local url="${REPO_BASE}/${file}"
    
    echo -n "   正在下载 ${file}... "
    
    # 尝试 1: 直接下载 (带 15s 超时)
    if curl -fsSL --connect-timeout 15 "${url}" -o "${target}"; then
        echo -e "${GREEN}OK${NC}"
        return 0
    fi
    
    # 尝试 2: 使用加速镜像
    echo -n "原生连接较慢，切换加速镜像... "
    if curl -fsSL --connect-timeout 20 "${GITHUB_PROXY}${url}" -o "${target}"; then
        echo -e "${GREEN}OK${NC}"
        return 0
    else
        echo -e "${RED}FAILED${NC}"
        echo -e "${RED}❌ 错误: 无法下载 ${file}，请检查网络连接或手动下载。${NC}"
        exit 1
    fi
}

download_file "docker-compose.yml" "docker-compose.yml"
download_file ".env" ".env"
download_file "init-db/01-init.sql" "init-db/01-init.sql"

echo -e "${GREEN}✅ 部署文件全部下载完成${NC}"

# ---------- 4. 配置密码 ----------
echo ""
echo -e "${YELLOW}🔐 请设置管理后台密码（直接回车使用默认密码 qq007qq008）：${NC}"
# 尝试从 tty 读取，如果失败则跳过交互（针对 curl | bash 管道模式）
USER_PASSWORD=""
if [ -t 0 ]; then
    read -r USER_PASSWORD
else
    # 管道模式尝试从 tty 重定向
    read -r USER_PASSWORD < /dev/tty 2>/dev/null || USER_PASSWORD=""
fi

# 替换 .env 中的密码
if [ -n "$USER_PASSWORD" ]; then
    # 采用更稳健的 sed 兼容方案
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i "" "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${USER_PASSWORD}/" .env
    else
        sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${USER_PASSWORD}/" .env
    fi
    echo -e "${GREEN}✅ 密码已成功设置${NC}"
else
    echo -e "${GREEN}✅ 使用默认密码${NC}"
fi

# ---------- 5. 启动服务 ----------
echo ""
echo "🚀 启动所有服务..."
docker compose up -d

# ---------- 6. 等待启动 ----------
echo ""
echo "⏳ 等待服务初始化（约 30 秒）..."
sleep 30

# ---------- 7. 显示状态 ----------
echo ""
echo "📊 服务状态："
docker compose ps
echo ""

# 获取访问地址
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || curl -s ifconfig.me 2>/dev/null || echo "localhost")
WEB_PORT=$(grep '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2 || echo "3080")

echo "=========================================="
echo -e "  ${GREEN}✅ 部署完成！${NC}"
echo "=========================================="
echo ""
echo "  📌 访问地址: http://${SERVER_IP}:${WEB_PORT}"
echo "  📌 管理密码: $(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2)"
echo ""
echo "  常用命令（在 ${DEPLOY_DIR} 目录下执行）："
echo "    查看日志:  docker compose logs -f"
echo "    停止服务:  docker compose down"
echo "    重启服务:  docker compose restart"
echo "    更新版本:  docker compose pull && docker compose up -d"
echo ""
