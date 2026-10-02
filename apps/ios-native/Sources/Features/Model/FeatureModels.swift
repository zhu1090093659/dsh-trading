//
//  FeatureModels.swift
//  Features
//
//  呈现层模型（presentation models）。**不是领域模型**：这里只承载「已经决定怎么显示」的东西
//  —— 标签、色调、是否可渲染、动作是否禁用。领域语义（执行/依赖/可信度、fail-closed 判定）
//  一律在 Domain 与 Contract 里做，Features 只把它翻译成 { 标签, 色调 }。
//
//  为什么要这一层：
//    1. 视图可以用**夹具**渲染（快照证据不需要网络、不需要 mock 领域逻辑）；
//    2. 三维语义在类型上就分列（每个观测项都带 axes），不会出现「某页面漏了可信度」；
//    3. Domain 字段还在演进时，改动只在 Adapter 一处。
//
//  硬约束（对应冻结件 §7）：
//    * 每一项都带 axes（执行/依赖/可信度）—— 三维**分列**，不合并成一个「状态」；
//    * rendersData == false ⇒ 视图只渲染 notice，**不渲染数据本身**；
//    * 未知 closed 枚举 ⇒ 动作 enabled == false 且只显示 fallbackText。
//

import Foundation

// MARK: - 运行形态（实盘 / 模拟）—— 视觉与操作语义必须永远不同

public enum RuntimeMode: String, Sendable, Hashable, CaseIterable {
    case live
    case simulated
    case unknown

    public var label: String {
        switch self {
        case .live: return "实盘"
        case .simulated: return "模拟盘"
        case .unknown: return "形态未知"
        }
    }

    /// 图标在三档里必须不同 —— 只靠颜色区分在灰度/色觉障碍下会失效。
    public var systemImage: String {
        switch self {
        case .live: return "exclamationmark.triangle.fill"
        case .simulated: return "testtube.2"
        case .unknown: return "questionmark.circle"
        }
    }

    public var tone: ThemeTone {
        switch self {
        case .live: return .live
        case .simulated: return .simulated
        case .unknown: return .unknown
        }
    }

    /// 操作语义也要不同：实盘上的破坏性动作需要额外一句「这是真实资金」。
    public var destructiveWarning: String? {
        switch self {
        case .live: return "这是实盘账户：动作会影响真实资金。"
        case .simulated: return "这是模拟盘：动作不会影响真实资金。"
        case .unknown: return "无法确认这是实盘还是模拟盘 —— 请先在设置里确认连接。"
        }
    }
}

// MARK: - 三维语义（每个观测项都必须分列表达）

/// 一个维度的一行呈现。
public struct AxisPresentation: Sendable, Hashable {
    public let title: String
    public let value: String
    public let tone: ThemeTone
    public let systemImage: String
    public let detail: String?

    public init(title: String, value: String, tone: ThemeTone, systemImage: String, detail: String? = nil) {
        self.title = title
        self.value = value
        self.tone = tone
        self.systemImage = systemImage
        self.detail = detail
    }
}

/// 三维**分列**呈现。任何观测项都要带这个，视图不得把它们合成一句「状态」。
public struct StateAxesPresentation: Sendable, Hashable {
    public let execution: AxisPresentation
    public let dependency: AxisPresentation
    public let trust: AxisPresentation

    public init(execution: AxisPresentation, dependency: AxisPresentation, trust: AxisPresentation) {
        self.execution = execution
        self.dependency = dependency
        self.trust = trust
    }

    public var all: [AxisPresentation] { [execution, dependency, trust] }
}

// MARK: - 机器人状态（「看不见」与「已停止」是两种显示）

/// 机器人呈现状态。**case 的分法就是防折叠的实现**：
///   * .unreachable = App 看不到机器人（传输层拿不到数据）；
///   * .stoppedConfirmed = 确认机器人已停止；
///   * .unknownStale / .neverConfirmed / .unrecognizedExecutionState = 已连上但无法判定。
/// 三者互不折叠。
public enum BotStateKind: String, Sendable, Hashable, CaseIterable {
    case starting
    case operational
    case runningRestricted
    case paused
    case stopping
    case stoppedConfirmed
    case faulted
    case unknownDisconnected
    case unknownStale
    case neverConfirmed
    /// 已连上、也拿到了数据，但拿不到权威执行信号（/a0/status）—— 第三种显示。
    case indeterminateExecution
    case unrecognizedExecutionState
    case unreachable

