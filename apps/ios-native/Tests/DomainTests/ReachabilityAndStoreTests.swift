import XCTest
import DshTradingContract
@testable import DshTradingDomain

/// 卡的核心判据：「App 看不到机器人」与「机器人已停止」是**两种显示**，
/// 且「已连上但无法判定执行状态」是第三种。
final class ReachabilityVsStoppedTests: XCTestCase {

    private func blockedReport() -> DependencyReport {
        DependencyReport(
            marketData: .known(.delayed),
            tradeChannel: .known(.normal),
            accountSync: .known(.ok),
            riskLevel: .known(.reduceOnly),
            priceStates: [InstrumentPriceState(symbol: "BTC", alignment: .known(.aligned))]
        )
    }

    /// 情形 A：机器人**仍在运行**，依赖异常、已禁止新增仓位。
    func test_givenRunningBotWithBlockedDependencies_whenProjected_thenRunningRestrictedNotStopped() {
        let report = blockedReport()
        let permission = report.permission(for: "BTC")
        let blockers = DependencyAssessment.blockers(
            DependencyAssessment.issues(report, permission: permission, symbol: "BTC")
        )
        let verdict = ObservationProjector.verdictFor(
            reachability: .reachable,
            execution: .running,
            dependency: DependencyHealth.from(report, symbol: "BTC"),
            trust: .fresh,
            openRiskAllowed: permission.openRiskAllowed,
            blockers: blockers
        )

        XCTAssertEqual(verdict, .runningRestricted(reasons: ["风控限制：只减不增"]))
        XCTAssertFalse(verdict.isConfirmedStopped)
        XCTAssertFalse(verdict.isUnknown)
        XCTAssertEqual(verdict.title, "机器人运行中（受限：禁止新增仓位；风控限制：只减不增）")
    }

    /// 情形 B：连接中断，机器人状态**未知**（不许拿"最后一次读到的东西"当现状）。
    func test_givenLinkDown_whenProjected_thenCannotSeeBotAndNeverStopped() {
        let verdict = ObservationProjector.verdictFor(
            reachability: .unreachable(reason: "连接失败"),
            execution: .indeterminate,
            dependency: .unknown,
            trust: .unknown,
            openRiskAllowed: false,
            blockers: []
        )

        XCTAssertEqual(verdict, .cannotSeeBot(reason: "连接失败"))
        XCTAssertFalse(verdict.isConfirmedStopped)
        XCTAssertTrue(verdict.isUnknown)
        XCTAssertEqual(verdict.title, "看不到机器人（连接失败）")
    }

    /// 两者**不得**渲染成同一句话。
    func test_givenTheTwoScenarios_whenCompared_thenTitlesDifferAndNeitherIsStopped() {
        let report = blockedReport()
        let permission = report.permission(for: "BTC")
        let scenarioA = ObservationProjector.verdictFor(
            reachability: .reachable,
            execution: .running,
            dependency: DependencyHealth.from(report, symbol: "BTC"),
            trust: .fresh,
            openRiskAllowed: permission.openRiskAllowed,
            blockers: DependencyAssessment.blockers(
                DependencyAssessment.issues(report, permission: permission, symbol: "BTC")
            )
        )
        let scenarioB = ObservationProjector.verdictFor(
            reachability: .unreachable(reason: "超时"),
            execution: .killed,
            dependency: .unknown,
            trust: .unknown,
            openRiskAllowed: false,
            blockers: []
        )

        XCTAssertNotEqual(scenarioA, scenarioB)
        XCTAssertNotEqual(scenarioA.title, scenarioB.title)
        XCTAssertNotEqual(scenarioA.title, ObservationVerdict.stopped.title)
        XCTAssertNotEqual(scenarioB.title, ObservationVerdict.stopped.title)
        XCTAssertFalse(scenarioA.isConfirmedStopped)
        XCTAssertFalse(scenarioB.isConfirmedStopped)
    }

    /// **看不到机器人时，即使最后一次读到的是 killed，也不得显示"已停止"。**
    func test_givenUnreachableButLastKnownKilled_whenProjected_thenStillCannotSeeBot() {
        let verdict = ObservationProjector.verdictFor(
            reachability: .unreachable(reason: "未配对"),
            execution: .killed,
            dependency: .healthy,
            trust: .fresh,
            openRiskAllowed: false,
            blockers: []
        )

        XCTAssertEqual(verdict, .cannotSeeBot(reason: "未配对"))
        XCTAssertNotEqual(verdict.title, ObservationVerdict.stopped.title)
        XCTAssertFalse(verdict.isConfirmedStopped)
    }

