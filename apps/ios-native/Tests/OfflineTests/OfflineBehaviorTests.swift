import XCTest
import DshTradingContract
import DshTradingDomain
@testable import DshTradingOffline

/// 按脚本回放的取数端口（ObservationSource/SnapshotFetching 的真实最小实现，
/// 不桩内部、不 sleep；时间由注入时钟给定）。
actor ScriptedFetcher: SnapshotFetching {
    private var steps: [Result<FetchedSnapshot, ObservationFetchFailure>]

    init(_ steps: [Result<FetchedSnapshot, ObservationFetchFailure>]) {
        self.steps = steps
    }

    func fetch() async throws -> FetchedSnapshot {
        guard !steps.isEmpty else {
            throw ObservationFetchFailure(failure: .unknown, message: "脚本已用尽")
        }
        switch steps.removeFirst() {
        case let .success(snapshot): return snapshot
        case let .failure(failure): throw failure
        }
    }
}

private func card(_ id: String, _ revision: Double, type: String = "desk-summary") -> Card {
    Card(cardId: id, cardType: type, revision: revision, fallbackText: "fb", fields: [], actions: [], freshnessMs: nil)
}

private func a0(killed: Bool, paused: Bool, atMs: Int) -> A0Status {
    A0Status(
        ok: true,
        state: KillState(killed: killed, paused: paused, reason: "test", atMs: atMs),
        device: "dev-1",
        scopes: [.read]
    )
}

private let budget = StalenessBudget(freshMs: 1_000, staleMs: 2_000, ttlMs: 3_000)

final class OfflineBackoffTests: XCTestCase {

    func test_givenRepeatedFailures_whenScheduling_thenDelayGrowsAndStaysBoundedAndNeverSleeps() {
        let policy = BackoffPolicy(baseMs: 100, maxMs: 1_000, multiplier: 2, jitterFraction: 0, maxAttempts: 6)

        XCTAssertEqual(RetryScheduler.decide(attempt: 0, failure: .unreachable, policy: policy, randomFraction: 0), .retry(afterMs: 100))
        XCTAssertEqual(RetryScheduler.decide(attempt: 1, failure: .unreachable, policy: policy, randomFraction: 0), .retry(afterMs: 200))
        XCTAssertEqual(RetryScheduler.decide(attempt: 2, failure: .unreachable, policy: policy, randomFraction: 0), .retry(afterMs: 400))
        // 有上限：再多的失败也不会超过 maxMs（次数上限另管，这里直接看延迟函数）
        XCTAssertEqual(policy.delayMs(attempt: 9, randomFraction: 0), 1_000)
        XCTAssertLessThanOrEqual(policy.delayMs(attempt: 99, randomFraction: 0), policy.maxMs)
        // 次数上限到点就必须放弃，而不是继续按上限延迟重试
        XCTAssertEqual(RetryScheduler.decide(attempt: 9, failure: .unreachable, policy: policy, randomFraction: 0), .giveUp(reason: "重试次数已达上限（6）"))
    }

    func test_givenJitterFraction_whenRandomFractionVaries_thenDelayStaysWithinTheJitterBand() {
        let policy = BackoffPolicy(baseMs: 1_000, maxMs: 10_000, multiplier: 2, jitterFraction: 0.5, maxAttempts: 8)

        XCTAssertEqual(RetryScheduler.decide(attempt: 0, failure: .unreachable, policy: policy, randomFraction: 0).delayMs, 1_000)
        XCTAssertEqual(RetryScheduler.decide(attempt: 0, failure: .unreachable, policy: policy, randomFraction: 1).delayMs, 500)
        // 单调不减（同 randomFraction）
        let first = RetryScheduler.decide(attempt: 0, failure: .unreachable, policy: policy, randomFraction: 0.25).delayMs ?? 0
        let second = RetryScheduler.decide(attempt: 2, failure: .unreachable, policy: policy, randomFraction: 0.25).delayMs ?? 0
        XCTAssertGreaterThan(second, first)
    }

    /// 「不该重试」的失败必须直接放弃 —— 否则用户会一直卡在转圈里。
    func test_givenNonRetryableFailure_whenScheduling_thenGivesUpInsteadOfRetrying() {
        let policy = BackoffPolicy(baseMs: 100, maxMs: 1_000, multiplier: 2, jitterFraction: 0, maxAttempts: 6)

        for failure in [FetchFailure.originNotBound, .unauthorized, .scopeRequired, .clientTooOld, .unknown] {
            let decision = RetryScheduler.decide(attempt: 0, failure: failure, policy: policy, randomFraction: 0)
            guard case .giveUp = decision else {
                XCTFail("失败类别 " + failure.rawValue + " 不该重试，却得到 " + String(describing: decision))
                continue
            }
            XCTAssertNil(decision.delayMs)
        }
        // 可重试的两类仍然重试
        XCTAssertEqual(RetryScheduler.decide(attempt: 0, failure: .unreachable, policy: policy, randomFraction: 0).delayMs, 100)
        XCTAssertEqual(RetryScheduler.decide(attempt: 0, failure: .badResponse, policy: policy, randomFraction: 0).delayMs, 100)
    }

