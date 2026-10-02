#!/bin/bash
# Transport 用例的可复现运行入口（IOS-2 作用域：Tests/TransportTests/**）。
#
# 为什么不是 xcodebuild test：本机运行沙箱禁止 openpty，xcodebuild 的测试启动器
# （iOS 模拟器与 macOS 目标都一样）报 IDEPseudoTerminalDomain / errno 1
# "Operation not permitted"，拿不到任何断言证据（IOS-1 的 IOS-1-VALIDATION.md 记录了同一现象）。
# 这里把**同一批** Sources/Contract + Sources/Transport + Tests/TransportTests 放进一个临时
# SwiftPM 包，用 macOS 逻辑测试跑同一份用例 —— Transport 只依赖 Foundation/Security，
# 平台无关。iOS 侧的编译由 xcodebuild build-for-testing 验证（不启动模拟器，不受 openpty 影响）。
#
# SwiftPM 自己的内层 sandbox-exec 也会被外层沙箱挡住，所以显式 --disable-sandbox。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
HARNESS="$(mktemp -d /tmp/dsh-transport-tests.XXXXXX)"
mkdir -p "$HARNESS/Sources/DshTradingContract" "$HARNESS/Sources/DshTradingTransport" "$HARNESS/Tests/DshTradingTransportTests"
cp "$ROOT"/apps/ios-native/Sources/Contract/*.swift "$HARNESS/Sources/DshTradingContract/"
cp "$ROOT"/apps/ios-native/Sources/Transport/*.swift "$HARNESS/Sources/DshTradingTransport/"
cp "$ROOT"/apps/ios-native/Tests/TransportTests/*.swift "$HARNESS/Tests/DshTradingTransportTests/"
cat > "$HARNESS/Package.swift" <<'SWIFT'
// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "TransportVerification",
    platforms: [.macOS(.v14)],
    products: [],
    targets: [
        .target(name: "DshTradingContract"),
        .target(name: "DshTradingTransport", dependencies: ["DshTradingContract"]),
        .testTarget(name: "DshTradingTransportTests", dependencies: ["DshTradingTransport", "DshTradingContract"]),
    ]
)
SWIFT
echo "Harness: $HARNESS"
xcrun swift test --package-path "$HARNESS" --scratch-path "$HARNESS/.build" --cache-path "$HARNESS/.cache" --disable-sandbox
