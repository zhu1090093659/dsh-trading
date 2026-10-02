import XCTest
import DshTradingContract
@testable import DshTradingAlerts

/// 告警闭环：发生 → 重复 → 确认 → 恢复；**确认 ≠ 恢复**。
final class AlertLifecycleTests: AlertsTestCase {
    func testRaiseCreatesOneOpenRecord() {
        // Given 一个空闭环
        let lifecycle = AlertLifecycle()

        // When 发生一次
        let record = lifecycle.observe(deskId: "desk-1", kind: "escalation", severity: "warning", atMs: 1000)

        // Then 一条 open 记录，次数 1
        XCTAssertEqual(record.occurrences, 1)
        XCTAssertTrue(record.isOpen)
        XCTAssertFalse(record.isAcknowledged)
        XCTAssertFalse(record.isRecovered)
        XCTAssertEqual(record.firstSeenAtMs, 1000)
        XCTAssertEqual(lifecycle.records.count, 1)
    }

    func testRepeatAggregatesIntoTheSameRecord() {
        // Given 已有一条告警
        let lifecycle = AlertLifecycle()
        lifecycle.observe(deskId: "desk-1", kind: "escalation", severity: "warning", atMs: 1000)

        // When 同一 (desk, kind) 再来一次
        let record = lifecycle.observe(deskId: "desk-1", kind: "escalation", severity: "warning", atMs: 2000)

        // Then 聚合成一条（不刷屏），首见时间不变、最近时间前移
        XCTAssertEqual(lifecycle.records.count, 1)
        XCTAssertEqual(record.occurrences, 2)
        XCTAssertEqual(record.firstSeenAtMs, 1000)
        XCTAssertEqual(record.lastSeenAtMs, 2000)
        XCTAssertEqual(lifecycle.history.map(\.transition), [.raised, .repeated])
    }

    func testAcknowledgeDoesNotRecover() {
        // Given 一条 open 告警
        let lifecycle = AlertLifecycle()
        let raised = lifecycle.observe(deskId: "desk-1", kind: "escalation", severity: "warning", atMs: 1000)

        // When 用户确认
        let acknowledged = lifecycle.acknowledge(dedupeKey: raised.dedupeKey, atMs: 1500)

        // Then 已确认，但**仍然 open**（确认不是恢复）
        XCTAssertEqual(acknowledged?.isAcknowledged, true)
        XCTAssertEqual(acknowledged?.isRecovered, false)
        XCTAssertEqual(acknowledged?.isOpen, true)
        XCTAssertEqual(lifecycle.openRecords.count, 1)
    }

    func testRecoverKeepsAcknowledgementIndependent() {
        // Given 已确认的告警
        let lifecycle = AlertLifecycle()
        let raised = lifecycle.observe(deskId: "desk-1", kind: "escalation", severity: "warning", atMs: 1000)
        lifecycle.acknowledge(dedupeKey: raised.dedupeKey, atMs: 1500)

        // When 故障恢复
        let recovered = lifecycle.recover(dedupeKey: raised.dedupeKey, atMs: 2500)

        // Then 两个事实各自成立（恢复不改确认）
        XCTAssertEqual(recovered?.isAcknowledged, true)
        XCTAssertEqual(recovered?.isRecovered, true)
        XCTAssertFalse(recovered?.isOpen ?? true)
        XCTAssertEqual(lifecycle.openRecords.count, 0)
    }

    func testRecoverWithoutAcknowledgeIsAllowed() {
        // Given 一条没被确认的告警
        let lifecycle = AlertLifecycle()
        let raised = lifecycle.observe(deskId: "desk-1", kind: "escalation", severity: "warning", atMs: 1000)

        // When 直接恢复
        let recovered = lifecycle.recover(dedupeKey: raised.dedupeKey, atMs: 2000)

        // Then 恢复成立，且**没有**被冒认成"用户已确认"
        XCTAssertEqual(recovered?.isRecovered, true)
        XCTAssertEqual(recovered?.isAcknowledged, false)
    }

    func testRepeatTransitionsAreIdempotentInHistory() {
        // Given 已确认、已恢复的告警
        let lifecycle = AlertLifecycle()
        let raised = lifecycle.observe(deskId: "desk-1", kind: "escalation", severity: "warning", atMs: 1000)
        lifecycle.acknowledge(dedupeKey: raised.dedupeKey, atMs: 1100)
        lifecycle.recover(dedupeKey: raised.dedupeKey, atMs: 1200)
        let countBefore = lifecycle.history.count

        // When 重复确认/重复恢复
        lifecycle.acknowledge(dedupeKey: raised.dedupeKey, atMs: 1300)
        lifecycle.recover(dedupeKey: raised.dedupeKey, atMs: 1400)

        // Then 历史不重复记（append-only 只记真实转移）
        XCTAssertEqual(lifecycle.history.count, countBefore)
        XCTAssertEqual(lifecycle.records.first?.acknowledgedAtMs, 1100)
        XCTAssertEqual(lifecycle.records.first?.recoveredAtMs, 1200)
    }

    func testReRaiseAfterRecoveryStartsANewCycle() {
        // Given 上一轮已确认并恢复
        let lifecycle = AlertLifecycle()
        let raised = lifecycle.observe(deskId: "desk-1", kind: "escalation", severity: "warning", atMs: 1000)
        lifecycle.acknowledge(dedupeKey: raised.dedupeKey, atMs: 1100)
        lifecycle.recover(dedupeKey: raised.dedupeKey, atMs: 1200)

        // When 同一个问题再次发生
        let again = lifecycle.observe(deskId: "desk-1", kind: "escalation", severity: "critical", atMs: 2000)

        // Then 是新一轮：再次 open，上一轮的确认不适用于新故障
        XCTAssertTrue(again.isOpen)
        XCTAssertFalse(again.isAcknowledged)
        XCTAssertFalse(again.isRecovered)
        XCTAssertEqual(again.occurrences, 2)
        XCTAssertEqual(again.firstSeenAtMs, 1000)
        XCTAssertEqual(lifecycle.history.map(\.transition), [.raised, .acknowledged, .recovered, .raised])
    }

    func testUnknownKeyOperationsReturnNil() {
        // Given 空闭环
        let lifecycle = AlertLifecycle()

        // When / Then 对不存在的告警操作返回 nil（不凭空造一条）
        XCTAssertNil(lifecycle.acknowledge(dedupeKey: "nope", atMs: 1))
        XCTAssertNil(lifecycle.recover(dedupeKey: "nope", atMs: 1))
        XCTAssertTrue(lifecycle.records.isEmpty)
        XCTAssertTrue(lifecycle.history.isEmpty)
    }

    func testDedupeKeyIsDeskAndKind() {
        // Given 同 kind 不同 desk
        let lifecycle = AlertLifecycle()
        lifecycle.observe(deskId: "desk-1", kind: "escalation", severity: "warning", atMs: 1000)
        lifecycle.observe(deskId: "desk-2", kind: "escalation", severity: "warning", atMs: 1000)

        // Then 两条独立告警（聚合只在同一台 desk 内发生）
        XCTAssertEqual(lifecycle.records.count, 2)
        XCTAssertEqual(AlertLifecycle.dedupeKey(deskId: "desk-1", kind: "escalation"), "desk-1|escalation")
    }
}