    public var label: String {
        switch self {
        case .starting: return "启动中"
        case .operational: return "运行中"
        case .runningRestricted: return "运行中（受限）"
        case .paused: return "已暂停"
        case .stopping: return "停止中"
        case .stoppedConfirmed: return "已停止"
        case .faulted: return "故障"
        case .unknownDisconnected: return "看不到机器人（连接中断）"
        case .unknownStale: return "状态未知（数据过期）"
        case .neverConfirmed: return "状态尚未确认"
        case .indeterminateExecution: return "已连上但无法判定执行状态"
        case .unrecognizedExecutionState: return "无法识别运行状态"
        case .unreachable: return "看不到机器人（连接失败/未配对）"
        }
    }

    /// 给用户的下一句：为什么是这个状态、能做什么。
    public var explanation: String {
        switch self {
        case .starting: return "机器人正在启动，尚未进入可运行状态。"
        case .operational: return "执行状态正常，依赖健康，允许新增风险。"
        case .runningRestricted: return "机器人仍在运行，但依赖异常、已禁止新增仓位 —— 这与「已停止」不是一回事。"
        case .paused: return "机器人被暂停在带外信号上；恢复前不会新增风险。"
        case .stopping: return "正在停止；期间不会有新的风险动作。"
        case .stoppedConfirmed: return "执行核确认机器人已停止。"
        case .faulted: return "机器人进入故障态；需要人工处置。"
        case .unknownDisconnected: return "App 与监控服务连接中断，此刻无法确认机器人状态。"
        case .unknownStale: return "手里这份数据已过期，不足以判断机器人现在在做什么。"
        case .neverConfirmed: return "还没有拿到过可信状态，不要按「已停止」理解。"
        case .indeterminateExecution: return "连接正常，但没有拿到权威执行信号（/a0/status）—— 不能默认成「运行中」，也不能说成「已停止」。"
        case .unrecognizedExecutionState: return "服务端返回了本客户端不认识的执行状态；请升级客户端。"
        case .unreachable: return "App 联系不上监控服务或尚未配对 —— 这是「看不到」，不是「已停止」。"
        }
    }

    public var tone: ThemeTone {
        switch self {
        case .operational: return .positive
        case .starting, .stopping: return .info
        case .runningRestricted: return .warning
        case .paused: return .warning
        case .faulted: return .critical
        case .stoppedConfirmed: return .neutral
        case .unknownDisconnected, .unreachable, .unknownStale, .neverConfirmed, .indeterminateExecution, .unrecognizedExecutionState: return .unknown
        }
    }

    public var systemImage: String {
        switch self {
        case .starting: return "hourglass"
        case .operational: return "circle.fill"
        case .runningRestricted: return "exclamationmark.shield.fill"
        case .paused: return "pause.circle.fill"
        case .stopping: return "stop.circle"
        case .stoppedConfirmed: return "stop.circle.fill"
        case .faulted: return "xmark.octagon.fill"
        case .unknownDisconnected: return "wifi.slash"
        case .unknownStale: return "clock.badge.exclamationmark"
        case .neverConfirmed: return "questionmark.circle.fill"
        case .indeterminateExecution: return "questionmark.circle"
        case .unrecognizedExecutionState: return "questionmark.square.dashed"
        case .unreachable: return "antenna.radiowaves.left.and.right.slash"
        }
    }

    public var isConfirmedStopped: Bool { self == .stoppedConfirmed }
    public var isUnreachable: Bool { self == .unreachable }
    public var isUnknown: Bool {
        switch self {
        case .unknownDisconnected, .unknownStale, .neverConfirmed, .indeterminateExecution, .unrecognizedExecutionState, .unreachable:
            return true
        case .starting, .operational, .runningRestricted, .paused, .stopping, .stoppedConfirmed, .faulted:
            return false
        }
    }
}

// MARK: - 机器人

/// 身份三件套：稳定身份 / 策略版本 / 运行实例 —— **三者可区分**。
public struct IdentityPresentation: Sendable, Hashable {
    public let botLabel: String?
    public let botId: String?
    public let strategyLabel: String?
    public let strategyHash: String?
    public let runLabel: String?
    public let runHost: String?

