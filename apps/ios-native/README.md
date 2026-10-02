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

### 各层事实之家（一个事实只有一个家）

| 面 | 事实之家 |
|---|---|
| 工程形态、构建与测试命令、沙箱环境事实 | 本 README §1 / §2 |
| 层间依赖白名单 | [check-swift-layering.mjs](../../scripts/ios-native/check-swift-layering.mjs)（可执行判据）+ 上面的 target 表 |
| 契约面（版本 / 作用域 / 卡片 / 确认 / 推送 / 离线 / 数据源守卫 / A0） | [Sources/Contract/](Sources/Contract/) + 本 README §3 / §4 |
| 传输面（配对、设备令牌、origin 绑定、配对身份、`/a0/*`、`/v1/*`） | [Sources/Transport/](Sources/Transport/)：`ObservationTransport` / `DshtApiClient` / `PairingClient` / `TransportSession` / `PairingIdentity`（**代码即判据，端点清单不在此复述**，避免第二个家） |
| 领域面（三维语义、跨层端口、观测态） | [Sources/Domain/](Sources/Domain/)（`Ports.swift` 是跨层端口的家） |
| 界面面（五入口、Domain→Features 翻译） | [Sources/Features/](Sources/Features/)（`FeaturesAdapter` 是唯一翻译点） |
| 告警面（推送载荷、深链、生物识别闸门） | [Sources/Alerts/](Sources/Alerts/) |
| 离线面（快照、陈旧度、退避、gap report） | [Sources/Offline/](Sources/Offline/) |
| 组合根（装配、配对门、夹具情形） | 本 README §5 + [Sources/App/](Sources/App/) |
| 决策与被否决方案 | [Owning Note](../../.agents/notes/implemented/architecture/2026-10-01-mobile-app-and-contract-core-entry.md) |

## 2. 构建与测试（可复现命令）

```bash
cd apps/ios-native
./scripts/build-simulator.sh      # node 生成契约快照 → xcodegen → xcodebuild 模拟器构建
./scripts/test-contract.sh        # 契约防漂移机检（含重新生成快照 + 重放行为向量）
```

两个脚本都先取重活锁 `build/.heavy.lock`（重活串行纪律：同一时刻只允许一路 xcodegen/xcodebuild；
取锁失败立即退出 75，绝不无锁继续或按时间删除他人锁；调用者不得再包同一把锁）。

等价的裸命令：

```bash
node scripts/gen-contract-snapshot.mjs
xcodegen generate
xcodebuild -project DshTradingNative.xcodeproj -scheme DshTradingNative \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -configuration Debug -derivedDataPath build/DerivedData build
```

### 本机环境事实（5 条；都不是代码问题，已在工程里处理）

1. **宏插件嵌套沙箱**：本机会话的 DSH 文件沙箱内，swiftc 给宏插件起不了嵌套沙箱
   （`sandbox-exec: sandbox_apply: Operation not permitted` ⇒
   `external macro implementation type 'ObservationMacros.ObservableMacro' could not be found`），
   `@Observable` 因此加载不了。`project.yml` 的 `settings.base` 设了
   `OTHER_SWIFT_FLAGS: -disable-sandbox`（只关插件执行沙箱，不动网络/文件权限），加上后标准命令即可复现构建。
2. **xctest 伪终端**：`xcodebuild test` 的 macOS 运行器要开伪终端，被同一沙箱挡下
   （`Pseudo Terminal Setup Error` / EPERM）。因此 `scripts/test-contract.sh` 用
   `build-for-testing` + `xcrun xctest <同一个 .xctest 包>` 执行**同一次编译产物**；在没有该限制的机器上，
   `xcodebuild ... -scheme DshTradingContractTests -destination 'platform=macOS' test` 同样可用。

3. **新增/删除源文件后必须先 `xcodegen generate`**：`DshTradingNative.xcodeproj` 是生成物、不入库，
   而源文件是按目录 glob 进 target 的 —— 新文件只有重新生成工程才会进构建。不重新生成直接 build 会报
   `cannot find 'X' in scope`（看起来像"代码没写完"，其实是工程没刷新）。`scripts/build-simulator.sh` 与
   `scripts/test-contract.sh` 都已经把 `xcodegen generate` 放在 `xcodebuild` 之前。

4. **不带 `-derivedDataPath` 会红，且不是代码问题**：`xcodebuild … build`（没有 `-derivedDataPath`）在沙箱内 exit 65，
   日志里 **0 条 `error:`**，真因是写不了 `~/Library/Developer/Xcode/DerivedData/...`（permission 513）。
   一律带 `-derivedDataPath build/DerivedData`（脚本已如此）。
