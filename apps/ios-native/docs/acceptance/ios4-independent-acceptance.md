# IOS-4 独立验收：契约门禁 / 分层门禁 / 各层构建与测试

验收人：IOS-4（Features 作者，对 Contract / Transport / Domain / Offline / Alerts / CI 门禁而言是独立一方）
日期：2026-10-02 ｜ 写作用域：`apps/ios-native/docs/acceptance/**`（本文件）

## 0. 读法（先看这条）

- **结论绑 sha**：每条结论都标注它运行时看到的 `git rev-parse HEAD`，以及当时的脏文件清单。
- **退出码不等于通过**：本次验收**抓到一次真实的假绿**（见 §5），因此后面的复跑采用更严的判据。
- **未复跑 = 未验证**：别人的数字一律不引用；本文件里每个数字都来自我现场跑出的原始输出。

## 1. 采用的证据判据（含吸收 Lead 反馈后的加强版）

每个测试目标都必须同时留下三样东西，缺一即视为未验证：

1. **先删旧 bundle**：`rm -rf build/DerivedData/Build/Products/Debug-iphonesimulator/DshTrading<Area>Tests.xctest`
   —— 否则 `build-for-testing` 失败后 `xctest` 仍会跑上一次的产物，打出 `0 failures` 的**假绿**（§5 实证）。
2. **断言 build-for-testing 退出码为 0**：非 0 立即判红并**停止**，不再往下跑 xctest。
3. 记录 **bundle mtime**：证明被测的就是本次编译的产物，不是上一次的。

另外两条沿用本仓纪律：**无报告即红**（解析不到 `Executed N tests` 一律判红，不静默通过）；
**重活持锁串行**（`apps/ios-native/build/.heavy.lock`）。

## 2. 契约防漂移门禁（`scripts/ios-native/check-contract-drift.mjs`）

### 2.1 绿（HEAD `b46b5c04`，Sources 干净）

```
$ node apps/ios-native/scripts/gen-contract-snapshot.mjs
wrote /Users/zcl/code/dsh-trading/apps/ios-native/Generated/contract-snapshot.json
contract 0.5.0 | vectors 136 | byte-card 97 bytes
gen_exit=0

$ node scripts/ios-native/check-contract-drift.mjs
契约防漂移门禁：绿 —— Swift 侧封闭枚举 / 查表 / 上限 / 常量与 TS 权威一致
drift_exit=0
```

### 2.2 故意破坏 -> 必须红 -> 还原 -> 必须绿

破坏方式：把 `Sources/Contract/ContractVersion.swift` 的 `public static let minor = 0` 改成 `99`（不改 TS）。

```
--- mutated: minor 0 -> 99 ---
diff: apps/ios-native/Sources/Contract/ContractVersion.swift | 2 +-

$ node scripts/ios-native/check-contract-drift.mjs
契约防漂移门禁：红 —— Swift 侧与 TS 权威不一致（1 项）
  - ApiContract.minor 漂移：Swift = 99，TS = 0

权威在 packages/contract/src：要改契约先改 TS，再让 Swift 跟上。
drift_exit=1

--- restored (git diff 为空 = 与 HEAD 逐字节一致) ---
$ node scripts/ios-native/check-contract-drift.mjs
契约防漂移门禁：绿 —— Swift 侧封闭枚举 / 查表 / 上限 / 常量与 TS 权威一致
drift_exit=0
```

## 3. 分层门禁（`scripts/ios-native/check-swift-layering.mjs`）

### 3.1 绿（HEAD `b46b5c04`）

```
$ node scripts/ios-native/check-swift-layering.mjs
Swift 分层门禁：绿 —— 7 层全部合规（Domain 的 Observation 宏在白名单内）
layering_exit=0
```

### 3.2 故意破坏 -> 必须红 -> 还原 -> 必须绿

破坏方式：给 `Sources/Domain/DomainBoundary.swift` 加一行 `import SwiftUI`（冻结件 §3 明令 Domain 不许 import SwiftUI）。

```
--- injected: import SwiftUI into Domain ---
diff: apps/ios-native/Sources/Domain/DomainBoundary.swift | 1 +

$ node scripts/ios-native/check-swift-layering.mjs
Swift 分层门禁：红（1 处越界）
  - apps/ios-native/Sources/Domain/DomainBoundary.swift：Domain 层不许 import SwiftUI
layering_exit=1

--- restored (git diff 为空) ---
$ node scripts/ios-native/check-swift-layering.mjs
Swift 分层门禁：绿 —— 7 层全部合规（Domain 的 Observation 宏在白名单内）
layering_exit=0
```

## 4. 各层构建与真实执行（HEAD `b46b5c04`，锁定串行）

