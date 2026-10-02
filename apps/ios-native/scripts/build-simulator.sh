#!/usr/bin/env bash
# 可复现的 iOS 模拟器构建（见 README §2「构建与测试」）。
#
# 生成物全部落在本目录（都已 gitignore）：
#   Generated/contract-snapshot.json —— 由 scripts/gen-contract-snapshot.mjs 从 TS 契约导出
#   DshTradingNative.xcodeproj       —— 由 xcodegen 从 project.yml 生成
#   build/DerivedData                —— 构建产物
set -euo pipefail
cd "$(dirname "$0")/.."

# 重活锁（重活串行，见 README §2）：同一时刻只允许一路 xcodegen/xcodebuild。
LOCK=build/.heavy.lock
mkdir -p "$(dirname "$LOCK")"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "HEAVY_LOCK_BUSY: $LOCK (do not wrap this script in the same lock)" >&2
  exit 75
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

node scripts/gen-contract-snapshot.mjs
xcodegen generate
xcodebuild -project DshTradingNative.xcodeproj -scheme DshTradingNative \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -configuration Debug -derivedDataPath build/DerivedData build
