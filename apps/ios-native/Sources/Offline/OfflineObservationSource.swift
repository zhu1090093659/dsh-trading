//
//  OfflineObservationSource.swift
//  Offline
//
//  离线观测源：**快照优先 + 事件续读**（冻结件 §9）。
//
//    * 快照是**契约**：重连第一步永远是取 GET /v1/cards；WS 事件流只是优化，
//      本文件用 CoalescingBuffer 承接事件路径，缺席也完全可用。
//    * **本地缓存按来源身份归属**：只有 cached.sourceId == 本源的 sourceId 才能被降级使用。
//      来源不同 ⇒ 当作"没有本地快照"（抛错），绝不用别的配对实例的数据凑合显示。
//    * **断线不得清空本地最后快照**，但可信度必须如实降档 —— 做法是：失败时把缓存里的
//      卡片原样返回，并把 atMs 保持为数据被抓到的时刻（不是本次读取时刻），
//      于是 Domain 侧按真实账龄算出 aging/stale/expired/unknown，过期即不再渲染数据本身。
//    * 恢复后产出 **gap report**（断连期间的错过触发、被拒意图、降级动作、持仓变化）。
//
//  **iOS 后台限制（明写）**：App 进入后台后不得假设能保活 —— 系统会挂起、限流乃至回收进程，
//  后台定时器与长连接都不可依赖。这**不影响交易**：权威态与快照都在执行核，执行核不依赖本 App 存活；
//  本 App 醒来后重新走一次"快照优先"即可，代价只是观测延迟，不是执行风险。
//
//  分层：Offline -> Contract + Domain + Foundation（不 import Transport / SwiftUI）。
//

import Foundation
import DshTradingContract
import DshTradingDomain

/// 一次成功抓取的结果（由上层适配器从 Transport 事实装配）。
public struct FetchedSnapshot: Sendable {
    public let cards: [Card]
    public let caps: [String]
    public let downgraded: [String]
    public let truncated: Bool
    /// /a0/status 的结果；**拿不到就是 nil，不许编**（执行状态随之是 .indeterminate）。
    public let a0: A0Status?
    /// 服务端给出/适配器观测到的抓取时刻；nil ⇒ 用注入时钟。
    public let atMs: Int?

    public init(
        cards: [Card],
        caps: [String] = [],
        downgraded: [String] = [],
        truncated: Bool = false,
        a0: A0Status? = nil,
        atMs: Int? = nil
    ) {
        self.cards = cards
        self.caps = caps
        self.downgraded = downgraded
        self.truncated = truncated
        self.a0 = a0
        self.atMs = atMs
    }
}

/// 取快照的端口。
///
/// 契约（实现方必须遵守）：
///   * 先确保"看得见机器人"（/a0/ping）；ping 失败 ⇒ 抛 ObservationFetchFailure(.unreachable)。
///   * cards 失败按类别抛对应失败；**抛非 ObservationFetchFailure 的错误会被当成 .unknown，不重试**。
///   * 拿不到 /a0/status 时 a0 传 nil（而不是编一个 running）。
public protocol SnapshotFetching: Sendable {
    func fetch() async throws -> FetchedSnapshot
}

