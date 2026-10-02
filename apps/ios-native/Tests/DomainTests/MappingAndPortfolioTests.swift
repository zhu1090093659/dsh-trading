import XCTest
import DshTradingContract
@testable import DshTradingDomain

/// 卡片 -> 观测态：认识的 key 结构化映射，不认识的进 raw，缺失显示未知（不填 0）。
final class CardMappingTests: XCTestCase {

    func test_givenCardWithUnknownFieldKey_whenMapped_thenKeyIsKeptRawAndNotInterpreted() {
        let card = Fixtures.card("pos-1", "position", fields: [("symbol", "BTC"), ("quantity", "1.5"), ("mysteryMetric", "42")])

        let observation = DeskMapper.map(snapshot: Fixtures.snapshot(cards: [card]), nowMs: 1_000)

        XCTAssertEqual(observation.positions.first?.symbol, "BTC")
        XCTAssertEqual(observation.positions.first?.quantity, "1.5")
        XCTAssertEqual(observation.positions.first?.rawFields.map(\.key), ["mysteryMetric"])
    }

    func test_givenMissingField_whenMapped_thenValueIsNilNotZeroOrEmptyString() {
        let card = Fixtures.card("pos-1", "position", fields: [("symbol", "BTC")])

        let observation = DeskMapper.map(snapshot: Fixtures.snapshot(cards: [card]), nowMs: 1_000)

        XCTAssertEqual(observation.positions.first?.symbol, "BTC")
        XCTAssertNil(observation.positions.first?.quantity)
        XCTAssertNil(observation.positions.first?.entryPrice)
        XCTAssertNil(observation.positions.first?.pnl)
    }

    func test_givenUnknownCardType_whenMapped_thenCardIsListedNotDropped() {
        let unknown = Fixtures.card("future-1", "quantum-desk", fields: [("whatever", "1")], fallback: "未来卡片")
        let known = Fixtures.card("pos-1", "position", fields: [("symbol", "BTC")])

        let observation = DeskMapper.map(snapshot: Fixtures.snapshot(cards: [unknown, known]), nowMs: 1_000)

        XCTAssertEqual(observation.unrecognizedCards.count, 1)
        XCTAssertEqual(observation.unrecognizedCards.first?.cardType, "quantum-desk")
        XCTAssertEqual(observation.unrecognizedCards.first?.fallbackText, "未来卡片")
        XCTAssertEqual(observation.positions.count, 1)
    }

    func test_givenRiskStateCard_whenMapped_thenDependencyFollowsLevelAndAlignment() {
        let card = Fixtures.riskStateCard(level: "reduce_only", alignment: "unaligned")

        let observation = DeskMapper.map(snapshot: Fixtures.snapshot(cards: [card]), nowMs: 1_000)

        XCTAssertEqual(observation.bot.dependency, .degraded(reasons: ["风控限制：只减不增", "BTC 价格未对齐"]))
        XCTAssertEqual(observation.bot.assessment?.health.openRiskAllowed, false)
        XCTAssertEqual(observation.bot.assessment?.verdict, .runningRestricted(reasons: ["风控限制：只减不增", "BTC 价格未对齐"]))
    }

    func test_givenUnknownRiskLevelRawValue_whenMapped_thenDependencyIsUnknownFailClosed() {
        let card = Fixtures.riskStateCard(level: "extremely_normal", alignment: "aligned")

        let observation = DeskMapper.map(snapshot: Fixtures.snapshot(cards: [card]), nowMs: 1_000)

        XCTAssertEqual(observation.bot.dependency, .unknown)
        XCTAssertEqual(observation.bot.assessment?.health.openRiskAllowed, false)
    }

    func test_givenMissingRiskStateCard_whenMapped_thenDependencyIsUnknownNotHealthy() {
        let observation = DeskMapper.map(snapshot: Fixtures.snapshot(cards: []), nowMs: 1_000)

        XCTAssertEqual(observation.bot.dependency, .unknown)
        XCTAssertNil(observation.bot.deskId)
    }

    func test_givenFreshnessCardWithAge_whenMapped_thenTrustFollowsTheAgeField() {
        let expired = Fixtures.card("fresh-1", "freshness", fields: [("age", "expired")])
        let fresh = Fixtures.card("fresh-2", "freshness", fields: [("age", "fresh")])

        XCTAssertEqual(DeskMapper.map(snapshot: Fixtures.snapshot(cards: [expired]), nowMs: 1_000).bot.trust, .expired)
        XCTAssertEqual(DeskMapper.map(snapshot: Fixtures.snapshot(cards: [fresh]), nowMs: 1_000).bot.trust, .fresh)
    }

