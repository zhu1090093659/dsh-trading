# apps/ios-native 接口冻结（Lead 所有，冻结于 2026-10-02）

> 本文件是**本轮 Agent Team 的工作冻结件**，不是长期事实之家。收尾时其事实并入
> `apps/ios-native/README.md` 与 Owning Note
> `.agents/notes/implemented/architecture/2026-10-01-mobile-app-and-contract-core-entry.md`（就地更新），
> 本文件随后删除。**除 Lead 外任何人不得修改本文件。**

## 0. 产品定位（不得偏离）

本 App 是**自动交易机器人（Trading Bot）的观测端**：看机器人运行状态、持仓/订单/资产、告警、升级。
它**不是**辅助交易 App 的手机版，**不做**手动下单面板，**不做**行情终端。
权威态在执行核；GUI 只是视图。手机崩溃/断线/锁屏**不得**影响执行。

## 1. 工程形态（冻结，2026-10-02 修订 A）

- `apps/ios-native/` 是**独立 Xcode 工程**，由 **XcodeGen** 从 `project.yml` 生成。
- **不进 pnpm workspace**（与 `desktop/`、`apps/mobile` 同一先例）。
- **工程名 `DshTradingNative`**；**一个子目录 = 一个 framework target**（IOS-1 采用，Lead 采纳）：
  `DshTradingContract` / `DshTradingTransport` / `DshTradingDomain` / `DshTradingFeatures` /
  `DshTradingAlerts` / `DshTradingOffline` / `DshTradingNative`（App）。
  **这比原来"单 target + grep 门禁"更强**：§3 的层间依赖由**编译器**强制，不靠脚本自觉。
  每个子目录另有 iOS 逻辑测试目标 `DshTrading<Area>Tests`；`DshTradingContractTests` 是
  **macOS** 目标，直接编译 `Sources/Contract` 同一批源文件（平台无关），秒级跑防漂移机检。
- **生成物不入库**：`DshTradingNative.xcodeproj/`、`build/`、`Generated/`（契约快照）、
  `xcuserdata/`、`.build/` 全部进 `apps/ios-native/.gitignore`。
  **该文件目前缺失（IOS-1 必须立刻补）**。
- 依赖：**只依赖 `@dshtrading/contract` 的语义**（Swift 侧等价实现，见 §4），
  **不得**依赖任何 bot 平面运行时包，**不得**内嵌交易所密钥（一条都不许出现在 Swift 源码里）。

### 目录划分与写作用域（互不重叠，逐卡独占）

| 目录 / 文件 | 归属卡 | 内容 |
|---|---|---|
| `project.yml`、`.gitignore`、`README.md` | IOS-1 | XcodeGen 工程定义、忽略规则、工程说明 |
| `Sources/Contract/` | IOS-1 | 契约等价实现（§4） |
| `Sources/App/` | IOS-1 | `@main` App 入口 + 组合根（装配，最后落地） |
| `Tests/ContractTests/` | IOS-1 | 契约单测 + **TS 防漂移机检** |
| `Sources/Transport/`、`Tests/TransportTests/` | IOS-2 | /v1 客户端、配对、设备令牌、Keychain、origin 绑定 |
| `Sources/Domain/`、`Tests/DomainTests/` | IOS-3 | 观测态领域模型、三维状态语义机、**跨层协议（端口）** |
| `Sources/Features/`、`Tests/FeaturesTests/` | IOS-4 | SwiftUI 观测面 |
| `Sources/Alerts/`、`Tests/AlertsTests/` | IOS-5 | 告警闭环、推送载荷、深链、生物识别闸门 |
| `Sources/Offline/`、`Tests/OfflineTests/` | IOS-6 | 离线快照、陈旧度、resync、弱网、性能 |
| `scripts/ios-native/`、`apps/ios-native/docs/`、`.github/workflows/` | IOS-7 | 夹具生成器、CI、证据与文档 |

**跨卡纪律**：不得写别人的目录。需要别人改动时发消息给该卡的 teammate，不自己动手。

## 2. 构建与测试（冻结的命令）

