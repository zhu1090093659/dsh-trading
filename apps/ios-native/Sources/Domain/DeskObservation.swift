//
//  DeskObservation.swift
//  Domain
//
//  观测面聚合（冻结件 §6.3）：**UI 只读这个**。
//
//  §6 已冻结的字段保留不改（只增不改地扩展，Lead 2026-10-02 授权）；
//  新增字段一律可选或带默认值，且每个新观测项要么能追到卡片字段、要么显式"未知"。
//

import Foundation
import Observation
import DshTradingContract

/// 一个持仓观测项。
public struct PositionObservation: Sendable {
    public let cardId: String
    public let symbol: String?
    public let side: String?
    public let quantity: String?
    public let entryPrice: String?
    public let pnl: String?
    public let fallbackText: String
    public let trust: DataTrust
    /// 只增：不认识的 field.key 原样保留（**绝不推断语义**）。
    public let rawFields: [CardField]
    /// 只增：机器人归属；不可靠时为 nil（UI 显示未知，不编数字）。
    public let attribution: String?

    public init(
        cardId: String,
        symbol: String?,
        side: String?,
        quantity: String?,
        entryPrice: String?,
        pnl: String?,
        fallbackText: String,
        trust: DataTrust,
        rawFields: [CardField] = [],
        attribution: String? = nil
    ) {
        self.cardId = cardId
        self.symbol = symbol
        self.side = side
        self.quantity = quantity
        self.entryPrice = entryPrice
        self.pnl = pnl
        self.fallbackText = fallbackText
        self.trust = trust
        self.rawFields = rawFields
        self.attribution = attribution
    }

    public func withTrust(_ trust: DataTrust) -> PositionObservation {
        PositionObservation(
            cardId: cardId, symbol: symbol, side: side, quantity: quantity,
            entryPrice: entryPrice, pnl: pnl, fallbackText: fallbackText, trust: trust,
            rawFields: rawFields, attribution: attribution
        )
    }
}

/// 一个订单观测项。state 是**原串**：订单状态机在服务端，客户端不自己映射成枚举。
public struct OrderObservation: Sendable {
    public let cardId: String
    public let symbol: String?
    public let side: String?
    public let price: String?
    public let quantity: String?
    public let state: String?
    public let fallbackText: String
    public let trust: DataTrust
    /// 只增：状态自何时起（拿不到就是 nil，UI 显示未知）。
    public let stateSinceMs: Int?
    /// 只增：已成交数量（拿不到就是 nil）。
    public let filledQuantity: String?
    /// 只增：不认识的 field.key 原样保留。
    public let rawFields: [CardField]

    public init(
        cardId: String,
        symbol: String?,
        side: String?,
        price: String?,
        quantity: String?,
        state: String?,
        fallbackText: String,
        trust: DataTrust,
        stateSinceMs: Int? = nil,
        filledQuantity: String? = nil,
        rawFields: [CardField] = []
    ) {
        self.cardId = cardId
        self.symbol = symbol
        self.side = side
        self.price = price
        self.quantity = quantity
        self.state = state
        self.fallbackText = fallbackText
        self.trust = trust
        self.stateSinceMs = stateSinceMs
        self.filledQuantity = filledQuantity
        self.rawFields = rawFields
    }

    public func withTrust(_ trust: DataTrust) -> OrderObservation {
        OrderObservation(
            cardId: cardId, symbol: symbol, side: side, price: price, quantity: quantity,
            state: state, fallbackText: fallbackText, trust: trust,
            stateSinceMs: stateSinceMs, filledQuantity: filledQuantity, rawFields: rawFields
        )
    }
}

/// 一个资产观测项。
///
/// **契约缺口（已报 Lead）**：当前 12 个封闭卡片类型里**没有独立的资产卡片**，
/// 资产只能来自 mandate-status 的 limit/used 与 desk-summary 的字段。缺口如实记录，
/// 不在客户端自造卡片类型或端点。
public struct AssetObservation: Sendable {
    public let cardId: String
    public let label: String
    public let value: String
    public let unit: String?
    public let trust: DataTrust
    /// 只增：不认识的 field.key 原样保留。
    public let rawFields: [CardField]