    public init(botLabel: String?, botId: String?, strategyLabel: String?, strategyHash: String?, runLabel: String?, runHost: String?) {
        self.botLabel = botLabel
        self.botId = botId
        self.strategyLabel = strategyLabel
        self.strategyHash = strategyHash
        self.runLabel = runLabel
        self.runHost = runHost
    }

    public static let unknown = IdentityPresentation(botLabel: nil, botId: nil, strategyLabel: nil, strategyHash: nil, runLabel: nil, runHost: nil)
}

public struct TraceLinkPresentation: Sendable, Hashable, Identifiable {
    public enum Target: Sendable, Hashable {
        case bot(String)
        case account(String)
        case order(String)
        case none
    }

    public let id: String
    public let label: String
    public let target: Target

    public init(id: String, label: String, target: Target) {
        self.id = id
        self.label = label
        self.target = target
    }
}

public struct PositionPresentation: Sendable, Hashable, Identifiable {
    public let id: String
    public let symbol: String?
    public let side: String?
    public let quantity: String?
    public let entryPrice: String?
    public let pnl: String?
    /// 机器人归属。**不可靠归属时必须是 nil**（不制造精确数字）。
    public let attribution: String?
    public let isAttributionReliable: Bool
    public let fallbackText: String
    public let rendersData: Bool
    public let notice: String?
    public let axes: StateAxesPresentation
    public let actions: [ActionPresentation]

    public init(id: String, symbol: String?, side: String?, quantity: String?, entryPrice: String?, pnl: String?,
                attribution: String?, isAttributionReliable: Bool, fallbackText: String, rendersData: Bool,
                notice: String?, axes: StateAxesPresentation, actions: [ActionPresentation]) {
        self.id = id
        self.symbol = symbol
        self.side = side
        self.quantity = quantity
        self.entryPrice = entryPrice
        self.pnl = pnl
        self.attribution = attribution
        self.isAttributionReliable = isAttributionReliable
        self.fallbackText = fallbackText
        self.rendersData = rendersData
        self.notice = notice
        self.axes = axes
        self.actions = actions
    }
}

/// 订单生命周期阶段。**只识别契约里写过的字面量**；不认识的原始值原样显示（不猜）。
public enum OrderLifecycleStage: Sendable, Hashable {
    case submitted
    case partiallyFilled
    case filled
    case cancelPending
    case cancelling
    case canceled
    case rejected
    case expired
    case submittedUnknown
    case neverArrived
    case unknownState(String)

    public var label: String {
        switch self {
        case .submitted: return "已提交"
        case .partiallyFilled: return "部分成交"
        case .filled: return "已成交"
        case .cancelPending: return "撤单处理中"
        case .cancelling: return "正在撤单"
        case .canceled: return "已撤单"
        case .rejected: return "已拒绝"
        case .expired: return "已过期"
        case .submittedUnknown: return "结果未知（已提交，未确认）"
        case .neverArrived: return "未到达交易所"
        case let .unknownState(raw): return raw
        }
    }

    public var tone: ThemeTone {
        switch self {
        case .filled: return .positive
        case .partiallyFilled, .cancelPending, .cancelling: return .warning
        case .submittedUnknown: return .critical
        case .neverArrived, .rejected, .canceled, .expired: return .neutral
        case .submitted: return .info
        case .unknownState: return .unknown
        }
    }

    public var isAwaiting: Bool {
        switch self {
        case .partiallyFilled, .cancelPending, .cancelling, .submittedUnknown, .submitted: return true
        case .filled, .canceled, .rejected, .expired, .neverArrived, .unknownState: return false
        }
    }
}

public struct OrderPresentation: Sendable, Hashable, Identifiable {
    public let id: String
    public let symbol: String?
    public let side: String?
    public let price: String?
    public let quantity: String?
    public let filledQuantity: String?
    public let stateRaw: String?
    public let stage: OrderLifecycleStage
    public let stateSinceMs: Int?
    public let attribution: String?
    public let fallbackText: String
    public let rendersData: Bool
    public let notice: String?
    public let axes: StateAxesPresentation
    public let actions: [ActionPresentation]

