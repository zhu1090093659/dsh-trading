//
//  Observation.swift
//  Domain
//
//  本卡的核心：把三维状态（执行 / 依赖 / 可信度）投影成一个**观测结论**。
//
//  两个必须区分、且**不允许渲染成同一句话**的情形（冻结件 §6.2）：
//    A. 机器人仍在运行，但依赖异常、已禁止新增仓位，最后确认时间 T；
//    B. App 与监控服务连接中断，机器人状态**未知**，最后一次确认运行正常的时间 T。
//
//  二者在类型上就是不同的 case（.runningRestricted vs .cannotSeeBot），
//  因此视图层不可能把它们折叠成同一个"已停止" —— 这不是靠约定，是靠类型。
//
//  判据只能来自**传输事实**（有没有拿到 A0 响应 / 卡片），不得从卡片文本里猜。
//

// MARK: - 可达性（冻结件 §6.2）

/// App 能不能看到机器人。**这是传输事实**，不是从卡片里读出来的。
public enum BotReachability: Equatable, Sendable, Hashable {
    /// /a0/ping 或 /v1/cards 连不上（连接失败 / 未配对 / 未绑定 origin）。
    case unreachable(reason: String)
    case reachable

    public var isReachable: Bool {
        if case .reachable = self { return true }
        return false
    }

    public var reason: String? {
        if case let .unreachable(reason) = self { return reason }
        return nil
    }

    /// 由链路观测导出。**只认"有没有拿到响应"**，不认卡片内容。
    public static func from(link: MonitorLinkState) -> BotReachability {
        switch link {
        case .connected, .degraded: return .reachable
        case .down: return .unreachable(reason: "与监控服务连接中断")
        }
    }
}

// MARK: - 未知封闭枚举

/// 一条未知的封闭枚举值（携带它属于哪个集合，便于界面说清"哪一类不认识"）。
public struct UnknownClosedValue: Hashable, Sendable {
    public let kind: String
    public let rawValue: String

    public init(kind: String, rawValue: String) {
        self.kind = kind
        self.rawValue = rawValue
    }
}

/// 观测面的可达结论。**未知封闭枚举与不可信数据是两种不同的"不能操作"**。
public enum SurfaceDecision: Hashable, Sendable {
    /// 可操作。
    case interactive
    /// 可只读展示，但**禁用全部动作**：卡片/动作里有客户端不认识的值。
    case readOnly(unknown: [UnknownClosedValue])
    /// **不渲染**：数据不可信（过期 / 尚未确认）。
    case notRendered(reason: String)

    public var allowsActions: Bool {
        if case .interactive = self { return true }
        return false
    }

    public var rendersContent: Bool {
        if case .notRendered = self { return false }
        return true
    }
}

/// 观测面判定。顺序即优先级，两条都不许被"尽力渲染"绕过。
public enum SurfacePolicy {
    public static func decide(trust: DataTrust, unknownClosedValues: [UnknownClosedValue]) -> SurfaceDecision {
        // 1. 数据不可信 -> 什么都不渲染（过期/未确认不渲染数据本身）。
        guard trust.rendersData else {
            return .notRendered(reason: trust.notice ?? "数据不可信")
        }
        // 2. 任一未知封闭枚举 -> 只读展示、禁用全部动作（未知类型/未知动作 = 不可操作）。
        if !unknownClosedValues.isEmpty {
            return .readOnly(unknown: unknownClosedValues)
        }
        // 3. 否则可操作。
        return .interactive
    }
}

// MARK: - 健康评估（心跳 != 业务）

/// 健康评估：**心跳是一个字段，业务健康是另一个字段**，两者不许互相顶替。
public struct HealthAssessment: Hashable, Sendable {
    public let heartbeatHealthy: Bool
    public let openRiskAllowed: Bool
    public let blockers: [DependencyIssue]

    public init(heartbeatHealthy: Bool, openRiskAllowed: Bool, blockers: [DependencyIssue]) {
        self.heartbeatHealthy = heartbeatHealthy
        self.openRiskAllowed = openRiskAllowed
        self.blockers = blockers
    }

    /// 业务正常 = 心跳正常 **且** 允许新增风险 **且** 没有阻断项。
    /// 心跳单独为 true 不足以让这里为 true。
    public var businessHealthy: Bool {
        heartbeatHealthy && openRiskAllowed && blockers.isEmpty
    }
}

// MARK: - 观测结论

