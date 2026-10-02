import XCTest
import DshTradingContract
@testable import DshTradingDomain

/// 封闭枚举 fail-closed、三维状态语义、心跳 != 业务。
final class DomainSemanticsTests: XCTestCase {

    // MARK: - 未知封闭枚举一律 fail-closed

    func test_givenUnknownClosedEnumValue_whenParsed_thenRawValueIsPreservedAndNotGuessed() {
        let parsed = ClosedEnum<ExecutionLifecycle>(rawValue: "hibernating")

        XCTAssertTrue(parsed.isUnknown)
        XCTAssertNil(parsed.value)
        XCTAssertEqual(parsed.rawValue, "hibernating")
        XCTAssertEqual(ClosedEnum<ExecutionLifecycle>(rawValue: "running").value, .running)
    }

    /// 穷尽 switch：这里**没有 default 分支** —— 新增 ExecutionState case 时本用例编译失败。
    func test_givenEveryExecutionState_whenSwitched_thenEveryCaseHasItsOwnLabel() {
        var labels: Set<String> = []

        for state in ExecutionState.allCases {
            switch state {
            case .running: labels.insert(state.label)
            case .paused: labels.insert(state.label)
            case .killed: labels.insert(state.label)
            case .indeterminate: labels.insert(state.label)
            }
        }

        XCTAssertEqual(labels.count, ExecutionState.allCases.count)
        XCTAssertEqual(ExecutionState.allCases.map(\.rawValue), ["running", "paused", "killed", "indeterminate"])
    }

    func test_givenUnknownCardType_whenDecidingSurface_thenActionsDisabledButContentStillRendered() {
        let unknown = UnknownClosedValue(kind: "cardType", rawValue: "future-card")
        let decision = SurfacePolicy.decide(trust: .fresh, unknownClosedValues: [unknown])

        XCTAssertEqual(decision, .readOnly(unknown: [unknown]))
        XCTAssertFalse(decision.allowsActions)
        XCTAssertTrue(decision.rendersContent)
    }

    func test_givenUnknownActionKind_whenDecidingSurface_thenSameFailClosedVerdict() {
        let unknown = UnknownClosedValue(kind: "actionKind", rawValue: "future-action")
        let decision = SurfacePolicy.decide(trust: .fresh, unknownClosedValues: [unknown])

        XCTAssertFalse(decision.allowsActions)
        XCTAssertTrue(decision.rendersContent)
    }

    func test_givenNoUnknownEnumAndTrustedData_whenDecidingSurface_thenInteractive() {
        XCTAssertEqual(SurfacePolicy.decide(trust: .fresh, unknownClosedValues: []), .interactive)
        XCTAssertTrue(SurfacePolicy.decide(trust: .fresh, unknownClosedValues: []).allowsActions)
    }

    // MARK: - 新鲜度：过期/未确认不渲染数据本身

    func test_givenExpiredTrust_whenDecidingSurface_thenNothingIsRendered() {
        let decision = SurfacePolicy.decide(trust: .expired, unknownClosedValues: [])

        XCTAssertEqual(decision, .notRendered(reason: "本地数据已过期，请联网获取后再操作"))
        XCTAssertFalse(decision.rendersContent)
        XCTAssertFalse(decision.allowsActions)
        XCTAssertFalse(DataTrust.expired.rendersData)
        XCTAssertTrue(DataTrust.expired.blocksCommands)
    }

    func test_givenFreshAgingAndStaleTrust_whenChecked_thenOnlyThoseRenderData() {
        XCTAssertTrue(DataTrust.fresh.rendersData)
        XCTAssertTrue(DataTrust.aging.rendersData)
        XCTAssertTrue(DataTrust.stale.rendersData)
        XCTAssertFalse(DataTrust.unknown.rendersData)
        XCTAssertNil(DataTrust.fresh.badge)
        XCTAssertEqual(DataTrust.stale.badge, "⚠ 数据陈旧，仅供对照")
    }

