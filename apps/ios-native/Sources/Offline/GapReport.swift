//
//  GapReport.swift
//  Offline
//
//  冻结件 §7.2：「恢复连接必须产出 gap report（断连期间的错过触发、被拒意图、降级动作、持仓变化）」。
//
//  为什么必须有它：断连期间控制面不可达，服务端按 mandate 朝更低风险一侧降级；
//  手机重新连上时看到的是一份"现在的"状态，用户如果不被告知中间发生了什么，
//  就会以为断连期间什么都没发生 —— 而实际上可能有被拒的意图、被降级的动作。
//  空报告与"没有报告"是两件事，所以这里区分 exists / isEmpty。
//

import Foundation

/// 断连期间发生了什么。
public struct GapReport: Sendable, Equatable {
    public let disconnectedAtMs: Int
    public let recoveredAtMs: Int
    public let missedTriggers: Int
    public let rejectedIntents: Int
    public let missedEscalations: Int
    public let degradedActions: [String]
    public let positionChanges: [String]

    public init(
        disconnectedAtMs: Int,
        recoveredAtMs: Int,
        missedTriggers: Int,
        rejectedIntents: Int,
        missedEscalations: Int,
        degradedActions: [String],
        positionChanges: [String]
    ) {
        self.disconnectedAtMs = disconnectedAtMs
        self.recoveredAtMs = recoveredAtMs
        self.missedTriggers = missedTriggers
        self.rejectedIntents = rejectedIntents
        self.missedEscalations = missedEscalations
        self.degradedActions = degradedActions
        self.positionChanges = positionChanges
    }

    public var durationMs: Int { max(0, recoveredAtMs - disconnectedAtMs) }

    /// 断连期间确实什么都没发生。
    public var isEmpty: Bool {
        missedTriggers == 0 && rejectedIntents == 0 && missedEscalations == 0
            && degradedActions.isEmpty && positionChanges.isEmpty
    }

    /// 给人看的一句话（不夸大：空就明说没有变化）。
    public var summary: String {
        if isEmpty {
            return "断连 " + String(durationMs) + "ms，期间没有错过触发、被拒意图或降级动作"
        }
        var parts: [String] = []
        if missedTriggers > 0 { parts.append("错过触发 " + String(missedTriggers)) }
        if rejectedIntents > 0 { parts.append("被拒意图 " + String(rejectedIntents)) }
        if missedEscalations > 0 { parts.append("错过升级 " + String(missedEscalations)) }
        if !degradedActions.isEmpty { parts.append("降级动作：" + degradedActions.joined(separator: "、")) }
        if !positionChanges.isEmpty { parts.append("持仓变化：" + positionChanges.joined(separator: "、")) }
        return "断连 " + String(durationMs) + "ms：" + parts.joined(separator: "；")
    }
}

/// 断连期间的记录器（由 Offline 源在失联时开启，恢复时落定）。
public struct GapReportBuilder: Sendable, Equatable {
    public let disconnectedAtMs: Int
    public private(set) var missedTriggers: Int = 0
    public private(set) var rejectedIntents: Int = 0
    public private(set) var missedEscalations: Int = 0
    public private(set) var degradedActions: [String] = []
    public private(set) var positionChanges: [String] = []

    public init(disconnectedAtMs: Int) {
        self.disconnectedAtMs = disconnectedAtMs
    }

    public mutating func recordMissedTrigger(_ count: Int = 1) {
        missedTriggers += max(0, count)
    }

    public mutating func recordRejectedIntent(_ count: Int = 1) {
        rejectedIntents += max(0, count)
    }

    public mutating func recordMissedEscalation(_ count: Int = 1) {
        missedEscalations += max(0, count)
    }

    public mutating func recordDegradedAction(_ label: String) {
        degradedActions.append(label)
    }

    public mutating func recordPositionChange(_ label: String) {
        positionChanges.append(label)
    }

    public func build(recoveredAtMs: Int) -> GapReport {
        GapReport(
            disconnectedAtMs: disconnectedAtMs,
            recoveredAtMs: recoveredAtMs,
            missedTriggers: missedTriggers,
            rejectedIntents: rejectedIntents,
            missedEscalations: missedEscalations,
            degradedActions: degradedActions,
            positionChanges: positionChanges
        )
    }
}
