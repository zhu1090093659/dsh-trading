#!/usr/bin/env bash
# 观测面截图（只截模拟器设备画面：simctl io screenshot）。
# 禁止全屏桌面截图 —— 会卷入用户隐私且遮挡不可控（AGENTS.md 明文禁止）。
#
# 前提：
#   1. 组合根已接线（IOS-1）：Transport + Offline + Domain + Features 装配完成；
#   2. App bundle id = com.dshtrading.ios-native；
#   3. 夹具服务器可用（同目录 fixture-server.mjs）。
#
# 用法：bash docs/evidence/capture-screenshots.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

UDID=536D8D31-6BA6-4535-BCEF-842E9A47078D
PORT=8787
BUNDLE_ID=com.dshtrading.ios-native
APP="$PWD/build/DerivedData/Build/Products/Debug-iphonesimulator/DshTradingNative.app"
OUT="$PWD/docs/evidence/screenshots"
mkdir -p "$OUT"

if [ ! -d "$APP" ]; then
  echo "缺少 App：先跑 xcodebuild -scheme DshTradingNative build"
  exit 2
fi

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null

xcrun simctl install "$UDID" "$APP"

wait_fixture() {
  for _ in $(seq 1 50); do
    curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}

for scenario in running restricted stopped unreachable unknown-enum; do
  node "$PWD/docs/evidence/fixture-server.mjs" --scenario "$scenario" --port "$PORT" \
    >"/tmp/fixture-capture-$scenario.log" 2>&1 &
  server_pid=$!

  if [ "$scenario" != "unreachable" ]; then
    wait_fixture || { echo "FAIL $scenario: 夹具未就绪"; kill $server_pid 2>/dev/null; continue; }
  fi

  xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
  # 组合根若支持夹具地址注入，用 launch args 传；不支持就在设置页手动填
  #   http://127.0.0.1:PORT + 任意配对码
  xcrun simctl launch "$UDID" "$BUNDLE_ID" \
    --args -fixture-origin "http://127.0.0.1:$PORT" -fixture-code "any-code-1" >/dev/null 2>&1 || true

  # 截图不是测试：这里允许一次有界等待让首屏稳定（测试代码禁止 sleep 的纪律不适用于采集脚本）
  sleep 3
  xcrun simctl io "$UDID" screenshot "$OUT/$scenario.png" >/dev/null 2>&1
  echo "captured $scenario -> $OUT/$scenario.png"
  kill $server_pid 2>/dev/null
  wait $server_pid 2>/dev/null
done

echo "完成：$OUT"