    func test_givenAgeBeyondRetention_whenDerivingTrust_thenExpired() {
        let budget = TrustBudget(freshMs: 1_000, agingMs: 2_000, staleMs: 3_000, ttlMs: 4_000)

        XCTAssertEqual(DataTrustPolicy.trust(age: budget.age(ofMs: 500)), .fresh)
        XCTAssertEqual(DataTrustPolicy.trust(age: budget.age(ofMs: 1_500)), .aging)
        XCTAssertEqual(DataTrustPolicy.trust(age: budget.age(ofMs: 2_500)), .stale)
        XCTAssertEqual(DataTrustPolicy.trust(age: budget.age(ofMs: 9_999)), .expired)
        XCTAssertEqual(DataTrustPolicy.trust(age: nil), .unknown)
    }

    func test_givenUnknownStalenessRawValue_whenDerivingTrust_thenUnknownNotFresh() {
        XCTAssertEqual(DataTrustPolicy.trust(stalenessRawValue: "brand-new"), .unknown)
        XCTAssertEqual(DataTrustPolicy.trust(stalenessRawValue: nil), .unknown)
        XCTAssertEqual(DataTrustPolicy.trust(stalenessRawValue: "expired"), .expired)
    }

    /// 防漂移（可执行断言）：领域侧 DataTrust 必须与契约侧 Staleness 的取值集合一致。
    func test_givenContractStaleness_whenCompared_thenDomainTrustMirrorsItsValues() {
        XCTAssertEqual(
            DataTrust.allCases.map(\.rawValue).sorted(),
            Staleness.allCases.map(\.rawValue).sorted()
        )
    }

    // MARK: - 心跳正常 != 业务正常

    func test_givenFreshHeartbeatButUnavailableMarketData_whenAssessing_thenBusinessIsNotHealthy() {
        let heartbeat = Fixtures.healthyHeartbeat
        XCTAssertTrue(heartbeat.isHealthy(atMs: 1_500))

        let report = DependencyReport(
            marketData: .known(.unavailable),
            tradeChannel: .known(.normal),
            accountSync: .known(.ok),
            riskLevel: .known(.normal),
            priceStates: [InstrumentPriceState(symbol: "BTC", alignment: .known(.aligned))]
        )
        let permission = report.permission(for: "BTC")
        let blockers = DependencyAssessment.blockers(
            DependencyAssessment.issues(report, permission: permission, symbol: "BTC")
        )
        let assessment = ObservationProjector.assess(
            reachability: .reachable,
            execution: .running,
            dependency: DependencyHealth.from(report, symbol: "BTC"),
            trust: .fresh,
            heartbeat: heartbeat,
            atMs: 1_500,
            openRiskAllowed: permission.openRiskAllowed,
            blockers: blockers
        )

        XCTAssertTrue(assessment.health.heartbeatHealthy)
        XCTAssertFalse(assessment.health.businessHealthy)
        // openRiskAllowed 就是第 22 条的合取（level ∧ alignment）：行情不可用不改它；
        // 真正能不能新增风险是 allowsNewRisk（合取 ∧ 无阻断项）。
        XCTAssertTrue(assessment.health.openRiskAllowed)
        XCTAssertFalse(assessment.health.allowsNewRisk)
        XCTAssertEqual(assessment.health.blockers, [.marketDataUnavailable])
        XCTAssertEqual(assessment.verdict, .runningRestricted(reasons: ["行情不可用"]))
    }