```bash
cd apps/ios-native
node scripts/gen-contract-snapshot.mjs   # 先生成 Generated/contract-snapshot.json（不入库）
xcodegen generate                        # 生成 DshTradingNative.xcodeproj（不入库）

# 真编译（必须能复现 BUILD SUCCEEDED）
xcodebuild -project DshTradingNative.xcodeproj -scheme DshTradingNative \
  -destination 'platform=iOS Simulator,name=DshtTrading,OS=27.0' \
  -derivedDataPath build/DerivedData build

# Swift 测试：契约防漂移走 macOS（秒级），其余走 iOS 模拟器
xcodebuild -project DshTradingNative.xcodeproj -scheme DshTradingContractTests \
  -destination 'platform=macOS' -derivedDataPath build/DerivedData test
xcodebuild -project DshTradingNative.xcodeproj -scheme DshTradingDomainTests \
  -destination 'platform=iOS Simulator,name=DshtTrading,OS=27.0' \
  -derivedDataPath build/DerivedData test
```

本机已备好专用模拟器 `DshtTrading`（UDID `536D8D31-6BA6-4535-BCEF-842E9A47078D`，iOS 27.0）。
可用 `-destination 'id=536D8D31-6BA6-4535-BCEF-842E9A47078D'` 更稳。
本机工具链：Xcode 27.0 / iOS SDK 27.0 / Swift 6.4。

### 重活串行（硬纪律）

**同一时刻只允许一路** `xcodegen` / `xcodebuild` / `swift` / `pnpm` 重活。
开工前先确认没有别人在跑；跑完必须查孤儿进程。**不许并发 xcodebuild**——上一次本机并发把
load(15m) 推到 20+、swap 到 4.4 GB。

## 3. 层间依赖（机检，IOS-7 写 `scripts/ios-native/check-swift-layering.mjs` 守）

```
Contract   → 只许 Foundation
Transport  → Contract + Foundation + Security(Keychain)
Domain     → Contract + Foundation              （**禁止 import SwiftUI / UIKit**）
Offline    → Contract + Domain + Foundation     （禁止 import SwiftUI）
Alerts     → Contract + Domain + Foundation + UserNotifications + LocalAuthentication + UIKit(仅 UIApplication)
Features   → 允许 import 全部 + SwiftUI
App        → 允许 import 全部
```

**任何层都不得 import `Features` 或 `App`。** 只许 import 上表列出的模块 + 白名单 Apple 框架；
出现其它 import（尤其任何第三方包）即判红。分层 framework 下这条**由编译器强制**。

**`project.yml` 必须补上的依赖边（IOS-1 负责，当前缺失）**：
`DshTradingFeatures` / `DshTradingOffline` / `DshTradingAlerts` 各自都要依赖 `DshTradingDomain`
（它们消费 §6 的端口 `ObservationStore`/`ObservationSource`/`ConfirmationGate`）。
`DshTradingTransport` 保持只依赖 Contract（它只提供 §5 的 `ObservationTransport`，
由 Offline 适配成 `ObservationSource`）。

## 4. 契约层冻结面（`Sources/Contract/`，IOS-1 实现）

TS 契约是**唯一权威**（`packages/contract/src/{version,scopes,cards,push,confirm,offline,source-guard}.ts`）。
Swift 侧是等价实现。**不得为使 Swift 好写而放宽任何判据。**

### 4.1 fail-closed 的建模方式（**最重要的一条**）

TS 里 CardType / FieldKind / ActionKind / severity / scope 都是**封闭枚举**，未知值 ⇒
**不可操作**（禁用全部 Action），但卡片本身仍要能显示。Swift 的 `enum: String` 解码未知值会抛错，
**因此 Swift 侧的 DTO 必须把封闭枚举项保留为 `String`**，再用 `CardType(rawValue:)` 之类的
查表判定；查表落空 ⇒ 同等渲染为"不可操作"，**绝不**抛掉整张卡、**绝不**猜一个默认值。

### 4.2 类型与签名