命令形态（iOS 层；Contract 是 macOS 逻辑测试）：

```
xcodebuild -project DshTradingNative.xcodeproj -scheme DshTrading<Area>Tests \
  -destination "id=536D8D31-6BA6-4535-BCEF-842E9A47078D" -derivedDataPath build/DerivedData build-for-testing
SIMCTL_CHILD_DYLD_FRAMEWORK_PATH=<Products> SIMCTL_CHILD_DYLD_LIBRARY_PATH=<Products> \
  xcrun simctl spawn <udid> \
  /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/Xcode/Agents/xctest \
  <Products>/DshTrading<Area>Tests.xctest
```

（`xcodebuild test` 在本机沙箱内拿不到 PTY：`Pseudo Terminal Setup Error` ⇒ 用 `xcrun simctl spawn ... xctest` 真执行，不跳过。）

| 目标 | build-for-testing | xctest 报告 |
|---|---|---|
| Contract（macOS） | 0 | `Executed 36 tests, with 0 failures` |
| Transport | 0 | `Executed 37 tests, with 0 failures` |
| Domain | 0 | `Executed 57 tests, with 0 failures` |
| Alerts | 0 | `Executed 60 tests, with 0 failures` |
| Offline | 0 | `Executed 21 tests, with 0 failures` |
| Features | 0 | `Executed 22 tests, with 0 failures` |

合计 **233 例，0 失败**。

## 5. 抓到的不一致与可疑之处（本验收最有价值的部分）

### 5.1 【已实证】陈旧 bundle 会制造假绿（高）

在 HEAD `f8cd25f8` + 在飞 Contract 编辑的树上：`DshTradingOfflineTests` / `DshTradingFeaturesTests` 的
`build-for-testing` **exit 65**，但随后 `xctest` 仍打印 `Executed 21 tests, 0 failures` / `Executed 22 tests, 0 failures`
—— 那是**上一次编译的旧 bundle**。只看例数会把红读成绿。
处置：已在 §1 写成硬判据（先删 bundle + 断言 bft 退出码 + 记 mtime）。

### 5.2 【已实证】分层门禁有两个 import 前缀绕过（高）

两种写法都让门禁**保持绿**（真实输出）：

```
=== PROBE A: @_exported import SwiftUI in Domain ===
Swift 分层门禁：绿 —— 7 层全部合规（Domain 的 Observation 宏在白名单内）
layering_exit=0

=== PROBE B: @testable import DshTradingFeatures in Domain ===
Swift 分层门禁：绿 —— 7 层全部合规（Domain 的 Observation 宏在白名单内）
layering_exit=0
```

原因：扫描正则是 `^\s*import\s+(...)`，而 `@_exported import X` / `@testable import X` 行首不是 `import`。
`@_exported` 恰恰是**把禁层模块透传出去**的那种写法，属于真实缺口（不只是理论）。
对照组：`import struct SwiftUI.Color` 会被判红（保守方向没错），但报的是模块名 `struct`（见 5.3）。

### 5.3 【已实证】越界诊断文案指错对象（中）

```
$ # Domain 里写：import struct SwiftUI.Color
Swift 分层门禁：红（1 处越界）
  - .../DomainBoundary.swift：Domain 层不许 import struct
```
结论是对的（红），但文案把**关键字 `struct` 当成了模块名**。真正的越界模块是 `SwiftUI`。
对"按提示去修"的人会误导，建议正则支持 `import (kind)? Module.Symbol`。

### 5.4 白名单比冻结件 §3 更宽（中）

门禁自己的白名单是判据的"家"，它比冻结件 §3 表宽：

| 层 | 冻结件 §3 | 门禁白名单 |
|---|---|---|
| Offline | Contract + Domain + Foundation | 额外允许 `Observation` |
| Alerts | Contract + Domain + Foundation + UserNotifications + LocalAuthentication + UIKit | 额外允许 `Observation` |
| Features | 全部 + SwiftUI | 额外允许 `Combine` / `Charts` |

当前三层都没有真的 import 这些额外模块（所以绿是真绿），但**白名单的宽松会让未来的越界合法化**。
建议：把 §3 表逐字作为白名单，或把额外项在注释里写明"经 Lead 批准"。

### 5.5 两条新门禁没有门禁自测（中）

```
$ ls scripts/*.mjs | grep -v "\\.test\\.mjs$" | wc -l   -> 25（门禁）
$ ls scripts/*.test.mjs | wc -l                        -> 15（自测）
$ ls scripts/ios-native/*.mjs | wc -l                  -> 2（新门禁）
$ ls scripts/ios-native/*.test.mjs | wc -l             -> 0（自测）
```
`pnpm test:scripts` 因此**跑不到**这两条门禁的任何断言 —— 我的 §2.2 / §3.2 破坏实验事实上是手工补的自测。
建议：给两条门禁各加一个 `*.test.mjs`（夹具驱动：错常量必红、越界 import 必红），否则"门禁自己错了"永远不会被发现。

