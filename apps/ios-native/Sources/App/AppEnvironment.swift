import Foundation
import Observation
import DshTradingAlerts
import DshTradingContract
import DshTradingDomain
import DshTradingFeatures
import DshTradingOffline
import DshTradingTransport

/// App 组合根：把 Contract 的判据、Transport 的 /v1 与 A0 通道、Offline 的快照源、Domain 的观测态、
/// Features 的呈现面、Alerts 的确认闸门装成一条流水。
///
/// 三条纪律只落在这里（别的层都不该有）：
///   * 只有 App 能同时 import 所有层（分层 framework 已把这条变成编译期事实）；
///   * 客户端**唯一**允许自造的 id 是 `clientRequestId`（幂等键，契约明文「可见可重试」）；
///     **orderId 永不自造** —— ids.ts 的语义不下沉到客户端；
///   * 未配对就是未配对：没有令牌就不建 api client（`TransportSession.apiClient()` 返回 nil），
///     也不发匿名请求。
///
/// 写作用域：apps/ios-native/Sources/App/**（IOS-1）
@MainActor
@Observable
public final class AppEnvironment {
    /// 观测数据来源方式。fixtures 让"没有真实 bot 也能跑起来"（组合根仍走同一条离线/领域流水）。
    public enum Mode: String, Sendable {
        case live
        case fixtures
    }

    public let mode: Mode
    public let session: TransportSession?
    public let gate: any ConfirmationGate
    /// **致命**环境故障（连内存回退都建不起来）。非 nil 时界面只显示它，不假装能工作。
    public let environmentProblem: String?
    /// **可继续**的环境告警（如 Keychain 不可用、退回内存存储）。界面显示它，但**不挡**观测面：
    /// fixtures 模式根本不需要令牌，live 模式也仍可走完配对（令牌只活在本进程内，重启重新配对即可）。
    public let environmentWarning: String?

    public private(set) var sessionState: TransportSessionState = .unpaired
    public private(set) var store: ObservationStore?
    public private(set) var dispatcher: StoreActionDispatcher?
    public private(set) var pairingMessage: String?
    public private(set) var pairingBusy = false

    private let clock: @Sendable () -> Int
    private let persistence = InMemorySnapshotPersistence()

    /// 陈旧度预算（契约只定义分档，具体毫秒数由客户端定；这里是观测端的默认值）。
    public static let stalenessBudget = StalenessBudget(freshMs: 30_000, staleMs: 5 * 60_000, ttlMs: 30 * 60_000)

    /// IOS-3 报的契约缺口：呈现面把它们如实显示为"缺口"，而不是猜一个值。
    public static let contractGaps: [String] = [
        "field.key 未冻结：只认识的 key 走结构化映射，其余原样列出",
        "资产没有独立卡片类型（由 mandate-status / desk-summary 拼出）",
        "成交/资金变动/事件/订单 stateSince/等待原因在卡片面与 A0 面都拿不到",
    ]