```swift
// —— 版本与能力 ——
enum ApiContract {
  static let major = 1, minor = 0, compatibleMajorSpan = 3
  static let capsHeader = "x-dsht-caps"
  static let clientTooOldStatus = 426
}
func parseCaps(_ raw: String?) -> [String]
func formatCaps(_ caps: [String]) -> String
enum VersionVerdict: Equatable {
  case ok(caps: [String], downgraded: [String])
  case rejected(status: Int, code: String, message: String)   // CLIENT_TOO_OLD / CLIENT_TOO_NEW
}
func negotiateVersion(clientMajor: Int, serverMajor: Int = ApiContract.major,
                      clientCaps: [String], requiredCaps: [String] = [],
                      serverCaps: [String] = []) -> VersionVerdict

// —— 作用域 ——
enum ScopePlane: String, CaseIterable { case read, command, control }
let defaultScopePlanes: [ScopePlane]   // [.read]
let explicitScopePlanes: [ScopePlane]  // [.control]
func isScopePlane(_ v: String) -> Bool
func grantableByDefault(_ requested: [String]) -> [ScopePlane]   // control 永远被剔除

// —— 卡片协议 ——
enum CardType: String, CaseIterable { /* 12 个 */ }
enum FieldKind: String, CaseIterable { /* 12 个 */ }
enum ActionKind: String, CaseIterable { /* 12 个 */ }
let actionScope: [ActionKind: ScopePlane]
struct CardLimits { /* 12 个上限，字段名与 TS CARD_LIMITS 一一对应 */ }
let cardLimits: CardLimits
struct CardField  { let key: String; let label: String; let kind: String; let value: String?
                    let unit: String?; let values: [String]? }
struct CardAction { let kind: String; let label: String; let params: [String: String]?; let confirm: Bool? }
struct Card { let cardId: String; let cardType: String; let revision: Int
              let fallbackText: String; let fields: [CardField]; let actions: [CardAction]
              let freshnessMs: Int? }
struct CardVerdict { let valid: Bool; let operable: Bool; let problems: [String] }
func validateCard(_ card: Card, limits: CardLimits = cardLimits) -> CardVerdict
func renderableActions(_ card: Card, clientCaps: [String], limits: CardLimits = cardLimits) -> [CardAction]
func fallbackFor(_ card: Card) -> String

// —— 确认闸门 ——
enum ConfirmLevel: String { case none, confirm, biometric }
let actionConfirm: [ActionKind: ConfirmLevel]
func confirmLevel(for action: ActionKind) -> ConfirmLevel
func auditConfirmPolicy() -> (ok: Bool, problems: [String])
enum ClientPlatform { case web, mobile }
func requiresBiometric(_ action: ActionKind, platform: ClientPlatform) -> Bool

// —— 离线陈旧度 ——
enum Staleness: String { case fresh, aging, stale, expired, unknown }
struct StalenessBudget { let freshMs: Int; let staleMs: Int; let ttlMs: Int }
struct OfflineSnapshot<T> { let data: T; let atMs: Int; let sourceId: String }
func stalenessOf<T>(_ s: OfflineSnapshot<T>?, nowMs: Int, budget: StalenessBudget) -> Staleness
enum OfflineView<T> { case data(T, Staleness, String?); case notice(Staleness, String) }
func offlineView<T>(_ s: OfflineSnapshot<T>?, nowMs: Int, budget: StalenessBudget) -> OfflineView<T>

// —— 深链（封闭集合，未知一律拒绝） ——
enum DeeplinkScreen: String, CaseIterable { case escalations, decisions, positions, control }
enum DeeplinkResult { case ok(screen: DeeplinkScreen, id: String?); case rejected(reason: String) }
func parseDeeplink(_ url: String) -> DeeplinkResult

// —— 数据源守卫（跨源永不混显） ——
struct SourcedDatum<T> { let id: String; let sourceId: String; let value: T }
struct ReconcileReport { let ok: Bool; let activeCount: Int; let incomingCount: Int; let reason: String? }
final class SourceGuard<T> {
  init(activeSourceId: String)
  func sourceId() -> String
  func viewOf(_ data: [SourcedDatum<T>]) -> [SourcedDatum<T>]
  func writable() -> Bool
  func switchTo(_ nextSourceId: String)
  func switching() -> Bool
  func reconcile(active: [SourcedDatum<T>], incoming: [SourcedDatum<T>]) -> ReconcileReport
}

// —— 推送载荷 ——
enum PushSeverity: String, CaseIterable { case info, warning, critical }
enum PushKind: String, CaseIterable { case escalation, degradation = "degradation", killConfirmed = "kill-confirmed" /* …5 个，rawValue 用 TS 原串 */ }
enum PushAction: String, CaseIterable { case ack, approve, reject, pause, kill }
let deeplinkScheme = "dshtrading://"
struct PushLimits { /* 5 个上限，与 TS PUSH_LIMITS 同名 */ }
let pushLimits: PushLimits
struct PushPayload { /* kind/severity 为 String；deskId/deeplink/expiresInMs/actions/fallbackText/revision */ }
func validatePushPayload(_ p: PushPayload) -> (valid: Bool, problems: [String])
func shouldInterrupt(_ p: PushPayload, muted: [String]) -> Bool
```