### 5.6 防漂移覆盖不到 A0 类型（低）

`Sources/Contract/` 有 9 个文件，其中 `ContractA0.swift`（KillState / A0Status）在 `packages/contract/src/` 里
**没有对应模块**（TS 侧 grep 无 A0Status/KillState）。也就是说「TS 是唯一权威」这句话目前**不覆盖 A0 面**。
这不是缺陷，但读者会以为 Contract 层 100% 受防漂移保护 —— 事实是 8/9 受保护。

### 5.7 沙箱环境事实（会让"照抄命令"失败，必须写进文档）

- `xcodebuild -scheme DshTradingNative -sdk iphonesimulator build`（**不带** `-derivedDataPath`）在沙箱内 **exit 65**，
  日志里 0 条 `error:`，真因是 `Failed to open log store at ~/Library/Developer/Xcode/DerivedData/...: (513) permission`。
  带 `-derivedDataPath build/DerivedData`（冻结件 §2 的写法）⇒ **BUILD SUCCEEDED**。
- `xcodebuild test` 需要 `openpty`，沙箱内 `script: openpty: Operation not permitted` ⇒ 用 `xcrun simctl spawn ... xctest`。
- `ps` 在沙箱内被拒（`/bin/ps: Operation not permitted`）⇒ 孤儿进程检查要换手段（如 `pgrep` 或宿主侧执行）。
- `$HOME/Library/Caches` 与 Darwin user cache 不可写，`$TMPDIR` 可写 ⇒ 编译缓存必须落在仓内。

## 6. App 构建

| 条件 | 命令 | 结果 |
|---|---|---|
| HEAD `f8cd25f8`，Sources 干净 | `… -scheme DshTradingNative -destination id=… -derivedDataPath build/DerivedData build` | **BUILD SUCCEEDED**（compile_errors=0，warnings=7） |
| 同上 | Lead 字面命令（无 `-derivedDataPath`） | exit 65，**非代码问题**（沙箱拒绝写 `~/Library/.../DerivedData`，0 条 `error:`） |
| HEAD `f8cd25f8` + 在飞 Contract 编辑 | 带 `-derivedDataPath` | exit 65，根因 `ContractPush.swift:82/85/116` 的 `Int`/`Double` 类型错（在飞，非已提交） |

## 7. 周边门禁

```
$ node scripts/ci-wiring-check.mjs
[ci-wiring] 检查 3 个 workflow：20 处 pnpm 脚本、10 处 node 脚本
[ci-wiring] ✓ 必须接线的 14 条门禁都在 CI 或 gates:all 里；2 条带原因豁免
[ci-wiring] ✓ 接线完整（CI 引用的脚本都存在）
ci_wiring_exit=0
```

## 8. 跟踪：Double 类型 ripple 的复验（Features 侧）

Lead 裁决 `revision` 从 `Int` 改 `Double`（贴合 TS 有限数语义）。Features 侧两行已改：
  `Sources/Features/Model/FeatureModels.swift:858` `public let revision: Double`；
  `:862` init 形参同步改（未用 `Int(...)` 截断）。

按 §1 的加强判据复跑（HEAD `f8cd25f8`）：

```
--- 删掉旧 bundle（防陈旧假绿） ---
bundle_removed
features_bft_exit=0
bundle_mtime_after_build=15:52:57
features_test_exit=0
  Executed 22 tests, with 0 failures (0 unexpected) in 7.921 (7.930) seconds
bundle_mtime_after_test=15:52:57
```
bundle mtime 与本次编译一致 ⇒ 跑的是新产物，不是旧 bundle。

## 9. 待办

- [x] 类型 ripple 落定后跑**绑 sha 的完整矩阵** —— 见 §11（HEAD `95b70ff9`，Sources/Tests 干净）。

## 10. 本轮未验证（如实标注）

- 真机 / 部署构型 / 发布签名：未验（不在本轮）；
- 快照渲染是夹具驱动的静态图，不含交互；
- Alerts 的 APNs 与生物识别、Offline 的弱网与性能：仅单元层面（60 / 21 例），无设备验证；
- 门禁的 5.2 绕过**尚未修复**（我只验证了它存在，未改别人的门禁）。
## 11. 最终：绑 sha 的完整矩阵（HEAD `95b70ff9`，Sources/Tests **干净**）

