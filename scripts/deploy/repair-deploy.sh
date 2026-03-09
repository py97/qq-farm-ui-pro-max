#!/usr/bin/env bash

set -Eeuo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-$(pwd)}"
DEPLOY_BASE_DIR="${DEPLOY_BASE_DIR:-/opt}"
CURRENT_LINK="${CURRENT_LINK:-${DEPLOY_BASE_DIR}/qq-farm-bot-current}"
REPO_SLUG="${REPO_SLUG:-smdk000/qq-farm-ui-pro-max}"
REPO_REF="${REPO_REF:-main}"
RAW_BASE_URL="${RAW_BASE_URL:-https://raw.githubusercontent.com/${REPO_SLUG}/${REPO_REF}}"
BACKUP_BEFORE_SYNC="${BACKUP_BEFORE_SYNC:-0}"
RUN_DB_REPAIR="${RUN_DB_REPAIR:-0}"
PRESERVE_COMPOSE_LAYOUT="${PRESERVE_COMPOSE_LAYOUT:-0}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

print_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[OK]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

trap 'print_error "部署包修复失败，请检查上方日志。"' ERR

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --deploy-dir)
                DEPLOY_DIR="${2:-}"
                shift 2
                ;;
            --backup)
                BACKUP_BEFORE_SYNC=1
                shift
                ;;
            --run-db-repair)
                RUN_DB_REPAIR=1
                shift
                ;;
            --preserve-compose)
                PRESERVE_COMPOSE_LAYOUT=1
                shift
                ;;
            *)
                print_error "未知参数: $1"
                exit 1
                ;;
        esac
    done
}

copy_file_if_needed() {
    local source_path="$1"
    local target_path="$2"

    if [ "${source_path}" = "${target_path}" ]; then
        return 0
    fi

    cp "${source_path}" "${target_path}"
}

download_file() {
    local remote_path="$1"
    local target_path="$2"
    curl -fsSL "${RAW_BASE_URL}/${remote_path}" -o "${target_path}"
}

resolve_deploy_dir() {
    if [ -f "${DEPLOY_DIR}/docker-compose.yml" ] || [ -f "${DEPLOY_DIR}/.env" ]; then
        return 0
    fi

    if [ -L "${CURRENT_LINK}" ] || [ -d "${CURRENT_LINK}" ]; then
        if [ -f "${CURRENT_LINK}/docker-compose.yml" ] || [ -f "${CURRENT_LINK}/.env" ]; then
            DEPLOY_DIR="${CURRENT_LINK}"
            return 0
        fi
    fi

    local latest=""
    latest="$(find "${DEPLOY_BASE_DIR}" -mindepth 2 -maxdepth 2 -type d -name qq-farm-bot 2>/dev/null | sort | tail -n 1)"
    if [ -n "${latest}" ]; then
        DEPLOY_DIR="${latest}"
        return 0
    fi
}

backup_bundle() {
    local backup_dir="${DEPLOY_DIR}/backups"
    local backup_file="${backup_dir}/deploy-bundle-$(date +%Y%m%d_%H%M%S).tar.gz"
    local files=()

    mkdir -p "${backup_dir}"

    for path in \
        docker-compose.yml \
        .env.example \
        README.md \
        update-app.sh \
        repair-mysql.sh \
        repair-deploy.sh \
        fresh-install.sh \
        quick-deploy.sh \
        init-db/01-init.sql; do
        if [ -e "${DEPLOY_DIR}/${path}" ]; then
            files+=("${path}")
        fi
    done

    if [ "${#files[@]}" -eq 0 ]; then
        print_warning "当前目录没有可备份的部署包文件，跳过备份。"
        return 0
    fi

    tar -czf "${backup_file}" -C "${DEPLOY_DIR}" "${files[@]}"
    print_success "部署包备份完成: ${backup_file}"
}

mark_current_release() {
    local current_parent
    current_parent="$(dirname "${CURRENT_LINK}")"
    mkdir -p "${current_parent}"
    ln -sfn "${DEPLOY_DIR}" "${CURRENT_LINK}"
}

