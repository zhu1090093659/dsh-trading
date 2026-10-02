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
## 13. 绑最终 HEAD 的验收复跑（HEAD `e26ef6f6`，工作区 clean）

Lead 指定最终 HEAD = `e26ef6f6430c29d106d11f60013654d41bdd2fa9`。本轮按 §12 清单执行，全程持重活锁串行。

### 13.1 完整矩阵（HEAD_BEFORE == HEAD_AFTER，脏文件 0）

```
HEAD_BEFORE=e26ef6f6430c29d106d11f60013654d41bdd2fa9
DIRTY_BEFORE=0        DIRTY_SRC_BEFORE=0
snapshot_gen_exit=0   contract 0.5.0 | vectors 144 | byte-card 97 bytes
契约防漂移门禁：绿 —— Swift 侧封闭枚举 / 查表 / 上限 / 常量与 TS 权威一致   (drift_exit=0)
Swift 分层门禁：绿 —— 7 层全部合规（Observation 经 Lead 批准）              (layering_exit=0)
RESULT Contract                 bft=0 mtime=16:18:58 xctest=0  Executed 37 tests, with 0 failures
RESULT DshTradingTransportTests bft=0 mtime=16:19:03 xctest=0  Executed 37 tests, with 0 failures
RESULT DshTradingDomainTests    bft=0 mtime=16:19:06 xctest=0  Executed 62 tests, with 0 failures
RESULT DshTradingAlertsTests    bft=0 mtime=16:19:08 xctest=0  Executed 62 tests, with 0 failures
RESULT DshTradingOfflineTests   bft=0 mtime=16:19:10 xctest=0  Executed 21 tests, with 0 failures
RESULT DshTradingFeaturesTests  bft=0 mtime=16:19:12 xctest=0  Executed 22 tests, with 0 failures
RESULT App build=0 ** BUILD SUCCEEDED ** compile_errors=0
HEAD_AFTER=e26ef6f6430c29d106d11f60013654d41bdd2fa9    DIRTY_SRC_AFTER=0
```

合计 **241 例 / 0 失败**；六个目标 mtime 各不相同且都是本次编译 ⇒ 无陈旧 bundle 假绿。

### 13.2 四项 findings 的处置复核（破坏性实验，全部已还原）

每个探针：注入 -> 跑分层门禁 -> 还原 -> 再跑一次确认绿。收尾 `git status` 干净。

| 探针 | 注入内容 | 期望 | 实测 | 结论 |
|---|---|---|---|---|
| A | Domain + `@_exported import SwiftUI` | 红 | **红** | §5.2 已修 |
| B | Domain + `@testable import DshTradingFeatures` | 红 | **红** | §5.2 已修 |
| C | Domain + `import struct SwiftUI.Color` | 红且报 `SwiftUI` | **红，诊断=SwiftUI** | §5.3 已修 |
| D0 | Domain + `import Observation` | 绿（批准） | **绿** | 正对照通过 |
| D1 | Offline + `import Observation` | 红 | **绿** | **未修，见 13.3** |
| D2 | Alerts + `import Observation` | 红 | **绿** | **未修，见 13.3** |
| D3 | Features + `import Combine` | 红 | **红** | §5.4 已修 |
| D4 | Features + `import Charts` | 红 | **红** | §5.4 已修 |

原始输出（红/绿两段）：

```
### A: Domain + @_exported import SwiftUI  [expect RED -> got RED]
Swift 分层门禁：红（1 处越界）
  - .../Domain/DomainBoundary.swift：Domain 层不许 import SwiftUI（@_exported 会把该模块再透传出去，所以更要拦）

### B: Domain + @testable import DshTradingFeatures  [expect RED -> got RED]
  - .../Domain/DomainBoundary.swift：Domain 层不许 import DshTradingFeatures

### C: Domain + import struct SwiftUI.Color  [expect RED(报 SwiftUI) -> got RED]
  - .../Domain/DomainBoundary.swift：Domain 层不许 import SwiftUI        <-- 诊断对象已是模块名

### D0 正对照: Domain + Observation (批准)  [expect GREEN -> got GREEN]
Swift 分层门禁：绿 —— 7 层全部合规（Observation 经 Lead 批准）

### D3: Features + Combine  [RED]   - Features 层不许 import Combine
### D4: Features + Charts   [RED]   - Features 层不许 import Charts
```