> 枚举 case 名用 Swift 驼峰、**rawValue 必须与 TS 字面量逐字相同**（如 `kill-confirmed`、
> `open-detail`、`retry-sync`）。机检断言比对的就是 rawValue。

### 4.3 防漂移机检（**必须是可执行断言**）

1. `apps/ios-native/scripts/gen-contract-snapshot.mjs`（IOS-1 已落地）从 `@dshtrading/contract`
   的**运行期真值**导出 JSON：
   `{ version:{...}, scopes:{...}, cardTypes:[], fieldKinds:[], actionKinds:[], actionScope:{}, actionConfirm:{},
     cardLimits:{}, confirmLevels:[], staleness:[], deeplinkScreens:[], deeplinkScheme:,
     pushKinds:[], pushSeverities:[], pushActions:[], pushLimits:{},
     vectors:{ negotiateVersion:[], validateCard:[], stalenessOf:[], offlineView:[], parseDeeplink:[],
               grantableByDefault:[], sourceGuard:[] } }`
2. 输出路径：`apps/ios-native/Generated/contract-snapshot.json`（**生成物，不入库**），
   由 `DshTradingContractTests` 作为 bundle resource 读取。
3. `Tests/ContractTests/*`（IOS-1）逐字段断言 Swift 常量 == 快照，并**逐条重放 vectors**。
4. **夹具缺失 ⇒ 测试必须 FAIL 并打印生成命令，绝不 skip、绝不静默通过**
   （对齐本仓"未验证 ≠ 通过"的读法）。
5. **必须补行为向量 `vectors`**：现有生成器只导出表与常量（弱机检 —— 行为漂移会漏过去）。
   要补 `negotiateVersion / validateCard / stalenessOf / offlineView / parseDeeplink /
   grantableByDefault / sourceGuard` 的输入-输出向量。IOS-1 补生成器与断言，
   IOS-7 在 CI 把"重新生成快照 ⇒ 断言一致"接成门禁。

## 5. 传输层冻结面（`Sources/Transport/`，IOS-2 实现）

服务端是唯一权威。客户端只调这些面（**不要自己造端点**）：

| 面 | 方法/路径 | 说明 |
|---|---|---|
| 配对 | `POST /pair/redeem` body `{code, name}` | 公开路径；成功 → `{deviceId, secret}`，失败 → `{error}` |
| 令牌 | `Authorization: Bearer <deviceId>.<secret>` | 与 `packages/tradectl/src/pairing-client.ts` `authorizationFor` 同构 |
| A0 心跳 | `GET /a0/ping` | `{ok, atMs, device}`；**这是"App 能不能看到机器人"的唯一判据** |
| A0 状态 | `GET /a0/status` | `{ok, state:{killed,paused,reason,atMs}, device, scopes}`；**这是"机器人是否已停止"的信号** |
| A0 控制 | `/a0/kill` `/a0/pause` `/a0/resume` | **control 平面**，走 §6 闸门；本卡只做传输，不决定 UI |
| 健康 | `GET /healthz` | 公开路径 |
| 卡片 | `GET /v1/cards` | `{cards, truncated, caps, downgraded}`；请求头 `x-dsht-caps` |
| 命令 | `POST /v1/commands` body `{clientRequestId, action, params}` | 回执 `{clientRequestId, replayed, result}` |

