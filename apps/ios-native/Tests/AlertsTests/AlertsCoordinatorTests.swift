import XCTest
import DshTradingContract
import DshTradingDomain
@testable import DshTradingAlerts

/// 接收流水总装：载荷 → 校验 → 偏好/静默 → revision 守卫 → 闭环 → 通知端口。
final class AlertsCoordinatorTests: AlertsTestCase {
    private func makeCoordinator(
        port: RecordingNotificationPort,
        lifecycle: AlertLifecycle = AlertLifecycle(),
        preferences: AlertPreferences = AlertPreferences(),
        nowMs: Int = 1_000_000
    ) -> AlertsCoordinator {
        AlertsCoordinator(
            lifecycle: lifecycle,
            notifications: port,
            preferences: preferences,
            clock: { nowMs }
        )
    }

    func testValidPayloadIsDeliveredAndRecorded() async {
        // Given 一条合法载荷 + 空闭环
        let port = RecordingNotificationPort()
        let lifecycle = AlertLifecycle()
        let coordinator = makeCoordinator(port: port, lifecycle: lifecycle)

        // When 接收
        let result = await coordinator.receive(json: AlertsTestCase.payloadJSON())

        // Then 入闭环、交给通知端口、且是打断级
        guard case .delivered(let record, _, let interrupted) = result else {
            return XCTFail("期望 delivered，实际 \(result)")
        }
        XCTAssertEqual(record.dedupeKey, "desk-1|escalation")
        XCTAssertTrue(interrupted)
        XCTAssertEqual(lifecycle.records.count, 1)
        XCTAssertEqual(port.delivered.count, 1)
        XCTAssertEqual(port.interruptedFlags, [true])
    }

    func testMutedDeskIsDeliveredSilently() async {
        // Given 该 desk 被静音
        let port = RecordingNotificationPort()
        let coordinator = makeCoordinator(port: port, preferences: AlertPreferences(mutedDesks: ["desk-1"]))

        // When 接收一条 warning
        let result = await coordinator.receive(json: AlertsTestCase.payloadJSON(severity: "warning"))

        // Then 仍然入闭环并送达，但**静默**（不打断）
        guard case .delivered(_, _, let interrupted) = result else {
            return XCTFail("期望 delivered，实际 \(result)")
        }
        XCTAssertFalse(interrupted)
        XCTAssertEqual(port.interruptedFlags, [false])
    }

    func testCriticalStaysInterruptingEvenWhenMuted() async {
        // Given critical + 静音
        let port = RecordingNotificationPort()
        let coordinator = makeCoordinator(port: port, preferences: AlertPreferences(mutedDesks: ["desk-1"]))

        // When / Then critical 不受静音影响
        let result = await coordinator.receive(json: AlertsTestCase.payloadJSON(severity: "critical", actions: ["ack"]))
        guard case .delivered(_, _, let interrupted) = result else {
            return XCTFail("期望 delivered，实际 \(result)")
        }
        XCTAssertTrue(interrupted)
    }

    func testInvalidPayloadIsDroppedWithoutTouchingLifecycleOrNotifications() async {
        // Given 未知 kind
        let port = RecordingNotificationPort()
        let lifecycle = AlertLifecycle()
        let coordinator = makeCoordinator(port: port, lifecycle: lifecycle)

        // When
        let result = await coordinator.receive(json: AlertsTestCase.payloadJSON(kind: "not-a-kind"))

        // Then 丢弃（带原因），闭环与通知端口都没被碰
        guard case .dropped(let reason) = result else { return XCTFail("期望 dropped，实际 \(result)") }
        XCTAssertTrue(reason.contains("载荷非法"), "实际：" + reason)
        XCTAssertTrue(lifecycle.records.isEmpty)
        XCTAssertTrue(port.delivered.isEmpty)
    }

    func testOutOfOrderRevisionIsDropped() async {
        // Given 已处理 revision 7
        let port = RecordingNotificationPort()
        let lifecycle = AlertLifecycle()
        let coordinator = makeCoordinator(port: port, lifecycle: lifecycle)
        _ = await coordinator.receive(json: AlertsTestCase.payloadJSON(revision: 7))

        // When 一条落后的 revision 5 到达
        let stale = await coordinator.receive(json: AlertsTestCase.payloadJSON(revision: 5))

        // Then 丢弃（APNs 不保证顺序），不覆盖更新的状态
        guard case .dropped(let reason) = stale else { return XCTFail("期望 dropped，实际 \(stale)") }
        XCTAssertTrue(reason.contains("乱序"), "实际：" + reason)
        XCTAssertEqual(port.delivered.count, 1)
        XCTAssertEqual(lifecycle.records.first?.occurrences, 1)

        // And 更新的 revision 8 仍然正常
        let fresh = await coordinator.receive(json: AlertsTestCase.payloadJSON(revision: 8))
        guard case .delivered = fresh else { return XCTFail("期望 delivered，实际 \(fresh)") }
        XCTAssertEqual(lifecycle.records.first?.occurrences, 2)
    }