    func test_givenNoFreshnessCard_whenSnapshotIsOld_thenTrustFallsBackToSnapshotAge() {
        let budget = TrustBudget(freshMs: 1_000, agingMs: 2_000, staleMs: 3_000, ttlMs: 4_000)
        let snapshot = Fixtures.snapshot(cards: [], atMs: 0)

        XCTAssertEqual(DeskMapper.map(snapshot: snapshot, nowMs: 500, budget: budget).bot.trust, .fresh)
        XCTAssertEqual(DeskMapper.map(snapshot: snapshot, nowMs: 5_000, budget: budget).bot.trust, .expired)
    }

    func test_givenMandateStatusCard_whenMapped_thenAssetsAndSummaryComeFromItsKeys() {
        let card = Fixtures.card("m-1", "mandate-status", fields: [("limit", "1000"), ("used", "250"), ("currency", "USDT")])

        let observation = DeskMapper.map(snapshot: Fixtures.snapshot(cards: [card]), nowMs: 1_000)

        XCTAssertEqual(observation.assets.map(\.label).sorted(), ["limit", "used"])
        XCTAssertEqual(observation.assetsSummary?.currency, "USDT")
    }

    func test_givenAlertCardWithUnknownActionKind_whenMapped_thenItIsNotOperable() {
        let unknownAction = CardAction(kind: "future-action", label: "未来动作")
        let card = Fixtures.card("esc-1", "escalation", fields: [("severity", "critical"), ("title", "需要人决策")], actions: [unknownAction])

        let observation = DeskMapper.map(snapshot: Fixtures.snapshot(cards: [card]), nowMs: 1_000)

        XCTAssertEqual(observation.alerts.count, 1)
        XCTAssertFalse(observation.alerts.first?.operable ?? true)
        XCTAssertEqual(observation.alerts.first?.severity, "critical")
        XCTAssertEqual(observation.alerts.first?.title, "需要人决策")
    }

    func test_givenAlertCardWithControlActionWithoutConfirm_whenMapped_thenNotOperable() {
        let action = CardAction(kind: "kill", label: "停机", confirm: false)
        let card = Fixtures.card("esc-2", "escalation", fields: [("title", "停机")], actions: [action])

        let observation = DeskMapper.map(snapshot: Fixtures.snapshot(cards: [card]), nowMs: 1_000)

        XCTAssertFalse(observation.alerts.first?.operable ?? true)
    }

    func test_givenUnreachableSnapshot_whenMapped_thenUnrecognizedCardsAreStillListed() {
        let unknown = Fixtures.card("future-2", "future-type", fallback: "未来")
        let snapshot = Fixtures.snapshot(
            cards: [unknown],
            reachability: .unreachable(reason: "连接失败"),
            execution: .indeterminate,
            heartbeat: nil
        )

        let observation = DeskMapper.map(snapshot: snapshot, nowMs: 1_000)

        XCTAssertEqual(observation.bot.assessment?.verdict, .cannotSeeBot(reason: "连接失败"))
        XCTAssertEqual(observation.unrecognizedCards.count, 1)
    }
}

/// 身份三件套、订单状态机、归因与会话安全。
final class IdentityOrderAndAttributionTests: XCTestCase {

    func test_givenBotWithTwoVersionsAndTwoRuns_whenInspected_thenIdentityVersionAndRunStayDistinct() {
        let bot = BotIdentity(id: BotId("bot-1"), displayName: "主力", venue: "okx", account: AccountRef("acct-1"), createdAtMs: 100)
        let version1 = StrategyVersion(id: StrategyVersionId("sv-1"), botId: bot.id, strategyId: "s", version: "1.0", contentHash: "h1", activatedAtMs: 200)
        let version2 = StrategyVersion(id: StrategyVersionId("sv-2"), botId: bot.id, strategyId: "s", version: "2.0", contentHash: "h2", activatedAtMs: 400)
        let run1 = RunInstance(id: RunInstanceId("run-1"), botId: bot.id, strategyVersionId: version1.id, startedAtMs: 200, endedAtMs: 300, host: "h")
        let run2 = RunInstance(id: RunInstanceId("run-2"), botId: bot.id, strategyVersionId: version2.id, startedAtMs: 400, endedAtMs: nil, host: "h")
        let roster = BotRoster(bot: bot, strategyVersions: [version1, version2], runs: [run1, run2])

        XCTAssertNotEqual(run1.id.rawValue, version1.id.rawValue)
        XCTAssertNotEqual(version1.id.rawValue, bot.id.rawValue)
        XCTAssertTrue(roster.isCoherent(run: run1))
        XCTAssertTrue(roster.isCoherent(run: run2))
        XCTAssertEqual(roster.currentRun(atMs: 450)?.id, run2.id)
        XCTAssertEqual(roster.currentRun(atMs: 250)?.id, run1.id)
        XCTAssertEqual(roster.runs(ofStrategyVersion: version1.id).map(\.id), [run1.id])
        XCTAssertEqual(roster.strategyVersion(of: run2)?.version, "2.0")
    }