    func test_givenRelinkingFailures_whenScheduling_thenGiveUpReasonSaysRepairPairing() {
        let policy = BackoffPolicy(baseMs: 100, maxMs: 1_000, multiplier: 2, jitterFraction: 0, maxAttempts: 6)
        let decision = RetryScheduler.decide(attempt: 0, failure: .unauthorized, policy: policy, randomFraction: 0)

        guard case let .giveUp(reason) = decision else {
            return XCTFail("应当放弃重试")
        }
        XCTAssertTrue(reason.contains("重新配对"))
        XCTAssertTrue(FetchFailure.unauthorized.requiresRelinking)
        XCTAssertFalse(FetchFailure.unreachable.requiresRelinking)
    }

    func test_givenAttemptCapReached_whenScheduling_thenGivesUpWithAttemptReason() {
        let policy = BackoffPolicy(baseMs: 100, maxMs: 1_000, multiplier: 2, jitterFraction: 0, maxAttempts: 3)
        let decision = RetryScheduler.decide(attempt: 2, failure: .unreachable, policy: policy, randomFraction: 0)

        guard case let .giveUp(reason) = decision else {
            return XCTFail("到次数上限应当放弃")
        }
        XCTAssertTrue(reason.contains("上限"))
    }

    /// 未知类别必须 fail-closed（不许被误判成可重试）。
    func test_givenUnknownFailureKindRawValue_whenBridged_thenFailsClosedToUnknown() {
        XCTAssertEqual(FetchFailure(kindRawValue: "brandNewFailure"), .unknown)
        XCTAssertEqual(FetchFailure(kindRawValue: nil), .unknown)
        XCTAssertFalse(FetchFailure(kindRawValue: "brandNewFailure").isRetryable)
        // 已知类别按 rawValue 桥接
        XCTAssertEqual(FetchFailure(kindRawValue: "unauthorized"), .unauthorized)
        XCTAssertEqual(FetchFailure(kindRawValue: "unreachable"), .unreachable)
    }
}

final class CardCoalescingTests: XCTestCase {

    func test_givenOutOfOrderRevisions_whenCoalesced_thenHighestRevisionWins() {
        let merged = CardCoalescer.coalesce([
            card("a", 3),
            card("b", 1),
            card("a", 1),
            card("a", 7),
            card("b", 5),
        ])

        XCTAssertEqual(merged.map(\.cardId), ["a", "b"])
        XCTAssertEqual(merged.map(\.revision), [7, 5])
    }

    func test_givenManyOffers_whenDrained_thenOneMergedPublishAndBufferIsEmpty() {
        var buffer = CoalescingBuffer()
        buffer.offer(card("a", 1))
        buffer.offer([card("a", 2), card("b", 1)])
        buffer.offer(card("b", 4))

        XCTAssertEqual(buffer.pendingCount, 4)

        let published = buffer.drain()
        XCTAssertEqual(published.map(\.cardId), ["a", "b"])
        XCTAssertEqual(published.map(\.revision), [2, 4])
        XCTAssertEqual(buffer.pendingCount, 0)
        XCTAssertTrue(buffer.drain().isEmpty)
    }
}

final class SnapshotPersistenceTests: XCTestCase {

    func test_givenSavedSnapshot_whenLoaded_thenAtMsAndSourceIdArePreserved() {
        let store = InMemorySnapshotPersistence()
        store.save(OfflineSnapshot(data: [card("a", 1)], atMs: 1_234, sourceId: "src-local"))

        let loaded = store.load()
        XCTAssertEqual(loaded?.atMs, 1_234)
        XCTAssertEqual(loaded?.sourceId, "src-local")
        XCTAssertEqual(loaded?.data.map(\.cardId), ["a"])
    }

    func test_givenClearedStore_whenLoaded_thenNil() {
        let store = InMemorySnapshotPersistence()
        store.save(OfflineSnapshot(data: [card("a", 1)], atMs: 1, sourceId: "s"))
        store.clear()

        XCTAssertNil(store.load())
    }

    func test_givenCardSnapshotStore_whenRoundTripped_thenPayloadSurvives() {
        let store = CardSnapshotStore(persistence: InMemorySnapshotPersistence())
        store.save(OfflineSnapshot(data: [card("a", 2)], atMs: 9, sourceId: "s"))

        XCTAssertEqual(store.load()?.data.map(\.revision), [2])
    }
}

final class OfflineObservationSourceTests: XCTestCase {