sync_bundle() {
    local init_dir="${DEPLOY_DIR}/init-db"
    local bundle_dir=""
    local bundle_env_example=""
    local bundle_readme=""
    local bundle_init_sql=""
    local bundle_update=""
    local bundle_repair_mysql=""
    local bundle_repair_deploy=""
    local bundle_fresh=""
    local bundle_quick=""

    mkdir -p "${init_dir}"

    if [ -f "${SCRIPT_DIR}/fresh-install.sh" ] \
        && [ -f "${SCRIPT_DIR}/repair-deploy.sh" ] \
        && [ -f "${SCRIPT_DIR}/../../deploy/docker-compose.yml" ] \
        && [ -f "${SCRIPT_DIR}/../../deploy/.env.example" ]; then
        bundle_dir="${SCRIPT_DIR}/../../deploy"
        bundle_env_example="${bundle_dir}/.env.example"
        bundle_readme="${bundle_dir}/README.md"
        bundle_init_sql="${bundle_dir}/init-db/01-init.sql"
        bundle_update="${SCRIPT_DIR}/update-app.sh"
        bundle_repair_mysql="${SCRIPT_DIR}/repair-mysql.sh"
        bundle_repair_deploy="${SCRIPT_DIR}/repair-deploy.sh"
        bundle_fresh="${SCRIPT_DIR}/fresh-install.sh"
        bundle_quick="${SCRIPT_DIR}/quick-deploy.sh"
    elif [ -f "${SCRIPT_DIR}/docker-compose.yml" ] \
        && [ -f "${SCRIPT_DIR}/.env.example" ] \
        && [ -f "${SCRIPT_DIR}/init-db/01-init.sql" ]; then
        bundle_dir="${SCRIPT_DIR}"
        bundle_env_example="${bundle_dir}/.env.example"
        bundle_readme="${bundle_dir}/README.md"
        bundle_init_sql="${bundle_dir}/init-db/01-init.sql"
        bundle_update="${bundle_dir}/update-app.sh"
        bundle_repair_mysql="${bundle_dir}/repair-mysql.sh"
        bundle_repair_deploy="${bundle_dir}/repair-deploy.sh"
        bundle_fresh="${bundle_dir}/fresh-install.sh"
        bundle_quick="${bundle_dir}/quick-deploy.sh"
    fi

    if [ -n "${bundle_dir}" ]; then
        if [ "${PRESERVE_COMPOSE_LAYOUT}" != "1" ]; then
            copy_file_if_needed "${bundle_dir}/docker-compose.yml" "${DEPLOY_DIR}/docker-compose.yml"
            copy_file_if_needed "${bundle_env_example}" "${DEPLOY_DIR}/.env.example"
            copy_file_if_needed "${bundle_readme}" "${DEPLOY_DIR}/README.md"
            copy_file_if_needed "${bundle_init_sql}" "${init_dir}/01-init.sql"
        elif [ ! -f "${DEPLOY_DIR}/.env.example" ]; then
            copy_file_if_needed "${bundle_env_example}" "${DEPLOY_DIR}/.env.example"
        fi

        copy_file_if_needed "${bundle_update}" "${DEPLOY_DIR}/update-app.sh"
        copy_file_if_needed "${bundle_repair_mysql}" "${DEPLOY_DIR}/repair-mysql.sh"
        copy_file_if_needed "${bundle_repair_deploy}" "${DEPLOY_DIR}/repair-deploy.sh"
        copy_file_if_needed "${bundle_fresh}" "${DEPLOY_DIR}/fresh-install.sh"
        copy_file_if_needed "${bundle_quick}" "${DEPLOY_DIR}/quick-deploy.sh"
    else
        if [ "${PRESERVE_COMPOSE_LAYOUT}" != "1" ]; then
            download_file "deploy/docker-compose.yml" "${DEPLOY_DIR}/docker-compose.yml"
            download_file "deploy/.env.example" "${DEPLOY_DIR}/.env.example"
            download_file "deploy/README.md" "${DEPLOY_DIR}/README.md"
            download_file "deploy/init-db/01-init.sql" "${init_dir}/01-init.sql"
        elif [ ! -f "${DEPLOY_DIR}/.env.example" ]; then
            download_file "deploy/.env.example" "${DEPLOY_DIR}/.env.example"
        fi

        download_file "scripts/deploy/update-app.sh" "${DEPLOY_DIR}/update-app.sh"
        download_file "scripts/deploy/repair-mysql.sh" "${DEPLOY_DIR}/repair-mysql.sh"
        download_file "scripts/deploy/repair-deploy.sh" "${DEPLOY_DIR}/repair-deploy.sh"
        download_file "scripts/deploy/fresh-install.sh" "${DEPLOY_DIR}/fresh-install.sh"
        download_file "scripts/deploy/quick-deploy.sh" "${DEPLOY_DIR}/quick-deploy.sh"
    fi

    if [ ! -f "${DEPLOY_DIR}/.env" ] && [ -f "${DEPLOY_DIR}/.env.example" ]; then
        cp "${DEPLOY_DIR}/.env.example" "${DEPLOY_DIR}/.env"
        print_warning "未检测到 .env，已根据 .env.example 生成默认配置，请尽快检查密码和端口。"
    fi

    chmod +x \
        "${DEPLOY_DIR}/update-app.sh" \
        "${DEPLOY_DIR}/repair-mysql.sh" \
        "${DEPLOY_DIR}/repair-deploy.sh" \
        "${DEPLOY_DIR}/fresh-install.sh" \
        "${DEPLOY_DIR}/quick-deploy.sh"
}

run_db_repair_if_requested() {
    if [ "${RUN_DB_REPAIR}" = "1" ]; then
        print_info "执行数据库修复脚本..."
        "${DEPLOY_DIR}/repair-mysql.sh" --deploy-dir "${DEPLOY_DIR}"
    fi
}

main() {
    parse_args "$@"
    resolve_deploy_dir

    mkdir -p "${DEPLOY_DIR}"

    if [ "${BACKUP_BEFORE_SYNC}" = "1" ]; then
        backup_bundle
    fi

    sync_bundle
    mark_current_release
    run_db_repair_if_requested

    echo ""
    print_success "部署包修复完成。"
    echo "部署目录: ${DEPLOY_DIR}"
    echo "当前版本链接: ${CURRENT_LINK}"
    echo "主程序更新命令: ${DEPLOY_DIR}/update-app.sh"
    echo "数据库修复命令: ${DEPLOY_DIR}/repair-mysql.sh --backup"
    echo ""
}

main "$@"
