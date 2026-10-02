import Foundation
import DshTradingContract

/// 告警闭环里的状态转移（**每个都留一条记录**，"发生过什么"可追溯）。
public enum AlertTransition: String, Sendable, CaseIterable {
    case raised
    case repeated
    case acknowledged
    case recovered
}

/// 一条不可变的闭环事件（append-only 历史）。
public struct AlertEvent: Equatable, Sendable {
    public let dedupeKey: String
    public let transition: AlertTransition
    public let severity: String
    public let atMs: Int

    public init(dedupeKey: String, transition: AlertTransition, severity: String, atMs: Int) {
        self.dedupeKey = dedupeKey
        self.transition = transition
        self.severity = severity
        self.atMs = atMs
    }
}

/// 一条告警的当前状态。
///
/// **"用户已确认"与"故障已恢复"是两个独立事实**：确认只改 acknowledgedAtMs，恢复只改
/// recoveredAtMs；两者都不由对方推断。把两者合成一个"已解决"字段正是本卡要避免的错误。
public struct AlertRecord: Equatable, Sendable {
    public let dedupeKey: String
    public let deskId: String
    public let kind: String
    public let severity: String
    public let firstSeenAtMs: Int
    public let lastSeenAtMs: Int
    /// 聚合次数（重复异常聚合成一条，不刷屏）。
    public let occurrences: Int
    public let acknowledgedAtMs: Int?
    public let recoveredAtMs: Int?

    public init(
        dedupeKey: String, deskId: String, kind: String, severity: String,
        firstSeenAtMs: Int, lastSeenAtMs: Int, occurrences: Int,
        acknowledgedAtMs: Int?, recoveredAtMs: Int?
    ) {
        self.dedupeKey = dedupeKey
        self.deskId = deskId
        self.kind = kind
        self.severity = severity
        self.firstSeenAtMs = firstSeenAtMs
        self.lastSeenAtMs = lastSeenAtMs
        self.occurrences = occurrences
        self.acknowledgedAtMs = acknowledgedAtMs
        self.recoveredAtMs = recoveredAtMs
    }

    public var isAcknowledged: Bool { acknowledgedAtMs != nil }
    public var isRecovered: Bool { recoveredAtMs != nil }
    public var isOpen: Bool { recoveredAtMs == nil }
}

/// 告警闭环：发生 → 重复 → 确认 → 恢复。
///
/// 三条纪律：
///   1. **重复聚合**：同一 (deskId, kind) 重复到达只把 occurrences+1、刷 lastSeenAtMs，
///      不制造第二条告警（避免告警轰炸）；
///   2. **确认与恢复互不顶替**：确认不是恢复，恢复也不代表用户看过；
///   3. **历史 append-only**：每次真实的状态转移落一条事件，供追溯（重复确认/重复恢复不重复记）。
public final class AlertLifecycle: @unchecked Sendable {
    private let lock = NSLock()
    private var byKey: [String: AlertRecord] = [:]
    private var firstSeenOrder: [String] = []
    private var events: [AlertEvent] = []

    public init() {}

    /// 聚合键：同一台 desk 上的同一类问题算一条。
    public static func dedupeKey(deskId: String, kind: String) -> String {
        deskId + "|" + kind
    }

    public static func dedupeKey(for payload: PushPayload) -> String {
        dedupeKey(deskId: payload.deskId, kind: payload.kind)
    }

    @discardableResult
    public func observe(_ payload: PushPayload, atMs: Int) -> AlertRecord {
        observe(deskId: payload.deskId, kind: payload.kind, severity: payload.severity, atMs: atMs)
    }

    /// 记录一次"发生"。已存在 ⇒ 重复（聚合）；已恢复的再次发生 ⇒ 新的一轮（清掉上一轮的确认与恢复）。
    @discardableResult
    public func observe(deskId: String, kind: String, severity: String, atMs: Int) -> AlertRecord {
        let key = AlertLifecycle.dedupeKey(deskId: deskId, kind: kind)
        lock.lock(); defer { lock.unlock() }
        if let existing = byKey[key] {
            let reopened = existing.isRecovered
            let next = AlertRecord(
                dedupeKey: key,
                deskId: existing.deskId,
                kind: existing.kind,
                severity: severity,
                firstSeenAtMs: existing.firstSeenAtMs,
                lastSeenAtMs: atMs,
                occurrences: existing.occurrences + 1,
                // 新的一轮：上一轮的"确认"不适用于这次的新故障
                acknowledgedAtMs: reopened ? nil : existing.acknowledgedAtMs,
                recoveredAtMs: nil
            )
            byKey[key] = next
            events.append(AlertEvent(dedupeKey: key, transition: reopened ? .raised : .repeated, severity: severity, atMs: atMs))
            return next
        }
        let record = AlertRecord(
            dedupeKey: key, deskId: deskId, kind: kind, severity: severity,
            firstSeenAtMs: atMs, lastSeenAtMs: atMs, occurrences: 1,
            acknowledgedAtMs: nil, recoveredAtMs: nil
        )
        byKey[key] = record
        firstSeenOrder.append(key)
        events.append(AlertEvent(dedupeKey: key, transition: .raised, severity: severity, atMs: atMs))
        return record
    }

    /// 用户确认。**不是恢复**：记录仍然 open。
    @discardableResult
    public func acknowledge(dedupeKey key: String, atMs: Int) -> AlertRecord? {
        lock.lock(); defer { lock.unlock() }
        guard let existing = byKey[key] else { return nil }
        if existing.isAcknowledged { return existing }   // 幂等：不重复记、不改时间
        let next = AlertRecord(
            dedupeKey: existing.dedupeKey, deskId: existing.deskId, kind: existing.kind,
            severity: existing.severity, firstSeenAtMs: existing.firstSeenAtMs,
            lastSeenAtMs: existing.lastSeenAtMs, occurrences: existing.occurrences,
            acknowledgedAtMs: atMs, recoveredAtMs: existing.recoveredAtMs
        )
        byKey[key] = next
        events.append(AlertEvent(dedupeKey: key, transition: .acknowledged, severity: existing.severity, atMs: atMs))
        return next
    }

    /// 故障恢复。**与确认独立**：一条没被确认的告警也可以恢复；恢复不改 acknowledgedAtMs。
    @discardableResult
    public func recover(dedupeKey key: String, atMs: Int) -> AlertRecord? {
        lock.lock(); defer { lock.unlock() }
        guard let existing = byKey[key] else { return nil }
        if existing.isRecovered { return existing }   // 幂等
        let next = AlertRecord(
            dedupeKey: existing.dedupeKey, deskId: existing.deskId, kind: existing.kind,
            severity: existing.severity, firstSeenAtMs: existing.firstSeenAtMs,
            lastSeenAtMs: existing.lastSeenAtMs, occurrences: existing.occurrences,
            acknowledgedAtMs: existing.acknowledgedAtMs, recoveredAtMs: atMs
        )
        byKey[key] = next
        events.append(AlertEvent(dedupeKey: key, transition: .recovered, severity: existing.severity, atMs: atMs))
        return next
    }

    /// 所有告警（按首次出现顺序，稳定）。
    public var records: [AlertRecord] {
        lock.lock(); defer { lock.unlock() }
        return firstSeenOrder.compactMap { byKey[$0] }
    }

    /// 仍然 open（未恢复）的告警。
    public var openRecords: [AlertRecord] {
        records.filter { $0.isOpen }
    }

    /// append-only 历史。
    public var history: [AlertEvent] {
        lock.lock(); defer { lock.unlock() }
        return events
    }
}