/// 观测结论。**没有 default 分支**：新增情形必须在这里显式落子。
public enum ObservationVerdict: Hashable, Sendable {
    /// 情形 B：看不到机器人（连接失败/未配对）—— **不是"已停止"**。
    case cannotSeeBot(reason: String)
    /// 运行中且依赖正常。
    case running
    /// 情形 A：还在运行，但依赖异常、已禁止新增仓位。
    case runningRestricted(reasons: [String])
    case paused
    case stopped
    /// 已连上但无法判定执行状态（第三种显示，不许折叠成前两种）。
    case indeterminate
    /// 数据不可信（过期/尚未确认）：不渲染数据本身，也不推断执行状态。
    case dataNotTrustworthy(trust: DataTrust)

    /// 穷尽 switch（无 default）。
    public var title: String {
        switch self {
        case let .cannotSeeBot(reason): return "看不到机器人（" + reason + "）"
        case .running: return "机器人运行中"
        case let .runningRestricted(reasons):
            return reasons.isEmpty ? "机器人运行中（受限：禁止新增仓位）" : "机器人运行中（受限：禁止新增仓位；" + reasons.joined(separator: "、") + "）"
        case .paused: return "机器人已暂停"
        case .stopped: return "机器人已停止"
        case .indeterminate: return "已连上但无法判定执行状态"
        case let .dataNotTrustworthy(trust): return trust.notice ?? "数据不可信"
        }
    }

    /// 是不是"确认已停止"。未知/看不到**不是**已停止 —— 这正是本卡要防的那次折叠。
    public var isConfirmedStopped: Bool {
        if case .stopped = self { return true }
        return false
    }

    /// 是不是"我们不知道机器人在干什么"。
    public var isUnknown: Bool {
        switch self {
        case .cannotSeeBot, .indeterminate, .dataNotTrustworthy: return true
        case .running, .runningRestricted, .paused, .stopped: return false
        }
    }
}

/// 一次观测的完整结论（IOS-4 的 BotStatus.assessment 用它承载三维语义）。
public struct ObservationAssessment: Hashable, Sendable {
    public let verdict: ObservationVerdict
    public let health: HealthAssessment
    public let trust: DataTrust

    public init(verdict: ObservationVerdict, health: HealthAssessment, trust: DataTrust) {
        self.verdict = verdict
        self.health = health
        self.trust = trust
    }

    public var rendersData: Bool { trust.rendersData }

    /// 与未知封闭枚举一起决定观测面能不能操作。
    public func surface(unknownClosedValues: [UnknownClosedValue] = []) -> SurfaceDecision {
        SurfacePolicy.decide(trust: trust, unknownClosedValues: unknownClosedValues)
    }
}

/// 投影器：由三维输入得出唯一结论。纯函数，不读时钟。
public enum ObservationProjector {
    public static func assess(
        reachability: BotReachability,
        execution: ExecutionState,
        dependency: DependencyHealth,
        trust: DataTrust,
        heartbeat: HeartbeatStatus,
        atMs: EpochMillis,
        openRiskAllowed: Bool,
        blockers: [DependencyIssue]
    ) -> ObservationAssessment {
        let health = HealthAssessment(
            heartbeatHealthy: heartbeat.isHealthy(atMs: atMs),
            openRiskAllowed: openRiskAllowed,
            blockers: blockers
        )
        let verdict = verdictFor(
            reachability: reachability,
            execution: execution,
            dependency: dependency,
            trust: trust,
            openRiskAllowed: openRiskAllowed,
            blockers: blockers
        )
        return ObservationAssessment(verdict: verdict, health: health, trust: trust)
    }

    /// 优先级即安全顺序：先"看不看得见"，再"数据可不可信"，最后才是执行状态。
    public static func verdictFor(
        reachability: BotReachability,
        execution: ExecutionState,
        dependency: DependencyHealth,
        trust: DataTrust,
        openRiskAllowed: Bool,
        blockers: [DependencyIssue]
    ) -> ObservationVerdict {
        // 1. 看不到机器人：任何执行状态都不可采信（哪怕上次读到的是"已停止"）。
        if case let .unreachable(reason) = reachability {
            return .cannotSeeBot(reason: reason)
        }
        // 2. 数据不可信：不渲染数据本身，也不推断状态。
        if !trust.rendersData {
            return .dataNotTrustworthy(trust: trust)
        }
        // 3. 执行状态。
        switch execution {
        case .indeterminate:
            return .indeterminate
        case .killed:
            return .stopped
        case .paused:
            return .paused
        case .running:
            if openRiskAllowed && blockers.isEmpty {
                return .running
            }
            let reasons = reasonsFor(dependency: dependency, blockers: blockers)
            return .runningRestricted(reasons: reasons)
        }
    }

    private static func reasonsFor(dependency: DependencyHealth, blockers: [DependencyIssue]) -> [String] {
        let blockerLabels = blockers.map(\.label)
        if !blockerLabels.isEmpty { return blockerLabels }
        if case let .degraded(reasons) = dependency { return reasons }
        return []
    }
}
