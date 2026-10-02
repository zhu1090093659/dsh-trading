//
//  FeaturesAdapterTests.swift
//  DshTradingFeaturesTests
//
//  纯逻辑断言（不渲染）：三维分列、看不见 vs 已停止 vs 无法判定、fail-closed 动作、
//  未知 closed 枚举不猜、不可信数据不渲染。
//  禁 mock、禁 sleep：全部是纯函数与值构造。
//

import XCTest
import DshTradingContract
import DshTradingDomain
@testable import DshTradingFeatures

final class FeaturesAdapterTests: XCTestCase {
    // MARK: - 三维分列（每个观测项都必须能同时表达三维）

    func testAxesAlwaysCarryThreeDistinctDimensions() {
        // Given 一对（执行, 依赖, 可信度）取值
        let axes = FeaturesAdapter.axes(execution: .running, dependency: .degraded(reasons: ["行情延迟"]), trust: .stale)

        // Then 三个维度各自有名字、各自有值，且互不相同
        XCTAssertEqual(axes.execution.title, "执行状态")
        XCTAssertEqual(axes.dependency.title, "依赖健康")
        XCTAssertEqual(axes.trust.title, "数据可信度")
        XCTAssertEqual(axes.execution.value, "运行中")
        XCTAssertEqual(axes.dependency.value, "依赖异常：行情延迟")
        XCTAssertEqual(axes.trust.value, "陈旧")
        XCTAssertEqual(Set(axes.all.map(\.title)).count, 3)
    }

    // MARK: - 「App 看不到机器人」 vs 「机器人已停止」 vs 「已连上但无法判定」

    func testUnreachableStoppedAndIndeterminateAreThreeDifferentStates() {
        // Given 三种观测
        let unreachable = makeStatus(execution: .indeterminate, trust: .unknown, reachability: .unreachable(reason: "与监控服务连接中断"))
        let stopped = makeStatus(execution: .killed, trust: .fresh, reachability: .reachable)
        let indeterminate = makeStatus(execution: .indeterminate, trust: .fresh, reachability: .reachable)

        // When 翻译成呈现状态
        let unreachableKind = FeaturesAdapter.botStateKind(unreachable)
        let stoppedKind = FeaturesAdapter.botStateKind(stopped)
        let indeterminateKind = FeaturesAdapter.botStateKind(indeterminate)

        // Then 三者是三种不同状态，且文案互不混淆
        XCTAssertEqual(unreachableKind, .unreachable)
        XCTAssertEqual(stoppedKind, .stoppedConfirmed)
        XCTAssertEqual(indeterminateKind, .indeterminateExecution)
        XCTAssertNotEqual(unreachableKind.label, stoppedKind.label)
        XCTAssertNotEqual(indeterminateKind.label, stoppedKind.label)
        XCTAssertNotEqual(unreachableKind.label, indeterminateKind.label)
        XCTAssertTrue(unreachableKind.isUnknown)
        XCTAssertTrue(indeterminateKind.isUnknown)
        XCTAssertFalse(stoppedKind.isUnknown)
        XCTAssertTrue(stoppedKind.isConfirmedStopped)
        XCTAssertFalse(unreachableKind.isConfirmedStopped)
        XCTAssertFalse(indeterminateKind.isConfirmedStopped)
    }

    func testRunningWithBrokenDependencyIsNotStopped() {
        // Given 心跳正常、执行仍在跑，但依赖阻断新增风险
        let restricted = makeStatus(execution: .running, trust: .fresh, reachability: .reachable, dependency: .degraded(reasons: ["交易通道降级"]))

        // When / Then 它是「运行中（受限）」，不是「已停止」
        let kind = FeaturesAdapter.botStateKind(restricted)
        XCTAssertEqual(kind, .runningRestricted)
        XCTAssertFalse(kind.isConfirmedStopped)
        XCTAssertFalse(kind.isUnknown)
        XCTAssertTrue(kind.label.contains("运行中"))
    }

    // MARK: - 不可信数据不渲染

    func testExpiredTrustNeverRendersData() {
        // Given 一份过期快照
        let status = makeStatus(execution: .running, trust: .expired, reachability: .reachable)
        let observation = makeObservation(bot: status)

        // When
        let state = FeaturesAdapter.featuresState(from: FeaturesAdapterInput(
            observation: observation,
            runtimeMode: .simulated,
            nowMs: 1_790_000_000_000
        ))

        // Then 数据不可渲染，视图只会看到提示
        XCTAssertEqual(state.bots.count, 1)
        XCTAssertFalse(state.bots[0].rendersData)
        XCTAssertNotNil(state.bots[0].notice)
        XCTAssertEqual(state.bots[0].axes.trust.value, "已过期")
        XCTAssertFalse(state.overview.rendersData)
    }

    func testNoObservationMeansUnknownNotEmpty() {
        // Given 还没有任何观测
        // When
        let state = FeaturesAdapter.featuresState(from: FeaturesAdapterInput(observation: nil, nowMs: 1_790_000_000_000))

        // Then 不是「没有机器人」，而是「还没拿到数据」
        XCTAssertTrue(state.bots.isEmpty)
        XCTAssertNotNil(state.emptyMessage)
        XCTAssertEqual(state.connection.linkLabel, ConnectionPresentation.unknown.linkLabel)
        XCTAssertEqual(state.overview.totalBots, 0)
    }

    // MARK: - 动作 fail-closed