    private func makeSource(
        steps: [Result<FetchedSnapshot, ObservationFetchFailure>],
        persistence: InMemorySnapshotPersistence,
        nowMs: Int
    ) -> OfflineObservationSource {
        OfflineObservationSource(
            fetcher: ScriptedFetcher(steps),
            persistence: persistence,
            sourceId: "src-local",
            budget: budget,
            clock: { nowMs }
        )
    }

    func test_givenSuccessfulFetch_whenFetching_thenReachableAndCachedAndExecutionFromA0() async throws {
        let persistence = InMemorySnapshotPersistence()
        let source = makeSource(
            steps: [.success(FetchedSnapshot(cards: [card("a", 1)], a0: a0(killed: false, paused: false, atMs: 1_000), atMs: 1_000))],
            persistence: persistence,
            nowMs: 1_000
        )

        let snapshot = try await source.fetchSnapshot()

        XCTAssertEqual(snapshot.reachability, .reachable)
        XCTAssertEqual(snapshot.execution, .running)
        XCTAssertEqual(snapshot.atMs, 1_000)
        XCTAssertEqual(snapshot.cards.map(\.cardId), ["a"])
        XCTAssertEqual(persistence.load()?.atMs, 1_000)
        let disconnected = await source.isDisconnected()
        XCTAssertFalse(disconnected)
    }

    func test_givenA0Unavailable_whenFetching_thenExecutionIsIndeterminateNotRunning() async throws {
        let source = makeSource(
            steps: [.success(FetchedSnapshot(cards: [card("a", 1)], a0: nil, atMs: 1_000))],
            persistence: InMemorySnapshotPersistence(),
            nowMs: 1_000
        )

        let snapshot = try await source.fetchSnapshot()

        XCTAssertEqual(snapshot.execution, .indeterminate)
        XCTAssertEqual(snapshot.reachability, .reachable)
        XCTAssertTrue(snapshot.execution.blocksNewRisk)
    }

    func test_givenKilledA0_whenFetching_thenExecutionIsKilled() async throws {
        let source = makeSource(
            steps: [.success(FetchedSnapshot(cards: [], a0: a0(killed: true, paused: false, atMs: 1_000), atMs: 1_000))],
            persistence: InMemorySnapshotPersistence(),
            nowMs: 1_000
        )

        let snapshot = try await source.fetchSnapshot()
        XCTAssertEqual(snapshot.execution, .killed)
    }

    /// 断线不得清空最后快照；但可信度必须如实降档（账龄从数据被抓到的时刻算起）。
    func test_givenFailureAfterSuccess_whenFetching_thenLastSnapshotKeptAndMarkedUnreachable() async throws {
        let persistence = InMemorySnapshotPersistence()
        let source = makeSource(
            steps: [
                .success(FetchedSnapshot(cards: [card("a", 3)], a0: a0(killed: false, paused: false, atMs: 1_000), atMs: 1_000)),
                .failure(ObservationFetchFailure(failure: .unreachable, message: "offline")),
            ],
            persistence: persistence,
            nowMs: 1_000
        )

        _ = try await source.fetchSnapshot()
        let downgraded = try await source.fetchSnapshot()

        XCTAssertEqual(downgraded.reachability, .unreachable(reason: "连不上机器人"))
        XCTAssertEqual(downgraded.execution, .indeterminate)
        XCTAssertEqual(downgraded.cards.map(\.cardId), ["a"], "最后快照必须留着")
        XCTAssertEqual(downgraded.atMs, 1_000, "atMs 必须是数据被抓到的时刻，否则可信度会被算成最新")
        XCTAssertNil(downgraded.a0)
        let disconnected = await source.isDisconnected()
        let failure = await source.lastFailure()
        XCTAssertTrue(disconnected)
        XCTAssertEqual(failure, .unreachable)
        // 注入时钟与数据时刻相同 ⇒ 账龄 0，仍新鲜；账龄增长后的降档见 offlineCardsView 用例
        let staleness = await source.cachedStaleness()
        XCTAssertEqual(staleness, .fresh)
    }

    func test_givenFailureWithNoCache_whenFetching_thenThrowsSoStoreKeepsObservationNil() async {
        let source = makeSource(
            steps: [.failure(ObservationFetchFailure(failure: .unreachable, message: "offline"))],
            persistence: InMemorySnapshotPersistence(),
            nowMs: 1_000
        )

        do {
            _ = try await source.fetchSnapshot()
            XCTFail("没有本地快照时必须抛错，让上层保持 observation == nil")
        } catch let failure as ObservationFetchFailure {
            XCTAssertEqual(failure.failure, .unreachable)
            XCTAssertTrue(failure.message.contains("没有本地快照"))
        } catch {
            XCTFail("应抛 ObservationFetchFailure，实际 " + String(describing: error))
        }
    }