### 13.3 【新发现，需 Lead 裁决】Offline / Alerts 仍白名单化 `Observation`，且门禁注释与你的裁决矛盾

实测：把 `import Observation` 写进 Offline 与 Alerts，分层门禁**仍绿**（D1 / D2）。

两处相互矛盾的说法，都需要你定：

1. **你的裁决**（本轮指令）：「未获批准的 Observation（Offline/Alerts）=> 必须红；注意 Observation 在 Domain 是经 Lead 批准的」。
2. **门禁里的注释**（`scripts/ios-native/check-swift-layering.mjs:32-33`）：「Observation 在 Domain/Offline/Alerts/Features/App 上白名单化是**经 Lead 批准**的」。
   白名单实现也照此把 `OBSERVATION_APPROVED` 放进了 Offline（:40）、Alerts（:42）、Features（:46）、App（:52）。

事实核对：Offline 与 Alerts 的**实际 import 里都没有 Observation**（`grep -rh "^import"` 结果里 0 次；
两层也没有任何 `@Observable`）。所以这是**潜在的宽松**而不是当前的越界：
今天绿是真绿，但将来谁在 Offline/Alerts 里加一个 `@Observable` 都不会被拦 —— 而这正是 §5.4 要防的形态。

建议（二选一，请你或 IOS-1 定）：
- 若确如你的裁决（只有 Domain 批准）：把 Offline/Alerts 的 `OBSERVATION_APPROVED` 移除，并改掉 :32-33 的注释；
- 若 IOS-1 手上的确有更宽的批准：请更新裁决口径，让注释与裁决一致（注释不能单方面替裁决说话）。

### 13.4 门禁自测已接入 `pnpm test:scripts`（§5.5 已修）

```
$ pnpm test:scripts        # exit 0
 ✓ scripts/ios-native/check-contract-drift.test.mjs (3 tests) 550ms
 ✓ scripts/ios-native/check-swift-layering.test.mjs (6 tests) 681ms
 Test Files  17 passed (17)
      Tests  128 passed (128)
```

两条门禁的断言现在真的在 CI 的 `test:scripts` 里跑（此前是 0 自测）。

### 13.5 本轮结论

- 绑 `e26ef6f6`：**两条门禁绿 + 六层 241 例 0 失败 + App BUILD SUCCEEDED + test:scripts 128 例绿**；
- findings §5.1（陈旧假绿，方法固化）、§5.2（前缀绕过）、§5.3（诊断对象）、§5.4 的 Combine/Charts、§5.5（门禁自测）均**已修并现场复核**；
- **唯一未闭合**：§13.3 的 Offline/Alerts `Observation` 白名单与裁决口径不一致（潜在宽松，非当前越界），需人定；
- 所有破坏性实验均已还原，收尾 `git status` 对 `apps/ios-native/Sources` 与 `Tests` 为 0 项。
## 14. 下一轮复跑的判据（**先写下，后执行**）

Lead 对本轮 §13.3 的裁决（2026-10-02）：「Observation 只保留 Domain 与 App（今天真的在用这两处），
Offline / Alerts / Features 三层移除，注释改为与实际裁决一致，自测补 Offline/Alerts 必红。」

下一轮在**新 HEAD** 上要跑的不只是矩阵：门禁脚本本身变了，结论必须绑新 commit。
先固定判据如下，跑完只做「符合 / 不符合」判定，不改标准：

