import XCTest
import DshTradingContract
import DshTradingDomain
@testable import DshTradingAlerts

/// 确认闸门：档位取自契约，生物识别不可用时**必须 fail-closed**。
final class AlertsConfirmationGateTests: AlertsTestCase {
    func testNoneLevelApprovesWithoutTouchingBiometrics() async {
        // Given 一个"一定会失败"的生物识别
        let biometrics = RecordingBiometrics(.failed)
        let gate = AlertsConfirmationGate(biometrics: biometrics)

        // When 问一个 none 档
        let decision = await gate.confirm(level: .none, reason: "ack")

        // Then 放行，且根本没碰生物识别
        XCTAssertEqual(decision, .approved)
        XCTAssertEqual(biometrics.callCount, 0)
    }

    func testConfirmLevelIsTreatedAsAlreadyConfirmedInApp() async {
        // Given 二次确认档（界面交互属于 Features）
        let biometrics = RecordingBiometrics(.failed)
        let gate = AlertsConfirmationGate(biometrics: biometrics)

        // When 问二次确认档
        let decision = await gate.confirm(level: .confirm, reason: "approve")

        // Then 闸门只负责强因子，不重复问
        XCTAssertEqual(decision, .approved)
        XCTAssertEqual(biometrics.callCount, 0)
    }

    func testBiometricSuccessApproves() async {
        // Given 生物识别成功
        let gate = AlertsConfirmationGate(biometrics: RecordingBiometrics(.success))

        // When 问闸门
        let decision = await gate.confirm(level: .biometric, reason: "kill")

        // Then 放行
        XCTAssertEqual(decision, .approved)
    }

    func testBiometricFailureDenies() async {
        // Given 生物识别没过
        let gate = AlertsConfirmationGate(biometrics: RecordingBiometrics(.failed))

        // When 问闸门
        let decision = await gate.confirm(level: .biometric, reason: "kill")

        // Then 拒绝
        XCTAssertEqual(decision, .denied)
    }

    func testBiometricCancelDenies() async {
        // Given 用户在弹窗里点了取消
        let gate = AlertsConfirmationGate(biometrics: RecordingBiometrics(.canceled))

        // When 问闸门
        let decision = await gate.confirm(level: .biometric, reason: "kill")

        // Then 拒绝（取消不是放行）
        XCTAssertEqual(decision, .denied)
    }

    func testBiometricUnavailableIsFailClosed() async {
        // Given 设备做不了生物识别（无硬件/未录入/被策略禁用）
        let gate = AlertsConfirmationGate(biometrics: RecordingBiometrics(.unavailable(reason: "no hardware")))

        // When
        let decision = await gate.confirm(level: .biometric, reason: "flatten")

        // Then 是 unavailable（fail-closed 的一种），**绝不放行**
        XCTAssertEqual(decision, .unavailable(reason: "no hardware"))
        XCTAssertNotEqual(decision, .approved)
    }

    func testNotificationActionLevelsComeFromContract() {
        // Given / When / Then 档位取自契约；未知标识一律最高档
        XCTAssertEqual(AlertsGate.level(forNotificationAction: "kill"), .biometric)
        XCTAssertEqual(AlertsGate.level(forNotificationAction: "ack"), .none)
        XCTAssertEqual(AlertsGate.level(forNotificationAction: "definitely-not-an-action"), .biometric)
    }

    func testContractConfirmPolicyAuditPasses() {
        // Given 契约的确认策略表
        // When 跑它的自检
        let audit = auditConfirmPolicy()

        // Then 无问题（control 一律 biometric）
        XCTAssertTrue(audit.ok, audit.problems.joined(separator: "；"))
        XCTAssertTrue(audit.problems.isEmpty)
    }

    func testBiometricApprovalDoesNotReplaceServerAuthorization() {
        // Given 一个 control 类动作
        // When 客户端闸门放行之后
        // Then 服务端授权判据**没有因此改变**：它仍要求 control 作用域。
        //      生物识别只决定"要不要把动作发出去"，服务端仍按 scope 与 mandate 判。
        XCTAssertEqual(scopeForAction("kill"), .control)
        XCTAssertEqual(scopeForAction("ack"), .read)
        XCTAssertEqual(confirmLevel(for: "kill"), .biometric)
    }
}
