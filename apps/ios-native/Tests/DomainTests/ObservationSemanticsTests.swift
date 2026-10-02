import Foundation
import XCTest
@testable import DshTradingDomain

final class ObservationSemanticsTests: XCTestCase {
    let t = Date(timeIntervalSince1970: 1000)
    let healthy = DependencyHealth(market: .normal, trading: .normal, account: .normal, risk: .allowed)

    func testUserSeesThreeIndependentDimensionsWithoutHeartbeatGrantingTrading() {
        // Given: all execution, trust and dependency combinations, with a live heartbeat.
        let unhealthy = DependencyHealth(market: .delayed, trading: .abnormal, account: .syncFailed, risk: .reduceOnly)
        // When: the user observes each combination.
        for execution in ExecutionState.allCases {
            for trust in DataTrust.allCases {
                for health in [healthy, unhealthy] {
                    let value = BotObservation(execution: execution, dependencies: health, trust: trust, heartbeat: .alive, lastConfirmedAt: t)
                    let view = value.presentation
                    // Then: only fresh, running, healthy business can add exposure.
                    XCTAssertEqual(view.canAddExposure, execution == .running && trust == .latest && health == healthy)
                    XCTAssertEqual(view.execution, trust == .latest ? execution : nil)
                    XCTAssertEqual(view.dependencies, trust == .latest ? health : nil)
                    XCTAssertEqual(view.trust, trust)
                    XCTAssertEqual(view.lastConfirmedAt, t)
                }
            }
        }
    }

    func testUserDistinguishesRunningWithDependenciesBlockedFromDisconnectedAndStopped() {
        // Given: the bot is alive but trading is blocked at T.
        let health = DependencyHealth(market: .delayed, trading: .abnormal, account: .syncFailed, risk: .reduceOnly)
        let running = BotObservation(execution: .running, dependencies: health, trust: .latest, heartbeat: .alive, lastConfirmedAt: t)
        // When: the app loses its monitoring connection, or receives a confirmed stop.
        let disconnected = running.withTrust(.disconnected)
        let stopped = BotObservation(execution: .stopped, dependencies: healthy, trust: .latest, heartbeat: .alive, lastConfirmedAt: t)
        // Then: the states have distinct user-visible meanings and preserve confirmation time.
        XCTAssertEqual(running.presentation.executionText, "运行")
        XCTAssertFalse(running.presentation.canAddExposure)
        XCTAssertEqual(disconnected.presentation.executionText, "未知")
        XCTAssertNil(disconnected.presentation.execution)
        XCTAssertNil(disconnected.presentation.dependencies)
        XCTAssertEqual(disconnected.presentation.lastConfirmedAt, t)
        XCTAssertEqual(stopped.presentation.executionText, "已停止")
        XCTAssertNotEqual(running.presentation, disconnected.presentation)
        XCTAssertNotEqual(disconnected.presentation, stopped.presentation)
    }

    func testUserCannotTreatAnySingleDependencyFailureAsSafeTrading() {
        // Given: one failed dependency at a time, despite a live heartbeat.
        let failures = [DependencyHealth(market: .delayed, trading: .normal, account: .normal, risk: .allowed), DependencyHealth(market: .normal, trading: .abnormal, account: .normal, risk: .allowed), DependencyHealth(market: .normal, trading: .normal, account: .syncFailed, risk: .allowed), DependencyHealth(market: .normal, trading: .normal, account: .normal, risk: .blocked)]
        // When: the user checks safety.
        for health in failures {
            let observation = BotObservation(execution: .running, dependencies: health, trust: .latest, heartbeat: .alive, lastConfirmedAt: t)
            // Then: business health is not inferred from heartbeat.
            XCTAssertFalse(observation.presentation.canAddExposure)
            XCTAssertEqual(observation.presentation.execution, .running)
        }
    }

