#!/usr/bin/env bash
# 观测面截图（只截模拟器设备画面：simctl io screenshot）。禁止全屏桌面截图。
#
# 采集纪律（每条都是踩过的坑，不是风格）：
#   1. 构建退出码必须为 0 才继续 —— 构建红时旧 .app 还留在 DerivedData，install 照装会造假绿；
#   2. 装完比对**安装容器里**的可执行文件哈希与本次构建产物，不一致拒绝采图；
#   3. 情形经 SIMCTL_CHILD_DSH_IOS_FIXTURE_SCENARIO 注入（simctl 会剥掉 SIMCTL_CHILD_ 前缀）；
#   4. unreachable 要截**第二屏**：首屏是"先有缓存"的正常态。
#      **时序来源**（写在这里，是为了让它在间隔被改时先过期）：刷新循环在
#      Sources/App/DshTradingNativeApp.swift 的 .task 里 —— 先立刻 refresh() 一次，之后每 30 秒一次
#      （硬编码 Task.sleep(for: .seconds(30))）。故时间线是 t≈0 成功、t≈30s 抛 .unreachable，
#      36s 落在第二次之后。**那 30 秒一旦改动，本文件的 36 就不再正确。**
#      另外四档（running/restricted/stopped/unknown-enum）首屏即可：判据来自首帧的 A0 与卡片。
#
# 用法：bash docs/evidence/capture-screenshots.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

UDID=536D8D31-6BA6-4535-BCEF-842E9A47078D
BUNDLE_ID=com.dshtrading.ios-native
APP="$PWD/build/DerivedData/Build/Products/Debug-iphonesimulator/DshTradingNative.app"
OUT="$PWD/docs/evidence/screenshots"
mkdir -p "$OUT"

LOCK=build/.heavy.lock
mkdir -p "$(dirname "$LOCK")"
for _ in $(seq 1 60); do mkdir "$LOCK" 2>/dev/null && break; sleep 10; done
export TMPDIR="$PWD/build/tmp"
mkdir -p "$TMPDIR"

echo "=== 1) 构建（退出码必须为 0）==="
xcodegen generate >/dev/null 2>&1 || { echo "FAIL: xcodegen 未成功"; exit 1; }
if ! xcodebuild -project DshTradingNative.xcodeproj -scheme DshTradingNative \
      -destination "id=$UDID" -derivedDataPath build/DerivedData \
      OTHER_SWIFT_FLAGS='-disable-sandbox' build >/tmp/ios-capture-build.log 2>&1; then
  echo "FAIL: 构建未成功（见 /tmp/ios-capture-build.log）—— 拒绝采图，否则会装旧产物造假绿"
  exit 1
fi
grep -q "BUILD SUCCEEDED" /tmp/ios-capture-build.log || { echo "FAIL: 未见到 BUILD SUCCEEDED"; exit 1; }
rmdir "$LOCK" 2>/dev/null || true
echo "构建 OK（Release 前的重活锁已释放）"

echo "=== 2) 安装 + 二进制新鲜度断言 ==="
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl install "$UDID" "$APP"
# 比的是**整个 bundle 的清单哈希**，不是只看 App 可执行文件 ——
# 真正会被改动的层（Domain/Offline/Features…）在嵌入的 framework 里，
# App 可执行文件的哈希可以**一动不动**（实测踩过：改了 Domain，App 可执行文件哈希不变）。
bundle_manifest_sha() {
  ( cd "$1" && find . -type f | sort | while read -r one; do shasum -a 256 "$one"; done | shasum -a 256 | awk '{print $1}' )
}
BUILT_SHA=$(bundle_manifest_sha "$APP")
INSTALLED_DIR=$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" app)
INSTALLED_SHA=$(bundle_manifest_sha "$INSTALLED_DIR")
if [ -z "$BUILT_SHA" ] || [ "$BUILT_SHA" != "$INSTALLED_SHA" ]; then
  echo "FAIL: 模拟器里的 bundle 与本次构建不一致（built=$BUILT_SHA installed=$INSTALLED_SHA）；拒绝采图"
  exit 1
fi
DOMAIN_SHA=$(shasum -a 256 "$INSTALLED_DIR/Frameworks/DshTradingDomain.framework/DshTradingDomain" | awk '{print $1}')
echo "ok: 模拟器里跑的是本次构建的 bundle（清单 sha256=${BUILT_SHA}）"
echo "    Domain.framework 二进制 sha256=$DOMAIN_SHA"

echo "=== 3) 五情形采集 ==="
for scenario in running restricted stopped unreachable unknown-enum; do
  xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  SIMCTL_CHILD_DSH_IOS_FIXTURE_SCENARIO="$scenario" \
    xcrun simctl launch "$UDID" "$BUNDLE_ID" --args --fixtures >/dev/null 2>&1 || true
  if [ "$scenario" = "unreachable" ]; then
    echo "  unreachable: 等第二次刷新后再截（依赖 App 的 30s 刷新间隔，见文件头时序来源）"
    sleep 36
  else
    sleep 4
  fi
  xcrun simctl io "$UDID" screenshot "$OUT/$scenario.png" >/dev/null 2>&1
  echo "  captured $scenario"
done

echo "完成：$OUT"
