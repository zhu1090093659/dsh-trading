//
//  ExecutionAndDependencies.swift
//  Domain
//
//  状态语义的第一、二维（冻结件 §6.1）：
//
//    enum ExecutionState   { running, paused, killed, indeterminate }
//    enum DependencyHealth { healthy, degraded(reasons:), halted, unknown }
//
//  这两个维度**互相独立、不得互相顶替、不得取提升**，也不得把一维的取值映射成另一维的词。
//  把"运行中但依赖异常"压成"运行中"，用户会以为还能开新仓；压成"已停止"则是另一种谎。
//
//  依赖健康按设计文档第 9/22 条实现：标的级价格状态 alignment 与 desk 级交易权限 level
//  是**两套不得相交的词汇表**，判定取**合取**，绝不把标的级状态提升为 desk 级。
//

// MARK: - 执行状态（冻结件 §6.1）

/// 执行状态。权威来源是 /a0/status 的 state.killed / state.paused（带外信号）。
///
/// **拿不到 /a0/status 一律 .indeterminate，不许默认成 .running** —— 默认成运行中，
/// 就等于把"看不见"说成"在跑"，这是最危险的一种乐观。
public enum ExecutionState: String, CaseIterable, Sendable, Hashable {
    case running
    case paused
    case killed
    case indeterminate

    /// 由 A0 状态字段导出。拿不到响应时**不要调这个函数**，直接用 .indeterminate。
    public static func fromA0(killed: Bool, paused: Bool) -> ExecutionState {
        if killed { return .killed }
        if paused { return .paused }
        return .running
    }

    /// 穷尽 switch（无 default）。
    public var label: String {
        switch self {
        case .running: return "运行中"
        case .paused: return "已暂停"
        case .killed: return "已停止"
        case .indeterminate: return "无法判定"
        }
    }

    /// 是否处于"不能承载新风险"的状态。**indeterminate 也在这里面**（fail-closed）。
    public var blocksNewRisk: Bool {
        switch self {
        case .running: return false
        case .paused, .killed, .indeterminate: return true
        }
    }
}

/// 更细的执行生命周期：来源是 desk-summary / 服务端自述，**不是** A0 的 killed/paused。
/// 保留它是为了表达"启动中 / 停止中"这类过渡；权威执行状态仍以 ExecutionState 为准。
public enum ExecutionLifecycle: String, ClosedEnumValue, CaseIterable, Sendable {
    case starting
    case running
    case paused
    case stopping
    case stopped
    case faulted

    /// 穷尽 switch（无 default）：新增成员时**编译期**就会在这里红。
    public var label: String {
        switch self {
        case .starting: return "启动中"
        case .running: return "运行中"
        case .paused: return "已暂停"
        case .stopping: return "停止中"
        case .stopped: return "已停止"
        case .faulted: return "故障"
        }
    }

    /// 只有运行态可能承载新风险。
    public var mayCarryNewRisk: Bool {
        switch self {
        case .running: return true
        case .starting, .paused, .stopping, .stopped, .faulted: return false
        }
    }

    /// 向权威执行状态投影。starting 投影到 .running 是**有损**的：细节留在 lifecycle 自己身上。
    public var portState: ExecutionState {
        switch self {
        case .starting, .running: return .running
        case .paused: return .paused
        case .stopping, .stopped, .faulted: return .killed
        }
    }
}

/// 带时间与运行实例归属的执行状态。
public struct ExecutionStatus: Hashable, Sendable {
    public let state: ClosedEnum<ExecutionLifecycle>
    public let sinceMs: EpochMillis?
    public let runId: RunInstanceId?

    public init(state: ClosedEnum<ExecutionLifecycle>, sinceMs: EpochMillis?, runId: RunInstanceId?) {
        self.state = state
        self.sinceMs = sinceMs
        self.runId = runId
    }
}

// MARK: - 依赖健康的零件

/// 行情健康。delayed 与 unavailable 是两件事：前者是慢，后者是没有。
public enum MarketDataHealth: String, ClosedEnumValue, CaseIterable, Sendable {
    case normal
    case delayed
    case unavailable
}

/// 交易通道健康。
public enum TradeChannelHealth: String, ClosedEnumValue, CaseIterable, Sendable {
    case normal
    case degraded
    case unavailable
}

/// 账户同步健康（对账面）。
public enum AccountSyncHealth: String, ClosedEnumValue, CaseIterable, Sendable {
    case ok
    case inProgress
    case failed
}

/// desk 级交易权限。**与标的级 alignment 是两套不相交的词汇表。**
/// rawValue 与设计文档/服务端一致（下划线形态）。
public enum RiskLevel: String, ClosedEnumValue, CaseIterable, Sendable {
    case normal
    case caution
    case reduceOnly = "reduce_only"
    case halt

