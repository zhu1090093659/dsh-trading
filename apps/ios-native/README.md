# apps/ios-native —— 交易机器人的 iOS 观测端（原生）

本目录是**独立 Xcode 工程**，由 [XcodeGen](https://github.com/yonaskolb/XcodeGen) 从 [project.yml](project.yml) 生成，
**不进 pnpm workspace**（与 `desktop/`、`apps/mobile` 同一先例）。

**定位**：它是自动交易机器人（Trading Bot）的**观测端** —— 看机器人运行状态、持仓/订单/资产、告警、升级。
它是**只读视图**，不做手动下单面板、不做行情终端；权威态在执行核，手机崩溃/断线/锁屏**不影响执行**。

## 1. 工程形态与目录（一个子目录 = 一个 framework target）

| 目录 | target / 模块名 | 测试 target | 归属卡 |
|---|---|---|---|
| `Sources/Contract/` | `DshTradingContract` | `DshTradingContractTests`（macOS 逻辑测试） | IOS-1（**冻结面，只由 IOS-1 修改**） |
| `Sources/Transport/` | `DshTradingTransport` | `DshTradingTransportTests` | IOS-2 |
| `Sources/Domain/` | `DshTradingDomain` | `DshTradingDomainTests` | IOS-3 |
| `Sources/Features/` | `DshTradingFeatures` | `DshTradingFeaturesTests` | IOS-4 |
| `Sources/Alerts/` | `DshTradingAlerts` | `DshTradingAlertsTests` | IOS-5 |
| `Sources/Offline/` | `DshTradingOffline` | `DshTradingOfflineTests` | IOS-6 |
| `Sources/App/` | `DshTradingNative`（App） | — | IOS-1 |

- 层间依赖（`Contract → 其它`；`Features/Offline/Alerts → Domain`）由 **project.yml 的 target 依赖**表达，
  **编译器强制**，不靠脚本自觉；每一层都有独立 scheme（`xcodebuild -scheme DshTradingDomain build`）。
- 每个子目录与 `Tests/<Area>Tests/` 都被整体 glob 进对应 target：**加文件不用改 project.yml**。
- 生成物不入库（见 [.gitignore](.gitignore)）：`*.xcodeproj/`、`build/`、`Generated/`、`xcuserdata/`、`*.xcuserstate`。

## 2. 构建与测试（可复现命令）

```bash
cd apps/ios-native
./scripts/build-simulator.sh      # node 生成契约快照 → xcodegen → xcodebuild 模拟器构建
./scripts/test-contract.sh        # 契约防漂移机检（含重新生成快照 + 重放行为向量）
```

两个脚本都先取重活锁 `build/.heavy.lock`（接口冻结 §2「重活串行」：同一时刻只允许一路 xcodegen/xcodebuild；
取锁失败立即退出 75，绝不无锁继续或按时间删除他人锁；调用者不得再包同一把锁）。

等价的裸命令：

```bash
node scripts/gen-contract-snapshot.mjs
xcodegen generate
xcodebuild -project DshTradingNative.xcodeproj -scheme DshTradingNative \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -configuration Debug -derivedDataPath build/DerivedData build
```

### 两个本机环境事实（都不是代码问题，已在工程里处理）

1. **宏插件嵌套沙箱**：本机会话的 DSH 文件沙箱内，swiftc 给宏插件起不了嵌套沙箱
   （`sandbox-exec: sandbox_apply: Operation not permitted` ⇒
   `external macro implementation type 'ObservationMacros.ObservableMacro' could not be found`），
   `@Observable` 因此加载不了。`project.yml` 的 `settings.base` 设了
   `OTHER_SWIFT_FLAGS: -disable-sandbox`（只关插件执行沙箱，不动网络/文件权限），加上后标准命令即可复现构建。
2. **xctest 伪终端**：`xcodebuild test` 的 macOS 运行器要开伪终端，被同一沙箱挡下
   （`Pseudo Terminal Setup Error` / EPERM）。因此 `scripts/test-contract.sh` 用
   `build-for-testing` + `xcrun xctest <同一个 .xctest 包>` 执行**同一次编译产物**；在没有该限制的机器上，
   `xcodebuild ... -scheme DshTradingContractTests -destination 'platform=macOS' test` 同样可用。

本机实测工具链：Xcode 27.0（27A266a）/ iOS SDK 27.0 / Swift 6.4 / XcodeGen 2.45.3；模拟器 `DshtTrading`（iOS 27.0）。

## 3. 冻结的契约面（`Sources/Contract/`）

**TS 契约是唯一权威**（`packages/contract/src/{version,scopes,cards,push,confirm,offline,source-guard}.ts`），
Swift 侧是等价实现。客户端**不自行发号**（不引入 `ids.ts` 语义）。

| 文件 | 冻结符号 |
|---|---|
| [ContractVersion.swift](Sources/Contract/ContractVersion.swift) | `ApiContract`（major/minor/compatibleMajorSpan/capsHeader/clientTooOldStatus）、`VersionVerdict`、`parseCaps`、`formatCaps`、`negotiateVersion` |
| [ContractScopes.swift](Sources/Contract/ContractScopes.swift) | `ScopePlane`、`scopePlanes`、`defaultScopePlanes`、`explicitScopePlanes`、`isScopePlane`、`grantableByDefault` |
| [ContractCards.swift](Sources/Contract/ContractCards.swift) | `CardType`/`FieldKind`/`ActionKind`（12/12/12 封闭枚举，rawValue 与 TS 逐字相同）、`actionScope`、`CardLimits`/`cardLimits`、`CardField`/`CardAction`/`Card`/`CardVerdict`、`validateCard`、`renderableActions`、`fallbackFor` |
| [ContractConfirm.swift](Sources/Contract/ContractConfirm.swift) | `ConfirmLevel`、`actionConfirm`、`confirmLevel(for:)`（`ActionKind` 与 `String` 两个重载）、`scopeForAction`、`auditConfirmPolicy`、`ClientPlatform`、`requiresBiometric` |
| [ContractPush.swift](Sources/Contract/ContractPush.swift) | `PushSeverity`/`PushKind`/`PushAction`、`deeplinkScheme`、`PushLimits`/`pushLimits`、`PushPayload`、`validatePushPayload`、`acceptedPush`、`shouldInterrupt` |
| [ContractOffline.swift](Sources/Contract/ContractOffline.swift) | `Staleness`、`StalenessBudget`、`OfflineSnapshot`、`stalenessOf`、`OfflineView`、`offlineView`、`DeeplinkScreen`、`DeeplinkResult`、`parseDeeplink` |
| [ContractSourceGuard.swift](Sources/Contract/ContractSourceGuard.swift) | `SourcedDatum`、`ReconcileReport`、`SourceGuard` |
| [ContractDecoding.swift](Sources/Contract/ContractDecoding.swift) | 宽松标量解码（`LenientText`/`LenientTextMap`）：**只搬类型，不判语义、不猜默认值** |

### fail-closed 的建模方式（接口冻结 §4.1）

封闭枚举项（`cardType` / `field.kind` / `action.kind` / `push.kind` / `push.severity`）在 DTO 里**保留为 `String`**，
由 `CardType(rawValue:)` 一类查表判定；**查表落空 ⇒ 不可操作**（禁用全部 Action，只渲染 `fallbackText`），
**绝不抛掉整张卡、绝不猜默认值**。所有查表用 `switch`/表驱动，**没有 `default` 分支吞掉未知值**；
新增枚举项会让 `scopeOf`/`confirmLevelOf` 的 `switch` **编译失败**，逼人显式补一行。

未知动作字符串另有第二道保险：`scopeForAction("future-action") == .control`、
`confirmLevel(for: "future-action") == .biometric`（**最高档**）。

### 唯一的签名偏离

`SourceGuard<T: Sendable>`（冻结件写的是 `SourceGuard<T>`）：Swift 6 严格并发会为
"final class + 全 Sendable 存储属性"自动推断 Sendable，于是 `T` 必须 Sendable 才能编译。语义不变，
只是非 Sendable 的载荷类型不能再用这个守卫。

## 4. 契约防漂移机检

```
packages/contract/src/*.ts  ──(scripts/gen-contract-snapshot.mjs)──▶  Generated/contract-snapshot.json
                                                                              │
                                        Tests/ContractTests/**  ────断言/重放──┘   （TS 是权威，Swift 必须对齐）
```

- [gen-contract-snapshot.mjs](scripts/gen-contract-snapshot.mjs) 从 `@dshtrading/contract` 的**运行期真值**导出：
  常量（version/scopes/limits/deeplinkScheme）、封闭枚举（cardTypes/fieldKinds/actionKinds/push*）、
  查表（actionScope/actionConfirm）、以及 **136 条行为向量**（negotiateVersion / validateCard /
  renderableActions / fallbackFor / stalenessOf / offlineView / parseDeeplink / grantableByDefault /
  parseCaps / formatCaps / requiresBiometric / sourceGuard / validatePushPayload 的输入 → TS 权威输出）。
  推送校验覆盖 UTF-16 长度边界，诊断与合法性均逐条匹配 TS；新增向量待串行测试验证。
- [ContractDriftTests.swift](Tests/ContractTests/ContractDriftTests.swift) 逐字段比对常量与表，
  并锁住 fail-closed 行为（未知 cardType ⇒ `valid=false, operable=false`；未知枚举 ⇒ 全动作禁用；
  control ⇒ biometric；过期不渲染数据本身；跨源不混显）。
- [ContractVectorTests.swift](Tests/ContractTests/ContractVectorTests.swift) 逐条重放行为向量 ——
  只比对常量是弱机检，**行为漂移会被这一层抓住**。
- **夹具缺失 ⇒ 测试 FAIL** 并打印重新生成命令，绝不 skip（对齐本仓"未验证 ≠ 通过"）。
- 机检可运行且真的会红：`./scripts/test-contract.sh`，故意改错的红/绿证据见
  [build/](build/) 下的 `mutation-a.log` / `mutation-b.log` / `mutation-restored.log`
  （A：让 `grantableByDefault` 放行 control ⇒ 6 例红；B：`maxFields` 24→25 ⇒ 1 例红；改回 ⇒ 31 例全绿。

### CI 接线（不需要 Xcode）

仓根 `scripts/ios-native/` 有两条**纯 Node** 门禁，跑在 `ci.yml` 的 static-gates job 里：

- `node scripts/ios-native/check-contract-drift.mjs` —— 直接 import TS 契约取权威真值，
  再从 `Sources/Contract/*.swift` 解析出封闭枚举/查表/上限/常量逐项比对；**解析不出来一律判红**。
- `node scripts/ios-native/check-swift-layering.mjs` —— 分层 import 白名单（Domain 的 `Observation` 宏在名单内），
  越界或新增未登记的分层即红；第三方依赖同样拦下。

两者都验证过「故意改错 ⇒ 红」（改 `kill` 的确认档位、给 Transport 加 `import SwiftUI`）。
CI **不跑 iOS 构建**（与 `apps/mobile` 同一先例）：真正的 Swift 断言（35 例）留本机 `./scripts/test-contract.sh`。

## 5. 契约面 finding（记录，不自行放宽）

1. **TS 注释与代码不一致**：`cards.ts` 的注释写"未知 cardType ⇒ `valid` 仍可为 true"，
   代码实际会 push problem，于是 `valid = problems.length === 0` ⇒ **`valid=false`**。
   Swift 侧按**代码**实现（`valid=false, operable=false`），并由 `testUnknownCardTypeIsInvalidAndInoperable`
   锁住。**未修改 TS**（客户端的方便不是动服务端语义的理由）。
2. **`CardField.value` 从 `unknown` 收窄为 `String?`**：TS 只在 `typeof value === 'string'` 时查
   `maxValueChars`，Swift 对所有标量查文本长度；非标量（数组/对象）留 `nil` 交给判定，不猜。
   差异已放进**向量**（number / bool / 大整数 / enum 值为数字或布尔 / 对象值 / params 非字符串），
   在可达范围内两侧等价 —— 机检覆盖，而不是只写在说明里。
3. **`PushPayload.actions` 解码是严格的**（缺失或非字符串数组 ⇒ 抛错 ⇒ 整条载荷 drop），
   与卡片的"绝不抛掉整张卡"相反：推送是"非法载荷一律 drop"（`acceptedPush` 同时校验深链）。
4. **契约缺口（只报告，不改服务端；同一份清单也在 Owning Note 里）**：
   - `field.key` **未冻结**（仓内只有夹具用过 `level`）：服务端应冻结每张卡的 key，
     否则客户端"认识的 key 走结构化映射、不认识的进 raw 列表"这条只能靠约定；
   - **资产没有独立卡片类型**；成交/资金变动/事件/订单 `stateSince`/等待原因在**卡片面与 A0 面都拿不到**；
   - **`ids.ts` 的 `isOrderId` 把 UUID 版本位钉成 v4**（第三组 `4[0-9a-f]{3}` + 变体位 `[89ab]`），
     与设计文档明文冻结的"不钉版本位（`[0-9a-f]{4}`）"冲突；
   - `cards.ts` 关于未知 cardType 的注释与代码不一致（见 finding 1）。

## 6. 文档与决策记录

本轮的接口冻结件是 `INTERFACE-FREEZE.md`（Lead 所有，收尾时删除）；其事实并入本 README 与
[Owning Note](../../.agents/notes/implemented/architecture/2026-10-01-mobile-app-and-contract-core-entry.md)。
`packages/contract` 只被**只读消费**：本目录不修改任何 TS 契约。
