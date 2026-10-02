#!/usr/bin/env bash
# 契约防漂移机检（接口冻结 §4.3）—— **可执行断言**，任何漂移 ⇒ 非零退出。
#
# 两步：
#   1. 从 packages/contract 的**运行期真值**重新生成 Generated/contract-snapshot.json（TS 是唯一权威）；
#   2. 编译并运行 DshTradingContractTests（macOS 逻辑测试，直接编译 Sources/Contract 的**同一批源文件**），
#      逐字段比对常量表 + 逐条重放行为向量。
#
# 为什么不是直接 `xcodebuild test`：本机会话的沙箱会挡住 xcodebuild 测试运行器的伪终端
# （"Pseudo Terminal Setup Error" / EPERM），这是**环境限制不是代码问题**；
# 改成 build-for-testing + `xcrun xctest` 跑**同一次编译产物**，断言完全相同。
# 在没有该限制的机器上，`xcodebuild ... -scheme DshTradingContractTests -destination 'platform=macOS' test` 同样可用。
set -euo pipefail
cd "$(dirname "$0")/.."

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
xcodebuild -project DshTradingNative.xcodeproj -scheme DshTradingContractTests \
  -destination 'platform=macOS' -derivedDataPath build/DerivedData build-for-testing >/dev/null
xcrun xctest build/DerivedData/Build/Products/Debug/DshTradingContractTests.xctest