| 编号 | 注入位置与内容 | 期望 | 前置依据 |
|---|---|---|---|
| A | Domain + `@_exported import SwiftUI` | 红 | §5.2 修复已复核（§13.2） |
| B | Domain + `@testable import DshTradingFeatures` | 红 | 同上 |
| C | Domain + `import struct SwiftUI.Color` | 红，且诊断对象为 `SwiftUI` | §5.3 |
| D0 | Domain + `import Observation` | **绿** | Lead 裁决：Domain 保留 |
| D1 | Offline + `import Observation` | **红** | Lead 裁决：Offline 移除 |
| D2 | Alerts + `import Observation` | **红** | Lead 裁决：Alerts 移除 |
| D3 | Features + `import Observation` | **红** | Lead 裁决：Features 移除 |
| D4 | Features + `import Combine` | 红 | §5.4 |
| D5 | Features + `import Charts` | 红 | §5.4 |
| D6 | App + `import Observation` | **绿** | Lead 裁决：App 保留 |

另需复核（同一轮的"元"判据）：

- 门禁注释（`check-swift-layering.mjs` 顶部）必须与上表一致，不得再出现「Offline/Alerts 也经批准」这类与裁决相反的表述；
- `scripts/ios-native/check-swift-layering.test.mjs` 必须补上 Offline/Alerts 必红的用例，且 `pnpm test:scripts` 真的跑到（用例数增量证明，不看"应该会跑"）；
- 矩阵与探针都在**同一个新 HEAD** 上完成，且 `HEAD_BEFORE == HEAD_AFTER`、Sources/Tests 脏文件为 0；
- 任何破坏性实验逐条还原，收尾 `git status` 对 Sources/Tests 为 0 项。
## 15. 最终验收（HEAD `2f1c753d`）——按 §14 事先写好的判据执行，未改标准

### 15.1 完整矩阵

```
HEAD_BEFORE=2f1c753d01faf8bb716a4e6af628b8a6d73e3fc4
DIRTY_BEFORE=1        DIRTY_SRC_BEFORE=0
snapshot_gen_exit=0   contract 0.5.0 | vectors 144 | byte-card 97 bytes
契约防漂移门禁：绿 —— Swift 侧封闭枚举 / 查表 / 上限 / 常量与 TS 权威一致   (drift_exit=0)
Swift 分层门禁：绿 —— 7 层全部合规（Observation 仅 Domain/App 经 Lead 批准）  (layering_exit=0)
RESULT Contract                 bft=0 mtime=16:24:18 xctest=0  Executed 37 tests, with 0 failures
RESULT DshTradingTransportTests bft=0 mtime=16:24:20 xctest=0  Executed 37 tests, with 0 failures
RESULT DshTradingDomainTests    bft=0 mtime=16:24:25 xctest=0  Executed 62 tests, with 0 failures
RESULT DshTradingAlertsTests    bft=0 mtime=16:24:28 xctest=0  Executed 62 tests, with 0 failures
RESULT DshTradingOfflineTests   bft=0 mtime=16:24:30 xctest=0  Executed 21 tests, with 0 failures
RESULT DshTradingFeaturesTests  bft=0 mtime=16:24:33 xctest=0  Executed 22 tests, with 0 failures
RESULT App build=0 ** BUILD SUCCEEDED ** compile_errors=0
HEAD_AFTER=2f1c753d01faf8bb716a4e6af628b8a6d73e3fc4   DIRTY_SRC_AFTER=0
```

合计 **241 例 / 0 失败**，六个目标 mtime 各不相同且均为本次编译。

说明 `DIRTY_BEFORE=1`：那一条脏文件是**本验收报告自己**（我在跑之前追加了 §14），
`apps/ios-native/Sources` 与 `Tests` 的脏文件数为 **0**。所以结论可以写成「在 `2f1c753d` 上绿」，
不是「HEAD + 一串在飞源文件」。

### 15.2 A–D6 探针（10/10 命中事先写下的期望；每条注入后立即还原）

