#!/usr/bin/env bash
# 兼容 shim：本入口原名 scripts/refresh-trading-web-profile.sh，只刷新 trading-web。
# 2026-10-09 泛化为 scripts/refresh-profile.sh <profile...>（trading-all / trading-dev
# 等 profile 用同一条命令刷新，install 后必定重挂核心包 symlink）。本文件保留转发，
# 外部技能与既有习惯（含 ~/.agents/skills/dsh-sdk-upgrade 的引用）继续可用。
#
# 语义不变：位置参数仍是「只刷这些 @dshtrading 包」（缺省 = 全部），目标固定 trading-web。
# 用法：scripts/refresh-trading-web-profile.sh [pkg ...]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARGS=(trading-web)
for pkg in "$@"; do
  ARGS+=(--package "$pkg")
done

exec "$SCRIPT_DIR/refresh-profile.sh" "${ARGS[@]}"
