# Agent Note: 证据跑批脚本的 fail-closed 判据

Status: implemented

## Problem

2026-10-02 IOS-12 独立验收抓到 [run-all-tests.sh](../../../../apps/ios-native/docs/evidence/run-all-tests.sh) 制造假绿：
在 main `d5776342` 上 DshTradingDomainTests / DshTradingOfflineTests 的 `build-for-testing` exit=65，
脚本仍继续执行，跑的是上一次构建留下的旧 `.xctest`，打印 `Executed N tests, with 0 failures`，脚本整体 exit 0。

同一脚本另有两处：取锁循环 60 次耗尽后照样无锁往下跑；`trap rmdir "$LOCK"` 在本进程并未取得锁时也会删掉别人的锁，
既破坏串行，也让"锁在不在"失去意义。脚本当时只有 `set -uo pipefail`，没有 `-e`，也没有把失败累积起来决定退出码
—— 与 [验收与重活执行的资源纪律](../process/2026-10-02-verification-resource-discipline.md) 的"退出码不等于通过"同源。

## Decision

`run-all-tests.sh` 按 fail-closed 判据实现，退出码 `0` 全绿 / `1` 判红 / `75` 取锁失败：

- 每个目标**先删自己的 `.xctest`** 再 `build-for-testing`；build 非 0 ⇒ 立即点名该目标并非零退出，绝不执行 xctest。
- build 成功后校验新产物：macOS 走 `Contents/MacOS/<name>`、iOS 走 bundle 根的二进制，路径缺失或 mtime 早于本次
  build 开始即判红（拿不到新产物不算通过）。
- 每个目标分别记录 build / test 两个退出码，末尾 `=== matrix ===` 汇总；test 退出码非 0、日志缺
  `Executed N tests, with M failures` 报告行、或 M≠0 都判红；汇总里任一项非零 ⇒ 脚本整体非零。
- 取锁失败（默认 60 × 10s）⇒ exit 75；只有本进程确实创建了锁才注册 trap 清理。

判据的机检自测是 `pnpm test:ios-evidence`（[check-evidence-runner.mjs](../../../../scripts/ios-native/check-evidence-runner.mjs)
+ [evidence-stubs/](../../../../scripts/ios-native/evidence-stubs/)）：用 xcodebuild / xcrun / xcodegen 桩驱动**真实脚本**，
现场喂坏源 / 脏缓存 / 占用锁 / 缺报告，断言脚本红 —— 七个场景覆盖四条判据与全绿路径。它接在 `ci.yml` 的
static-gates、`gates:all` 与 `ci-wiring:check` 的必须接线清单里（CI 不跑 iOS 构建，桩是唯一通路）。
自测自身有变异测试（[check-evidence-runner.test.mjs](../../../../scripts/ios-native/check-evidence-runner.test.mjs)）：
把真脚本改回旧假绿形态必须让门禁红。

## Alternatives considered

- **只补 fail-fast、不校产物**：旧 bundle 就在同一个 DerivedData 里，除了 build 失败之外的路径（产物没刷新、
  跑错 scheme）仍可能拿到上一次的包。先删旧产物 + 校 mtime 才让"沿用旧 bundle"不可能。败。
- **每次用干净 DerivedData**：判据最硬，但每次六目标全量重编，把验收循环变成重活；删单个目标的产物 + 校 mtime
  已排除旧包，且只重建受影响的目标。败。
- **取锁失败只告警继续跑**：这正是被修的行为（无锁并行 = 重活互相踩）。取不到就红是与"重活串行"一致的选择。败。
- **自测写成纯静态扫描**（读脚本源码断言存在 `exit 75`）：只是文本匹配，控制流被改坏仍然绿；桩驱动真实脚本
  才能证明行为。败。

## Consequences

- 编译失败不再被旧产物掩盖：脚本非零退出并点名目标；Domain/Offline 的测试目标编译失败在第一次跑批就现形。
- "六目标全绿"的含义收窄为"本次构建的新产物、报告齐全、0 失败"；文档里旧 HEAD 的例数只是历史快照，必须重跑并绑 sha。
- 跑批脚本自身成了可机检门禁：CI 上不需要 Xcode 也能验证它的判据没被改坏。
- 锁的语义变得可用：锁在 = 有人在跑重活；没取得锁的进程不再动它。
