#!/usr/bin/env bash
# 各层测试一键复现（IOS-3 验收夹具）：
#   * ContractTests 走 macOS xctest（逻辑测试，秒级）；
#   * 其余五层走 iOS 模拟器上的 xctest agent（simctl spawn）。
#
# 为什么不用 xcodebuild test：本机 DSH 文件沙箱下 xcodebuild 的测试启动器拿不到 PTY
# （Pseudo Terminal Setup Error），而 simctl spawn 直接跑同一个测试 bundle 是可行的。
# 同理 Swift 宏插件需要 -disable-sandbox 才能在沙箱内加载。
#
# 判据（2026-10-02 IOS-13 修假绿，按 IOS-4 §1/§12 的加强判据固化）：
#   * 每个目标**先删旧 .xctest**，再 build-for-testing。build 非 0 ⇒ 立刻点名该目标并非零
#     退出，绝不再跑 xctest —— "编译失败仍跑上一次留下的旧 bundle" 正是此前的假绿来源；
#   * build 成功但拿不到本次新产物（产物路径缺失，或二进制 mtime 早于本次 build 开始）⇒ 判红，
#     不执行 xctest（"拿不到新产物"不算通过）；
#   * 每个目标分别记录 build / test 两个退出码，并检查 xctest 报告（缺报告 ⇒ 判红）；
#     汇总里任一项非零 ⇒ 脚本整体非零（test 失败不中断，先把六目标的账记完）；
#   * 重活锁取不到 ⇒ exit 75（拒绝无锁并行跑重活）；只有本进程确实创建了锁才在 trap 里清理。
#
# 用法：bash docs/evidence/run-all-tests.sh
# 退出码：0 = 六目标全绿；1 = 任一 build/产物/报告/test 判红；75 = 取锁失败
set -euo pipefail
cd "$(dirname "$0")/../.."

# 重活串行锁：取不到就红，不"无锁也跑"，也不动别人的锁。
# 重试次数/间隔可用环境变量覆盖（门禁自测用；默认 60 × 10s = 600s，判据不改）。
LOCK=build/.heavy.lock
LOCK_TRIES=${RUN_ALL_TESTS_LOCK_TRIES:-60}
LOCK_INTERVAL=${RUN_ALL_TESTS_LOCK_INTERVAL:-10}
mkdir -p "$(dirname "$LOCK")"
lock_held=0
for _ in $(seq 1 "$LOCK_TRIES"); do
  if mkdir "$LOCK" 2>/dev/null; then lock_held=1; break; fi
  sleep "$LOCK_INTERVAL"
done
if [ "$lock_held" -ne 1 ]; then
  printf '[lock] ✗ 取锁失败：%s 已被占用（重试 %s 次仍拿不到）—— 拒绝无锁跑重活（另有构建在跑？）\n' "$LOCK" "$LOCK_TRIES" >&2
  exit 75
fi
# 只有本进程确实创建了这把锁才注册清理：否则会在别人持锁时删掉别人的锁，串行形同虚设。
trap '[ "$lock_held" -eq 1 ] && rmdir "$LOCK" 2>/dev/null || true' EXIT

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

if ! xcodegen generate >"$LOG_DIR/xcodegen.log" 2>&1; then
  printf '[gate] ✗ xcodegen generate 失败（见 %s）—— 拒绝带着旧工程继续\n' "$LOG_DIR/xcodegen.log" >&2
  exit 1
fi

SCHEMES=(DshTradingContractTests DshTradingTransportTests DshTradingDomainTests DshTradingFeaturesTests DshTradingAlertsTests DshTradingOfflineTests)

product_for() {
  case "$1" in
    DshTradingContractTests) printf '%s/%s.xctest' "$PRODUCTS_MAC" "$1" ;;
    *) printf '%s/%s.xctest' "$PRODUCTS_IOS" "$1" ;;
  esac
}

# macOS 的 .xctest 是 wrapper bundle（Contents/MacOS/<name>），iOS 的二进制直接躺在 bundle 根。
binary_for() {
  case "$1" in
    DshTradingContractTests) printf '%s/Contents/MacOS/%s' "$2" "$1" ;;
    *) printf '%s/%s' "$2" "$1" ;;
  esac
}

file_mtime() {
  case "$(uname -s)" in
    Darwin) stat -f '%m' "$1" ;;
    *) stat -c '%Y' "$1" ;;
  esac
}

BUILD_CODES=()
TEST_CODES=()
NOTES=()
failed=0