    public init(id: String, symbol: String?, side: String?, price: String?, quantity: String?, filledQuantity: String?,
                stateRaw: String?, stage: OrderLifecycleStage, stateSinceMs: Int?, attribution: String?,
                fallbackText: String, rendersData: Bool, notice: String?, axes: StateAxesPresentation,
                actions: [ActionPresentation]) {
        self.id = id
        self.symbol = symbol
        self.side = side
        self.price = price
        self.quantity = quantity
        self.filledQuantity = filledQuantity
        self.stateRaw = stateRaw
        self.stage = stage
        self.stateSinceMs = stateSinceMs
        self.attribution = attribution
        self.fallbackText = fallbackText
        self.rendersData = rendersData
        self.notice = notice
        self.axes = axes
        self.actions = actions
    }
}

public struct FillPresentation: Sendable, Hashable, Identifiable {
    public let id: String
    public let symbol: String?
    public let side: String?
    public let quantity: String?
    public let price: String?
    public let atMs: Int?
    public let botLabel: String?
    public let fallbackText: String
    public let rendersData: Bool
    public let notice: String?
    public let axes: StateAxesPresentation

    public init(id: String, symbol: String?, side: String?, quantity: String?, price: String?, atMs: Int?,
                botLabel: String?, fallbackText: String, rendersData: Bool, notice: String?, axes: StateAxesPresentation) {
        self.id = id
        self.symbol = symbol
        self.side = side
        self.quantity = quantity
        self.price = price
        self.atMs = atMs
        self.botLabel = botLabel
        self.fallbackText = fallbackText
        self.rendersData = rendersData
        self.notice = notice
        self.axes = axes
    }
}

public struct EventPresentation: Sendable, Hashable, Identifiable {
    public let id: String
    public let atMs: Int?
    public let kind: String
    public let title: String
    public let detail: String?
    public let tone: ThemeTone

    public init(id: String, atMs: Int?, kind: String, title: String, detail: String?, tone: ThemeTone) {
        self.id = id
        self.atMs = atMs
        self.kind = kind
        self.title = title
        self.detail = detail
        self.tone = tone
    }
}

public struct BotPresentation: Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String
    public let identity: IdentityPresentation
    public let state: BotStateKind
    public let stateDetail: String?
    public let axes: StateAxesPresentation
    public let phase: String?
    public let waitReason: String?
    public let dependencyIssues: [String]
    public let positionCount: Int?
    public let activeOrderCount: Int?
    public let lastConfirmedHealthyAtMs: Int?
    public let runtimeMode: RuntimeMode
    public let rendersData: Bool
    public let notice: String?
    public let generatedAtMs: Int
    public let sourceId: String
    public let timeline: [EventPresentation]
    public let positions: [PositionPresentation]
    public let orders: [OrderPresentation]
    public let recentFills: [FillPresentation]
    public let decisionSummary: String?
    public let decisionBlockedReason: String?
    public let actions: [ActionPresentation]

    public init(id: String, label: String, identity: IdentityPresentation, state: BotStateKind, stateDetail: String?,
                axes: StateAxesPresentation, phase: String?, waitReason: String?, dependencyIssues: [String],
                positionCount: Int?, activeOrderCount: Int?, lastConfirmedHealthyAtMs: Int?, runtimeMode: RuntimeMode,
                rendersData: Bool, notice: String?, generatedAtMs: Int, sourceId: String,
                timeline: [EventPresentation], positions: [PositionPresentation], orders: [OrderPresentation],
                recentFills: [FillPresentation], decisionSummary: String?, decisionBlockedReason: String?,
                actions: [ActionPresentation]) {
        self.id = id
        self.label = label
        self.identity = identity
        self.state = state
        self.stateDetail = stateDetail
        self.axes = axes
        self.phase = phase
        self.waitReason = waitReason
        self.dependencyIssues = dependencyIssues
        self.positionCount = positionCount
        self.activeOrderCount = activeOrderCount
        self.lastConfirmedHealthyAtMs = lastConfirmedHealthyAtMs
        self.runtimeMode = runtimeMode
        self.rendersData = rendersData
        self.notice = notice
        self.generatedAtMs = generatedAtMs
        self.sourceId = sourceId
        self.timeline = timeline
        self.positions = positions
        self.orders = orders
        self.recentFills = recentFills
        self.decisionSummary = decisionSummary
        self.decisionBlockedReason = decisionBlockedReason
        self.actions = actions
    }
}

// MARK: - 告警

/// 严重等级。**未知值保留原始串**（不折叠成 warning）。
public enum AlertSeverity: Sendable, Hashable {
    case info
    case warning
    case critical
    case unknown(String)

