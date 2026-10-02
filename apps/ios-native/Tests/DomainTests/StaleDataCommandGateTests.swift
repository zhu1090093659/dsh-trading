import XCTest
import DshTradingContract
@testable import DshTradingDomain

/// 旧数据在屏时的命令通道（IOS-7 第 4 条）。
///
/// 判据只有一个家：DataTrust.blocksCommands（过期 / 尚未确认 ⇒ 禁止下发命令）。
/// 这里断言它**真的接在** ObservationStore.send 上，而不只是一条没人读的属性。
@MainActor
final class StaleDataCommandGateTests: XCTestCase {

    /// 屏上数据已过期 ⇒ 控制动作不得发出去（fail-closed，不是"发出去让服务端拒"）。
    func test_givenExpiredDataOnScreen_whenSendingControlAction_thenCommandIsNeverSent() async {
        let sink = RecordingSink()
        // atMs=0、nowMs=10_000_000 ⇒ 账龄远超客户端默认保留期（60 分钟）⇒ expired
        let expired = Fixtures.snapshot(cards: [], atMs: 0)
        let store = ObservationStore(
            source: SequencedSource([.success(expired)]),
            commands: sink,
            clock: { 10_000_000 }
        )

        await store.refresh()
        XCTAssertEqual(store.observation?.bot.trust, .expired, "前置条件：屏上数据必须是已过期")

        let outcome = await store.send(ActionKind.kill, params: [:], gate: FixedGate(decision: .approved))

        XCTAssertFalse(outcome.accepted)
        let sent = await sink.receivedCount()
        XCTAssertEqual(sent, 0, "已过期数据在屏时一个命令都不许发出去")
    }

    /// 还没有任何可信数据 ⇒ 同样不得下发（没有观测依据就没有动作）。
    func test_givenNoObservationAtAll_whenSendingAction_thenCommandIsNeverSent() async {
        let sink = RecordingSink()
        let store = ObservationStore(
            source: SequencedSource([.failure(.unreachable)]),
            commands: sink,
            clock: { 1_000 }
        )

        await store.refresh()
        XCTAssertNil(store.observation, "前置条件：没有任何观测态")

        let outcome = await store.send(ActionKind.ack, params: [:], gate: FixedGate(decision: .approved))

        XCTAssertFalse(outcome.accepted)
        let sent = await sink.receivedCount()
        XCTAssertEqual(sent, 0, "没有观测数据时不许下发任何命令")
    }

    /// 正对照：数据可信时命令照常下发（修复不得把命令通道整个关掉）。
    func test_givenFreshDataOnScreen_whenSendingAction_thenCommandReachesSink() async {
        let sink = RecordingSink()
        let fresh = Fixtures.snapshot(
            cards: [Fixtures.riskStateCard(level: "normal", alignment: "aligned")],
            atMs: 1_000,
            heartbeat: Fixtures.healthyHeartbeat
        )
        let store = ObservationStore(source: SequencedSource([.success(fresh)]), commands: sink, clock: { 1_000 })

        await store.refresh()
        XCTAssertEqual(store.observation?.bot.trust, .fresh, "前置条件：数据新鲜")

        let outcome = await store.send(ActionKind.ack, params: [:], gate: FixedGate(decision: .approved))

        XCTAssertTrue(outcome.accepted)
        let sent = await sink.receivedCount()
        XCTAssertEqual(sent, 1)
    }
}