| 编号 | 注入 | 事先期望 | 实测 |
|---|---|---|---|
| A | Domain + `@_exported import SwiftUI` | 红 | **红** |
| B | Domain + `@testable import DshTradingFeatures` | 红 | **红** |
| C | Domain + `import struct SwiftUI.Color` | 红，诊断=`SwiftUI` | **红，诊断=`SwiftUI`** |
| D0 | Domain + `import Observation` | 绿 | **绿** |
| D1 | Offline + `import Observation` | 红 | **红** |
| D2 | Alerts + `import Observation` | 红 | **红** |
| D3 | Features + `import Observation` | 红 | **红** |
| D4 | Features + `import Combine` | 红 | **红** |
| D5 | Features + `import Charts` | 红 | **红** |
| D6 | App + `import Observation` | 绿 | **绿** |

```
### D1 Offline + import Observation  [expect RED -> got RED]
  - .../Offline/OfflineBoundary.swift：Offline 层不许 import Observation
### D2 Alerts + import Observation   [expect RED -> got RED]
  - .../Alerts/AlertsBoundary.swift：Alerts 层不许 import Observation
### D3 Features + import Observation [expect RED -> got RED]
  - .../Features/FeaturesBoundary.swift：Features 层不许 import Observation
### D0 Domain + import Observation   [expect GREEN -> got GREEN]
Swift 分层门禁：绿 —— 7 层全部合规（Observation 仅 Domain/App 经 Lead 批准）
### D6 App + import Observation      [expect GREEN -> got GREEN]
Swift 分层门禁：绿 —— 7 层全部合规（Observation 仅 Domain/App 经 Lead 批准）
```

§13.3 那条「Offline/Alerts 潜在宽松」**已闭合**。

### 15.3 元判据（§14 里一并写下的那些）

1. **注释与裁决一致**：`check-swift-layering.mjs:32-34` 已改为「Observation **仅 Domain 与 App 经 Lead 批准**」，
   并补了一句「这份注释只记录发生过的批准，不替裁决说话」；白名单实现同步（Offline :41 / Alerts :43 / Features :47 均已移除）。
2. **门禁自测补齐**：`check-swift-layering.test.mjs` 现有 9 个用例（此前 6），含
   `@_exported` 透传必红、`@testable` 上层必红、`import struct SwiftUI.Color` 必报 `SwiftUI`、
   **Offline/Alerts 用 Observation 必红**、Domain/App 用 Observation 必绿、注释里的 import 不算越界、未登记分层必红。
3. **自测真的被跑到（用例数增量证明）**：`pnpm test:scripts` ⇒ `Test Files 17 passed (17)`、`Tests 131 passed (131)`，
   其中 `check-swift-layering.test.mjs (9 tests)`（上一轮 6 ⇒ +3，与 Lead 观察一致；总例数 128 ⇒ 131）。
4. **finding §5.6 已落地**：`apps/ios-native/README.md:91-94` 写明「权威边界（8/9）」：
   `ContractA0.swift` 在 `packages/contract/src/` 无对应模块，其 fail-closed 行为由 `ContractA0Tests.swift` 断言守着。

### 15.4 结论

- 绑 `2f1c753d`：**两条门禁绿 + 六层 241 例 0 失败 + App BUILD SUCCEEDED + test:scripts 131 例绿**；
- §14 事先写下的 10 条探针判据**全部命中**，无一条需要事后调整；
- 本轮**没有发现新的不一致**；此前 6 条 finding 全部闭合（§5.1 方法已固化、§5.2/§5.3/§5.4/§5.5/§5.6 均已修复并现场复核）；
- 破坏性实验逐条还原；收尾 `git status`：`Sources` / `Tests` 脏文件 **0**，全仓唯一脏文件是本报告自身。

### 15.5 仍未验证（不因本轮绿而改变）

- 真机、部署构型、签名、APNs 真推送、生物识别真设备、弱网：未验；
- 渲染证据是夹具驱动的静态快照，不含交互与像素基线；
- 门禁是**静态文本判据**：它拦"写出来的 import"，不拦运行时通过反射/动态手段达成的跨层耦合（本仓目前没有这种用法）。