    func test_givenSubmittedUnknownOrder_whenRecovering_thenPolicyQueriesVenueAndNeverResends() {
        XCTAssertFalse(OrderState.submittedUnknown.isTerminal)
        XCTAssertTrue(OrderState.submittedUnknown.requiresVenueQuery)
        XCTAssertEqual(OrderRecoveryPolicy.recovery(for: .submittedUnknown), .queryVenue)
        XCTAssertEqual(OrderRecoveryPolicy.recovery(for: .intentRecorded), .rollback)
        XCTAssertEqual(OrderRecoveryPolicy.recovery(for: .partiallyFilled), .rebuildFromVenue)
        XCTAssertEqual(OrderRecoveryPolicy.recovery(for: .filled), .terminal)
    }

    func test_givenOrderStateMachine_whenEnumerated_thenTerminalSetIsExactlyTheClosedFive() {
        let terminals = OrderState.allCases.filter(\.isTerminal).map(\.rawValue).sorted()

        XCTAssertEqual(terminals, ["canceled", "expired", "filled", "neverArrived", "rejected"])
        XCTAssertEqual(OrderState.allCases.filter(\.requiresVenueQuery), [.submittedUnknown])
    }

    func test_givenOrderInSubmittedUnknown_whenInspected_thenOpaqueHandleExistsAndOrderIsStillDangling() {
        let order = Order(
            orderId: OrderIdFormat.make(uuid: "12345678-1234-4678-9abc-0123456789ab"),
            clientRequestId: "req-1",
            botId: BotId("bot-1"),
            runId: RunInstanceId("run-1"),
            symbol: "BTC",
            side: .buy,
            type: .limit,
            quantity: Decimal(string: "1")!,
            filledQuantity: 0,
            state: .submittedUnknown,
            venueOrderId: nil,
            createdAtMs: 1_000,
            updatedAtMs: 1_100
        )

        XCTAssertTrue(OrderIdFormat.isValid(order.orderId.rawValue))
        XCTAssertTrue(order.isDangling)
        XCTAssertTrue(order.needsRecovery)
        XCTAssertNil(order.venueOrderId)
        XCTAssertEqual(order.clientRequestId, "req-1")
    }

    /// 形态按设计文档 §4 冻结为**不钉版本位**：v4 与 v7 形状的 UUID 都合法。
    func test_givenVersionAgnosticOrderIdFormat_whenValidated_thenV4AndV7ShapesBothPass() {
        XCTAssertTrue(OrderIdFormat.isValid("ord_12345678-1234-4678-9abc-0123456789ab"))
        XCTAssertTrue(OrderIdFormat.isValid("ord_12345678-1234-7678-9abc-0123456789ab"))
        XCTAssertFalse(OrderIdFormat.isValid("ord_12345678-1234-4678-9abc-0123456789"))
        XCTAssertFalse(OrderIdFormat.isValid("12345678-1234-4678-9abc-0123456789ab"))
    }

    // MARK: - 多机器人共用账户的归因

    func test_givenTwoBotsOnOneAccount_whenDerivingBotLevelValue_thenUnattributableAndNoFabricatedDigits() {
        let botA = BotId("bot-a")
        let botB = BotId("bot-b")
        let context = AttributionContext(account: AccountRef("acct-1"), botsOnAccount: [botA, botB], hasManualOrExternalFlow: false)
        let attributed: AttributedValue<Decimal> = BotLevelAttribution.fromAccount(Decimal(string: "1234.56")!, context: context, for: botA)

        XCTAssertEqual(attributed.confidence, .unattributable)
        XCTAssertNil(attributed.value)

        let text = AttributedDisplay.text(attributed) { String(describing: $0) }
        XCTAssertFalse(text.contains("1234"))
        XCTAssertTrue(text.contains("不可归属"))
        XCTAssertTrue(text.contains("共用"))
    }