**冻结的 Swift 面**：

```swift
struct DshtOrigin: Equatable, Hashable { let scheme: String; let host: String; let port: Int
                                         func url(_ path: String) -> URL? }
protocol HttpClient: Sendable { func send(_ request: DshtRequest) async throws -> DshtResponse }
struct DshtRequest { let method: String; let url: URL; let headers: [String: String]; let body: Data? }
struct DshtResponse { let status: Int; let headers: [String: String]; let body: Data }
enum TransportError: Error { case originNotBound(expected: String, actual: String)
                             case unreachable(String); case badResponse(String)
                             case scopeRequired(required: ScopePlane); case clientTooOld(status: Int, code: String) }
protocol SecureStore { func save(_ key: String, _ value: String) throws
                       func load(_ key: String) throws -> String?
                       func remove(_ key: String) throws }
protocol TokenProvider: Sendable { func authorization() -> String?; func forget() }
struct KillState { let killed: Bool; let paused: Bool; let reason: String; let atMs: Int }
struct A0Status  { let ok: Bool; let state: KillState; let device: String; let scopes: [ScopePlane] }
struct CardsPage { let cards: [Card]; let truncated: Bool; let caps: [String]; let downgraded: [String] }
protocol ObservationTransport: Sendable {
  func ping() async throws -> Bool
  func a0Status() async throws -> A0Status
  func cards(clientCaps: [String]) async throws -> CardsPage
  func command(action: ActionKind, params: [String: String], clientRequestId: String) async throws -> Data
}
final class DshtApiClient: ObservationTransport { init(origin:, tokens: TokenProvider, http: HttpClient) }
```

**两条硬规则（机检 + 单测）**：

1. **令牌只发往配对绑定的 origin**：令牌与 origin 一起存；每次请求前断言目标 origin == 绑定 origin，
   不等则抛 `originNotBound` 且**连请求都不发**。跨源拒绝要有测试（断言 HTTP 层零调用）。
2. **配对永不签发 `control`**：`/pair/redeem` 的响应里不存在 scope 授予；客户端拿到的 scopes
   一律来自 `/a0/status`（或 401/403 的 `required`），**不得**自己假设有 control。

## 6. 领域层冻结面（`Sources/Domain/`，IOS-3 实现）

**本层是跨卡"端口"之家**：IOS-4/IOS-5/IOS-6 都实现或消费这里定义的类型，所以这些名字不得改。

### 6.1 三维状态语义（**这是全卡的语义核心**）

三个维度**互相独立、不得互相顶替、不得取提升**，也**不得**把任一维度的取值映射成另一维度的词：

```swift
enum ExecutionState { case running, paused, killed, indeterminate }  // 执行状态
enum DependencyHealth { case healthy, degraded(reasons: [String]), halted, unknown } // 依赖健康
enum DataTrust { case fresh, aging, stale, expired, unknown }        // 数据可信度（复用 Staleness）
```

- **执行状态**来自 `/a0/status` 的 `state.killed/paused`（带外信号，权威）。
  `/a0/status` 拿不到 ⇒ `.indeterminate`（**不许**默认成 `.running`）。
- **依赖健康**来自 `risk-state` 卡片（`alignment`/`level` 两套词汇**不得相交**：标的级
  `aligned/unaligned/stale` vs desk 级 `normal/caution/reduce_only/halt`）。缺失 ⇒ `.unknown`。
- **数据可信度**来自 `freshness` 卡片 `age` 字段与快照自身年龄。缺失 ⇒ `.unknown`。

### 6.2 「App 看不到机器人」≠「机器人已停止」（**两种显示，硬要求**）

```swift
enum BotReachability {
  case unreachable(reason: String)     // /a0/ping 或 /v1/cards 连不上 ⇒ 「App 看不到机器人」
  case reachable
}
```