    public init(cardId: String, label: String, value: String, unit: String?, trust: DataTrust, rawFields: [CardField] = []) {
        self.cardId = cardId
        self.label = label
        self.value = value
        self.unit = unit
        self.trust = trust
        self.rawFields = rawFields
    }

    public func withTrust(_ trust: DataTrust) -> AssetObservation {
        AssetObservation(cardId: cardId, label: label, value: value, unit: unit, trust: trust, rawFields: rawFields)
    }
}

/// 一个告警/升级观测项。§6 字段保留，只增详情字段（全部可选，拿不到就是 nil）。
public struct AlertObservation: Sendable {
    public let cardId: String
    public let severity: String
    public let title: String
    public let actions: [CardAction]
    public let operable: Bool
    public let fallbackText: String
    public let trust: DataTrust

    /// 只增（IOS-4 要求）：告警闭环需要的详情字段，全部可选。
    public let firstSeenMs: Int?
    public let lastSeenMs: Int?
    public let recoveredAtMs: Int?
    public let repeatCount: Int?
    public let readAtMs: Int?
    public let acknowledgedAtMs: Int?
    public let recovered: Bool?
    public let relatedBotId: String?
    public let relatedAccountId: String?
    public let relatedOrderId: String?
    public let reason: String?
    public let impact: String?
    /// 只增：不认识的 field.key 原样保留。
    public let rawFields: [CardField]

    public init(
        cardId: String,
        severity: String,
        title: String,
        actions: [CardAction],
        operable: Bool,
        fallbackText: String,
        trust: DataTrust,
        firstSeenMs: Int? = nil,
        lastSeenMs: Int? = nil,
        recoveredAtMs: Int? = nil,
        repeatCount: Int? = nil,
        readAtMs: Int? = nil,
        acknowledgedAtMs: Int? = nil,
        recovered: Bool? = nil,
        relatedBotId: String? = nil,
        relatedAccountId: String? = nil,
        relatedOrderId: String? = nil,
        reason: String? = nil,
        impact: String? = nil,
        rawFields: [CardField] = []
    ) {
        self.cardId = cardId
        self.severity = severity
        self.title = title
        self.actions = actions
        self.operable = operable
        self.fallbackText = fallbackText
        self.trust = trust
        self.firstSeenMs = firstSeenMs
        self.lastSeenMs = lastSeenMs
        self.recoveredAtMs = recoveredAtMs
        self.repeatCount = repeatCount
        self.readAtMs = readAtMs
        self.acknowledgedAtMs = acknowledgedAtMs
        self.recovered = recovered
        self.relatedBotId = relatedBotId
        self.relatedAccountId = relatedAccountId
        self.relatedOrderId = relatedOrderId
        self.reason = reason
        self.impact = impact
        self.rawFields = rawFields
    }

    public func withTrust(_ trust: DataTrust) -> AlertObservation {
        AlertObservation(
            cardId: cardId, severity: severity, title: title, actions: actions, operable: operable,
            fallbackText: fallbackText, trust: trust, firstSeenMs: firstSeenMs, lastSeenMs: lastSeenMs,
            recoveredAtMs: recoveredAtMs, repeatCount: repeatCount, readAtMs: readAtMs,
            acknowledgedAtMs: acknowledgedAtMs, recovered: recovered, relatedBotId: relatedBotId,
            relatedAccountId: relatedAccountId, relatedOrderId: relatedOrderId, reason: reason,
            impact: impact, rawFields: rawFields
        )
    }
}

/// 只增：事件时间线的一项（IOS-4 要求）。
public struct EventObservation: Sendable, Hashable {
    public let atMs: Int
    public let kind: String
    public let title: String
    public let detail: String?

    public init(atMs: Int, kind: String, title: String, detail: String?) {
        self.atMs = atMs
        self.kind = kind
        self.title = title
        self.detail = detail
    }
}

/// 只增：资产汇总（IOS-4 要求）。**每个字段拿不到就是 nil，UI 显示"未知"，不填 0。**
public struct AssetsSummaryObservation: Sendable {
    public let currency: String?
    public let equity: String?
    public let available: String?
    public let margin: String?
    public let realizedPnl: String?
    public let unrealizedPnl: String?
    public let costs: [AssetObservation]