    public var label: String {
        switch self {
        case .info: return "提示"
        case .warning: return "警告"
        case .critical: return "严重"
        case let .unknown(raw): return raw
        }
    }

    public var tone: ThemeTone {
        switch self {
        case .info: return .info
        case .warning: return .warning
        case .critical: return .critical
        case .unknown: return .unknown
        }
    }

    public var systemImage: String {
        switch self {
        case .info: return "info.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .critical: return "exclamationmark.octagon.fill"
        case .unknown: return "questionmark.circle"
        }
    }

    public var rank: Int {
        switch self {
        case .critical: return 3
        case .warning: return 2
        case .info: return 1
        case .unknown: return 0
        }
    }
}

/// 三个**独立**状态：已读 / 已确认 / 已恢复。
/// 「用户已确认」!= 「故障已恢复」—— 所以它们在类型上是三个字段，不是一个枚举。
public struct AlertLifecyclePresentation: Sendable, Hashable {
    public let readAtMs: Int?
    public let acknowledgedAtMs: Int?
    public let recoveredAtMs: Int?
    public let isRecovered: Bool?
    public let firstSeenMs: Int?
    public let lastSeenMs: Int?
    public let repeatCount: Int?

    public init(readAtMs: Int?, acknowledgedAtMs: Int?, recoveredAtMs: Int?, isRecovered: Bool?,
                firstSeenMs: Int?, lastSeenMs: Int?, repeatCount: Int?) {
        self.readAtMs = readAtMs
        self.acknowledgedAtMs = acknowledgedAtMs
        self.recoveredAtMs = recoveredAtMs
        self.isRecovered = isRecovered
        self.firstSeenMs = firstSeenMs
        self.lastSeenMs = lastSeenMs
        self.repeatCount = repeatCount
    }

    public var isRead: Bool? { readAtMs.map { _ in true } }
    public var isAcknowledged: Bool? { acknowledgedAtMs.map { _ in true } }

    /// 聚合展示：同一异常重复出现时的「x N」。
    public var aggregationLabel: String? {
        guard let repeatCount, repeatCount > 1 else { return nil }
        return "重复 " + String(repeatCount) + " 次"
    }
}

public struct AlertPresentation: Sendable, Hashable, Identifiable {
    public let id: String
    public let severity: AlertSeverity
    public let title: String
    public let lifecycle: AlertLifecyclePresentation
    public let relatedBot: TraceLinkPresentation?
    public let relatedAccount: TraceLinkPresentation?
    public let relatedOrder: TraceLinkPresentation?
    public let reason: String?
    public let impact: String?
    public let fallbackText: String
    public let operable: Bool
    public let unknownEnumReason: String?
    public let rendersData: Bool
    public let notice: String?
    public let axes: StateAxesPresentation
    public let actions: [ActionPresentation]

    public init(id: String, severity: AlertSeverity, title: String, lifecycle: AlertLifecyclePresentation,
                relatedBot: TraceLinkPresentation?, relatedAccount: TraceLinkPresentation?,
                relatedOrder: TraceLinkPresentation?, reason: String?, impact: String?, fallbackText: String,
                operable: Bool, unknownEnumReason: String?, rendersData: Bool, notice: String?,
                axes: StateAxesPresentation, actions: [ActionPresentation]) {
        self.id = id
        self.severity = severity
        self.title = title
        self.lifecycle = lifecycle
        self.relatedBot = relatedBot
        self.relatedAccount = relatedAccount
        self.relatedOrder = relatedOrder
        self.reason = reason
        self.impact = impact
        self.fallbackText = fallbackText
        self.operable = operable
        self.unknownEnumReason = unknownEnumReason
        self.rendersData = rendersData
        self.notice = notice
        self.axes = axes
        self.actions = actions
    }
}

// MARK: - 动作（fail-closed）

public struct ActionPresentation: Sendable, Hashable, Identifiable {
    public let id: String
    /// 原始动作串（未知时就是原始值，UI 只显示 fallbackText、禁用动作）。
    public let kind: String
    public let label: String
    public let enabled: Bool
    public let requiresBiometric: Bool
    public let isUnknownKind: Bool
    public let scopeLabel: String?
    public let confirmNote: String?