/// 离线观测源（Domain 的 ObservationSource 实现）。
public actor OfflineObservationSource: ObservationSource {
    private let fetcher: any SnapshotFetching
    /// 本地快照槽 + 来源身份校验（见 SnapshotPersistence.swift 的 SourceScopedSnapshots）。
    private let snapshots: SourceScopedSnapshots
    private let sourceId: String
    private let budget: StalenessBudget
    private let clock: @Sendable () -> Int

    private var gapBuilder: GapReportBuilder?
    private var storedGapReport: GapReport?
    private var lastFailureValue: FetchFailure?
    private var lastErrorValue: String?

    public init(
        fetcher: any SnapshotFetching,
        persistence: any SnapshotPersistence,
        sourceId: String,
        budget: StalenessBudget,
        clock: @escaping @Sendable () -> Int
    ) {
        self.fetcher = fetcher
        self.snapshots = SourceScopedSnapshots(persistence: persistence)
        self.sourceId = sourceId
        self.budget = budget
        self.clock = clock
    }

    /// 上一次失败的类别（成功时清空）。
    public func lastFailure() -> FetchFailure? { lastFailureValue }

    /// 上一次失败给人看的说明。
    public func lastError() -> String? { lastErrorValue }

    /// 当前是否处于失联状态（已开启 gap 记录）。
    public func isDisconnected() -> Bool { gapBuilder != nil }

    /// 取出并清空最近一次恢复产出的 gap report。
    /// **没有报告（nil）与空报告是两件事**：nil = 还没经历过一次恢复。
    public func takeGapReport() -> GapReport? {
        let report = storedGapReport
        storedGapReport = nil
        return report
    }

    public func recordMissedTrigger(_ count: Int = 1) {
        gapBuilder?.recordMissedTrigger(count)
    }

    public func recordRejectedIntent(_ count: Int = 1) {
        gapBuilder?.recordRejectedIntent(count)
    }

    public func recordMissedEscalation(_ count: Int = 1) {
        gapBuilder?.recordMissedEscalation(count)
    }

    public func recordDegradedAction(_ label: String) {
        gapBuilder?.recordDegradedAction(label)
    }

    public func recordPositionChange(_ label: String) {
        gapBuilder?.recordPositionChange(label)
    }

    /// 本地最后快照的陈旧度（冻结件 §9 的判据来自 Contract，不在本层重定义）。
    /// **只认本来源的缓存**：别的配对实例留下的快照不算"我们的本地数据"。
    public func cachedStaleness(nowMs: Int? = nil) -> Staleness {
        let now = nowMs ?? clock()
        return stalenessOf(snapshots.load(sourceId: sourceId), nowMs: now, budget: budget)
    }

    /// 本地最后快照的可渲染视图：**过期只给提示，不给数据本身**。
    /// 来源身份不一致的缓存同样只给提示（走 .unknown 那一档），不渲染别人的卡片。
    public func offlineCardsView(nowMs: Int? = nil) -> OfflineView<[Card]> {
        let now = nowMs ?? clock()
        return offlineView(snapshots.load(sourceId: sourceId), nowMs: now, budget: budget)
    }

    public func fetchSnapshot() async throws -> ObservationSnapshot {
        let nowMs = clock()
        do {
            let fetched = try await fetcher.fetch()
            let dataAtMs = fetched.atMs ?? nowMs
            snapshots.save(OfflineSnapshot(data: fetched.cards, atMs: dataAtMs, sourceId: sourceId))
            if let builder = gapBuilder {
                storedGapReport = builder.build(recoveredAtMs: dataAtMs)
                gapBuilder = nil
            }
            lastFailureValue = nil
            lastErrorValue = nil
            let execution: ExecutionState
            if let a0 = fetched.a0 {
                execution = ExecutionState.fromA0(killed: a0.state.killed, paused: a0.state.paused)
            } else {
                execution = .indeterminate
            }
            return ObservationSnapshot(
                atMs: dataAtMs,
                sourceId: sourceId,
                cards: fetched.cards,
                reachability: .reachable,
                execution: execution,
                a0: fetched.a0,
                heartbeat: nil
            )
        } catch {
            let typed = error as? ObservationFetchFailure
            let failure = typed?.failure ?? .unknown
            if gapBuilder == nil {
                gapBuilder = GapReportBuilder(disconnectedAtMs: nowMs)
            }
            lastFailureValue = failure
            lastErrorValue = typed?.message ?? String(describing: error)
            // **来源身份校验**：cached.sourceId != 本源的 sourceId ⇒ 当作没有缓存。
            // 这不只是"更小心"：重新配对之后旧实例的卡片仍在这个槽里，降级显示它们
            // 等于把另一个机器人的持仓画在当前配对上。走同一条"没有本地快照"路径。
            guard let cached = snapshots.load(sourceId: sourceId) else {
                throw ObservationFetchFailure(
                    failure: failure,
                    message: "没有本地快照可降级显示：" + (typed?.message ?? String(describing: error))
                )
            }
            // 断线不清空最后快照；atMs 保持数据被抓到的时刻，可信度因此如实降档。
            return ObservationSnapshot(
                atMs: cached.atMs,
                sourceId: cached.sourceId,
                cards: cached.data,
                reachability: .unreachable(reason: failure.label),
                execution: .indeterminate,
                a0: nil,
                heartbeat: nil
            )
        }
    }
}
