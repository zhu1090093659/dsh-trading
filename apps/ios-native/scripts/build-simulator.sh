#!/usr/bin/env bash
# 可复现的 iOS 模拟器构建（接口冻结 §2）。
#
# 生成物全部落在本目录（都已 gitignore）：
#   Generated/contract-snapshot.json —— 由 scripts/gen-contract-snapshot.mjs 从 TS 契约导出
#   DshTradingNative.xcodeproj       —— 由 xcodegen 从 project.yml 生成
#   build/DerivedData                —— 构建产物
set -euo pipefail
cd "$(dirname "$0")/.."

# 重活锁（接口冻结 §2「重活串行」）：同一时刻只允许一路 xcodegen/xcodebuild。
LOCK=build/.heavy.lock
mkdir -p "$(dirname "$LOCK")"
for _ in $(seq 1 90); do
  if mkdir "$LOCK" 2>/dev/null; then break; fi
  if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null; fi
  sleep 10
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

node scripts/gen-contract-snapshot.mjs
xcodegen generate
xcodebuild -project DshTradingNative.xcodeproj -scheme DshTradingNative \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -configuration Debug -derivedDataPath build/DerivedData build