    public init(
        currency: String? = nil,
        equity: String? = nil,
        available: String? = nil,
        margin: String? = nil,
        realizedPnl: String? = nil,
        unrealizedPnl: String? = nil,
        costs: [AssetObservation] = []
    ) {
        self.currency = currency
        self.equity = equity
        self.available = available
        self.margin = margin
        self.realizedPnl = realizedPnl
        self.unrealizedPnl = unrealizedPnl
        self.costs = costs
    }
}

/// 只增：成交观测（IOS-4 要求）。**当前卡片面拿不到** ⇒ 缺口，默认空数组。
public struct FillObservation: Sendable {
    public let cardId: String
    public let symbol: String?
    public let side: String?
    public let quantity: String?
    public let price: String?
    public let atMs: Int?
    public let botId: String?
    public let trust: DataTrust

    public init(cardId: String, symbol: String?, side: String?, quantity: String?, price: String?, atMs: Int?, botId: String?, trust: DataTrust) {
        self.cardId = cardId
        self.symbol = symbol
        self.side = side
        self.quantity = quantity
        self.price = price
        self.atMs = atMs
        self.botId = botId
        self.trust = trust
    }
}

/// 只增：资金变动观测（IOS-4 要求）。**当前卡片面拿不到** ⇒ 缺口，默认空数组。
public struct CashMovementObservation: Sendable {
    public let cardId: String
    public let label: String
    public let amount: String?
    public let unit: String?
    public let atMs: Int?
    public let trust: DataTrust

    public init(cardId: String, label: String, amount: String?, unit: String?, atMs: Int?, trust: DataTrust) {
        self.cardId = cardId
        self.label = label
        self.amount = amount
        self.unit = unit
        self.atMs = atMs
        self.trust = trust
    }
}

/// 只增：设置页的连接与设备只读面（IOS-4 要求）。由 App 层从 Transport 事实装配。
public struct ConnectionObservation: Sendable {
    public let originLabel: String?
    public let link: MonitorLinkState
    public let scopes: [ScopePlane]
    public let deviceLabel: String?
    public let apiMajor: Int?
    public let apiMinor: Int?
    public let caps: [String]

    public init(
        originLabel: String? = nil,
        link: MonitorLinkState = .down,
        scopes: [ScopePlane] = [],
        deviceLabel: String? = nil,
        apiMajor: Int? = nil,
        apiMinor: Int? = nil,
        caps: [String] = []
    ) {
        self.originLabel = originLabel
        self.link = link
        self.scopes = scopes
        self.deviceLabel = deviceLabel
        self.apiMajor = apiMajor
        self.apiMinor = apiMinor
        self.caps = caps
    }
}

/// 只增：未知卡片类型的观测项。
///
/// 为什么必须有：驾驶舱的实测教训 —— 协议层做到了"未知卡片不可操作而不是丢弃"，
/// 但界面按 cardType 分块过滤时把它**在 UI 层丢掉了**，于是"服务端说了有新东西、
/// 客户端装作没有"变成了事实上的静默丢弃。不丢弃的保证必须在聚合层就成立。
public struct UnrecognizedCardObservation: Sendable {
    public let cardId: String
    public let cardType: String
    /// 卡片重绘版本。**Double 而不是 Int**：TS 侧只要求"有限非负数"，
    /// 服务端理论上可发 3.5；用 Int 解码会让整页解码失败（IOS-1/Lead 裁决）。
    /// **不许 Int(...) 截断** —— 那会把 3.5 变成 3，反而制造与契约的分歧。
    public let revision: Double
    public let fallbackText: String
    public let rawFields: [CardField]
    public let reason: String

    public init(cardId: String, cardType: String, revision: Double, fallbackText: String, rawFields: [CardField], reason: String) {
        self.cardId = cardId
        self.cardType = cardType
        self.revision = revision
        self.fallbackText = fallbackText
        self.rawFields = rawFields
        self.reason = reason
    }
}

/// 机器人状态。§6 的六个字段保留；新增字段一律带默认值（只增不改）。
public struct BotStatus: Sendable {
    public let reachability: BotReachability
    public let execution: ExecutionState
    public let dependency: DependencyHealth
    public let trust: DataTrust
    public let deskId: String?
    public let label: String?