    public init(id: String, kind: String, label: String, enabled: Bool, requiresBiometric: Bool,
                isUnknownKind: Bool, scopeLabel: String?, confirmNote: String?) {
        self.id = id
        self.kind = kind
        self.label = label
        self.enabled = enabled
        self.requiresBiometric = requiresBiometric
        self.isUnknownKind = isUnknownKind
        self.scopeLabel = scopeLabel
        self.confirmNote = confirmNote
    }

    /// 未知动作的呈现：只有原始值 + 禁用。
    public static func unknown(rawKind: String) -> ActionPresentation {
        ActionPresentation(id: rawKind, kind: rawKind, label: rawKind, enabled: false, requiresBiometric: true,
                           isUnknownKind: true, scopeLabel: nil, confirmNote: "本客户端不认识这个动作，已禁用；请升级客户端。")
    }
}

// MARK: - 资产与交易

public struct AssetPresentation: Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String
    public let value: String?
    public let unit: String?
    /// 不可靠归属时 nil。
    public let attribution: String?
    public let fallbackText: String
    public let rendersData: Bool
    public let notice: String?
    public let axes: StateAxesPresentation

    public init(id: String, label: String, value: String?, unit: String?, attribution: String?, fallbackText: String,
                rendersData: Bool, notice: String?, axes: StateAxesPresentation) {
        self.id = id
        self.label = label
        self.value = value
        self.unit = unit
        self.attribution = attribution
        self.fallbackText = fallbackText
        self.rendersData = rendersData
        self.notice = notice
        self.axes = axes
    }
}

public struct AssetsSummaryPresentation: Sendable, Hashable {
    public let currency: String?
    public let equity: String?
    public let available: String?
    public let margin: String?
    public let realizedPnl: String?
    public let unrealizedPnl: String?
    public let costs: [AssetPresentation]
    public let rendersData: Bool
    public let notice: String?
    public let axes: StateAxesPresentation

    public init(currency: String?, equity: String?, available: String?, margin: String?, realizedPnl: String?,
                unrealizedPnl: String?, costs: [AssetPresentation], rendersData: Bool, notice: String?,
                axes: StateAxesPresentation) {
        self.currency = currency
        self.equity = equity
        self.available = available
        self.margin = margin
        self.realizedPnl = realizedPnl
        self.unrealizedPnl = unrealizedPnl
        self.costs = costs
        self.rendersData = rendersData
        self.notice = notice
        self.axes = axes
    }
}

public struct CashMovementPresentation: Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String
    public let amount: String?
    public let unit: String?
    public let atMs: Int?
    public let fallbackText: String
    public let rendersData: Bool
    public let notice: String?
    public let axes: StateAxesPresentation

    public init(id: String, label: String, amount: String?, unit: String?, atMs: Int?, fallbackText: String,
                rendersData: Bool, notice: String?, axes: StateAxesPresentation) {
        self.id = id
        self.label = label
        self.amount = amount
        self.unit = unit
        self.atMs = atMs
        self.fallbackText = fallbackText
        self.rendersData = rendersData
        self.notice = notice
        self.axes = axes
    }
}

public struct AssetsPresentation: Sendable, Hashable {
    public let summary: AssetsSummaryPresentation?
    public let positions: [PositionPresentation]
    public let orders: [OrderPresentation]
    public let fills: [FillPresentation]
    public let cashMovements: [CashMovementPresentation]
    public let runtimeMode: RuntimeMode
    public let generatedAtMs: Int
    public let sourceId: String

    public init(summary: AssetsSummaryPresentation?, positions: [PositionPresentation], orders: [OrderPresentation],
                fills: [FillPresentation], cashMovements: [CashMovementPresentation], runtimeMode: RuntimeMode,
                generatedAtMs: Int, sourceId: String) {
        self.summary = summary
        self.positions = positions
        self.orders = orders
        self.fills = fills
        self.cashMovements = cashMovements
        self.runtimeMode = runtimeMode
        self.generatedAtMs = generatedAtMs
        self.sourceId = sourceId
    }
}

// MARK: - 连接 / 设置

public struct ConnectionPresentation: Sendable, Hashable {
    public let linkLabel: String
    public let linkTone: ThemeTone
    public let linkIsDown: Bool
    public let isReachable: Bool
    public let originLabel: String?
    public let deviceLabel: String?
    public let scopes: [String]
    public let caps: [String]
    public let apiVersionLabel: String?
    public let lastUpdatedMs: Int?
    public let sourceId: String?
    public let notice: String?