    public static func launchMode(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Mode {
        if arguments.contains("--fixtures") || environment["DSH_IOS_FIXTURES"] == "1" { return .fixtures }
        return .live
    }

    public init(mode: Mode) {
        self.mode = mode
        self.clock = { Int(Date().timeIntervalSince1970 * 1000) }
        self.gate = AlertsConfirmationGate(biometrics: LocalAuthenticationBiometrics())
        let provider = AppEnvironment.makeTokenProvider()
        self.session = provider.keychain.map { TransportSession(tokens: $0) }
        self.environmentProblem = provider.fatal
        self.environmentWarning = provider.warning
        if let session { sessionState = session.state() }
        rebuildStore()
    }

    /// 令牌提供者：优先 Keychain；不可用才退回内存，并把**原始错误（含 OSStatus）**一起报出来 ——
    /// 否则"Keychain 不可用"是一句无法定位的断言（缺 entitlement 时是 errSecMissingEntitlement -34018）。
    /// **绝不**为了"能跑"把设备令牌写进 UserDefaults/文件（那等于把凭据降级成明文）。
    static func makeTokenProvider() -> (keychain: KeychainTokenProvider?, warning: String?, fatal: String?) {
        do {
            return (try KeychainTokenProvider(store: KeychainSecureStore()), nil, nil)
        } catch {
            let detail = String(describing: error)
            do {
                return (
                    try KeychainTokenProvider(store: InMemorySecureStore()),
                    "安全存储（Keychain）不可用（" + detail + "）：本次运行的设备令牌只放在内存里，重启需重新配对。",
                    nil
                )
            } catch {
                return (nil, nil, "安全存储与内存回退都不可用（" + detail + "），App 无法保存设备令牌。")
            }
        }
    }

    // MARK: - 装配

    private func rebuildStore() {
        guard let session else {
            store = nil
            dispatcher = nil
            return
        }
        switch mode {
        case .fixtures:
            let source = OfflineObservationSource(
                fetcher: FixtureSnapshotFetcher(clock: clock),
                persistence: persistence,
                sourceId: "fixtures",
                budget: AppEnvironment.stalenessBudget,
                clock: clock
            )
            let store = ObservationStore(source: source, commands: nil, clock: clock)
            self.store = store
            self.dispatcher = StoreActionDispatcher(store: store, gate: gate)
        case .live:
            guard let client = session.apiClient() else {
                store = nil
                dispatcher = nil
                return
            }
            let source = OfflineObservationSource(
                fetcher: TransportSnapshotFetcher(client: client, clock: clock),
                persistence: persistence,
                sourceId: "live",
                budget: AppEnvironment.stalenessBudget,
                clock: clock
            )
            let store = ObservationStore(source: source, commands: StoreCommandSink(client: client), clock: clock)
            self.store = store
            self.dispatcher = StoreActionDispatcher(store: store, gate: gate)
        }
    }

    // MARK: - 会话动作

    public func nowMs() -> Int { clock() }

    public var runtimeMode: RuntimeMode {
        mode == .fixtures ? .simulated : .unknown
    }

    /// 能不能进观测面。**告警不算故障**：Keychain 退回内存只影响"重启后要不要重新配对"，
    /// 不该把 fixtures 模式（根本不需要令牌）一起挡在门外（IOS-3 在模拟器上实测到过这个缺陷）。
    public var isObserving: Bool {
        if environmentProblem != nil { return false }
        if mode == .fixtures { return store != nil }
        return sessionState.isPaired && store != nil
    }

    public func refresh() async {
        await store?.refresh()
    }

    public func pair(baseURL: String, code: String, name: String) async {
        guard let session else {
            pairingMessage = "环境未就绪：" + (environmentProblem ?? environmentWarning ?? "未知原因")
            return
        }
        pairingBusy = true
        pairingMessage = nil
        defer { pairingBusy = false }
        do {
            let outcome = try await session.pairingClient().pair(baseURL: baseURL, code: code, name: name)
            sessionState = session.state()
            rebuildStore()
            // 配对**不做授权**：服务端如实回报的 deniedScopes 只是诊断信息，作用域只认 /a0/status。
            let denied = outcome.deniedScopes.isEmpty ? "" : "（服务端未签发的平面：" + outcome.deniedScopes.joined(separator: ",") + "）"
            pairingMessage = "已配对" + denied
        } catch {
            pairingMessage = "配对失败：" + String(describing: error)
        }
    }

    public func unpair() {
        session?.forget()
        sessionState = session?.state() ?? .unpaired
        rebuildStore()
    }
}

/// 动作派发：Features 只描述意图，真正的确认闸门与下发都在这里。
@MainActor
public final class StoreActionDispatcher: FeatureActionDispatching {
    private let store: ObservationStore
    private let gate: any ConfirmationGate

    public init(store: ObservationStore, gate: any ConfirmationGate) {
        self.store = store
        self.gate = gate
    }

    public func dispatch(_ action: ActionPresentation) async -> FeatureDispatchOutcome {
        guard let kind = ActionKind(rawValue: action.kind) else {
            // 呈现面已经把未知动作渲染成不可操作；这里再 fail-closed 一次，绝不放行。
            return FeatureDispatchOutcome(accepted: false, message: "本客户端不认识这个动作，已禁用：" + action.kind)
        }
        let outcome = await store.send(kind, params: [:], gate: gate)
        return FeatureDispatchOutcome(accepted: outcome.accepted, message: outcome.message)
    }
}

/// Transport → Domain 的命令端口适配。
public struct StoreCommandSink: CommandSink {
    private let client: any ObservationTransport

    public init(client: any ObservationTransport) {
        self.client = client
    }

    public func send(action: ActionKind, params: [String: String]) async throws -> CommandOutcome {
        // 客户端唯一允许自造的 id：幂等键 clientRequestId（契约明文可见、可重试）。
        let clientRequestId = "req_" + UUID().uuidString.lowercased()
        let receipt = try await client.command(action: action, params: params, clientRequestId: clientRequestId)
        return CommandOutcome(accepted: true, message: StoreCommandSink.describe(receipt: receipt))
    }

    /// 回执的**完整**语义由服务端契约定义；这里只读一个服务端明确给出的字段（replayed），
    /// 不解释别的、也不猜成功。
    static func describe(receipt: Data) -> String {
        guard let object = (try? JSONSerialization.jsonObject(with: receipt)) as? [String: Any] else {
            return "命令已下发（回执 " + String(receipt.count) + " 字节，未能按 JSON 解析）"
        }
        if object["replayed"] as? Bool == true { return "命令已下发（服务端去重命中，未重复执行）" }
        return "命令已下发（服务端已受理）"
    }
}

/// Transport → Offline 的快照抓取适配（IOS-3 裁决：放 App，让 Offline 保持零 Transport 依赖）。
///
/// 契约（Offline 侧写死的）：
///   * 先 ping（"看不看得见机器人"的唯一判据）；ping 不到 ⇒ 抛 .unreachable；
///   * cards 失败按 TransportError.kind 分类抛；
///   * /a0/status 拿不到就传 nil（**不许编一个 running**）；
///   * 抛非 ObservationFetchFailure 的错误会被 Offline 当成 .unknown 且不重试（fail-closed）。
public struct TransportSnapshotFetcher: SnapshotFetching {
    private let client: any ObservationTransport
    private let clock: @Sendable () -> Int

