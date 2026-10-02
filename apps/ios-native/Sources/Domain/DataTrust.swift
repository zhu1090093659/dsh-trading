//
//  DataTrust.swift
//  Domain
//
//  状态语义的第三维（冻结件 §6.1）：数据可信度，**复用契约面 Staleness 的五个取值**
//   fresh / aging / stale / expired / unknown。
//
//  它回答"我刚看到的这个数字有多可信"，与"机器人本身在什么状态"、"依赖健不健康"
//  都不是同一个问题。三维**不得互相顶替**：连接断了表达在 BotReachability 上，
//  不许把它写成 DataTrust 的第六个取值，更不许把它翻译成"已停止"。
//
//  契约面 packages/contract/src/offline.ts 的判据：age < freshMs ⇒ fresh；
//  < staleMs ⇒ aging；< ttlMs ⇒ stale；≥ ttlMs ⇒ expired；没有快照 ⇒ unknown。
//

import DshTradingContract

/// 观测链路（App <-> 监控服务）状态。它是**传输事实**，不是数据年龄，也不是执行状态。
public enum MonitorLinkState: String, ClosedEnumValue, CaseIterable, Sendable {
    case connected
    case degraded
    case down

    /// 穷尽 switch（无 default）。
    public var label: String {
        switch self {
        case .connected: return "已连接"
        case .degraded: return "连接不稳"
        case .down: return "连接中断"
        }
    }
}

/// 数据年龄分档（**只有年龄**）。与契约 STALENESS 的前四档一一对应。
public enum DataAge: String, ClosedEnumValue, CaseIterable, Sendable {
    case fresh
    case aging
    case stale
    case expired
}

/// 数据可信度（冻结件 §6.1，与契约 Staleness 同形）。
public enum DataTrust: String, CaseIterable, Sendable, Hashable {
    case fresh
    case aging
    case stale
    case expired
    case unknown

    /// 是否允许把数据本身画出来。
    ///
    /// **过期/未知不渲染数据本身**（冻结件 §10.2）：显示一个可能完全错的持仓，
    /// 比什么都不显示危险得多。fresh/aging/stale 渲染，后两者带徽标。
    public var rendersData: Bool {
        switch self {
        case .fresh, .aging, .stale: return true
        case .expired, .unknown: return false
        }
    }

    /// 可渲染时的徽标（fresh 没有徽标）。
    public var badge: String? {
        switch self {
        case .fresh, .expired, .unknown: return nil
        case .aging: return "数据可能已变化"
        case .stale: return "⚠ 数据陈旧，仅供对照"
        }
    }

    /// 不可渲染时的说明；可渲染时为 nil。
    public var notice: String? {
        switch self {
        case .fresh, .aging, .stale: return nil
        case .expired: return "本地数据已过期，请联网获取后再操作"
        case .unknown: return "数据尚未确认，请联网获取"
        }
    }

    /// 穷尽 switch 的用例：数据不可信时禁止下发命令。
    public var blocksCommands: Bool {
        switch self {
        case .fresh, .aging, .stale: return false
        case .expired, .unknown: return true
        }
    }
}

/// 观测端陈旧度预算的**唯一毫秒事实**（Domain 是 Contract 与 Offline 的共同下游）。
///
/// 这里曾经有两份各自定义的毫秒常量：Offline 收到的是 App 传的 30 分钟档，
/// 而 Domain 渲染判据用的是自己的 60 分钟档，于是"同一份缓存算不算过期"在两个层里
/// 得到两个答案。现在只留这一份：渲染（TrustBudget）与缓存视图（Offline 的
/// StalenessBudget）都由它派生，谁都不许再写死第二组毫秒数。
public enum ObservationStalenessBudget {
    /// 契约三档语义的客户端取值。**渲染判据就是这里的 ttlMs**。
    public static let clientDefault = StalenessBudget(
        freshMs: 30_000,
        staleMs: 5 * 60_000,
        ttlMs: 30 * 60_000
    )
}

/// 年龄 -> 可信度。**只吃年龄**：链路中断属于 BotReachability，不在这里折叠。
public enum DataTrustPolicy {
    public static func trust(age: DataAge?) -> DataTrust {
        guard let age else { return .unknown }
        switch age {
        case .fresh: return .fresh
        case .aging: return .aging
        case .stale: return .stale
        case .expired: return .expired
        }
    }

    /// 从契约面 Staleness 的原始值导入；不认识的原始值 ⇒ .unknown（fail-closed）。
    public static func trust(stalenessRawValue raw: String?) -> DataTrust {
        guard let raw else { return .unknown }
        return DataTrust(rawValue: raw) ?? .unknown
    }
}

/// 心跳预算。
public struct HeartbeatPolicy: Hashable, Sendable {
    public let intervalMs: EpochMillis
    public let graceFactor: Double

    public init(intervalMs: EpochMillis, graceFactor: Double) {
        self.intervalMs = intervalMs
        self.graceFactor = graceFactor
    }

    public func isHealthy(lastBeatAtMs: EpochMillis?, atMs: EpochMillis) -> Bool {
        guard let last = lastBeatAtMs else { return false }
        let budget = Double(intervalMs) * graceFactor
        return Double(atMs - last) < budget
    }
}

/// 心跳状态。
///
/// **心跳正常 != 业务正常。** 心跳只证明"进程还活着、还能说话"，
/// 它不证明行情可用、通道可用、账户对得上、风控允许开仓。
/// 把心跳当成健康判据，等于把"能说话"当成"能安全交易"。
public struct HeartbeatStatus: Hashable, Sendable {
    public let lastBeatAtMs: EpochMillis?
    public let policy: HeartbeatPolicy

    public init(lastBeatAtMs: EpochMillis?, policy: HeartbeatPolicy) {
        self.lastBeatAtMs = lastBeatAtMs
        self.policy = policy
    }

    public func isHealthy(atMs: EpochMillis) -> Bool {
        policy.isHealthy(lastBeatAtMs: lastBeatAtMs, atMs: atMs)
    }

    public func ageMs(atMs: EpochMillis) -> EpochMillis? {
        guard let last = lastBeatAtMs else { return nil }
        return atMs - last
    }
}