    /// 恢复必须产出 gap report；空报告与"没有报告"是两件事。
    func test_givenDisconnectThenRecovery_whenFetching_thenGapReportIsProducedThenCleared() async throws {
        let persistence = InMemorySnapshotPersistence()
        let source = makeSource(
            steps: [
                .success(FetchedSnapshot(cards: [card("a", 1)], a0: a0(killed: false, paused: false, atMs: 1_000), atMs: 1_000)),
                .failure(ObservationFetchFailure(failure: .unreachable, message: "offline")),
                .success(FetchedSnapshot(cards: [card("a", 2)], a0: a0(killed: false, paused: false, atMs: 2_000), atMs: 2_000)),
            ],
            persistence: persistence,
            nowMs: 1_000
        )

        _ = try await source.fetchSnapshot()
        _ = try await source.fetchSnapshot()
        await source.recordMissedTrigger(2)
        await source.recordRejectedIntent()
        await source.recordDegradedAction("reduce_only")
        await source.recordPositionChange("BTC 数量变化")
        _ = try await source.fetchSnapshot()

        let report = await source.takeGapReport()
        XCTAssertNotNil(report)
        XCTAssertEqual(report?.missedTriggers, 2)
        XCTAssertEqual(report?.rejectedIntents, 1)
        XCTAssertEqual(report?.degradedActions, ["reduce_only"])
        XCTAssertEqual(report?.positionChanges, ["BTC 数量变化"])
        XCTAssertEqual(report?.disconnectedAtMs, 1_000)
        XCTAssertEqual(report?.recoveredAtMs, 2_000)
        XCTAssertEqual(report?.isEmpty, false)
        XCTAssertTrue(report?.summary.contains("错过触发 2") ?? false)
        // 取走即清空
        let second = await source.takeGapReport()
        XCTAssertNil(second)
        let stillDisconnected = await source.isDisconnected()
        XCTAssertFalse(stillDisconnected)
    }

    func test_givenCleanRecovery_whenFetching_thenEmptyGapReportIsStillProduced() async throws {
        let persistence = InMemorySnapshotPersistence()
        let source = makeSource(
            steps: [
                .failure(ObservationFetchFailure(failure: .unreachable, message: "offline")),
                .success(FetchedSnapshot(cards: [card("a", 1)], a0: nil, atMs: 2_000)),
            ],
            persistence: persistence,
            nowMs: 2_000
        )
        persistence.save(OfflineSnapshot(data: [card("old", 1)], atMs: 2_000, sourceId: "src-local"))

        _ = try await source.fetchSnapshot()
        _ = try await source.fetchSnapshot()

        let report = await source.takeGapReport()
        XCTAssertNotNil(report, "经历一次恢复就必须有报告，哪怕期间什么都没发生")
        XCTAssertEqual(report?.isEmpty, true)
        XCTAssertTrue(report?.summary.contains("没有错过") ?? false)
    }

    /// 过期数据只给提示，不给数据本身（冻结件 §9 / §10.2）。
    func test_givenAgedCache_whenViewingOffline_thenNoticeInsteadOfData() async throws {
        let persistence = InMemorySnapshotPersistence()
        persistence.save(OfflineSnapshot(data: [card("a", 1)], atMs: 1_000, sourceId: "src-local"))
        let source = makeSource(steps: [], persistence: persistence, nowMs: 2_500)

        let stalenessBefore = await source.cachedStaleness()
        XCTAssertEqual(stalenessBefore, .aging, "atMs=1000 且 nowMs=2500 ⇒ 账龄 1500ms，落在 aging 档")
        guard case let .data(_, staleness, badge) = await source.offlineCardsView() else {
            return XCTFail("保留期内应当渲染数据")
        }
        XCTAssertEqual(staleness, .aging)
        XCTAssertEqual(badge, "数据可能已变化")

        // 同一份快照，10 秒后（早于 ttl=3000? 不，超出 ttl）⇒ 过期
        let old = makeSource(steps: [], persistence: persistence, nowMs: 9_000)
        let stalenessAfter = await old.cachedStaleness()
        XCTAssertEqual(stalenessAfter, .expired)
        guard case let .notice(staleness, message) = await old.offlineCardsView() else {
            return XCTFail("过期必须只给提示，不给数据本身")
        }
        XCTAssertEqual(staleness, .expired)
        XCTAssertTrue(message.contains("已过期"))
    }

    func test_givenNoCacheAtAll_whenViewingOffline_thenUnknownNoticeNotFabricatedData() async {
        let source = makeSource(steps: [], persistence: InMemorySnapshotPersistence(), nowMs: 1_000)

        guard case let .notice(staleness, _) = await source.offlineCardsView() else {
            return XCTFail("没有任何本地数据时必须给提示")
        }
        XCTAssertEqual(staleness, .unknown)
    }
}