    func testUserDoesNotSeeStaleUnconfirmedOrDisconnectedFinancialData() {
        // Given: a financial payload with an explicit confirmation and age budget.
        let snapshot = Observed(value: "sensitive position", confirmedAt: t)
        // When / Then: stale, disconnected, unconfirmed, future dated and invalid-budget data never renders.
        XCTAssertEqual(snapshot.render(at: t, maxAge: 10, trust: .latest), "sensitive position")
        XCTAssertEqual(snapshot.render(at: t.addingTimeInterval(10), maxAge: 10, trust: .latest), "sensitive position")
        XCTAssertNil(snapshot.render(at: t.addingTimeInterval(11), maxAge: 10, trust: .latest))
        for trust in [DataTrust.stale, .disconnected, .unconfirmed] { XCTAssertNil(snapshot.render(at: t, maxAge: 10, trust: trust)) }
        XCTAssertNil(snapshot.render(at: t.addingTimeInterval(-1), maxAge: 10, trust: .latest))
        XCTAssertNil(snapshot.render(at: t, maxAge: -1, trust: .latest))
        XCTAssertNil(snapshot.render(at: t, maxAge: .infinity, trust: .latest))
        XCTAssertNil(Observed(value: "unconfirmed", confirmedAt: nil).render(at: t, maxAge: 10, trust: .latest))
    }

    func testUserGetsUnknownExecutionAndOrderEnumsRejectedInsteadOfStoppedOrFilled() throws {
        // Given: future closed enum values from the wire.
        let decoder = JSONDecoder()
        // When / Then: decoding is controlled rejection, not a guessed state.
        XCTAssertThrowsError(try decoder.decode(ExecutionState.self, from: Data(#""future""#.utf8)))
        XCTAssertThrowsError(try decoder.decode(OrderState.self, from: Data(#""future""#.utf8)))
        XCTAssertEqual(try decoder.decode(OrderState.self, from: Data(#""submitted-unknown""#.utf8)), .submittedUnknown)
        XCTAssertTrue(OrderState.submittedUnknown.requiresReconciliation)
        XCTAssertFalse(OrderState.submittedUnknown.isTerminal)
        XCTAssertTrue(OrderState.neverArrived.isTerminal)
        XCTAssertFalse(OrderState.filled.requiresReconciliation)
    }

    func testUserSeesOnlyEvidenceAttributedValuesForTheRequestedBotRun() {
        // Given: two bots sharing an account, with account-level and uncertain metrics.
        let run = BotRun(botID: BotID(rawValue: "bot-a"), strategy: StrategyVersion(strategyID: "trend", version: "v2"), runID: RunID(rawValue: "run-1"))
        let other = BotRun(botID: BotID(rawValue: "bot-b"), strategy: run.strategy, runID: RunID(rawValue: "run-2"))
        let exact = Attributed(value: Decimal(42), attribution: .verified(run: run, evidence: "fill-ledger-1"))
        // When / Then: account totals never become bot totals; uncertainty is explicitly labeled.
        XCTAssertEqual(exact.forBot(run).value, Decimal(42))
        XCTAssertEqual(exact.forBot(other).label, "不属于此运行实例")
        XCTAssertNil(exact.forBot(other).value)
        XCTAssertEqual(Attributed(value: Decimal(900), attribution: .accountOnly(accountID: "shared")).forBot(run), AttributedView(value: nil, label: "账户级数据，不能归为机器人收益或持仓"))
        XCTAssertEqual(Attributed(value: Decimal(900), attribution: .uncertain(reason: "缺少成交映射")).forBot(run), AttributedView(value: nil, label: "归属不可靠：缺少成交映射"))
        XCTAssertNil(Attributed(value: Decimal(42), attribution: .verified(run: run, evidence: "")).forBot(run).value)
        XCTAssertNotEqual(run.botID.rawValue, run.runID.rawValue)
        XCTAssertNotEqual(run, BotRun(botID: run.botID, strategy: run.strategy, runID: RunID(rawValue: "restart")))
    }
}