    /// 穷尽 switch（无 default）。
    public var label: String {
        switch self {
        case .normal: return "正常"
        case .caution: return "审慎"
        case .reduceOnly: return "只减不增"
        case .halt: return "停机"
        }
    }
}

/// 标的级价格状态。**不得提升为 desk 级。**
public enum InstrumentAlignment: String, ClosedEnumValue, CaseIterable, Sendable {
    case aligned
    case unaligned
    case stale

    /// 穷尽 switch（无 default）。
    public var label: String {
        switch self {
        case .aligned: return "已对齐"
        case .unaligned: return "未对齐"
        case .stale: return "陈旧"
        }
    }
}

/// 单个标的的价格状态。
public struct InstrumentPriceState: Hashable, Sendable {
    public let symbol: String
    public let alignment: ClosedEnum<InstrumentAlignment>

    public init(symbol: String, alignment: ClosedEnum<InstrumentAlignment>) {
        self.symbol = symbol
        self.alignment = alignment
    }
}

/// 依赖健康的**零件箱**：risk-state 卡片解析出来的原始事实。
///
/// 它只是素材；对外结论是 DependencyHealth（冻结件 §6.1）。分开的理由是
/// "有哪些字段"与"结论是什么"是两件事 —— 混在一起就没法表达"字段缺失"。
public struct DependencyReport: Hashable, Sendable {
    public let marketData: ClosedEnum<MarketDataHealth>
    public let tradeChannel: ClosedEnum<TradeChannelHealth>
    public let accountSync: ClosedEnum<AccountSyncHealth>
    public let riskLevel: ClosedEnum<RiskLevel>
    public let priceStates: [InstrumentPriceState]

    public init(
        marketData: ClosedEnum<MarketDataHealth>,
        tradeChannel: ClosedEnum<TradeChannelHealth>,
        accountSync: ClosedEnum<AccountSyncHealth>,
        riskLevel: ClosedEnum<RiskLevel>,
        priceStates: [InstrumentPriceState]
    ) {
        self.marketData = marketData
        self.tradeChannel = tradeChannel
        self.accountSync = accountSync
        self.riskLevel = riskLevel
        self.priceStates = priceStates
    }

    /// risk-state 卡片缺失时的样子：**全 unknown**，不是"全正常"。
    public static let missing = DependencyReport(
        marketData: .unknown(""),
        tradeChannel: .unknown(""),
        accountSync: .unknown(""),
        riskLevel: .unknown(""),
        priceStates: []
    )

    public func alignment(for symbol: String) -> ClosedEnum<InstrumentAlignment> {
        guard let state = priceStates.first(where: { $0.symbol == symbol }) else { return .unknown("") }
        return state.alignment
    }

    /// 面向某个标的的交易权限：desk 级 level 与标的级 alignment 各自独立判定后取与。
    public func permission(for symbol: String?) -> TradingPermission {
        let alignment: ClosedEnum<InstrumentAlignment>
        if let symbol {
            alignment = self.alignment(for: symbol)
        } else {
            alignment = .unknown("")
        }
        return TradingPermission(level: riskLevel, alignment: alignment)
    }
}

/// 风控是否允许交易。两个维度都保留原值，只把**合取结果**暴露成 openRiskAllowed。
public struct TradingPermission: Hashable, Sendable {
    public let level: ClosedEnum<RiskLevel>
    public let alignment: ClosedEnum<InstrumentAlignment>

    public init(level: ClosedEnum<RiskLevel>, alignment: ClosedEnum<InstrumentAlignment>) {
        self.level = level
        self.alignment = alignment
    }

    /// 合取，且**未知一律 fail-closed**（任一侧不认识 ⇒ 不许开新仓）。
    /// 判据即设计文档第 22 条：level ∈ {normal, caution} 且 alignment == aligned。
    public var openRiskAllowed: Bool {
        guard let level = level.value, let alignment = alignment.value else { return false }
        return (level == .normal || level == .caution) && alignment == .aligned
    }

    /// desk 侧是否挂了"只减不增"以上（与标的无关）。
    public var deskRestricted: Bool {
        guard let level = level.value else { return true }
        return level == .reduceOnly || level == .halt
    }
}

/// 一条依赖问题。**未知封闭枚举也是一种问题**，而且是最该阻断的那一类。
public enum DependencyIssue: Hashable, Sendable {
    case marketDataDelayed
    case marketDataUnavailable
    case tradeChannelDegraded
    case tradeChannelUnavailable
    case accountSyncFailed
    case riskLevelCaution
    case riskLevelRestricted(RiskLevel)
    case priceUnaligned(symbol: String?, alignment: InstrumentAlignment)
    case unrecognizedClosedEnum(kind: String, rawValue: String)

