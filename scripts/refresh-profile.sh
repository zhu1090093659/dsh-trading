#!/usr/bin/env bash
# 刷新任意 trading profile 的 @dshtrading 包副本，并恢复宿主核心包单一实例 dedupe。
#
# 背景（2026-09-01「本轮运行失败 reading 'prepare'」）：
#   profile 自带的 @deepseek-ai/* 影子拷贝（dsh-tools 等）与宿主 dsh CLI 内的同一
#   包是两个模块实例——dsh-tools 的 TOOL_RUNTIME_SCHEDULER 是模块级 Symbol，跨拷贝
#   互不相认。宿主 α3 agent-loop 用 Symbol 读调度器，profile 影子拷贝（α2）提供的
#   实例上读不到 -> 每次工具调用（PTC run_code 尤甚）崩
#   "Cannot read properties of undefined (reading 'prepare')"。
#   纯文本回复不走工具调度，因此「能聊天、一干活就崩」。
#
# 2026-10-09 泛化：此前入口硬编码 trading-web，trading-all / trading-dev 只能照
#   profile-cohort-normalize note 手工复刻（同步 overrides、删副本、install、重挂
#   symlink 四步），漏掉任一步就留下混世代副本或双模块实例。本脚本一次处理任意/多个
#   profile，把四步收成一条命令：install 后**始终**重挂核心包 symlink，不让它成为
#   容易被漏掉的手工步骤。旧入口 scripts/refresh-trading-web-profile.sh 保留为转发
#   shim（外部技能与既有习惯继续可用）。
#
# 用法：scripts/refresh-profile.sh [选项] [profile ...]
#   --profile <p>      要刷新的 profile（可重复；与位置参数等价；缺省 trading-web）
#   --package <pkg>    只刷新指定 @dshtrading 包（可重复；缺省 = 全部）
#   --dsh-home <dir>   profile 所在 home（缺省 $DSH_HOME 或 ~/.dsh-trading）
#   --host-root <dir>  宿主核心包目录（缺省 $DSH_TRADING_HOST_ROOT，再缺省 Homebrew dsh）
#   -h, --help         打印本帮助
#   位置参数一律是 profile 名；「只刷某个包」用 --package。旧脚本的位置参数是包名，
#   由 shim 翻译，语义不变。
# 前置：先在仓库跑 pnpm build。脚本会停掉目标 profile 的运行中实例。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HOST_ROOT="/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"
# 与宿主 CLI 树重叠、必须保持单一模块实例的核心包（模块级状态/Symbol 载体）。
# 2026-09-02 扩充：profile-cohort-check 查出 router 构建产物内嵌 0.1.2-alpha.2 残留
# 拷贝（dsh-llm/dsh-scope/dsh-timeout/dsh-typert-protocol/dsh-util-crypto，仓库
# lockfile 混代遗留）及三份同版实体拷贝（dsh-settings/dsh-skill/dsh-tool-cordis），
# 全部并入 symlink 归一，消除模块实例割裂类 FAIL/WARN。
# 2026-09-29 0.2.0-rc.2 cohort：dsh-agent-presets 官方改名 dsh-agent-preset-registry
# （两个名字都留，兼容旧 profile）；并按同代 profile-cohort-check 的 WARN 清单补入
# dsh-app-boot / dsh-atomic-write / dsh-config-editor / dsh-package-manifest。
CORE_PKGS=(dsh-web-app dsh-tools cosmokit schemastery dsh-agent-presets dsh-agent-preset-registry \
  dsh-brand dsh-util-values dsh-settings dsh-skill dsh-tool-cordis dsh-llm dsh-scope dsh-timeout \
  dsh-typert-protocol dsh-util-crypto dsh-app-boot dsh-atomic-write dsh-config-editor \
  dsh-package-manifest)

usage() {
  cat <<'USAGE'
用法：scripts/refresh-profile.sh [选项] [profile ...]

  --profile <p>      要刷新的 profile（可重复；与位置参数等价；缺省 trading-web）
  --package <pkg>    只刷新指定 @dshtrading 包（可重复；缺省 = 全部）
  --dsh-home <dir>   profile 所在 home（缺省 $DSH_HOME 或 ~/.dsh-trading）
  --host-root <dir>  宿主核心包目录（缺省 $DSH_TRADING_HOST_ROOT 或 Homebrew dsh）
  -h, --help         本帮助

位置参数一律是 profile 名；「只刷某个包」用 --package。
旧入口 scripts/refresh-trading-web-profile.sh 是转发 shim，其位置参数仍是包名。
前置：先在仓库跑 pnpm build；脚本会停掉目标 profile 的运行中实例。
USAGE
}

DH_FLAG=""
HOST_ROOT_FLAG=""
PROFILES=()
PKGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) [ -n "${2:-}" ] || { echo "缺少 --profile 的值" >&2; exit 1; }; PROFILES+=("$2"); shift 2 ;;
    --profile=*) [ -n "${1#--profile=}" ] || { echo "缺少 --profile 的值" >&2; exit 1; }; PROFILES+=("${1#--profile=}"); shift ;;
    --package) [ -n "${2:-}" ] || { echo "缺少 --package 的值" >&2; exit 1; }; PKGS+=("$2"); shift 2 ;;
    --package=*) [ -n "${1#--package=}" ] || { echo "缺少 --package 的值" >&2; exit 1; }; PKGS+=("${1#--package=}"); shift ;;
    --dsh-home) [ -n "${2:-}" ] || { echo "缺少 --dsh-home 的值" >&2; exit 1; }; DH_FLAG="$2"; shift 2 ;;
    --dsh-home=*) [ -n "${1#--dsh-home=}" ] || { echo "缺少 --dsh-home 的值" >&2; exit 1; }; DH_FLAG="${1#--dsh-home=}"; shift ;;
    --host-root) [ -n "${2:-}" ] || { echo "缺少 --host-root 的值" >&2; exit 1; }; HOST_ROOT_FLAG="$2"; shift 2 ;;
    --host-root=*) [ -n "${1#--host-root=}" ] || { echo "缺少 --host-root 的值" >&2; exit 1; }; HOST_ROOT_FLAG="${1#--host-root=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "未知选项：$1" >&2; usage >&2; exit 1 ;;
    *) PROFILES+=("$1"); shift ;;
  esac
