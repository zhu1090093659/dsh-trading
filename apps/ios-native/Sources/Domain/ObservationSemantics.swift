import Foundation

public enum ExecutionState: String, Codable, Sendable, CaseIterable {
    case starting, running, paused, stopping, stopped, faulted
    public var text: String {
        switch self {
        case .starting: "启动中"
        case .running: "运行"
        case .paused: "暂停"
        case .stopping: "停止中"
        case .stopped: "已停止"
        case .faulted: "故障"
        }
    }
}
public enum DataTrust: String, Codable, Sendable, CaseIterable { case latest, stale, disconnected, unconfirmed }
public enum MarketHealth: String, Codable, Sendable { case normal, delayed, unknown }
public enum TradingHealth: String, Codable, Sendable { case normal, abnormal, unknown }
public enum AccountHealth: String, Codable, Sendable { case normal, syncFailed, unknown }
public enum RiskPermission: String, Codable, Sendable { case allowed, reduceOnly, blocked, unknown }
public enum Heartbeat: String, Codable, Sendable { case alive, missing, unknown }

public struct DependencyHealth: Equatable, Sendable {
    public let market: MarketHealth
    public let trading: TradingHealth
    public let account: AccountHealth
    public let risk: RiskPermission
    public init(market: MarketHealth, trading: TradingHealth, account: AccountHealth, risk: RiskPermission) {
        self.market = market; self.trading = trading; self.account = account; self.risk = risk
    }
    public var permitsNewExposure: Bool {
        market == .normal && trading == .normal && account == .normal && risk == .allowed
    }
}

/// Observation only: this projection grants no command or live-trading authority.
/// Heartbeat is transport liveness, never evidence of safe business execution.
public struct BotObservation: Equatable, Sendable {
    public let execution: ExecutionState
    public let dependencies: DependencyHealth
    public let trust: DataTrust
    public let heartbeat: Heartbeat
    public let lastConfirmedAt: Date?
    public init(execution: ExecutionState, dependencies: DependencyHealth, trust: DataTrust, heartbeat: Heartbeat, lastConfirmedAt: Date?) {
        self.execution = execution; self.dependencies = dependencies; self.trust = trust
        self.heartbeat = heartbeat; self.lastConfirmedAt = lastConfirmedAt
    }
    public func withTrust(_ next: DataTrust) -> Self {
        Self(execution: execution, dependencies: dependencies, trust: next, heartbeat: heartbeat, lastConfirmedAt: lastConfirmedAt)
    }
    public var presentation: BotStatusPresentation {
        switch trust {
        case .latest:
            guard lastConfirmedAt != nil else {
                return BotStatusPresentation(execution: nil, dependencies: nil, trust: .unconfirmed, lastConfirmedAt: nil)
            }
            return BotStatusPresentation(execution: execution, dependencies: dependencies, trust: trust, lastConfirmedAt: lastConfirmedAt)
        case .stale, .disconnected, .unconfirmed:
            return BotStatusPresentation(execution: nil, dependencies: nil, trust: trust, lastConfirmedAt: lastConfirmedAt)
        }
    }
}
public struct BotStatusPresentation: Equatable, Sendable {
    public let execution: ExecutionState?
    public let dependencies: DependencyHealth?
    public let trust: DataTrust
    public let lastConfirmedAt: Date?
    public var executionText: String { execution?.text ?? "未知" }
    public var canAddExposure: Bool { trust == .latest && execution == .running && dependencies?.permitsNewExposure == true }
}

/// A render boundary: never return the payload for expired, future or unconfirmed observations.
/// maxAge is caller supplied; this module does not invent an uncalibrated freshness constant.
public struct Observed<Value: Sendable>: Sendable {
    private let value: Value
    public let confirmedAt: Date?
    public init(value: Value, confirmedAt: Date?) { self.value = value; self.confirmedAt = confirmedAt }
    public func render(at now: Date, maxAge: TimeInterval, trust: DataTrust) -> Value? {
        guard trust == .latest, let confirmedAt, maxAge.isFinite, maxAge >= 0 else { return nil }
        let age = now.timeIntervalSince(confirmedAt)
        guard age.isFinite, age >= 0, age <= maxAge else { return nil }
        return value
    }
}