这一轮是 Lead 要求的那次：**开跑前 `git status` 显示 Sources/Tests 脏文件数 = 0**，所以结论可以写成"在这个 sha 上绿"，
而不是"HEAD + 一串在飞文件"。全程持重活锁串行；每个 iOS 目标都先删旧 bundle、断言 build-for-testing 退出码为 0、
再记 bundle mtime 后跑 xctest（§1 的加强判据）。

```
HEAD_BEFORE=95b70ff91db56b6b2bbb9298ed966ea5698b3fd7
DIRTY_BEFORE=0
snapshot_gen_exit=0
契约防漂移门禁：绿 —— Swift 侧封闭枚举 / 查表 / 上限 / 常量与 TS 权威一致
drift_exit=0
Swift 分层门禁：绿 —— 7 层全部合规（Domain 的 Observation 宏在白名单内）
layering_exit=0
--- Contract (macOS) ---
RESULT Contract                    bft=0 mtime=15:55:21 xctest=0  Executed 37 tests, with 0 failures (0 unexpected)
RESULT DshTradingTransportTests    bft=0 mtime=15:55:33 xctest=0  Executed 37 tests, with 0 failures (0 unexpected)
RESULT DshTradingDomainTests       bft=0 mtime=15:55:46 xctest=0  Executed 57 tests, with 0 failures (0 unexpected)
RESULT DshTradingAlertsTests       bft=0 mtime=15:55:54 xctest=0  Executed 62 tests, with 0 failures (0 unexpected)
RESULT DshTradingOfflineTests      bft=0 mtime=15:56:01 xctest=0  Executed 21 tests, with 0 failures (0 unexpected)
RESULT DshTradingFeaturesTests     bft=0 mtime=15:56:05 xctest=0  Executed 22 tests, with 0 failures (0 unexpected)
--- App ---
RESULT App build=0 ** BUILD SUCCEEDED **
HEAD_AFTER=95b70ff91db56b6b2bbb9298ed966ea5698b3fd7
DIRTY_AFTER=1   (Sources/App/AppEnvironment.swift 在我跑完后被 IOS-1 开始编辑)
ACC_DONE
```

判读：

- **HEAD 前后一致**（`95b70ff9`），且 6 个目标的 mtime 各不相同、都是本次编译产物 ⇒ 不存在陈旧 bundle 假绿；
- 合计 **236 例，0 失败**（Contract 37 / Transport 37 / Domain 57 / Alerts 62 / Offline 21 / Features 22）；
- App `BUILD SUCCEEDED`；两条门禁绿；
- `DIRTY_AFTER=1` 是我跑完之后才出现的编辑（IOS-1 继续改 `AppEnvironment.swift`），**不影响本次矩阵结论**，
  但也说明：任何"当前全绿"的说法都有保质期，必须绑 sha 与时刻。
## 12. 复跑清单（等 Lead 给最终 HEAD 后执行；本文件 §11 届时应被新的 §13 取代）

§11 的结论绑 `95b70ff9`，**不能沿用到新 HEAD**。重跑时用同一套加强判据，一次锁内跑完：

- 先记录 `HEAD_BEFORE` 与 `git status --porcelain apps/ios-native/Sources apps/ios-native/Tests | wc -l`；
- 若脏文件 ≠ 0，结论只能写成「HEAD + 列出的脏文件」，不得写成「HEAD 绿」；
- 每个 iOS 目标：`rm -rf <bundle>` → `build-for-testing`（**非 0 立即判红并跳过 xctest**）→ 记 bundle mtime → `xcrun simctl spawn … xctest`；
- Contract 走 macOS：`-destination platform=macOS` + `xcrun xctest`；
- 两条门禁在跑构建前先跑（`check-contract-drift.mjs` 前先 `gen-contract-snapshot.mjs`）；
- 跑完再记 `HEAD_AFTER`（与 BEFORE 相同才可声称「绑这个 sha」）与收尾时的脏文件数。

锁：`apps/ios-native/build/.heavy.lock`（`mkdir` 抢锁 + `trap rmdir` 释放）。

重跑时**特别复核** IOS-1 的四项处置是否真的成立（这是本轮 findings 的验收）：

1. `@_exported import SwiftUI` / `@testable import DshTradingFeatures` 写在 Domain 下 ⇒ 分层门禁**必须红**（§5.2）；
2. `import struct SwiftUI.Color` 报的越界对象必须是 `SwiftUI` 而不是 `struct`（§5.3）；
3. Offline/Alerts 的 `Observation`、Features 的 `Combine`/`Charts` 若未获批准，写到对应层里**必须红**（§5.4）；
4. `scripts/ios-native/` 下若加了 `*.test.mjs`，`pnpm test:scripts` 必须真的跑到它们（§5.5）。