- `.unreachable` ⇒ UI 文案必须是"**看不到机器人**（连接失败/未配对）"，并且**不得**显示为"已停止"。
- `.reachable` + `ExecutionState.killed/paused` ⇒ UI 文案"**机器人已停止/已暂停**"。
- `.reachable` + `.indeterminate` ⇒ "**已连上但无法判定执行状态**"（第三种显示，不许折叠成前两种）。
- 判据只能来自**传输事实**（有没有拿到 A0 响应），**不得**从卡片文本里猜。

### 6.3 跨层端口与观测态

```swift
struct ObservationSnapshot {
  let atMs: Int; let sourceId: String; let cards: [Card]
  let reachability: BotReachability; let execution: ExecutionState
  let a0: A0Status?                       // 拿不到就是 nil，不许编
}
protocol ObservationSource: Sendable { func fetchSnapshot() async throws -> ObservationSnapshot }
protocol CommandSink: Sendable {
  func send(action: ActionKind, params: [String: String]) async throws -> CommandOutcome
}
struct CommandOutcome { let accepted: Bool; let message: String }
protocol ConfirmationGate: Sendable {
  func confirm(level: ConfirmLevel, reason: String) async -> ConfirmDecision
}
enum ConfirmDecision { case approved, denied, unavailable(reason: String) }

struct DeskObservation {                  // 观测面聚合（UI 只读这个）
  let bot: BotStatus; let positions: [PositionObservation]; let orders: [OrderObservation]
  let assets: [AssetObservation]; let alerts: [AlertObservation]; let generatedAtMs: Int
}
struct BotStatus { let reachability: BotReachability; let execution: ExecutionState
                   let dependency: DependencyHealth; let trust: DataTrust
                   let deskId: String?; let label: String? }
struct PositionObservation { let cardId: String; let symbol: String?; let side: String?
                             let quantity: String?; let entryPrice: String?; let pnl: String?
                             let fallbackText: String; let trust: DataTrust }
struct OrderObservation { let cardId: String; let symbol: String?; let side: String?; let price: String?
                          let quantity: String?; let state: String?; let fallbackText: String; let trust: DataTrust }
struct AssetObservation { let cardId: String; let label: String; let value: String; let unit: String?; let trust: DataTrust }
struct AlertObservation { let cardId: String; let severity: String; let title: String
                          let actions: [CardAction]; let operable: Bool; let fallbackText: String; let trust: DataTrust }

@MainActor @Observable final class ObservationStore {
  init(source: ObservationSource, commands: CommandSink?, clock: @escaping () -> Int)
  private(set) var observation: DeskObservation?      // nil = 还没有任何可信数据
  private(set) var lastError: String?
  func refresh() async
  func send(_ action: ActionKind, params: [String: String], gate: ConfirmationGate) async -> CommandOutcome
}
```

**字段来源（不新造端点、不改服务端语义）**：卡片 → 观测态的映射按 `(cardType, field.key)` 约定：

| 观测项 | 来源卡片 |
|---|---|
| 机器人状态 | `/a0/status`（执行状态）+ `desk-summary`（desk 标识）+ `risk-state`（依赖健康） |
| 持仓 | `position` |
| 订单 | `order` |
| 资产 | `mandate-status` 的 `limit`/`used` 等字段 + `desk-summary`（**当前契约没有独立的资产卡片类型**） |
| 告警/升级 | `escalation` `journal-gap` `system-notice` `freshness` |

`field.key` 在契约里**不是封闭枚举**，所以：认识的 key 走结构化映射，**不认识的 key 一律进
raw 字段列表原样展示**，并**绝不**推断语义。字段缺失时该观测项显示"未知"，**不许**填 0 或空串。

**契约缺口要记录，不许自己放宽**：若"资产"没有足够的字段支撑，在 README/Owning Note 里
**显式记为需要服务端补的字段**，同时 UI 保持"未知"。**不得**因此新增客户端自造的卡片类型或端点。

## 7. 界面层冻结面（`Sources/Features/`，IOS-4 实现）

五个入口（`TabView`）：**总览 / 机器人 / 资产与交易 / 告警 / 设置**。

- 只读 `ObservationStore.observation`，不自己发网络请求、不自己解析卡片 JSON。
- 每个观测项必须**同时**能表达三维语义（执行状态 / 依赖健康 / 数据可信度），
  三者分列显示，不得合并成一个"状态"。
