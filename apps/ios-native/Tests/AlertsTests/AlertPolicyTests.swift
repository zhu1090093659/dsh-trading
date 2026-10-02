import XCTest
import DshTradingContract
@testable import DshTradingAlerts

/// 通知分级、静音与静默时段：critical 永远例外这条必须由测试钉住。
final class AlertPolicyTests: AlertsTestCase {
    private func payload(severity: String = "warning", deskId: String = "desk-1") -> PushPayload {
        AlertsTestCase.decode(AlertsTestCase.payloadJSON(severity: severity, deskId: deskId))
    }

    func testWarningInterruptsWhenDeskIsNotMuted() {
        // Given / When 未静音
        let interrupt = AlertPolicy.shouldInterrupt(payload(), preferences: AlertPreferences(), minuteOfDay: 600)

        // Then 打断
        XCTAssertTrue(interrupt)
    }

    func testMutedDeskSuppressesNonCritical() {
        // Given 该 desk 被静音
        let preferences = AlertPreferences(mutedDesks: ["desk-1"])

        // When / Then 不打断
        XCTAssertFalse(AlertPolicy.shouldInterrupt(payload(), preferences: preferences, minuteOfDay: 600))
    }

    func testCriticalIgnoresDeskMute() {
        // Given critical + 该 desk 被静音
        let preferences = AlertPreferences(mutedDesks: ["desk-1"])

        // When / Then 仍然打断（契约的 shouldInterrupt 例外）
        XCTAssertTrue(
            AlertPolicy.shouldInterrupt(payload(severity: "critical"), preferences: preferences, minuteOfDay: 600)
        )
    }

    func testQuietHoursSuppressNonCritical() {
        // Given 静默时段 22:00-07:00，当前 23:00
        let preferences = AlertPreferences(quietHours: QuietHours(startMinute: 22 * 60, endMinute: 7 * 60))

        // When / Then 不打断
        XCTAssertFalse(AlertPolicy.shouldInterrupt(payload(), preferences: preferences, minuteOfDay: 23 * 60))
    }

    func testCriticalIgnoresQuietHours() {
        // Given critical + 静默时段内
        let preferences = AlertPreferences(quietHours: QuietHours(startMinute: 22 * 60, endMinute: 7 * 60))

        // When / Then 仍打断
        XCTAssertTrue(
            AlertPolicy.shouldInterrupt(payload(severity: "critical"), preferences: preferences, minuteOfDay: 23 * 60)
        )
    }

    func testQuietHoursWrapAroundMidnight() {
        // Given 23:00-07:00
        let quiet = QuietHours(startMinute: 23 * 60, endMinute: 7 * 60)

        // Then 夜里在区间内、白天不在
        XCTAssertTrue(quiet?.contains(minuteOfDay: 23 * 60 + 30) == true)
        XCTAssertTrue(quiet?.contains(minuteOfDay: 3 * 60) == true)
        XCTAssertFalse(quiet?.contains(minuteOfDay: 12 * 60) == true)
        XCTAssertFalse(quiet?.contains(minuteOfDay: 7 * 60) == true)
    }

    func testQuietHoursRejectsOutOfRangeAndEqualBoundsAreEmpty() {
        // Given / When 越界与相等边界
        // Then 越界构造失败；相等视为空区间（不是全天静音）
        XCTAssertNil(QuietHours(startMinute: -1, endMinute: 10))
        XCTAssertNil(QuietHours(startMinute: 0, endMinute: 1440))
        XCTAssertFalse(QuietHours(startMinute: 100, endMinute: 100)?.contains(minuteOfDay: 100) == true)
    }

    func testDefaultsAreConservative() {
        // Given 默认偏好
        let preferences = AlertPreferences()

        // Then 锁屏只给中性提示、正常成交不推送（默认不制造噪声）
        XCTAssertEqual(preferences.lockScreenDetail, .hidden)
        XCTAssertFalse(preferences.pushOnEveryFill)
        XCTAssertTrue(preferences.mutedDesks.isEmpty)
        XCTAssertNil(preferences.quietHours)
    }

    func testHandlerDropsInvalidKindWithReason() {
        // Given 未知 kind 的载荷
        let payload = AlertsTestCase.decode(AlertsTestCase.payloadJSON(kind: "not-a-kind"))

        // When
        let decision = PushHandler.decide(payload, preferences: AlertPreferences(), minuteOfDay: 600)

        // Then 丢弃，且理由来自契约校验
        guard case .drop(let reason) = decision else { return XCTFail("期望 drop，实际 \(decision)") }
        XCTAssertTrue(reason.contains("载荷非法"), "实际：" + reason)
    }

    func testHandlerDropsExternalDeeplinkWithoutGuessing() {
        // Given 外部深链
        let payload = AlertsTestCase.decode(AlertsTestCase.payloadJSON(deeplink: "https://evil.example.com/x"))

        // When
        let decision = PushHandler.decide(payload, preferences: AlertPreferences(), minuteOfDay: 600)

        // Then 不打开
        guard case .drop = decision else { return XCTFail("期望 drop，实际 \(decision)") }
    }

    func testHandlerOpensKnownScreenWithInterruptAndRevision() {
        // Given 合法载荷 + 未静音
        let payload = AlertsTestCase.decode(AlertsTestCase.payloadJSON(severity: "critical", actions: ["ack"], revision: 9))

        // When
        let decision = PushHandler.decide(payload, preferences: AlertPreferences(), minuteOfDay: 600)

        // Then 打开 decisions、打断、critical、revision 原样带出
        guard case .open(let screen, let interrupt, let critical, let revision) = decision else {
            return XCTFail("期望 open，实际 \(decision)")
        }
        XCTAssertEqual(screen, .decisions)
        XCTAssertTrue(interrupt)
        XCTAssertTrue(critical)
        XCTAssertEqual(revision, 9)
    }

    func testFractionalRevisionSurvivesDecisionUnchanged() {
        // Given 服务端发了一个小数 revision（Contract 用 Double 贴合 TS 的有限数语义）
        let payload = AlertsTestCase.decode(AlertsTestCase.payloadJSON(revision: 3.5))

        // When 处理
        let decision = PushHandler.decide(payload, preferences: AlertPreferences(), minuteOfDay: 600)

        // Then 原样带出，**不被整数截断**（截断就是改变语义）
        guard case .open(_, _, _, let revision) = decision else {
            return XCTFail("期望 open，实际 \(decision)")
        }
        XCTAssertEqual(revision, 3.5)
    }
}