    func testFractionalRevisionOrderingIsNotTruncated() async {
        // Given 已处理 revision 3.5
        let port = RecordingNotificationPort()
        let coordinator = makeCoordinator(port: port)
        _ = await coordinator.receive(json: AlertsTestCase.payloadJSON(revision: 3.5))

        // When 一条 3.4 到达
        let stale = await coordinator.receive(json: AlertsTestCase.payloadJSON(revision: 3.4))

        // Then 被丢弃 —— 若守卫里做 Int 截断（3.5→3、3.4→3）就会把旧通知误放行
        guard case .dropped(let reason) = stale else { return XCTFail("期望 dropped，实际 \(stale)") }
        XCTAssertTrue(reason.contains("乱序"), "实际：" + reason)
        XCTAssertEqual(port.delivered.count, 1)
    }

    func testNotRegisteredPushTokenDoesNotBlockReceiving() async {
        // Given 尚未注册推送 token
        let port = RecordingNotificationPort()
        let lifecycle = AlertLifecycle()
        let coordinator = makeCoordinator(port: port, lifecycle: lifecycle)
        coordinator.updateRegistration(.notRegistered)

        // When 仍然收到一条载荷
        let result = await coordinator.receive(json: AlertsTestCase.payloadJSON())

        // Then 照常入闭环（推送注册状态不参与观测/告警路径）
        guard case .delivered = result else { return XCTFail("期望 delivered，实际 \(result)") }
        XCTAssertEqual(coordinator.pushRegistration, .notRegistered)
        XCTAssertEqual(lifecycle.records.count, 1)
    }

    func testAPNsUserInfoPathWorksEndToEnd() async {
        // Given 嵌套形态的 APNs userInfo
        let port = RecordingNotificationPort()
        let coordinator = makeCoordinator(port: port)
        let userInfo = AlertsTestCase.apnsUserInfo(payload: AlertsTestCase.payloadJSON())

        // When / Then 与 JSON 路径同构
        guard case .delivered(let record, _, _) = await coordinator.receive(apnsUserInfo: userInfo) else {
            return XCTFail("期望 delivered")
        }
        XCTAssertEqual(record.deskId, "desk-1")
    }

    func testInstallCategoriesPushesIntersectionActions() async {
        // Given 一个记录型通知端口
        let port = RecordingNotificationPort()
        let coordinator = makeCoordinator(port: port)

        // When 装类目
        await coordinator.installCategories()

        // Then 端口收到的是契约交集定义的类目
        XCTAssertEqual(port.categories, AlertCategories.all)
        XCTAssertEqual(port.categories.first?.actions, AlertsNotificationAction.identifiers)
    }

    func testDeeplinkRoutingOnlyOpensAllowedScreens() async {
        // Given 一个记录型 opener
        let opener = RecordingDeeplinkOpener()
        let coordinator = makeCoordinator(port: RecordingNotificationPort())

        // When 未知 screen / 外部链接
        let unknown = coordinator.route("dshtrading://evil-screen/1", opener: opener)
        let external = coordinator.route("https://evil.example.com/x", opener: opener)

        // Then 一律 rejected，且 opener 一次都没被调用
        if case .rejected = unknown {} else { XCTFail("期望 rejected，实际 \(unknown)") }
        if case .rejected = external {} else { XCTFail("期望 rejected，实际 \(external)") }
        XCTAssertEqual(opener.count, 0)

        // And 开放集内的目标正常打开
        let allowed = coordinator.route("dshtrading://positions/p-1", opener: opener)
        if case .ok(let screen, let id) = allowed {
            XCTAssertEqual(screen, .positions)
            XCTAssertEqual(id, "p-1")
        } else {
            XCTFail("期望 ok，实际 \(allowed)")
        }
        XCTAssertEqual(opener.screens, [.positions])
    }

    func testNotificationActionGoesThroughGateAndFailsClosed() async {
        // Given 生物识别不可用
        let coordinator = makeCoordinator(port: RecordingNotificationPort())
        let gate = AlertsConfirmationGate(biometrics: RecordingBiometrics(.unavailable(reason: "no hardware")))

        // When 按下一个控制类通知动作
        let decision = await coordinator.handleNotificationAction("kill", gate: gate, reason: "kill")

        // Then 走闸门且 fail-closed（unavailable，不是放行）
        XCTAssertEqual(decision, .unavailable(reason: "no hardware"))
    }

    func testUnknownNotificationActionIsIgnored() async {
        // Given / When 一个不在交集内的动作标识
        let coordinator = makeCoordinator(port: RecordingNotificationPort())
        let gate = AlertsConfirmationGate(biometrics: RecordingBiometrics(.success))

        // Then 返回 nil（不猜、不放行）
        let decision = await coordinator.handleNotificationAction("open-detail", gate: gate, reason: "x")
        XCTAssertNil(decision)
    }
}