5. **`ps` 在沙箱内被拒**（`/bin/ps: Operation not permitted`）：孤儿进程检查要换 `pgrep` 或到宿主侧做。

本机实测工具链：Xcode 27.0（27A266a）/ iOS SDK 27.0 / Swift 6.4 / XcodeGen 2.45.3；模拟器 `DshtTrading`（iOS 27.0）。

## 3. 冻结的契约面（`Sources/Contract/`）

**TS 契约是唯一权威**（`packages/contract/src/{version,scopes,cards,push,confirm,offline,source-guard}.ts`），
Swift 侧是等价实现。客户端**不自行发号**（不引入 `ids.ts` 语义）。

> **权威边界（8/9）**：`Sources/Contract/` 有 9 个文件，其中 [ContractA0.swift](Sources/Contract/ContractA0.swift)
> （`KillState` / `A0Status`）在 `packages/contract/src/` 里**没有对应模块** —— 它是客户端侧的 wire DTO，
> 出处是 `GET /a0/status` 的响应形状（由 [ObservationTransport.swift](Sources/Transport/ObservationTransport.swift) 消费）。也就是说"TS 是唯一权威 + 防漂移机检"目前覆盖 **8/9**，
> A0 那两个类型由 [ContractA0Tests.swift](Tests/ContractTests/ContractA0Tests.swift) 的 fail-closed 行为断言守着
> （`killed`/`paused` 读不到就抛错、未知 scope 丢弃、不默认 false）。

| 文件 | 冻结符号 |
|---|---|
| [ContractVersion.swift](Sources/Contract/ContractVersion.swift) | `ApiContract`（major/minor/compatibleMajorSpan/capsHeader/clientTooOldStatus）、`VersionVerdict`、`parseCaps`、`formatCaps`、`negotiateVersion` |
| [ContractScopes.swift](Sources/Contract/ContractScopes.swift) | `ScopePlane`、`scopePlanes`、`defaultScopePlanes`、`explicitScopePlanes`、`isScopePlane`、`grantableByDefault` |
| [ContractCards.swift](Sources/Contract/ContractCards.swift) | `CardType`/`FieldKind`/`ActionKind`（12/12/12 封闭枚举，rawValue 与 TS 逐字相同）、`actionScope`、`CardLimits`/`cardLimits`、`CardField`（`rawValue` 保真 / `value` 投影）/`CardAction`/`Card`/`CardVerdict`、`validateCard`、`renderableActions`、`fallbackFor` |
| [ContractConfirm.swift](Sources/Contract/ContractConfirm.swift) | `ConfirmLevel`、`actionConfirm`、`confirmLevel(for:)`（`ActionKind` 与 `String` 两个重载）、`scopeForAction`、`auditConfirmPolicy`、`ClientPlatform`、`requiresBiometric` |
| [ContractPush.swift](Sources/Contract/ContractPush.swift) | `PushSeverity`/`PushKind`/`PushAction`、`deeplinkScheme`、`PushLimits`/`pushLimits`、`PushPayload`、`validatePushPayload`、`acceptedPush`、`shouldInterrupt` |
| [ContractOffline.swift](Sources/Contract/ContractOffline.swift) | `Staleness`、`StalenessBudget`、`OfflineSnapshot`、`stalenessOf`、`OfflineView`、`offlineView`、`DeeplinkScreen`、`DeeplinkResult`、`parseDeeplink` |
| [ContractSourceGuard.swift](Sources/Contract/ContractSourceGuard.swift) | `SourcedDatum`、`ReconcileReport`、`SourceGuard` |
| [ContractDecoding.swift](Sources/Contract/ContractDecoding.swift) | `CardValue`（字段值保真形状：null/bool/number/unrepresentableNumber/text/array/object）、`cardValueText`/`contractValueText`（`String(value)` 等价：null ⇒ "null"、缺失 ⇒ "undefined"、数组 join、对象 `[object Object]`）、`contractNumberText`/`contractJSONNumber`/`contractJSONString`/`contractJSONValue`（ECMAScript `Number::toString` 与 `JSON.stringify` 等价）、宽松标量解码（`LenientText`/`LenientTextMap`）：**只搬类型，不判语义、不猜默认值** |

### fail-closed 的建模方式

