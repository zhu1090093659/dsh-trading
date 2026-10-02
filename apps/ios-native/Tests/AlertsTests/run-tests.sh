#!/bin/bash
# Alerts 用例的可复现运行入口（IOS-5 作用域：Tests/AlertsTests/**）。
#
# 与 Transport/Domain 同一台架：本机沙箱禁止 openpty，xcodebuild 的测试启动器报
# IDEPseudoTerminalDomain / errno 1，拿不到断言证据。这里把同一批
# Sources/Contract + Sources/Domain + Sources/Alerts + Tests/AlertsTests 放进临时 SwiftPM 包，
# 用 macOS 逻辑测试跑同一份用例（Alerts 只依赖 Foundation/Contract/Domain；
# UserNotifications/LocalAuthentication 的适配被端口隔离，测试不碰真系统能力）。
# SwiftPM 内层 sandbox-exec 也被外层挡住，故 --disable-sandbox。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
HARNESS="$(mktemp -d /tmp/dsh-alerts-tests.XXXXXX)"
mkdir -p "$HARNESS/Sources/DshTradingContract" "$HARNESS/Sources/DshTradingDomain" "$HARNESS/Sources/DshTradingAlerts" "$HARNESS/Tests/AlertsTests"
cp "$ROOT"/apps/ios-native/Sources/Contract/*.swift "$HARNESS/Sources/DshTradingContract/"
cp "$ROOT"/apps/ios-native/Sources/Domain/*.swift "$HARNESS/Sources/DshTradingDomain/"
cp "$ROOT"/apps/ios-native/Sources/Alerts/*.swift "$HARNESS/Sources/DshTradingAlerts/"
cp "$ROOT"/apps/ios-native/Tests/AlertsTests/*.swift "$HARNESS/Tests/AlertsTests/"
cat > "$HARNESS/Package.swift" <<'SWIFT'
// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "AlertsVerification",
    platforms: [.macOS(.v14)],
    products: [],
    targets: [
        .target(name: "DshTradingContract"),
        .target(name: "DshTradingDomain", dependencies: ["DshTradingContract"]),
        .target(name: "DshTradingAlerts", dependencies: ["DshTradingContract", "DshTradingDomain"]),
        .testTarget(name: "AlertsTests", dependencies: ["DshTradingAlerts", "DshTradingDomain", "DshTradingContract"]),
    ]
)
SWIFT
echo "Harness: $HARNESS"
xcrun swift test --package-path "$HARNESS" --scratch-path "$HARNESS/.build" --cache-path "$HARNESS/.cache" --disable-sandbox