    /// 第三种显示：已连上但拿不到 A0 状态 ⇒ 不允许默认成 running。
    func test_givenReachableWithoutAuthoritativeExecutionState_whenProjected_thenIndeterminate() {
        XCTAssertEqual(ExecutionState.fromA0(killed: false, paused: false), .running)
        XCTAssertEqual(ExecutionState.fromA0(killed: true, paused: false), .killed)
        XCTAssertEqual(ExecutionState.fromA0(killed: false, paused: true), .paused)

        let verdict = ObservationProjector.verdictFor(
            reachability: .reachable,
            execution: .indeterminate,
            dependency: .healthy,
            trust: .fresh,
            openRiskAllowed: false,
            blockers: []
        )

        XCTAssertEqual(verdict, .indeterminate)
        XCTAssertTrue(verdict.isUnknown)
        XCTAssertFalse(verdict.isConfirmedStopped)
        XCTAssertEqual(verdict.title, "已连上但无法判定执行状态")
    }

    /// 数据不可信时：不渲染数据本身，也不推断状态。
    func test_givenReachableBotWithExpiredTrust_whenProjected_thenDataNotTrustworthyNotStopped() {
        let verdict = ObservationProjector.verdictFor(
            reachability: .reachable,
            execution: .running,
            dependency: .healthy,
            trust: .expired,
            openRiskAllowed: true,
            blockers: []
        )

        XCTAssertEqual(verdict, .dataNotTrustworthy(trust: .expired))
        XCTAssertFalse(verdict.isConfirmedStopped)
        XCTAssertFalse(DataTrust.expired.rendersData)
    }

    func test_givenReachabilityFromLink_whenLinkDown_thenUnreachable() {
        XCTAssertEqual(BotReachability.from(link: .connected), .reachable)
        XCTAssertEqual(BotReachability.from(link: .degraded), .reachable)
        XCTAssertEqual(BotReachability.from(link: .down), .unreachable(reason: "与监控服务连接中断"))
    }
}

/// 观测态存储：断线不清空最后快照但如实降档；确认闸门不可用即 fail-closed。
@MainActor
final class ObservationStoreTests: XCTestCase {

    private func healthySnapshot() -> ObservationSnapshot {
        Fixtures.snapshot(
            cards: [Fixtures.riskStateCard(level: "normal", alignment: "aligned")],
            reachability: .reachable,
            execution: .running,
            atMs: 1_000,
            heartbeat: Fixtures.healthyHeartbeat
        )
    }

    func test_givenHealthySnapshot_whenRefreshed_thenStorePublishesObservationAndConfirmsHealthyTime() async {
        let source = SequencedSource([.success(healthySnapshot())])
        let store = ObservationStore(source: source, commands: nil, clock: { 1_000 })

        await store.refresh()

        XCTAssertNil(store.lastError)
        XCTAssertNotNil(store.observation)
        XCTAssertEqual(store.observation?.bot.reachability, .reachable)
        XCTAssertEqual(store.observation?.bot.execution, .running)
        XCTAssertEqual(store.observation?.bot.dependency, .healthy)
        XCTAssertEqual(store.observation?.bot.trust, .fresh)
        XCTAssertEqual(store.observation?.bot.assessment?.verdict, .running)
        XCTAssertTrue(store.observation?.bot.assessment?.health.businessHealthy == true)
        XCTAssertEqual(store.lastConfirmedHealthyAtMs, 1_000)
    }