封闭枚举项（`cardType` / `field.kind` / `action.kind` / `push.kind` / `push.severity`）在 DTO 里**保留为 `String`**，
由 `CardType(rawValue:)` 一类查表判定；**查表落空 ⇒ 不可操作**（禁用全部 Action，只渲染 `fallbackText`），
**绝不抛掉整张卡、绝不猜默认值**。所有查表用 `switch`/表驱动，**没有 `default` 分支吞掉未知值**；
新增枚举项会让 `scopeOf`/`confirmLevelOf` 的 `switch` **编译失败**，逼人显式补一行。

未知动作字符串另有第二道保险：`scopeForAction("future-action") == .control`、
`confirmLevel(for: "future-action") == .biometric`（**最高档**）。

### 字段值的等价性（`String(value)`）

TS 的 `CardField.value` 是 `unknown`，权威判定用 `String(field.value)`。Swift 侧因此**不能把 JSON `null`
与"字段缺失"混成同一个 nil**：`CardField.rawValue` 里 nil 只表示缺键，JSON null 是 `CardValue.null`；
`CardField.value` 是前者的 `String?` 投影（缺失 ⇒ nil，null ⇒ `"null"`）。`String()` 的转换逐条对齐
ECMAScript ToString：数组 `join(",")`（null 元素成空串）、对象固定 `[object Object]`，**非标量不塌缩成 nil**。
数值文本由 `contractNumberText` 复刻 ECMAScript `Number::toString`（`1e21` 才切科学记数法、`1e-7` 才切、
`-0` 写 `"0"`），字节棘轮与 `JSON.stringify` 同源 —— 这条也顺带保证了 `revision` 的转换路径**不存在裸
`Int(Double)`**（极大有限数会 trap，见 [契约面字段值等价性](../../.agents/notes/implemented/bug-fix/2026-10-02-ios-contract-value-equivalence.md)）。

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
  查表（actionScope/actionConfirm）、以及**行为向量**（negotiateVersion / validateCard /
  renderableActions / fallbackFor / stalenessOf / offlineView / parseDeeplink / grantableByDefault /
  parseCaps / formatCaps / requiresBiometric / sourceGuard / validatePushPayload 的输入 → TS 权威输出）。
  **向量条数与用例数随契约扩展，不在此写死** —— 想看当前数字就重跑并读生成器输出（`node scripts/gen-contract-snapshot.mjs`
  会打印 `vectors <N>`）与测试汇总；长度上限覆盖 UTF-16 码元边界（emoji），诊断与合法性逐条匹配 TS。
  突变自检入口：`node scripts/test-drift-mutation.mjs`（先独占锁、改 `maxActions` 3→4、断言红、恢复并断言绿；
  锁忙时退出 75 且不改源码）。
- [ContractDriftTests.swift](Tests/ContractTests/ContractDriftTests.swift) 逐字段比对常量与表，
  并锁住 fail-closed 行为（未知 cardType ⇒ `valid=false, operable=false`；未知枚举 ⇒ 全动作禁用；
  control ⇒ biometric；过期不渲染数据本身；跨源不混显）。
- [ContractVectorTests.swift](Tests/ContractTests/ContractVectorTests.swift) 逐条重放行为向量 ——
  只比对常量是弱机检，**行为漂移会被这一层抓住**。
- **夹具缺失 ⇒ 测试 FAIL** 并打印重新生成命令，绝不 skip（对齐本仓"未验证 ≠ 通过"）。
- 机检可运行且真的会红：`./scripts/test-contract.sh`。红/绿证据：`node scripts/test-drift-mutation.mjs`
  会现场改错、断言红、恢复源码、再断言绿（自己重跑即可复现；日志落在 `build/`，那是不入库的生成物，不进文档链接）。
  两处已复核的突变：让 `grantableByDefault` 放行 control、把 `cardLimits.maxFields` 24 改成 25 —— 两者都会变红，改回即全绿。

### CI 接线（不需要 Xcode）

仓根 `scripts/ios-native/` 有两条**纯 Node** 门禁，跑在 `ci.yml` 的 static-gates job 里：

- `node scripts/ios-native/check-contract-drift.mjs` —— 直接 import TS 契约取权威真值，
  再从 `Sources/Contract/*.swift` 解析出封闭枚举/查表/上限/常量逐项比对；**解析不出来一律判红**。