    func test_givenStaleHeartbeatAndHealthyDependencies_whenAssessing_thenBusinessIsNotHealthyEither() {
        let heartbeat = HeartbeatStatus(
            lastBeatAtMs: 1_000,
            policy: HeartbeatPolicy(intervalMs: 1_000, graceFactor: 2)
        )

        XCTAssertFalse(heartbeat.isHealthy(atMs: 10_000))

        let report = DependencyReport(
            marketData: .known(.normal),
            tradeChannel: .known(.normal),
            accountSync: .known(.ok),
            riskLevel: .known(.normal),
            priceStates: [InstrumentPriceState(symbol: "BTC", alignment: .known(.aligned))]
        )
        let permission = report.permission(for: "BTC")
        let assessment = ObservationProjector.assess(
            reachability: .reachable,
            execution: .running,
            dependency: DependencyHealth.from(report, symbol: "BTC"),
            trust: .fresh,
            heartbeat: heartbeat,
            atMs: 10_000,
            openRiskAllowed: permission.openRiskAllowed,
            blockers: []
        )

        XCTAssertFalse(assessment.health.heartbeatHealthy)
        XCTAssertFalse(assessment.health.businessHealthy)
        XCTAssertTrue(assessment.health.openRiskAllowed)
        XCTAssertEqual(assessment.verdict, .running)
    }

    // MARK: - alignment 与 level 是两套不得相交的词汇表

    func test_givenSingleUnalignedInstrument_whenDerivingPermission_thenDeskLevelIsNotPromoted() {
        let report = DependencyReport(
            marketData: .known(.normal),
            tradeChannel: .known(.normal),
            accountSync: .known(.ok),
            riskLevel: .known(.normal),
            priceStates: [InstrumentPriceState(symbol: "BTC", alignment: .known(.unaligned))]
        )
        let permission = report.permission(for: "BTC")

        XCTAssertEqual(permission.level.value, .normal)
        XCTAssertEqual(permission.alignment.value, .unaligned)
        XCTAssertFalse(permission.openRiskAllowed)
        XCTAssertFalse(permission.deskRestricted)
    }

    func test_givenRiskLevelVocabulary_whenComparedWithAlignmentVocabulary_thenDisjoint() {
        let deskVocabulary = Set(RiskLevel.allCases.map(\.rawValue))
        let instrumentVocabulary = Set(InstrumentAlignment.allCases.map(\.rawValue))

        XCTAssertEqual(RiskLevel.allCases.map(\.rawValue), ["normal", "caution", "reduce_only", "halt"])
        XCTAssertEqual(InstrumentAlignment.allCases.map(\.rawValue), ["aligned", "unaligned", "stale"])
        XCTAssertTrue(deskVocabulary.isDisjoint(with: instrumentVocabulary))
    }

    func test_givenRiskStateMissingOrUnknown_whenDerivingDependencyHealth_thenUnknownNotHealthy() {
        XCTAssertEqual(DependencyHealth.from(.missing, symbol: nil), .unknown)

        let unknownLevel = DependencyReport(
            marketData: .known(.normal),
            tradeChannel: .known(.normal),
            accountSync: .known(.ok),
            riskLevel: .unknown("severely_normal"),
            priceStates: [InstrumentPriceState(symbol: "BTC", alignment: .known(.aligned))]
        )

        XCTAssertEqual(DependencyHealth.from(unknownLevel, symbol: "BTC"), .unknown)
        XCTAssertNotEqual(DependencyHealth.from(unknownLevel, symbol: "BTC"), .healthy)
    }

    func test_givenDeskHalted_whenDerivingDependencyHealth_thenHalted() {
        let report = DependencyReport(
            marketData: .known(.normal),
            tradeChannel: .known(.normal),
            accountSync: .known(.ok),
            riskLevel: .known(.halt),
            priceStates: [InstrumentPriceState(symbol: "BTC", alignment: .known(.aligned))]
        )

        XCTAssertEqual(DependencyHealth.from(report, symbol: "BTC"), .halted)
        XCTAssertFalse(report.permission(for: "BTC").openRiskAllowed)
    }

    func test_givenHealthyDependencies_whenDerivingDependencyHealth_thenHealthy() {
        let report = DependencyReport(
            marketData: .known(.normal),
            tradeChannel: .known(.normal),
            accountSync: .known(.ok),
            riskLevel: .known(.normal),
            priceStates: [InstrumentPriceState(symbol: "BTC", alignment: .known(.aligned))]
        )

        XCTAssertEqual(DependencyHealth.from(report, symbol: "BTC"), .healthy)
        XCTAssertTrue(report.permission(for: "BTC").openRiskAllowed)
    }
}
