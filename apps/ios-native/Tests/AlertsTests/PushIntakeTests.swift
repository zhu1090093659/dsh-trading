import XCTest
import DshTradingContract
@testable import DshTradingAlerts

/// 推送载荷接收：APNs userInfo / JSON → PushPayload，判据全在 Contract 的 acceptedPush。
final class PushIntakeTests: AlertsTestCase {
    func testNestedAPNsUserInfoYieldsPayload() {
        // Given 一条合法载荷放在 dsht 段里（aps 是系统段）
        let userInfo = AlertsTestCase.apnsUserInfo(payload: AlertsTestCase.payloadJSON())

        // When 接收
        let payload = PushIntake.accept(apnsUserInfo: userInfo)

        // Then 字段原样带出
        XCTAssertEqual(payload?.kind, "escalation")
        XCTAssertEqual(payload?.deskId, "desk-1")
        XCTAssertEqual(payload?.revision, 7)
    }

    func testFlatAPNsUserInfoIsAlsoAccepted() {
        // Given 扁平形态（去掉 aps 后就是业务段）
        let business = (try? JSONSerialization.jsonObject(with: AlertsTestCase.payloadJSON())) as? [String: Any] ?? [:]
        var userInfo: [AnyHashable: Any] = business
        userInfo["aps"] = ["alert": "通知"]

        // When / Then 一样能接收
        XCTAssertEqual(PushIntake.accept(apnsUserInfo: userInfo)?.deskId, "desk-1")
    }

    func testUnknownKindIsDropped() {
        // Given 未知 kind（封闭枚举之外）
        let data = AlertsTestCase.payloadJSON(kind: "not-a-kind")

        // When / Then 一律 drop（acceptedPush 拒绝），不"尽力解析"
        XCTAssertNil(PushIntake.accept(json: data))
    }

    func testExternalDeeplinkIsDropped() {
        // Given 指向外部站点的深链
        let data = AlertsTestCase.payloadJSON(deeplink: "https://evil.example.com/x")

        // When / Then 丢弃（校验期就挡住）
        XCTAssertNil(PushIntake.accept(json: data))
    }

    func testUnknownDeeplinkScreenIsDropped() {
        // Given 本 App scheme 但 screen 不在开放集内
        let data = AlertsTestCase.payloadJSON(deeplink: "dshtrading://evil-screen/1")

        // When / Then 丢弃（封闭集合，不尽力跳转）
        XCTAssertNil(PushIntake.accept(json: data))
    }

    func testMissingActionsKeyIsDropped() {
        // Given 载荷缺 actions（契约要求该字段存在）
        let object: [String: Any] = [
            "kind": "escalation", "severity": "warning", "deskId": "desk-1",
            "deeplink": "dshtrading://decisions", "expiresInMs": 60_000,
            "fallbackText": "兜底", "revision": 1,
        ]
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()

        // When / Then drop
        XCTAssertNil(PushIntake.accept(json: data))
    }

    func testUnknownActionIsDropped() {
        // Given 载荷声明了一个契约里没有的动作
        let data = AlertsTestCase.payloadJSON(actions: ["definitely-not-an-action"])

        // When / Then drop（validatePushPayload 的未知动作判据）
        XCTAssertNil(PushIntake.accept(json: data))
    }

    func testCriticalWithoutAnyActionIsDropped() {
        // Given critical 却不给任何可用动作（只喊危险不给出口）
        let data = AlertsTestCase.payloadJSON(severity: "critical", actions: [])

        // When / Then drop
        XCTAssertNil(PushIntake.accept(json: data))
    }

    func testCriticalWithActionIsAccepted() {
        // Given critical 且给了一个动作
        let data = AlertsTestCase.payloadJSON(severity: "critical", actions: ["ack"])

        // When / Then 接收
        XCTAssertEqual(PushIntake.accept(json: data)?.severity, "critical")
    }

    func testNonJSONValueInUserInfoIsRejected() {
        // Given userInfo 里混进了一个不是 JSON 类型的值（推送来自进程之外，不能假设形状）
        var userInfo: [AnyHashable: Any] = ["dsht": ["kind": "escalation", "when": Date()]]

        // When / Then 拒绝，不猜
        XCTAssertNil(PushIntake.accept(apnsUserInfo: userInfo))
        userInfo["dsht"] = ["kind": "escalation"]
        XCTAssertNil(PushIntake.accept(apnsUserInfo: userInfo))
    }
}
