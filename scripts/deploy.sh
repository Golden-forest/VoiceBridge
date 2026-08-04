#!/usr/bin/env bash
#
# VoiceBridge 统一部署脚本
#
# 用法：
#   ./scripts/deploy.sh              # 部署前端 + 后端（默认）
#   ./scripts/deploy.sh frontend     # 只部署前端 PWA
#   ./scripts/deploy.sh backend      # 只部署后端 Supabase
#   ./scripts/deploy.sh db           # 只推送数据库 migration
#   ./scripts/deploy.sh functions    # 只部署所有 Edge Functions
#   ./scripts/deploy.sh --help       # 显示帮助
#
# 前置条件：
#   - wrangler 已登录（npx wrangler login）
#   - supabase 已登录（npx supabase login）
#
# 项目信息：
#   - Cloudflare Pages 项目：voicebridge（voicebridge-6kr.pages.dev）
#   - Supabase 项目：VoiceBridge（ref: gqxxknusznbunkiznnal）

set -euo pipefail

# ── 颜色 ─────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ── 项目常量 ──────────────────────────────────────────
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CF_PROJECT_NAME="voicebridge"
PWA_DIR="${PROJECT_ROOT}/hosted-pwa"
PWA_DIST="${PWA_DIR}/dist"

# Edge Functions 列表（config.toml 中定义的所有函数）
# 格式："函数名:是否验证JWT"
EDGE_FUNCTIONS=(
  "transcribe:false"
  "device-pairing:false"
  "billing-create-checkout-session:true"
  "billing-create-portal-session:true"
  "stripe-webhook:false"
  "paddle-webhook:false"
)

# ── 帮助 ─────────────────────────────────────────────
show_help() {
  cat <<'EOF'
VoiceBridge 统一部署脚本

用法:
  ./scripts/deploy.sh [目标]

目标:
  (无参数)     部署前端 PWA + 后端 Supabase（functions + db）
  frontend     只部署前端 PWA 到 Cloudflare Pages
  backend      只部署后端（functions + db）
  db           只推送数据库 migration
  functions    只部署所有 Edge Functions

示例:
  ./scripts/deploy.sh frontend       # 只更新前端
  ./scripts/deploy.sh backend        # 只更新后端
  ./scripts/deploy.sh functions      # 只更新 Edge Functions
  ./scripts/deploy.sh                # 全量部署

前置条件:
  1. npx wrangler login    （首次需要）
  2. npx supabase login    （首次需要，token 会过期）

项目信息:
  Cloudflare Pages: voicebridge (voicebridge-6kr.pages.dev)
  Supabase:         VoiceBridge (gqxxknusznbunkiznnal)
EOF
  exit 0
}

# ── 前端部署 ──────────────────────────────────────────
deploy_frontend() {
  info "=== 前端 PWA 部署 ==="

  # 检查 wrangler 认证
  if ! npx wrangler whoami >/dev/null 2>&1; then
    fail "wrangler 未登录，请先执行: npx wrangler login"
  fi
  ok "wrangler 已认证"

  # 构建
  info "构建前端（hosted-pwa）..."
  cd "${PWA_DIR}"
  npm run build
  cd "${PROJECT_ROOT}"
  ok "构建完成"

  # 检查关键产物
  local required_files=(
    "${PWA_DIST}/server/index.js"
    "${PWA_DIST}/client/index.html"
    "${PWA_DIST}/client/app.html"
    "${PWA_DIST}/client/config.js"
  )
  for f in "${required_files[@]}"; do
    [[ -f "$f" ]] || fail "构建产物缺失: $f"
  done
  ok "构建产物校验通过"

  # 部署整个 dist 目录（包含 client/ + server/，Cloudflare Pages 需要 Worker 路由）
  info "部署到 Cloudflare Pages（${CF_PROJECT_NAME}）..."
  npx wrangler pages deploy "${PWA_DIST}" \
    --project-name="${CF_PROJECT_NAME}" \
    --branch=main \
    --commit-dirty=true

  ok "前端部署完成: https://${CF_PROJECT_NAME}-6kr.pages.dev"
}

# ── 数据库 migration ──────────────────────────────────
deploy_db() {
  info "=== 数据库 Migration 推送 ==="

  # 检查 supabase 认证
  if ! npx supabase projects list >/dev/null 2>&1; then
    fail "supabase 未登录或 token 过期，请先执行: npx supabase login"
  fi
  ok "supabase 已认证"

  cd "${PROJECT_ROOT}"
  info "推送 migration（--linked --include-all）..."
  npx supabase db push --linked --include-all
  ok "数据库 migration 推送完成"
}

# ── Edge Functions 部署 ───────────────────────────────
deploy_functions() {
  info "=== Edge Functions 部署 ==="

  # 检查 supabase 认证
  if ! npx supabase projects list >/dev/null 2>&1; then
    fail "supabase 未登录或 token 过期，请先执行: npx supabase login"
  fi
  ok "supabase 已认证"

  cd "${PROJECT_ROOT}"

  for entry in "${EDGE_FUNCTIONS[@]}"; do
    local fn_name="${entry%%:*}"
    local verify_jwt="${entry##*:}"

    info "部署 ${fn_name} ..."
    if [[ "${verify_jwt}" == "false" ]]; then
      npx supabase functions deploy "${fn_name}" --no-verify-jwt
    else
      npx supabase functions deploy "${fn_name}"
    fi
    ok "${fn_name} 部署完成"
  done

  ok "所有 Edge Functions 部署完成"
}

# ── 后端部署（functions + db）─────────────────────────
deploy_backend() {
  deploy_db
  echo ""
  deploy_functions
}

# ── 全量部署 ──────────────────────────────────────────
deploy_all() {
  deploy_frontend
  echo ""
  deploy_backend
}

# ── 参数解析 ──────────────────────────────────────────
case "${1:-all}" in
  all|"")
    deploy_all
    ;;
  frontend|pwa)
    deploy_frontend
    ;;
  backend)
    deploy_backend
    ;;
  db|migration|migrations)
    deploy_db
    ;;
  functions|function|edge)
    deploy_functions
    ;;
  --help|-h|help)
    show_help
    ;;
  *)
    fail "未知目标: $1\n运行 ./scripts/deploy.sh --help 查看可用选项"
    ;;
esac

echo ""
ok "部署流程结束。"