- `node scripts/ios-native/check-swift-layering.mjs` —— 分层 import 白名单（`Observation` 在名单内，**经 Lead 批准**：
  `@Observable` 是随工具链的标准库宏；`Combine`/`Charts` **未获批准，不在名单内**），越界或新增未登记的分层即红；
  第三方依赖同样拦下。识别**属性前缀与种类词**：`@_exported import SwiftUI`（把禁层模块透传出去）、
  `@testable import DshTradingFeatures`、`import struct SwiftUI.Color`（模块名取 `SwiftUI` 而不是关键字 `struct`）
  都会被抓住并给出正确诊断。
- 两条门禁都有自测（`scripts/ios-native/*.test.mjs`，夹具驱动）：真契约副本 ⇒ 绿、改常量 ⇒ 红并点名、
  缺文件 ⇒ fail-closed 红、`@_exported` 绕过 ⇒ 红。

两者都验证过「故意改错 ⇒ 红」（改 `kill` 的确认档位、给 Transport 加 `import SwiftUI`）。
CI **不跑 iOS 构建**（与 `apps/mobile` 同一先例）：真正的 Swift 断言留本机 `./scripts/test-contract.sh`（用例数随契约扩展）。

## 5. App 组合根（`Sources/App/`）

`DshTradingNativeApp` → `AppEnvironment` → 三屏：环境不可用 / **配对门**（`PairingClient`）/ 观测面（`RootTabView`）。

- **装配链**：`TransportSession`（Keychain 令牌）→ `TransportSnapshotFetcher`（`Sources/App` 里的
  Transport → `SnapshotFetching` 适配器：先 `/a0/ping`，失败抛 `.unreachable`；`/a0/status` 拿不到就传 nil）
  → `OfflineObservationSource` → `ObservationStore` → `FeaturesAdapter.featuresState(from:)` → `RootTabView`。
  适配器放 App 是为了让 **Offline 保持零 Transport 依赖**（分层表不动）。
- **动作派发**：Features 只给 `ActionPresentation`，`StoreActionDispatcher` 接到 `ObservationStore.send(_:params:gate:)`，
  gate 用 Alerts 的 `AlertsConfirmationGate`（`LocalAuthentication`）；未知动作在派发口**再 fail-closed 一次**。
- **未配对就是未配对**：`TransportSession.apiClient()` 在未配对时返回 nil，不建"没有令牌的客户端"、不发匿名请求；
  配对**不做授权**（配对永不签发 control），作用域只来自 `/a0/status`。
- **夹具模式**（`--fixtures` 或 `DSH_IOS_FIXTURES=1`）：没有真实 bot 也能跑起来，走**同一条**离线/领域流水
  （不是另写假路径），首屏顶部有横幅。夹具里含一张**未知 cardType** 的卡，用来肉眼确认 fail-closed 渲染。
- **客户端不发号**：唯一自造的 id 是幂等键 `clientRequestId`（契约明文可见可重试）；**orderId 永不自造**。
- **Keychain 不可用的退路**：退回内存存储并如实提示（重启需重新配对）；**绝不**把设备令牌写进 UserDefaults/文件。
- 未接线：真机签名、APNs 注册、设备上的生物识别验证、持久化快照落盘实现（Offline 卡范围；当前离线可用性只靠"重取一次快照"）。

## 6. 不变量与验收判据（每条都要有可执行落点）

> 判据来自本轮工作冻结件；冻结件已删除，**家在这里**。每条后面是它的可执行落点：
> 能机检的给门禁/测试，**测不到的如实标注**。

