#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
HARNESS="$(mktemp -d /tmp/dsh-domain-tests.XXXXXX)"
mkdir -p "$HARNESS/Sources/DshTradingContract" "$HARNESS/Sources/DshTradingDomain" "$HARNESS/Tests/DomainTests"
cp "$ROOT"/apps/ios-native/Sources/Contract/*.swift "$HARNESS/Sources/DshTradingContract/"
cp "$ROOT"/apps/ios-native/Sources/Domain/*.swift "$HARNESS/Sources/DshTradingDomain/"
cp "$ROOT"/apps/ios-native/Tests/DomainTests/*.swift "$HARNESS/Tests/DomainTests/"
cat > "$HARNESS/Package.swift" <<'SWIFT'
// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "DomainVerification", platforms: [.macOS(.v14)], products: [], targets: [.target(name: "DshTradingContract"), .target(name: "DshTradingDomain", dependencies: ["DshTradingContract"]), .testTarget(name: "DomainTests", dependencies: ["DshTradingDomain", "DshTradingContract"])])
SWIFT
echo "Harness: $HARNESS"
xcrun swift test --package-path "$HARNESS" --scratch-path "$HARNESS/.build" --cache-path "$HARNESS/.cache" --disable-sandbox
