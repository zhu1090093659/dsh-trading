import XCTest
import DshTradingContract
import DshTradingDomain
@testable import DshTradingOffline

/// 来源身份与本地快照的绑定（IOS-7 负例）。
///
/// 这些用例断言的是**跨配对实例的缓存污染**：配对实例 A 抓到的快照，绝不能因为
/// B 的第一次取数失败就被当成 B 自己的数据渲染出来。
/// 禁 mock、禁 sleep：取数端口是按脚本回放的真实实现，时间由注入时钟给定。
@MainActor
final class PairingScopedSnapshotTests: XCTestCase {

    private let budget = StalenessBudget(freshMs: 1_000, staleMs: 2_000, ttlMs: 3_000)

    private func card(_ id: String, _ revision: Double) -> Card {
        Card(cardId: id, cardType: "desk-summary", revision: revision, fallbackText: "fb", fields: [], actions: [], freshnessMs: nil as Double?)
    }

    private func failing() -> ScriptedFetcher {
        ScriptedFetcher([.failure(ObservationFetchFailure(failure: .unreachable, message: "offline"))])
    }

    /// 配对 A 抓过快照 → 重新配对到 B（来源身份不同）→ B 首次取数失败。
    /// B **不得**渲染 A 的任何卡片：跨源缓存只能当作"没有本地快照"。
    func test_givenSnapshotFromPairingA_whenPairingBFails_thenNoCardFromAIsRendered() async {
        let persistence = InMemorySnapshotPersistence()
        // Given 配对实例 A 留下的本地快照（它属于 A，不属于 B）
        persistence.save(OfflineSnapshot(data: [card("from-a", 1)], atMs: 1_000, sourceId: "live:originA#1"))
        // When 重新配对到实例 B，B 的第一次抓取就失败
        let sourceB = OfflineObservationSource(
            fetcher: failing(),
            persistence: persistence,
            sourceId: "live:originB#2",
            budget: budget,
            clock: { 1_000 }
        )
        let store = ObservationStore(source: sourceB, commands: nil, clock: { 1_000 })

        await store.refresh()

        // Then B 不给任何卡片：没有可渲染的观测态
        XCTAssertNil(store.observation, "B 不得把 A 的本地快照当成自己的数据渲染")
    }

    /// 来源身份不匹配的缓存**不得被使用**，且要与"从来没有过本地快照"走**同一条**路径（抛错）。
    func test_givenCachedSnapshotWithAnotherSourceId_whenFetchFails_thenItThrowsLikeNoCacheAtAll() async {
        let persistence = InMemorySnapshotPersistence()
        persistence.save(OfflineSnapshot(data: [card("from-a", 1)], atMs: 1_000, sourceId: "live:originA#1"))
        let sourceB = OfflineObservationSource(
            fetcher: failing(),
            persistence: persistence,
            sourceId: "live:originB#2",
            budget: budget,
            clock: { 1_000 }
        )

        do {
            _ = try await sourceB.fetchSnapshot()
            XCTFail("来源身份不匹配的缓存必须当作没有缓存：应当抛 ObservationFetchFailure")
        } catch let failure as ObservationFetchFailure {
            XCTAssertEqual(failure.failure, .unreachable)
            XCTAssertTrue(failure.message.contains("没有本地快照"), "必须走同一条'没有本地快照'路径，实际：" + failure.message)
        } catch {
            XCTFail("应抛 ObservationFetchFailure，实际 " + String(describing: error))
        }
    }

    /// 缓存视图助手也必须按来源身份过滤：B 看不到 A 的陈旧度。
    func test_givenCachedSnapshotWithAnotherSourceId_whenReadingCacheView_thenItIsUnknown() async {
        let persistence = InMemorySnapshotPersistence()
        persistence.save(OfflineSnapshot(data: [card("from-a", 1)], atMs: 1_000, sourceId: "live:originA#1"))
        let sourceB = OfflineObservationSource(
            fetcher: failing(),
            persistence: persistence,
            sourceId: "live:originB#2",
            budget: budget,
            clock: { 1_500 }
        )

        let staleness = await sourceB.cachedStaleness()
        XCTAssertEqual(staleness, .unknown, "别的实例的快照不构成 B 自己的本地数据")

        guard case .notice(.unknown, _) = await sourceB.offlineCardsView() else {
            return XCTFail("没有属于 B 的本地快照时只能给提示，不能给数据")
        }
    }

    /// 来源身份的派生：**不同配对实例必须得到不同 sourceId**（不再是一个写死的常量），
    /// 且同一 origin 重新配对（代际前移）也要换身份 —— 否则"来源身份校验"永远为真。
    func test_givenTwoPairings_whenDerivingSourceId_thenIdentitiesDifferForBothOriginAndEpoch() {
        let pairingA = SnapshotSourceId.live(origin: "http://127.0.0.1:3081", epoch: 1)
        let sameOriginNextPairing = SnapshotSourceId.live(origin: "http://127.0.0.1:3081", epoch: 2)
        let pairingB = SnapshotSourceId.live(origin: "http://127.0.0.1:3082", epoch: 1)

        XCTAssertNotEqual(pairingA, sameOriginNextPairing, "同 origin 重新配对必须换身份（代际进了来源身份）")
        XCTAssertNotEqual(pairingA, pairingB, "不同 origin 必须换身份")
        XCTAssertNotEqual(pairingA, SnapshotSourceId.fixtures)
        XCTAssertNotEqual(pairingA, SnapshotSourceId.unpaired)
        XCTAssertNotEqual(pairingA, "live", "绝不允许退回那个所有配对都相同的常量")
    }

    /// 解绑 / 重新配对：旧实例的缓存必须失效，**连来源相同的那份也不留**。
    func test_givenCachedSnapshot_whenInvalidatingForRepairing_thenPersistenceIsEmpty() {
        let persistence = InMemorySnapshotPersistence()
        let snapshots = SourceScopedSnapshots(persistence: persistence)
        snapshots.save(OfflineSnapshot(data: [card("mine", 1)], atMs: 1_000, sourceId: "live:a#1"))

        snapshots.invalidate()

        XCTAssertNil(persistence.load(), "解绑之后 persistence 必须为空")
        XCTAssertNil(snapshots.load(sourceId: "live:a#1"), "同一来源也不许再读到旧实例的缓存")
    }

    /// 正对照：来源身份**相同**的缓存仍要照常降级显示（修复不得把缓存整个关掉）。
    func test_givenCachedSnapshotWithTheSameSourceId_whenFetchFails_thenItIsStillUsed() async throws {
        let persistence = InMemorySnapshotPersistence()
        persistence.save(OfflineSnapshot(data: [card("mine", 1)], atMs: 1_000, sourceId: "live:originB#2"))
        let sourceB = OfflineObservationSource(
            fetcher: failing(),
            persistence: persistence,
            sourceId: "live:originB#2",
            budget: budget,
            clock: { 1_500 }
        )

        let snapshot = try await sourceB.fetchSnapshot()

        XCTAssertEqual(snapshot.cards.map(\.cardId), ["mine"])
        XCTAssertEqual(snapshot.atMs, 1_000, "atMs 必须是数据被抓到的时刻，可信度才能如实降档")
    }
}
