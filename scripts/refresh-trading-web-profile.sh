#!/usr/bin/env bash
# 刷新 trading-web profile 的 dsh-trading 包副本，并恢复宿主核心包单一实例 dedupe。
#
# 背景（2026-09-01「本轮运行失败 reading 'prepare'」）：
#   profile 自带的 @deepseek-ai/* 影子拷贝（dsh-tools 等）与宿主 dsh CLI 内的同一
#   包是两个模块实例——dsh-tools 的 TOOL_RUNTIME_SCHEDULER 是模块级 Symbol，跨拷贝
#   互不相认。宿主 α3 agent-loop 用 Symbol 读调度器，profile 影子拷贝（α2）提供的
#   实例上读不到 → 每次工具调用（PTC run_code 尤甚）崩
#   "Cannot read properties of undefined (reading 'prepare')"。
#   纯文本回复不走工具调度，因此「能聊天、一干活就崩」。
#
# 用法：scripts/refresh-trading-web-profile.sh [pkg ...]
#   无参数 = 刷新全部 @dsh-trading 包副本；带参数 = 只刷新指定包（如 client-ui-trading）。
# 前置：先在仓库跑 pnpm build。脚本会停掉运行中的 trading-web 实例。

set -euo pipefail

PROFILE="$HOME/.dsh/profiles/trading-web"
HOST_ROOT="/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
# 与宿主 CLI 树重叠、必须保持单一模块实例的核心包（模块级状态/Symbol 载体）。
CORE_PKGS=(dsh-web-app dsh-tools cosmokit schemastery dsh-agent-presets dsh-brand dsh-util-values)

echo "== 停止运行中的 trading-web 实例 =="
pgrep -f "profile trading-web" | xargs kill 2>/dev/null || true
sleep 1

echo "== 刷新 @dsh-trading 包副本 =="
if [ "$#" -gt 0 ]; then
  for pkg in "$@"; do rm -rf "$PROFILE/node_modules/@dsh-trading/$pkg"; done
else
  rm -rf "$PROFILE"/node_modules/@dsh-trading/*
fi
dsh plugin --profile trading-web install

echo "== 恢复宿主核心包单一实例 symlink（pnpm install 会重新物化影子拷贝，必须重挂）=="
# 递归处理：包括嵌套 node_modules 里的残留拷贝（如 @dsh-trading/knowledge 下的 dsh-tools）。
for pkg in "${CORE_PKGS[@]}"; do
  while IFS= read -r shadow; do
    rm -rf "$shadow"
    ln -s "$HOST_ROOT/$pkg" "$shadow"
    echo "  linked: ${shadow#"$PROFILE"/node_modules/} -> host/$pkg"
  done < <(find "$PROFILE/node_modules" -type d -path "*/@deepseek-ai/$pkg" \
             -not -path "$HOST_ROOT/*" 2>/dev/null)
done

echo "== 完成。启动实例：cd <你的工作目录> && dsh --profile trading-web --port 3081 --no-open =="
echo "   （token 每次重启轮换，从启动日志取新值）"