- `DataTrust.expired` ⇒ **不渲染数据本身**，只渲染 `offlineView` 给的提示（过期/陈旧不渲染）。
- 未知 closed 枚举 ⇒ 该卡片**禁用全部 Action**，只显示 `fallbackText`（fail-closed）。
- `reachability == .unreachable` 与 `execution == .killed/.paused` 必须是**肉眼可区分的两种显示**。
- 用 SwiftUI 原生组件，不引第三方 UI 依赖；配色/间距走一处 `Theme`，不散落裸字面量。
- 生物识别闸门**只经 `ConfirmationGate` 端口**（IOS-5 实现），Features 里不直接调 LocalAuthentication。

## 8. 告警层冻结面（`Sources/Alerts/`，IOS-5 实现）

- APNs：`UNUserNotificationCenterDelegate` + 载荷校验，**未注册推送 token 也不影响观测面**。
- 推送载荷一律过 `validatePushPayload`；非法载荷**一律 drop**（不"尽力解析"）。
- 通知里的动作 = `PushAction`（∩ `ActionKind`），按下后走 `ConfirmationGate`。
- 深链只认 `parseDeeplink` 的封闭集合；未知 screen 一律拒绝。
- `ConfirmationGate` 的 `biometric` 档用 `LocalAuthentication` 实现；
  **`unavailable` 时必须 fail-closed（拒绝动作）**，不得降级为"点一下就过"。
- **生物识别不替代服务端授权与风控**：它只决定"要不要把动作发出去"，发出去之后服务端仍按
  scope 与 mandate 判。这条要写成注释 + 单测。

## 9. 离线层冻结面（`Sources/Offline/`，IOS-6 实现）

- **快照优先 + 事件续读**：重连先取 `GET /v1/cards`（快照是契约），WS 流只是优化。
- 陈旧度用 `offlineView`（过期不渲染数据本身）；本地持久化只存快照与其 `atMs`/`sourceId`。
- **断线不得清空本地最后快照**，但 `DataTrust` 必须如实降档。
- 弱网：指数退避 + 抖动，**不做无退避重试风暴**；恢复后产出 **gap report**（断连期间的错失与状态变化）。
- 性能：大量卡片更新合并（coalesce）后**一次**发布到 UI；`ObservationStore` 的刷新不得在主线程做解析。
- **iOS 后台限制**：明确写"App 在后台不得假设能保活；执行不受影响（权威态在执行核）"。

## 10. 不变量（逐条要有可执行断言，不许只写在注释里）

1. 未知 closed 枚举 ⇒ 不可操作（禁用全部 Action）。
2. 过期/陈旧数据不渲染数据本身。
3. 跨源永不混显；切换期只读。
4. 令牌只发往配对绑定 origin，跨源**连请求都不发**。
5. 配对永不签发 control；控制类动作一律 `biometric` 档且 fail-closed。
6. 生物识别不替代服务端授权与风控。
7. 「App 看不到机器人」与「机器人已停止」是两种显示。
8. 三维状态语义互不顶替；`alignment` 与 `level` 两套词汇不得相交。
9. 客户端不含交易所密钥；不依赖 bot 平面运行时包。
10. 观测面不依赖 tick 流（快照是契约）。
11. 不改服务端语义；需要契约变更时**先记录**，不得为客户端方便放宽判据。

## 11. 硬停（遇到就停下报 Lead，不要静默降级）

真钱/真实下单/放宽授权或限额/开启实盘；重启正在运行的实例或在运行中 plugin install；
改公网暴露面/证书/宿主 DSH 本体；**推送、发版、tag**；规格卡未覆盖的架构分歧；
任何"看起来可以绕过"的冲动。

## 12. 提交纪律

- 分支：`feat/native-ios-mobile`（Lead 已建）。**不切换分支**、不 rebase、不 merge。
- Conventional Commits；**只暂存你自己作用域内核对过的文件**（`git add <具体路径>`）。
- **不推送、不打 tag、不发版。**
- 提交前跑自己那条重活并留真实输出。发现工作区被其它会话改动 ⇒ 停下报 Lead，不要并写。