    /// 是否阻断"新增风险"。caution 不阻断（level ∈ {normal, caution} 可开仓）。
    public var blocksNewRisk: Bool {
        switch self {
        case .marketDataDelayed: return false
        case .marketDataUnavailable: return true
        case .tradeChannelDegraded: return true
        case .tradeChannelUnavailable: return true
        case .accountSyncFailed: return true
        case .riskLevelCaution: return false
        case .riskLevelRestricted: return true
        case .priceUnaligned: return true
        case .unrecognizedClosedEnum: return true
        }
    }

    /// 穷尽 switch（无 default）。
    public var label: String {
        switch self {
        case .marketDataDelayed: return "行情延迟"
        case .marketDataUnavailable: return "行情不可用"
        case .tradeChannelDegraded: return "交易通道降级"
        case .tradeChannelUnavailable: return "交易通道不可用"
        case .accountSyncFailed: return "账户同步失败"
        case .riskLevelCaution: return "风控审慎档"
        case let .riskLevelRestricted(level): return "风控限制：" + level.label
        case let .priceUnaligned(symbol, alignment):
            let prefix = symbol.map { $0 + " " } ?? ""
            return prefix + "价格" + alignment.label
        case let .unrecognizedClosedEnum(kind, raw): return "无法识别的" + kind + "：" + raw
        }
    }
}

/// 从依赖零件导出问题清单。纯函数，不读时钟。
public enum DependencyAssessment {
    public static func issues(_ report: DependencyReport, permission: TradingPermission, symbol: String?) -> [DependencyIssue] {
        var issues: [DependencyIssue] = []

        switch report.marketData {
        case .known(.normal): break
        case .known(.delayed): issues.append(.marketDataDelayed)
        case .known(.unavailable): issues.append(.marketDataUnavailable)
        case let .unknown(raw): issues.append(.unrecognizedClosedEnum(kind: "marketDataHealth", rawValue: raw))
        }

        switch report.tradeChannel {
        case .known(.normal): break
        case .known(.degraded): issues.append(.tradeChannelDegraded)
        case .known(.unavailable): issues.append(.tradeChannelUnavailable)
        case let .unknown(raw): issues.append(.unrecognizedClosedEnum(kind: "tradeChannelHealth", rawValue: raw))
        }

        switch report.accountSync {
        case .known(.ok), .known(.inProgress): break
        case .known(.failed): issues.append(.accountSyncFailed)
        case let .unknown(raw): issues.append(.unrecognizedClosedEnum(kind: "accountSyncHealth", rawValue: raw))
        }

        switch report.riskLevel {
        case .known(.normal): break
        case .known(.caution): issues.append(.riskLevelCaution)
        case .known(.reduceOnly), .known(.halt):
            if let level = report.riskLevel.value { issues.append(.riskLevelRestricted(level)) }
        case let .unknown(raw): issues.append(.unrecognizedClosedEnum(kind: "riskLevel", rawValue: raw))
        }

        switch permission.alignment {
        case .known(.aligned): break
        case let .known(alignment): issues.append(.priceUnaligned(symbol: symbol, alignment: alignment))
        case let .unknown(raw): issues.append(.unrecognizedClosedEnum(kind: "instrumentAlignment", rawValue: raw))
        }

        return issues
    }

    public static func blockers(_ issues: [DependencyIssue]) -> [DependencyIssue] {
        issues.filter { $0.blocksNewRisk }
    }
}

// MARK: - 依赖健康（冻结件 §6.1）

/// 依赖健康结论。**缺失 ⇒ .unknown**（不是 .healthy）。
public enum DependencyHealth: Equatable, Sendable, Hashable {
    case healthy
    case degraded(reasons: [String])
    case halted
    case unknown

    /// 从零件箱导出结论。未知封闭枚举 ⇒ .unknown（fail-closed）。
    public static func from(_ report: DependencyReport, symbol: String?) -> DependencyHealth {
        let permission = report.permission(for: symbol)
        let issues = DependencyAssessment.issues(report, permission: permission, symbol: symbol)
        let hasUnknown = issues.contains { issue in
            if case .unrecognizedClosedEnum = issue { return true }
            return false
        }
        if hasUnknown { return .unknown }
        if let level = report.riskLevel.value, level == .halt { return .halted }
        if issues.isEmpty { return .healthy }
        return .degraded(reasons: issues.map(\.label))
    }

    /// 穷尽 switch（无 default）。
    public var label: String {
        switch self {
        case .healthy: return "依赖正常"
        case let .degraded(reasons): return reasons.isEmpty ? "依赖异常" : "依赖异常：" + reasons.joined(separator: "、")
        case .halted: return "依赖停机"
        case .unknown: return "依赖状况未知"
        }
    }
}