    func test_givenExclusiveBotAccount_whenDerivingBotLevelValue_thenAccountNumberIsReused() {
        let bot = BotId("bot-a")
        let context = AttributionContext(account: AccountRef("acct-1"), botsOnAccount: [bot], hasManualOrExternalFlow: false)
        let attributed: AttributedValue<Decimal> = BotLevelAttribution.fromAccount(Decimal(string: "10")!, context: context, for: bot)

        XCTAssertEqual(attributed.confidence, .exact)
        XCTAssertEqual(attributed.value, Decimal(string: "10"))
        XCTAssertEqual(BotLevelAttribution.quality(of: context, for: bot).allowsAccountNumbersOnBot, true)
    }

    func test_givenSingleBotButManualFlow_whenDeriving_thenStillUnattributable() {
        let bot = BotId("bot-a")
        let context = AttributionContext(account: AccountRef("acct-1"), botsOnAccount: [bot], hasManualOrExternalFlow: true)
        let attributed: AttributedValue<Decimal> = BotLevelAttribution.fromAccount(Decimal(string: "10")!, context: context, for: bot)

        XCTAssertEqual(attributed.confidence, .unattributable)
        XCTAssertNil(attributed.value)
    }

    func test_givenSharedAccountPosition_whenDerivingBotPosition_thenNoNumericValueIsProduced() {
        let botA = BotId("bot-a")
        let botB = BotId("bot-b")
        let context = AttributionContext(account: AccountRef("acct-1"), botsOnAccount: [botA, botB], hasManualOrExternalFlow: true)
        let accountPosition = AccountPosition(
            account: AccountRef("acct-1"),
            symbol: "BTC",
            quantity: Decimal(string: "3")!,
            averageCost: Decimal(string: "100")!,
            markPrice: Decimal(string: "110")!,
            unrealizedPnl: Decimal(string: "30")!
        )

        let attributed = BotLevelAttribution.botPosition(from: accountPosition, context: context, for: botA)

        XCTAssertEqual(attributed.confidence, .unattributable)
        XCTAssertNil(attributed.value)
        XCTAssertTrue(attributed.note?.contains("手动/外部成交") ?? false)
    }

    func test_givenSharedAccountPerformance_whenDerivingMetrics_thenNetIsNeverPrecise() {
        let botA = BotId("bot-a")
        let botB = BotId("bot-b")
        let context = AttributionContext(account: AccountRef("acct-1"), botsOnAccount: [botA, botB], hasManualOrExternalFlow: false)
        let account = AccountPerformance(
            account: AccountRef("acct-1"),
            window: PerformanceWindow(startMs: 0, endMs: 1_000),
            realizedPnl: Decimal(string: "100")!,
            unrealizedPnl: Decimal(string: "50")!,
            fees: Decimal(string: "5")!,
            funding: Decimal(string: "1")!,
            tradeCount: 7,
            maxDrawdown: Decimal(string: "20")!
        )

        let metrics = PerformanceAttribution.botMetrics(from: account, context: context, for: botA)

        XCTAssertEqual(metrics.realizedPnl.confidence, .unattributable)
        XCTAssertNil(metrics.realizedPnl.value)
        XCTAssertEqual(metrics.net.confidence, .unattributable)
        XCTAssertNil(metrics.net.value)
        XCTAssertEqual(metrics.maxDrawdown?.confidence, .unattributable)
    }

    func test_givenEveryMetricAttributable_whenComputingNet_thenNetIsExact() {
        let bot = BotId("bot-a")
        let window = PerformanceWindow(startMs: 0, endMs: 1_000)
        let metrics = PerformanceMetrics(
            botId: bot,
            window: window,
            realizedPnl: .exact(Decimal(string: "100")!),
            unrealizedPnl: .exact(Decimal(string: "50")!),
            fees: .exact(Decimal(string: "5")!),
            funding: .exact(Decimal(string: "1")!),
            tradeCount: 7,
            maxDrawdown: .exact(Decimal(string: "20")!)
        )

        XCTAssertEqual(metrics.net.confidence, .exact)
        XCTAssertEqual(metrics.net.value, Decimal(string: "146"))
    }

    func test_givenOneEstimatedMetric_whenComputingNet_thenNetIsNotExact() {
        let metrics = PerformanceMetrics(
            botId: BotId("bot-a"),
            window: PerformanceWindow(startMs: 0, endMs: 1_000),
            realizedPnl: .exact(Decimal(string: "100")!),
            unrealizedPnl: .estimated(Decimal(string: "50")!, note: "按比例摊"),
            fees: .exact(Decimal(string: "5")!),
            funding: .exact(Decimal(string: "1")!),
            tradeCount: 7,
            maxDrawdown: nil
        )

        XCTAssertEqual(metrics.net.confidence, .estimated)
        XCTAssertNotEqual(metrics.net.confidence, .exact)
    }
}