    public init(linkLabel: String, linkTone: ThemeTone, linkIsDown: Bool, isReachable: Bool, originLabel: String?,
                deviceLabel: String?, scopes: [String], caps: [String], apiVersionLabel: String?,
                lastUpdatedMs: Int?, sourceId: String?, notice: String?) {
        self.linkLabel = linkLabel
        self.linkTone = linkTone
        self.linkIsDown = linkIsDown
        self.isReachable = isReachable
        self.originLabel = originLabel
        self.deviceLabel = deviceLabel
        self.scopes = scopes
        self.caps = caps
        self.apiVersionLabel = apiVersionLabel
        self.lastUpdatedMs = lastUpdatedMs
        self.sourceId = sourceId
        self.notice = notice
    }

    public static let unknown = ConnectionPresentation(
        linkLabel: "尚未连接", linkTone: .unknown, linkIsDown: false, isReachable: false,
        originLabel: nil, deviceLabel: nil, scopes: [], caps: [], apiVersionLabel: nil,
        lastUpdatedMs: nil, sourceId: nil, notice: "尚未配对或还没有拿到任何数据。"
    )
}

public struct SettingsPresentation: Sendable, Hashable {
    public let connection: ConnectionPresentation
    public let scopes: [String]
    public let defaultScopes: [String]
    public let explicitScopes: [String]
    public let notificationMutedDesks: [String]
    public let privacyHidesAmounts: Bool
    public let displayThemePreference: String
    public let runtimeMode: RuntimeMode
    /// 契约缺口：服务端还没给的面，界面上要如实说明「未知」。
    public let contractGaps: [String]

    public init(connection: ConnectionPresentation, scopes: [String], defaultScopes: [String], explicitScopes: [String],
                notificationMutedDesks: [String], privacyHidesAmounts: Bool, displayThemePreference: String,
                runtimeMode: RuntimeMode, contractGaps: [String]) {
        self.connection = connection
        self.scopes = scopes
        self.defaultScopes = defaultScopes
        self.explicitScopes = explicitScopes
        self.notificationMutedDesks = notificationMutedDesks
        self.privacyHidesAmounts = privacyHidesAmounts
        self.displayThemePreference = displayThemePreference
        self.runtimeMode = runtimeMode
        self.contractGaps = contractGaps
    }
}

// MARK: - 顶层状态

public struct HealthBucketPresentation: Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String
    public let count: Int
    public let tone: ThemeTone

    public init(id: String, label: String, count: Int, tone: ThemeTone) {
        self.id = id
        self.label = label
        self.count = count
        self.tone = tone
    }
}

public struct OverviewPresentation: Sendable, Hashable {
    public let connection: ConnectionPresentation
    public let runtimeMode: RuntimeMode
    public let generatedAtMs: Int
    public let sourceId: String
    public let totalBots: Int
    public let healthBuckets: [HealthBucketPresentation]
    public let dependencyAnomalyCount: Int
    public let unknownCount: Int
    /// 健康异常时**必须**出现的句子：收益为正不代表系统正常。
    public let profitIsNotHealthWarning: String?
    public let topAlerts: [AlertPresentation]
    public let recentEvents: [EventPresentation]
    public let assets: AssetsSummaryPresentation?
    public let rendersData: Bool
    public let notice: String?
    public let axes: StateAxesPresentation

    public init(connection: ConnectionPresentation, runtimeMode: RuntimeMode, generatedAtMs: Int, sourceId: String,
                totalBots: Int, healthBuckets: [HealthBucketPresentation], dependencyAnomalyCount: Int,
                unknownCount: Int, profitIsNotHealthWarning: String?, topAlerts: [AlertPresentation],
                recentEvents: [EventPresentation], assets: AssetsSummaryPresentation?, rendersData: Bool,
                notice: String?, axes: StateAxesPresentation) {
        self.connection = connection
        self.runtimeMode = runtimeMode
        self.generatedAtMs = generatedAtMs
        self.sourceId = sourceId
        self.totalBots = totalBots
        self.healthBuckets = healthBuckets
        self.dependencyAnomalyCount = dependencyAnomalyCount
        self.unknownCount = unknownCount
        self.profitIsNotHealthWarning = profitIsNotHealthWarning
        self.topAlerts = topAlerts
        self.recentEvents = recentEvents
        self.assets = assets
        self.rendersData = rendersData
        self.notice = notice
        self.axes = axes
    }
}