print_matrix() {
  printf '%-28s %-7s %-7s %s\n' 'target' 'build' 'test' 'report / note'
  local index
  for index in "${!SCHEMES[@]}"; do
    printf '%-28s %-7s %-7s %s\n' \
      "${SCHEMES[$index]}" \
      "${BUILD_CODES[$index]:--}" \
      "${TEST_CODES[$index]:--}" \
      "${NOTES[$index]:-未执行（前面的目标判红即中止）}"
  done
}

for index in "${!SCHEMES[@]}"; do
  scheme="${SCHEMES[$index]}"
  if [ "$scheme" = "DshTradingContractTests" ]; then
    destination="platform=macOS"
  else
    destination="id=$UDID"
  fi
  product="$(product_for "$scheme")"

  # ① 先删旧产物：让"沿用上一次留下的 bundle"这件事根本不可能发生
  rm -rf "$product"
  build_started=$(date +%s)
  if xcodebuild -project DshTradingNative.xcodeproj -scheme "$scheme" \
      -destination "$destination" -derivedDataPath build/DerivedData \
      OTHER_SWIFT_FLAGS='-disable-sandbox' build-for-testing >>"$LOG_DIR/$scheme.build.log" 2>&1; then
    build_code=0
  else
    build_code=$?
  fi
  BUILD_CODES[$index]="$build_code"
  echo "build $scheme exit=$build_code"

  if [ "$build_code" -ne 0 ]; then
    NOTES[$index]="build 失败（exit=${build_code}）⇒ 跳过 xctest（旧 bundle 已删）"
    printf '[gate] ✗ %s：build-for-testing exit=%s —— 立即中止，绝不用旧产物当结果（日志 %s）\n' \
      "$scheme" "$build_code" "$LOG_DIR/$scheme.build.log" >&2
    failed=1
    break
  fi

  binary="$(binary_for "$scheme" "$product")"
  if [ ! -f "$binary" ]; then
    NOTES[$index]="build 成功但拿不到产物（${binary}）⇒ 跳过 xctest"
    printf '[gate] ✗ %s：build 成功却拿不到新产物 %s —— 判红（拿不到新产物不算通过）\n' "$scheme" "$binary" >&2
    failed=1
    break
  fi
  product_mtime=$(file_mtime "$binary")
  if [ "$product_mtime" -lt "$build_started" ]; then
    NOTES[$index]="产物陈旧（mtime ${product_mtime} < build 开始 ${build_started}）⇒ 跳过 xctest"
    printf '[gate] ✗ %s：产物不是本次构建的（mtime %s 早于本次 build 开始 %s）—— 判红\n' \
      "$scheme" "$product_mtime" "$build_started" >&2
    failed=1
    break
  fi

  if [ "$scheme" = "DshTradingContractTests" ]; then
    if xcrun xctest "$product" >"$LOG_DIR/$scheme.test.log" 2>&1; then test_code=0; else test_code=$?; fi
  else
    if xcrun simctl spawn "$UDID" "$AGENT" "$product" >"$LOG_DIR/$scheme.test.log" 2>&1; then test_code=0; else test_code=$?; fi
  fi
  TEST_CODES[$index]="$test_code"
  echo "test $scheme exit=$test_code"

  report=$(grep -E 'Executed [0-9]+ tests?, with' "$LOG_DIR/$scheme.test.log" | tail -1 || true)
  report_failures=$(printf '%s' "$report" | sed -nE 's/.*with ([0-9]+) failures?.*/\1/p')
  if [ -z "$report" ]; then
    NOTES[$index]="[无报告] ⇒ 判红（xctest exit=${test_code}）"
    printf '[gate] ✗ %s：日志里没有 "Executed N tests, with M failures" 报告 —— 判红（未验证 ≠ 通过，日志 %s）\n' \
      "$scheme" "$LOG_DIR/$scheme.test.log" >&2
    failed=1
    continue
  fi
  NOTES[$index]="${report}（xctest exit=${test_code}）"
  if [ "$test_code" -ne 0 ] || [ "$report_failures" != "0" ]; then
    printf '[gate] ✗ %s：%s（xctest exit=%s）—— 判红\n' "$scheme" "$report" "$test_code" >&2
    failed=1
  fi
done

echo
echo "=== matrix ==="
print_matrix

if [ "$failed" -ne 0 ]; then
  echo '[gate] ✗ 判红：build / 新产物 / 报告 / test 任一项失败即整体失败' >&2
  exit 1
fi
echo '[gate] ✓ 六目标全绿：build=0、新产物齐、test=0、报告齐全'