    func testUnknownActionIsDisabledAndKeepsRawValue() {
        // Given 一个本客户端不认识的动作，且卡片可操作、caps 齐全
        let cardActions = [CardAction(kind: "escalate-to-operator", label: "升级", params: nil, confirm: nil)]

        // When
        let presentations = FeaturesAdapter.actionPresentations(cardActions, operable: true, caps: ["action:*"])

        // Then 它被禁用，只保留原始值
        XCTAssertEqual(presentations.count, 1)
        XCTAssertTrue(presentations[0].isUnknownKind)
        XCTAssertFalse(presentations[0].enabled)
        XCTAssertEqual(presentations[0].kind, "escalate-to-operator")
    }

    func testControlActionRequiresBiometricButReadActionDoesNot() {
        // Given ack（只读）与 kill（控制）
        let cardActions = [
            CardAction(kind: "ack", label: "知道了", params: nil, confirm: nil),
            CardAction(kind: "kill", label: "紧急停机", params: nil, confirm: true)
        ]

        // When
        let presentations = FeaturesAdapter.actionPresentations(cardActions, operable: true, caps: ["action:ack", "action:kill"])

        // Then 控制类要求生物识别，只读类不要求
        XCTAssertEqual(presentations[0].requiresBiometric, false)
        XCTAssertEqual(presentations[0].scopeLabel, "只读")
        XCTAssertEqual(presentations[1].requiresBiometric, true)
        XCTAssertEqual(presentations[1].scopeLabel, "控制")
        XCTAssertNotNil(presentations[1].confirmNote)
    }

    func testActionWithoutCapsIsDisabled() {
        // Given 服务端没有授予该能力
        let cardActions = [CardAction(kind: "kill", label: "紧急停机", params: nil, confirm: true)]

        // When caps 里没有 action:kill
        let presentations = FeaturesAdapter.actionPresentations(cardActions, operable: true, caps: ["action:ack"])

        // Then 禁用
        XCTAssertFalse(presentations[0].enabled)
        XCTAssertNotNil(presentations[0].confirmNote)
    }

    func testInoperableCardDisablesEveryAction() {
        // Given 卡片不可操作（含未知 closed 枚举）
        let cardActions = [CardAction(kind: "ack", label: "知道了", params: nil, confirm: nil)]

        // When
        let presentations = FeaturesAdapter.actionPresentations(cardActions, operable: false, caps: ["action:*"])

        // Then 全部禁用
        XCTAssertTrue(presentations.allSatisfy { !$0.enabled })
    }

    // MARK: - 订单生命周期不猜

    func testOrderLifecycleRecognizesKnownRawValues() {
        XCTAssertEqual(FeaturesAdapter.lifecycleStage("submitted"), .submitted)
        XCTAssertEqual(FeaturesAdapter.lifecycleStage("submittedUnknown"), .submittedUnknown)
        XCTAssertEqual(FeaturesAdapter.lifecycleStage("partial"), .partiallyFilled)
        XCTAssertEqual(FeaturesAdapter.lifecycleStage("filled"), .filled)
        XCTAssertEqual(FeaturesAdapter.lifecycleStage("cancelPending"), .cancelPending)
        XCTAssertEqual(FeaturesAdapter.lifecycleStage("neverArrived"), .neverArrived)
    }

    func testOrderLifecycleKeepsUnknownRawValueInsteadOfGuessing() {
        // Given 服务端新增了一种状态
        let stage = FeaturesAdapter.lifecycleStage("awaiting-venue-ack")

        // Then 原样保留，不猜成任何已知阶段，也不当作终态
        guard case let .unknownState(raw) = stage else {
            return XCTFail("未知订单状态必须保留为 unknownState，实际是 \(stage)")
        }
        XCTAssertEqual(raw, "awaiting-venue-ack")
        XCTAssertTrue(stage.isAwaiting == false)
        XCTAssertEqual(stage.label, "awaiting-venue-ack")
    }

    // MARK: - 严重等级与可信度

    func testSeverityKeepsUnknownRawValue() {
        XCTAssertEqual(FeaturesAdapter.severity("critical").label, "严重")
        XCTAssertEqual(FeaturesAdapter.severity("warning").label, "警告")
        XCTAssertEqual(FeaturesAdapter.severity("emergency").label, "emergency")
        XCTAssertEqual(FeaturesAdapter.severity("emergency").rank, 0)
    }

    func testTrustLabelsCoverEveryCase() {
        XCTAssertEqual(FeaturesAdapter.trustLabel(.fresh), "最新")
        XCTAssertEqual(FeaturesAdapter.trustLabel(.aging), "可能已变化")
        XCTAssertEqual(FeaturesAdapter.trustLabel(.stale), "陈旧")
        XCTAssertEqual(FeaturesAdapter.trustLabel(.expired), "已过期")
        XCTAssertEqual(FeaturesAdapter.trustLabel(.unknown), "尚未确认")
    }

    // MARK: - 设置：control 永不默认签发

    func testSettingsSeparatesDefaultAndExplicitScopes() {
        let state = FeaturesAdapter.featuresState(from: FeaturesAdapterInput(observation: nil, nowMs: 1))
        XCTAssertEqual(state.settings.defaultScopes, ["read"])
        XCTAssertEqual(state.settings.explicitScopes, ["control"])
        XCTAssertFalse(state.settings.defaultScopes.contains("control"))
    }

    // MARK: - 构造器

    private func makeStatus(
        execution: ExecutionState,
        trust: DataTrust,
        reachability: BotReachability,
        dependency: DependencyHealth = .healthy
    ) -> BotStatus {
        BotStatus(
            reachability: reachability,
            execution: execution,
            dependency: dependency,
            trust: trust,
            deskId: "alpha",
            label: "Alpha"
        )
    }

    private func makeObservation(bot: BotStatus) -> DeskObservation {
        DeskObservation(
            bot: bot,
            positions: [],
            orders: [],
            assets: [],
            alerts: [],
            generatedAtMs: 1_790_000_000_000,
            sourceId: "test-source"
        )
    }
}