/// 本客户端不认识的卡片类型：**不丢弃**，只读展示兜底文本。
/// 驾驶舱的实测教训：协议层不丢弃，界面分块过滤时却把它在 UI 层丢掉了。
public struct UnrecognizedCardPresentation: Sendable, Hashable, Identifiable {
    public let id: String
    public let cardType: String
    public let revision: Double
    public let fallbackText: String
    public let reason: String

    public init(id: String, cardType: String, revision: Double, fallbackText: String, reason: String) {
        self.id = id
        self.cardType = cardType
        self.revision = revision
        self.fallbackText = fallbackText
        self.reason = reason
    }
}

/// 五入口共享的顶层呈现状态。视图只读它；动作经 FeatureActionDispatching 派发。
public struct FeaturesState: Sendable, Hashable {
    public let overview: OverviewPresentation
    public let bots: [BotPresentation]
    public let alerts: [AlertPresentation]
    public let assets: AssetsPresentation
    public let settings: SettingsPresentation
    public let connection: ConnectionPresentation
    public let runtimeMode: RuntimeMode
    /// 还没有任何可信数据时的整页提示（**不是「没有机器人」**）。
    public let emptyMessage: String?
    /// 本客户端不认识的卡片（未知 closed 枚举）——只读展示，不操作。
    public let unrecognizedCards: [UnrecognizedCardPresentation]

    public init(overview: OverviewPresentation, bots: [BotPresentation], alerts: [AlertPresentation],
                assets: AssetsPresentation, settings: SettingsPresentation, connection: ConnectionPresentation,
                runtimeMode: RuntimeMode, emptyMessage: String?, unrecognizedCards: [UnrecognizedCardPresentation] = []) {
        self.overview = overview
        self.bots = bots
        self.alerts = alerts
        self.assets = assets
        self.settings = settings
        self.connection = connection
        self.runtimeMode = runtimeMode
        self.emptyMessage = emptyMessage
        self.unrecognizedCards = unrecognizedCards
    }
}

/// 动作派发端口。Features **不**直接调 LocalAuthentication、不发网络请求：
/// 由 App 组合根把它接到 Domain 的 ObservationStore.send(_:params:gate:)。
@MainActor
public protocol FeatureActionDispatching: AnyObject {
    func dispatch(_ action: ActionPresentation) async -> FeatureDispatchOutcome
}

public struct FeatureDispatchOutcome: Sendable, Hashable {
    public let accepted: Bool
    public let message: String

    public init(accepted: Bool, message: String) {
        self.accepted = accepted
        self.message = message
    }
}

/// 什么都不做的派发器：只在快照/预览里用，**不会**被 App 装配（App 必须给真实端口）。
@MainActor
public final class NoopActionDispatcher: FeatureActionDispatching {
    public init() {}
    public func dispatch(_ action: ActionPresentation) async -> FeatureDispatchOutcome {
        FeatureDispatchOutcome(accepted: false, message: "未接线：快照/预览环境不派发动作。")
    }
}

/// 设置面的写端口（通知静音 / 隐私 / 显示 / 撤销设备）。
/// Features 只负责呈现与收集意图；持久化与撤销动作由 App 组合根接到 Offline/Alerts/Transport。
/// 刻意做成 Sendable + async：设置写入可能落到别的执行器（持久化、钥匙串），
/// 视图层不假设它一定在主线程上。
public protocol FeatureSettingsControlling: Sendable {
    func setNotificationMuted(desk: String, muted: Bool) async
    func setPrivacyHidesAmounts(_ hidden: Bool) async
    func setDisplayThemePreference(_ value: String) async
    func revokeDevice() async -> FeatureDispatchOutcome
}

public struct NoopSettingsController: FeatureSettingsControlling {
    public init() {}
    public func setNotificationMuted(desk: String, muted: Bool) async {}
    public func setPrivacyHidesAmounts(_ hidden: Bool) async {}
    public func setDisplayThemePreference(_ value: String) async {}
    public func revokeDevice() async -> FeatureDispatchOutcome {
        FeatureDispatchOutcome(accepted: false, message: "未接线：快照/预览环境不撤销设备。")
    }
}