    /// 只增：身份三件套（稳定身份 / 策略版本 / 运行实例），拿不到就是 nil。
    public let identity: BotIdentity?
    public let strategyVersion: StrategyVersion?
    public let run: RunInstance?
    /// 只增：当前阶段与等待原因（拿不到就是 nil，UI 显示未知）。
    public let phase: String?
    public let waitReason: String?
    /// 只增：三维结论（执行/依赖/可信度 + verdict）。
    public let assessment: ObservationAssessment?
    /// 只增：最后一次**确认运行正常**的时间。未知态下这是唯一能给用户的锚点。
    public let lastConfirmedHealthyAtMs: Int?

    public init(
        reachability: BotReachability,
        execution: ExecutionState,
        dependency: DependencyHealth,
        trust: DataTrust,
        deskId: String?,
        label: String?,
        identity: BotIdentity? = nil,
        strategyVersion: StrategyVersion? = nil,
        run: RunInstance? = nil,
        phase: String? = nil,
        waitReason: String? = nil,
        assessment: ObservationAssessment? = nil,
        lastConfirmedHealthyAtMs: Int? = nil
    ) {
        self.reachability = reachability
        self.execution = execution
        self.dependency = dependency
        self.trust = trust
        self.deskId = deskId
        self.label = label
        self.identity = identity
        self.strategyVersion = strategyVersion
        self.run = run
        self.phase = phase
        self.waitReason = waitReason
        self.assessment = assessment
        self.lastConfirmedHealthyAtMs = lastConfirmedHealthyAtMs
    }

    public func with(
        reachability: BotReachability? = nil,
        execution: ExecutionState? = nil,
        dependency: DependencyHealth? = nil,
        trust: DataTrust? = nil,
        assessment: ObservationAssessment? = nil,
        lastConfirmedHealthyAtMs: Int? = nil
    ) -> BotStatus {
        BotStatus(
            reachability: reachability ?? self.reachability,
            execution: execution ?? self.execution,
            dependency: dependency ?? self.dependency,
            trust: trust ?? self.trust,
            deskId: deskId,
            label: label,
            identity: identity,
            strategyVersion: strategyVersion,
            run: run,
            phase: phase,
            waitReason: waitReason,
            assessment: assessment ?? self.assessment,
            lastConfirmedHealthyAtMs: lastConfirmedHealthyAtMs ?? self.lastConfirmedHealthyAtMs
        )
    }
}

/// 观测面聚合（UI 只读这个）。
public struct DeskObservation: Sendable {
    public let bot: BotStatus
    public let positions: [PositionObservation]
    public let orders: [OrderObservation]
    public let assets: [AssetObservation]
    public let alerts: [AlertObservation]
    public let generatedAtMs: Int

    /// 只增：多机器人健康分布（首个与 bot 同源）。
    public let bots: [BotStatus]
    /// 只增：最近关键事件 / 运行时间线。
    public let events: [EventObservation]
    /// 只增：资产汇总。
    public let assetsSummary: AssetsSummaryObservation?
    /// 只增：成交（当前卡片面拿不到 ⇒ 缺口，默认空）。
    public let fills: [FillObservation]
    /// 只增：资金变动（当前卡片面拿不到 ⇒ 缺口，默认空）。
    public let cashMovements: [CashMovementObservation]
    /// 只增：设置页连接与设备只读面。
    public let connection: ConnectionObservation?
    /// 只增：本客户端不认识的卡片类型 —— **不丢弃**，原样列出。
    public let unrecognizedCards: [UnrecognizedCardObservation]
    /// 只增：快照来源（两种部署形态不得混显）。
    public let sourceId: String

    public init(
        bot: BotStatus,
        positions: [PositionObservation],
        orders: [OrderObservation],
        assets: [AssetObservation],
        alerts: [AlertObservation],
        generatedAtMs: Int,
        bots: [BotStatus] = [],
        events: [EventObservation] = [],
        assetsSummary: AssetsSummaryObservation? = nil,
        fills: [FillObservation] = [],
        cashMovements: [CashMovementObservation] = [],
        connection: ConnectionObservation? = nil,
        unrecognizedCards: [UnrecognizedCardObservation] = [],
        sourceId: String = ""
    ) {
        self.bot = bot
        self.positions = positions
        self.orders = orders
        self.assets = assets
        self.alerts = alerts
        self.generatedAtMs = generatedAtMs
        self.bots = bots
        self.events = events
        self.assetsSummary = assetsSummary
        self.fills = fills
        self.cashMovements = cashMovements
        self.connection = connection
        self.unrecognizedCards = unrecognizedCards
        self.sourceId = sourceId
    }