done

[ "${#PROFILES[@]}" -gt 0 ] || PROFILES=(trading-web)
HOST_ROOT="${HOST_ROOT_FLAG:-${DSH_TRADING_HOST_ROOT:-$DEFAULT_HOST_ROOT}}"

# dsh-trading 独立 home（2026-09-08 DSH_HOME 分离）；--dsh-home > 环境 DSH_HOME > 缺省。
export DSH_HOME="${DH_FLAG:-${DSH_HOME:-$HOME/.dsh-trading}}"

# 守卫（2026-10-01 实测踩中）：agent 会话会继承**宿主实例**的 DSH_HOME
# （~/.dsh + DSH_PROFILE=desktop）。那种情况下这里的缺省回落拿到的是宿主 home，
# 本脚本就会在另一个 home 里刷新同名 profile。破坏性脚本不该在这种歧义下继续。
if [ "$DSH_HOME" = "$HOME/.dsh" ]; then
  echo "拒绝执行：DSH_HOME 指向宿主 dsh home（${DSH_HOME}），不是 trading home。" >&2
  echo "本项目一律用 ~/.dsh-trading；请显式设置 DSH_HOME=$HOME/.dsh-trading 后重试。" >&2
  exit 2
fi

# 参数校验先于环境前提：目标 profile 不存在属于调用方错误，必须在「本机有没有 dsh」
# 之前给出结论。此前 dsh 检查在前，CI（无 dsh）上不存在的 profile 会报「找不到 dsh」，
# 掩盖真正的错误；2026-10-09 的 refresh-profile.test.mjs 在 CI 上据此判红。
for p in "${PROFILES[@]}"; do
  [ -f "$DSH_HOME/profiles/$p/package.json" ] || { echo "profile 不存在：$DSH_HOME/profiles/$p" >&2; exit 1; }
done
command -v dsh >/dev/null 2>&1 || { echo "找不到 dsh 可执行文件（刷新依赖 dsh plugin install）" >&2; exit 1; }

echo "== 同步 profile overrides（幂等追加，修闭包缺口；只增行不删活包）=="
for p in "${PROFILES[@]}"; do
  node "$SCRIPT_DIR/sync-profile-overrides.mjs" --profile "$p" --dsh-home "$DSH_HOME"
done

echo "== Profile 配置预检（死路径/身份漂移/闭包缺口，失败即中止）=="
# 版本漂移由紧随其后的删副本 + 重装消除，故预检对它只告警不中止。
"$SCRIPT_DIR/profile-config-preflight.sh" --allow-version-drift "${PROFILES[@]}"

echo "== 刷新 @dshtrading 包副本 =="
for p in "${PROFILES[@]}"; do
  PROFILE="$DSH_HOME/profiles/$p"
  echo "-- $p --"
  echo "   停止运行中的 $p 实例"
  # 只杀真正在跑该 profile 的宿主，绝不误杀刷新器自身：泛化后本脚本命令行里
  # 就可能含 "--profile <p>"，裸 pgrep -f "profile <p>" 会匹配到自己并自杀。
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *refresh-profile.sh*|*refresh-trading-web-profile.sh*) continue ;;
    esac
    kill "$pid" 2>/dev/null || true
  done < <(pgrep -f "profile $p" || true)
  sleep 1
  if [ "${#PKGS[@]}" -gt 0 ]; then
    for pkg in "${PKGS[@]}"; do rm -rf "$PROFILE/node_modules/@dshtrading/$pkg"; done
  else
    rm -rf "$PROFILE"/node_modules/@dshtrading/*
  fi
  dsh plugin --profile "$p" install
done

echo "== 恢复宿主核心包单一实例 symlink（pnpm install 会重新物化影子拷贝，必须重挂）=="
# 递归处理：包括嵌套 node_modules 里的残留拷贝（如 @dshtrading/knowledge 下的 dsh-tools）。
# -type d -o -type l：桌面壳 normalizeProfileCohort 把核心包归一为指向自带 runtime 的
# symlink，只匹配目录会漏掉这些链接。两类都要重挂到宿主。
for p in "${PROFILES[@]}"; do
  PROFILE="$DSH_HOME/profiles/$p"
  for pkg in "${CORE_PKGS[@]}"; do
    if [ ! -e "$HOST_ROOT/$pkg" ]; then
      continue
    fi
    while IFS= read -r shadow; do
      rm -rf "$shadow"
      ln -s "$HOST_ROOT/$pkg" "$shadow"
      echo "  linked: [$p] ${shadow#"$PROFILE"/node_modules/} -> host/$pkg"
    done < <(find "$PROFILE/node_modules" \( -type d -o -type l \) -path "*/@deepseek-ai/$pkg" \
               -not -path "$HOST_ROOT/*" 2>/dev/null)
  done
done

echo "== 完成（共 ${#PROFILES[@]} 个 profile：${PROFILES[*]}）=="
echo "   启动实例：cd <你的工作目录> && dsh-trading --profile <profile>"
echo "   trading-web 缺省 8888，可用 --no-open 不自动开浏览器；token 每次重启轮换，从启动日志取新值。"