    public init(client: any ObservationTransport, clock: @escaping @Sendable () -> Int) {
        self.client = client
        self.clock = clock
    }

    public func fetch() async throws -> FetchedSnapshot {
        let reachable: Bool
        do {
            reachable = try await client.ping()
        } catch {
            throw ObservationFetchFailure(failure: .unreachable, message: String(describing: error))
        }
        guard reachable else {
            throw ObservationFetchFailure(failure: .unreachable, message: "机器人没有回应心跳（/a0/ping）")
        }

        let page: CardsPage
        do {
            page = try await client.cards(clientCaps: TransportHandshake.clientCaps)
        } catch let error as TransportError {
            throw ObservationFetchFailure(failure: TransportSnapshotFetcher.category(error.kind), message: String(describing: error))
        } catch {
            throw ObservationFetchFailure(failure: .unknown, message: String(describing: error))
        }

        // 拿不到 A0 状态 ⇒ nil：Domain 侧据此判 .indeterminate，绝不默认成"在跑"。
        let a0 = try? await client.a0Status()
        return FetchedSnapshot(
            cards: page.cards,
            caps: page.caps,
            downgraded: page.downgraded,
            truncated: page.truncated,
            a0: a0,
            atMs: clock()
        )
    }

    /// 穷尽 switch（无 default）：TransportErrorKind 只增不减，新增类别时这里**必须**显式决定映射。
    static func category(_ kind: TransportErrorKind) -> FetchFailure {
        switch kind {
        case .originNotBound: return .originNotBound
        case .unreachable: return .unreachable
        case .badResponse: return .badResponse
        case .unauthorized: return .unauthorized
        case .scopeRequired: return .scopeRequired
        case .clientTooOld: return .clientTooOld
        }
    }
}

/// 没有真实 bot 时的夹具源：让"打不开 App"不再是验收入口的前提。
/// 它走的是**同一条**离线/领域流水（不是另写一条假路径）。
public struct FixtureSnapshotFetcher: SnapshotFetching {
    private let clock: @Sendable () -> Int

    public init(clock: @escaping @Sendable () -> Int) {
        self.clock = clock
    }

    public func fetch() async throws -> FetchedSnapshot {
        let now = clock()
        let cards: [Card] = [
            Card(
                cardId: "desk-1", cardType: "desk-summary", revision: 1, fallbackText: "交易台：运行中（夹具）",
                fields: [
                    CardField(key: "deskId", label: "交易台", kind: "symbol", value: "fixture-desk"),
                    CardField(key: "state", label: "状态", kind: "status", value: "running"),
                ],
                actions: [], freshnessMs: 1_000
            ),
            Card(
                cardId: "risk-1", cardType: "risk-state", revision: 1, fallbackText: "风险：正常（夹具）",
                fields: [
                    CardField(key: "level", label: "档位", kind: "enum", value: "normal", values: ["normal", "caution", "reduce_only", "halt"]),
                    CardField(key: "alignment", label: "对齐", kind: "enum", value: "aligned", values: ["aligned", "unaligned", "stale"]),
                ],
                actions: [], freshnessMs: 1_000
            ),
            Card(
                cardId: "pos-1", cardType: "position", revision: 1, fallbackText: "持仓：BTC 0.5（夹具）",
                fields: [
                    CardField(key: "symbol", label: "标的", kind: "symbol", value: "BTC/USDT"),
                    CardField(key: "quantity", label: "数量", kind: "number", value: "0.5"),
                    CardField(key: "pnl", label: "浮盈", kind: "currency", value: "+120.50"),
                ],
                actions: [CardAction(kind: "open-detail", label: "详情")], freshnessMs: 1_000
            ),
            Card(
                cardId: "future-1", cardType: "future-card-type", revision: 1, fallbackText: "这张卡需要更新的客户端（夹具）",
                fields: [CardField(key: "unknown", label: "未知", kind: "future-kind", value: "x")],
                actions: [CardAction(kind: "future-action", label: "?")], freshnessMs: 1_000
            ),
        ]
        let a0 = A0Status(
            ok: true,
            state: KillState(killed: false, paused: false, reason: "fixtures", atMs: now),
            device: "fixture-device",
            scopes: [.read]
        )
        return FetchedSnapshot(
            cards: cards,
            caps: TransportHandshake.clientCaps,
            downgraded: [],
            truncated: false,
            a0: a0,
            atMs: now
        )
    }
}