    /// 只增：换一个 bot 状态（ObservationStore 用来回填"最后确认运行正常的时间"）。
    public func replacingBot(_ bot: BotStatus) -> DeskObservation {
        DeskObservation(
            bot: bot,
            positions: positions,
            orders: orders,
            assets: assets,
            alerts: alerts,
            generatedAtMs: generatedAtMs,
            bots: bots.isEmpty ? [bot] : [bot],
            events: events,
            assetsSummary: assetsSummary,
            fills: fills,
            cashMovements: cashMovements,
            connection: connection,
            unrecognizedCards: unrecognizedCards,
            sourceId: sourceId
        )
    }

    /// 刷新失败时用：**不清空最后快照，但可信度如实降档**（冻结件 §9）。
    public func downgraded(reason: String) -> DeskObservation {
        let botStatus = bot.with(
            reachability: .unreachable(reason: reason),
            execution: .indeterminate,
            trust: .unknown
        )
        return DeskObservation(
            bot: botStatus,
            positions: positions.map { $0.withTrust(.unknown) },
            orders: orders.map { $0.withTrust(.unknown) },
            assets: assets.map { $0.withTrust(.unknown) },
            alerts: alerts.map { $0.withTrust(.unknown) },
            generatedAtMs: generatedAtMs,
            bots: bots.map { $0.with(trust: .unknown) },
            events: events,
            assetsSummary: assetsSummary,
            fills: fills,
            cashMovements: cashMovements,
            connection: connection,
            unrecognizedCards: unrecognizedCards,
            sourceId: sourceId
        )
    }
}

/// 观测态存储（冻结件 §6.3）。
///
/// 观测面**不依赖 tick 流**：它的全部状态来自 ObservationSource 的快照。
/// 刷新失败时**不清空**最后一次快照，但三维语义如实降档。
@MainActor
@Observable
public final class ObservationStore {
    private let source: ObservationSource
    private let commands: CommandSink?
    private let clock: () -> Int

    /// nil = 还没有任何可信数据。
    public private(set) var observation: DeskObservation?
    public private(set) var lastError: String?
    /// 最后一次**确认运行正常**的时间（未知态下给用户的唯一锚点）。
    public private(set) var lastConfirmedHealthyAtMs: Int?

    public init(source: ObservationSource, commands: CommandSink?, clock: @escaping () -> Int) {
        self.source = source
        self.commands = commands
        self.clock = clock
    }

    public func refresh() async {
        do {
            let snapshot = try await source.fetchSnapshot()
            let nowMs = clock()
            // 冻结件 §9：解析不在主线程做，只有赋值回到 MainActor。
            var mapped = await DeskMapper.mapOffMain(snapshot: snapshot, nowMs: nowMs)
            // 只有真的观测到"业务正常"才更新确认时间：心跳正常不算。
            if mapped.bot.assessment?.health.businessHealthy == true {
                lastConfirmedHealthyAtMs = nowMs
            }
            mapped = mapped.replacingBot(mapped.bot.with(lastConfirmedHealthyAtMs: lastConfirmedHealthyAtMs))
            observation = mapped
            lastError = nil
        } catch {
            let reason = String(describing: error)
            lastError = reason
            if let current = observation {
                observation = current.downgraded(reason: reason)
            }
        }
    }

    /// 下发动作：**先过确认闸门，闸门不可用即 fail-closed**。
    public func send(_ action: ActionKind, params: [String: String], gate: ConfirmationGate) async -> CommandOutcome {
        guard let commands else {
            return CommandOutcome(accepted: false, message: "未配置命令通道")
        }
        let decision = await gate.confirm(level: confirmLevel(for: action), reason: action.rawValue)
        switch decision {
        case .approved:
            break
        case .denied:
            return CommandOutcome(accepted: false, message: "已取消")
        case let .unavailable(reason):
            // 确认手段不可用 ⇒ 绝不降级为"点一下就过"（冻结件 §8/§10.5）。
            return CommandOutcome(accepted: false, message: "确认不可用（fail-closed）：" + reason)
        }
        do {
            return try await commands.send(action: action, params: params)
        } catch {
            return CommandOutcome(accepted: false, message: String(describing: error))
        }
    }
}