| # | 不变量 | 可执行落点 |
|---|---|---|
| 1 | 未知封闭枚举 ⇒ 不可操作（禁用全部 Action，只渲染 `fallbackText`） | `validateCard`/`renderableActions`（[ContractCards.swift](Sources/Contract/ContractCards.swift)）；`testUnknownClosedEnumValuesDisableEveryAction`、`testUnknownCardTypeIsInvalidAndInoperable`；`validateCard`/`renderableActions` 行为向量；[check-contract-drift.mjs](../../scripts/ios-native/check-contract-drift.mjs) 的 rawValue 比对 |
| 2 | 过期/陈旧数据不渲染数据本身 | `offlineView`（[ContractOffline.swift](Sources/Contract/ContractOffline.swift)）；`testExpiredSnapshotNeverRendersTheDataItself`；`offlineView` 向量；Offline 层单测。**渲染判据是契约面 `StalenessBudget.ttlMs`**，毫秒事实只有一个家（[DataTrust.swift](Sources/Domain/DataTrust.swift) 的 `ObservationStalenessBudget`，`TrustBudget` 由它派生） |
| 3 | 跨源永不混显；切换期只读 | 契约面：`SourceGuard`；`testSourceGuardNeverMixesSourcesAndIsReadOnlyWhileSwitching`；`sourceGuard` 向量；[ContractParityTests.swift](Tests/ContractTests/ContractParityTests.swift)。本地快照面（IOS-7）：来源身份 `SnapshotSourceId`（origin + 配对代际，**不写死**）、`SourceScopedSnapshots.load(sourceId:)` 的来源校验、配对边界 `clear()`；[PairingScopedSnapshotTests.swift](Tests/OfflineTests/PairingScopedSnapshotTests.swift) 的正负例 |
| 4 | 令牌只发往配对绑定的 origin，跨源**连请求都不发**；重新配对后**旧客户端**一律发不出 | ① [DshtApiClient.swift](Sources/Transport/DshtApiClient.swift) 的四道守卫，顺序即语义（origin → 配对代际 → 取令牌 → 发送）；② 取令牌**只有**带绑定入口 `authorization(ifBoundTo:)`（无绑定版本已删除），[TokenProvider.swift](Sources/Transport/TokenProvider.swift)；③ 配对身份 = 绑定 origin + 配对代际，[PairingIdentity.swift](Sources/Transport/PairingIdentity.swift)（同一身份也决定本地快照的来源，见 #3）；④ 跨源 30x 不跟随（`RedirectPolicyDelegate`）；⑤ 机检 [check-transport-token-binding.mjs](../../scripts/ios-native/check-transport-token-binding.mjs) 把①②③⑤钉成 CI 门禁。**真机未验** |
| 4 | 令牌只发往配对绑定的 origin，跨源**连请求都不发**；重新配对后**旧客户端**一律发不出 | ① [DshtApiClient.swift](Sources/Transport/DshtApiClient.swift) 的四道守卫，顺序即语义（origin → 配对代际 → 取令牌 → 发送）；② 取令牌**只有**带绑定入口 `authorization(ifBoundTo:)`（无绑定版本已删除），[TokenProvider.swift](Sources/Transport/TokenProvider.swift)；③ 配对身份 = 绑定 origin + 配对代际，[PairingIdentity.swift](Sources/Transport/PairingIdentity.swift)；④ 跨源 30x 不跟随（`RedirectPolicyDelegate`）；⑤ 机检 [check-transport-token-binding.mjs](../../scripts/ios-native/check-transport-token-binding.mjs) 把①②③⑤钉成 CI 门禁。**真机未验** |
| 5 | 配对永不签发 control；控制类动作一律 biometric 且 fail-closed | `grantableByDefault`（向量 + ContractParityTests）；`auditConfirmPolicy`/`actionConfirm`（`testEveryControlActionRequiresBiometric`）；Alerts 的 `AlertsConfirmationGate` 单测。**设备上的生物识别未验** |
| 6 | 生物识别不替代服务端授权与风控 | Alerts 的注释 + 单测：闸门只决定"要不要把动作发出去"，服务端仍按 scope 与 mandate 判。**无设备验证** |
| 7 | 「App 看不到机器人」与「机器人已停止」是两种显示 | Domain 的 reachability 与三维语义单测 + Features 呈现单测（见 [IOS-4 独立验收报告](docs/acceptance/ios4-independent-acceptance.md)）；夹具 `stopped` 与 `unreachable` 两情形可肉眼并排 |
| 8 | 三维语义（执行状态 / 依赖健康 / 数据可信度）互不顶替；`alignment` 与 `level` 两套词汇不相交 | Domain 的状态语义机与 `ClosedEnum` 单测（[Sources/Domain/](Sources/Domain/)） |
| 9 | 客户端不含交易所密钥；不依赖 bot 平面运行时包 | `pnpm plane:check`（CI 静态门禁）；本目录只消费 `@dshtrading/contract` 的语义，源码内无任何密钥 |
| 10 | 观测面不依赖 tick 流（快照是契约） | 结构事实：`ObservationSource.fetchSnapshot()` 是唯一数据入口，**WS 事件续读未实现**；`Sources/App` 只是定时重取快照。**"不依赖"是结构性质，无法用断言证明** |
| 11 | 不改服务端语义；需要契约变更先记录 | `packages/contract` 只读消费；缺口清单见 §8 finding 4 与 Owning Note |

**测不到的部分如实说**：4 / 5 / 6 目前只有单测或代码结构证据，**真机（Keychain 持久化、生物识别、推送）未验**；
10 的"不依赖 tick 流"是结构事实（没有 WS 客户端），不是断言；7 的并排图由 IOS-3 采集。

## 7. 未验证项（不得计入验收）