    func test_givenSourceFailsAfterSuccess_whenRefreshed_thenLastSnapshotKeptButTrustDowngraded() async {
        let source = SequencedSource([
            .success(healthySnapshot()),
            .failure(.unreachable),
        ])
        let store = ObservationStore(source: source, commands: nil, clock: { 1_000 })

        await store.refresh()
        XCTAssertEqual(store.observation?.bot.trust, .fresh)

        await store.refresh()

        // 断线不得清空最后快照（冻结件 §9）……
        XCTAssertNotNil(store.observation)
        XCTAssertNotNil(store.lastError)
        // ……但三维语义如实降档：看不到机器人、执行状态不可判定、数据不可信。
        XCTAssertEqual(store.observation?.bot.reachability, .unreachable(reason: "unreachable"))
        XCTAssertEqual(store.observation?.bot.execution, .indeterminate)
        XCTAssertEqual(store.observation?.bot.trust, .unknown)
        XCTAssertFalse(store.observation?.bot.assessment?.verdict.isConfirmedStopped ?? true)
        // 最后确认时间保留（情形 B 的锚点 T）。
        XCTAssertEqual(store.lastConfirmedHealthyAtMs, 1_000)
        XCTAssertEqual(store.observation?.bot.lastConfirmedHealthyAtMs, 1_000)
    }

    /// 大快照的解析走 detached 路径（§9：解析不在主线程），结果必须完整且有序。
    func test_givenManyCards_whenRefreshed_thenEveryPositionIsParsedOffMainAndKeptInOrder() async {
        let cards = (0..<500).map { index in
            Fixtures.card("p-\(index)", "position", fields: [("symbol", "S\(index)"), ("quantity", "1")])
        }
        let source = SequencedSource([
            .success(Fixtures.snapshot(cards: cards, heartbeat: Fixtures.healthyHeartbeat)),
        ])
        let store = ObservationStore(source: source, commands: nil, clock: { 1_000 })

        await store.refresh()

        XCTAssertEqual(store.observation?.positions.count, 500)
        XCTAssertEqual(store.observation?.positions.first?.symbol, "S0")
        XCTAssertEqual(store.observation?.positions.last?.symbol, "S499")
        XCTAssertNil(store.lastError)
    }

    func test_givenCommandSinkAndApprovedGate_whenSendingAction_thenCommandReachesSink() async {
        let source = SequencedSource([.success(healthySnapshot())])
        let sink = RecordingSink()
        let store = ObservationStore(source: source, commands: sink, clock: { 1_000 })

        let outcome = await store.send(
            ActionKind.ack,
            params: ["cardId": "c1"],
            gate: FixedGate(decision: .approved)
        )

        XCTAssertTrue(outcome.accepted)
        let receivedCount = await sink.receivedCount()
        let lastAction = await sink.lastAction()
        XCTAssertEqual(receivedCount, 1)
        XCTAssertEqual(lastAction, .ack)
    }

    /// 确认手段不可用 ⇒ **fail-closed**：动作绝不发出去，也不降级为"点一下就过"。
    func test_givenGateUnavailable_whenSendingAction_thenCommandIsNeverSent() async {
        let source = SequencedSource([.success(healthySnapshot())])
        let sink = RecordingSink()
        let store = ObservationStore(source: source, commands: sink, clock: { 1_000 })

        let outcome = await store.send(
            ActionKind.kill,
            params: [:],
            gate: FixedGate(decision: .unavailable(reason: "生物识别不可用"))
        )

        XCTAssertFalse(outcome.accepted)
        XCTAssertTrue(outcome.message.contains("fail-closed"))
        let sentAfterUnavailable = await sink.receivedCount()
        XCTAssertEqual(sentAfterUnavailable, 0)
    }

    func test_givenGateDenied_whenSendingAction_thenCommandIsNeverSent() async {
        let source = SequencedSource([.success(healthySnapshot())])
        let sink = RecordingSink()
        let store = ObservationStore(source: source, commands: sink, clock: { 1_000 })

        let outcome = await store.send(
            ActionKind.flatten,
            params: [:],
            gate: FixedGate(decision: .denied)
        )

        XCTAssertFalse(outcome.accepted)
        let sentAfterDenial = await sink.receivedCount()
        XCTAssertEqual(sentAfterDenial, 0)
    }

    func test_givenNoCommandSink_whenSendingAction_thenRejectedWithoutCallingGate() async {
        let source = SequencedSource([.success(healthySnapshot())])
        let store = ObservationStore(source: source, commands: nil, clock: { 1_000 })

        let outcome = await store.send(
            ActionKind.ack,
            params: [:],
            gate: FixedGate(decision: .approved)
        )

        XCTAssertFalse(outcome.accepted)
        XCTAssertEqual(outcome.message, "未配置命令通道")
    }
}
