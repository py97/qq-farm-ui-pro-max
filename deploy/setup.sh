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
REPO_BASE="https://raw.githubusercontent.com/smdk000/qq-farm-ui-pro-max/main/deploy"

echo "📦 下载部署文件..."
curl -fsSL "${REPO_BASE}/docker-compose.yml"  -o docker-compose.yml
curl -fsSL "${REPO_BASE}/.env"                -o .env
curl -fsSL "${REPO_BASE}/init-db/01-init.sql" -o init-db/01-init.sql
echo -e "${GREEN}✅ 部署文件下载完成${NC}"

# ---------- 4. 配置密码 ----------
echo ""
echo -e "${YELLOW}🔐 请设置管理后台密码（直接回车使用默认密码 qq007qq008）：${NC}"
read -r -p "密码: " USER_PASSWORD
if [ -n "$USER_PASSWORD" ]; then
    # macOS 和 Linux 的 sed 兼容写法
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${USER_PASSWORD}/" .env
    else
        sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${USER_PASSWORD}/" .env
    fi
    echo -e "${GREEN}✅ 密码已设置${NC}"
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
