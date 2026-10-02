#!/usr/bin/env bash
# 各层测试一键复现（IOS-3 验收夹具）：
#   * ContractTests 走 macOS xctest（逻辑测试，秒级）；
#   * 其余五层走 iOS 模拟器上的 xctest agent（simctl spawn）。
#
# 为什么不用 xcodebuild test：本机 DSH 文件沙箱下 xcodebuild 的测试启动器拿不到 PTY
# （Pseudo Terminal Setup Error），而 simctl spawn 直接跑同一个测试 bundle 是可行的。
# 同理，Swift 宏插件需要 -disable-sandbox 才能在沙箱内加载。
#
# 用法：bash docs/evidence/run-all-tests.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

LOCK=build/.heavy.lock
mkdir -p "$(dirname "$LOCK")"
for _ in $(seq 1 60); do mkdir "$LOCK" 2>/dev/null && break; sleep 10; done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

export TMPDIR="$PWD/build/tmp"
mkdir -p "$TMPDIR"

UDID=536D8D31-6BA6-4535-BCEF-842E9A47078D
AGENT=/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/Xcode/Agents/xctest
PRODUCTS_IOS="$PWD/build/DerivedData/Build/Products/Debug-iphonesimulator"
PRODUCTS_MAC="$PWD/build/DerivedData/Build/Products/Debug"
LOG_DIR="$PWD/docs/evidence/logs"
mkdir -p "$LOG_DIR"

export SIMCTL_CHILD_DYLD_FRAMEWORK_PATH="$PRODUCTS_IOS"
export SIMCTL_CHILD_DYLD_LIBRARY_PATH="$PRODUCTS_IOS"

xcodegen generate >/dev/null 2>&1

SCHEMES="DshTradingContractTests DshTradingTransportTests DshTradingDomainTests DshTradingFeaturesTests DshTradingAlertsTests DshTradingOfflineTests"
for scheme in $SCHEMES; do
  if [ "$scheme" = "DshTradingContractTests" ]; then DEST="platform=macOS"; else DEST="id=$UDID"; fi
  xcodebuild -project DshTradingNative.xcodeproj -scheme "$scheme" \
    -destination "$DEST" -derivedDataPath build/DerivedData \
    OTHER_SWIFT_FLAGS='-disable-sandbox' build-for-testing >>"$LOG_DIR/$scheme.build.log" 2>&1
  echo "build $scheme exit=$?"
done

run_ios() {
  xcrun simctl spawn "$UDID" "$AGENT" "$PRODUCTS_IOS/$1.xctest" >"$LOG_DIR/$1.test.log" 2>&1
  echo "test $1 exit=$?"
}

run_mac() {
  xcrun xctest "$PRODUCTS_MAC/$1.xctest" >"$LOG_DIR/$1.test.log" 2>&1
  echo "test $1 exit=$?"
}

run_mac DshTradingContractTests
run_ios DshTradingTransportTests
run_ios DshTradingDomainTests
run_ios DshTradingFeaturesTests
run_ios DshTradingAlertsTests
run_ios DshTradingOfflineTests

echo "=== summary ==="
for scheme in $SCHEMES; do
  line=$(grep -E "Executed [0-9]+ tests, with" "$LOG_DIR/$scheme.test.log" | tail -1)
  printf '%-28s %s\n' "$scheme" "${line:-[无报告]}"
done