| 项 | 现状 | 为什么没验 |
|---|---|---|
| 真机签名与部署 | 只有模拟器构建证据 | 无签名/账号 |
| APNs 真实送达与授权弹窗 | 只有载荷契约与 `acceptedPush` 闸门 | 未接推送服务、无设备 |
| 设备上的生物识别（Face ID / 密码回退）、锁屏渲染、专注模式 | 只有 `BiometricAuthenticating` 端口与闸门单测 | 无设备 |
| 弱网（超时 / 半开 / 抖动） | 有 `OfflineBackoff` 与 gap report 的结构与单测 | 未做真机弱网 |
| 沙箱外的 `xcodebuild test` | 本机只能 `build-for-testing` + `xcrun xctest` 绕过 PTY 限制 | 沙箱环境限制 |
| 事件续读（WS 流） | **未实现**：快照是唯一数据入口 | 本轮范围外 |
| 真机持久化 | `InMemorySnapshotPersistence`（重启丢快照 ⇒ 只影响离线可用性，不影响正确性）；来源身份校验在 `SourceScopedSnapshots`，落盘实现换上来时自动继承 | 落盘实现的原子性未验 |
| App 组合根（`Sources/App`）的接线 | `observationSourceId` 从配对身份派生、`pair()/unpair()` 清空快照 | 该层无测试目标；派生规则由 `PairingScopedSnapshotTests` 直接断言，接线本身只有编译期/结构证据 |
| 「解析不在主线程」 | 代码结构如此（`DeskMapper.mapOffMain`） | **无法用断言证明**，需要线程断言基础设施 |

## 8. finding（记录，不自行放宽）

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
5. **传输面曾有"安全实现写好了却没接线"（2026-10-02 已修，IOS-8）**：带 origin 绑定的
   `authorization(ifBoundTo:)` 一直存在，但生产路径调的是**无绑定**的 `authorization()`，
   且 `URLSession(configuration:)` 没挂 delegate ⇒ 跨源 30x 默认跟随。两处都已收敛：
   无绑定入口**从协议删除**（机检 ① 挡它回来）、重定向 delegate 挂上（机检 ⑤ 挡它被摘掉）、
   配对身份增加**代际**（守卫 ④ 挡"重新配对到同一 origin 后旧客户端仍可用"）。
   负例与突变演练证据见 [Agent Note](../../.agents/notes/implemented/bug-fix/2026-10-02-ios-token-origin-binding-and-pairing-epoch.md)。
6. **IOS-7（本地快照的来源身份）已修**：来源身份 `SnapshotSourceId`（规范化 origin + 配对代际）、
   读路径来源校验 `SourceScopedSnapshots`、配对边界清空、命令通道的数据可信度闸门（`DataTrust.blocksCommands`）。
   决策与红/绿证据见 [Agent Note](../../.agents/notes/implemented/bug-fix/2026-10-02-ios-offline-cache-source-identity.md)。
7. **`docs-link:check` **不覆盖本目录**（已知缺口，如实记录，留待下一轮补）**：
   `scripts/docs-link-check.mjs:31-32` 的扫描清单只有 `AGENTS.md` 与 `docs/**`，
   **不含 `apps/ios-native/**`** —— 本 README 的 45 条相对链接**没有任何门禁保**，只靠人工静态检查兜。
   2026-10-02 实证：工作冻结件删除后 `apps/ios-native/IOS-1-HANDOFF.md` 里指向 `INTERFACE-FREEZE.md` 的
   markdown 链接成了断链，而 `node scripts/docs-link-check.mjs --check` 仍 **exit 0**（它连这个文件都没扫）。
   影响：本目录的文档链接腐烂不会被 CI 发现。修法（下一轮）：把
   `apps/ios-native/**/*.md` 纳入扫描清单，或显式入基线并写明原因。

## 9. 文档与决策记录

本轮的工作冻结件 `INTERFACE-FREEZE.md` **已在收尾时删除**，其事实已归家：
- 工程形态 / 构建与测试命令 / 契约面与防漂移 / 组合根 / 不变量与验收判据 / 未验证项 → **本 README**；
- 决策、被否决方案与契约缺口 → [Owning Note](../../.agents/notes/implemented/architecture/2026-10-01-mobile-app-and-contract-core-entry.md)；
- 分层白名单 → [check-swift-layering.mjs](../../scripts/ios-native/check-swift-layering.mjs)（可执行判据即事实）。

`packages/contract` 只被**只读消费**：本目录不修改任何 TS 契约。
