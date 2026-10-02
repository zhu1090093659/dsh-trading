import XCTest
import DshTradingContract
@testable import DshTradingAlerts

/// 通知类目、动作交集、锁屏脱敏与前台强度。
final class AlertNotificationTests: AlertsTestCase {
    func testCategoriesCoverEveryPushKind() {
        // Given / When 全部类目
        let categories = AlertCategories.all

        // Then 一个 PushKind 一个类目，id 带统一前缀
        XCTAssertEqual(categories.count, PushKind.allCases.count)
        XCTAssertTrue(categories.allSatisfy { $0.id.hasPrefix(AlertCategories.identifierPrefix) })
    }

    func testActionIdentifiersAreExactlyPushActionIntersectActionKind() {
        // Given 交集定义
        let expected = PushAction.allCases.map(\.rawValue).filter { ActionKind(rawValue: $0) != nil }

        // When / Then 通知动作集合就是交集本身
        XCTAssertEqual(AlertsNotificationAction.identifiers, expected)
        XCTAssertEqual(Set(AlertsNotificationAction.identifiers), Set(["ack", "approve", "reject", "pause", "kill"]))
    }

    func testUnknownNotificationActionMapsToNil() {
        // Given 已知 / 是卡片动作但不是推送动作 / 完全未知
        // When / Then 只有交集内的才映射得出
        XCTAssertEqual(AlertsNotificationAction.actionKind(for: "ack"), .ack)
        XCTAssertNil(AlertsNotificationAction.actionKind(for: "open-detail"))
        XCTAssertNil(AlertsNotificationAction.actionKind(for: "definitely-not-an-action"))
    }

    func testAvailableActionsFilterOutNonPushActions() {
        // Given 载荷声明了一个不是推送动作的卡片动作
        let payload = AlertsTestCase.decode(AlertsTestCase.payloadJSON(actions: ["ack", "open-detail"]))

        // Then 只留下交集内的
        XCTAssertEqual(AlertCategories.availableActions(for: payload), ["ack"])
    }

    func testLockScreenHidesBusinessDetail() {
        // Given fallbackText 里带敏感数值
        let marker = "可用资金 1234567 元"
        let payload = AlertsTestCase.decode(AlertsTestCase.payloadJSON(severity: "warning", fallbackText: marker))

        // When 用默认的 hidden 档构造内容
        let content = AlertContentBuilder.content(for: payload, detail: .hidden)

        // Then 标题与正文都不回显业务数值，只给中性提示
        XCTAssertFalse(content.body.contains("1234567"))
        XCTAssertFalse(content.title.contains("1234567"))
        XCTAssertTrue(content.body.contains("解锁"))
    }

    func testFullDetailShowsFallbackText() {
        // Given 用户选择在锁屏显示细节
        let payload = AlertsTestCase.decode(AlertsTestCase.payloadJSON(fallbackText: "持仓已减半"))

        // When / Then 正文就是服务端文案
        XCTAssertEqual(AlertContentBuilder.content(for: payload, detail: .full).body, "持仓已减半")
    }

    func testUnknownKindFallsBackToDefaultCategory() {
        // Given 未知 kind（校验期会被 drop，这里只验构造不猜类目）
        let payload = AlertsTestCase.decode(AlertsTestCase.payloadJSON(kind: "unknown-kind"))

        // When / Then 用显式的 default 类目，而不是拼一个假 id
        XCTAssertEqual(
            AlertContentBuilder.content(for: payload, detail: .hidden).categoryId,
            AlertCategories.defaultCategoryId
        )
        XCTAssertNil(AlertCategories.categoryId(forKind: "unknown-kind"))
    }

    func testContentUserInfoCarriesRoutingFacts() {
        // Given 一条带深链与 revision 的载荷
        let payload = AlertsTestCase.decode(AlertsTestCase.payloadJSON(deeplink: "dshtrading://positions/p-1", revision: 12))

        // When
        let content = AlertContentBuilder.content(for: payload, detail: .hidden)

        // Then 路由/去重需要的事实都在 userInfo 里（深链仍受开放集约束）
        XCTAssertEqual(content.userInfo["deeplink"], "dshtrading://positions/p-1")
        // Contract 的 revision 是 Double，String(...) 给出 "12.0"（该值是内部路由元数据，不展示给用户）
        XCTAssertEqual(content.userInfo["revision"], "12.0")
        XCTAssertEqual(content.userInfo["deskId"], "desk-1")
        XCTAssertEqual(content.userInfo["dedupeKey"], "desk-1|escalation")
    }

    func testForegroundPresentation() {
        // Given / When / Then critical 一律强提示；其余只在应当打断时出横幅
        XCTAssertEqual(AlertPresentation.foreground(severity: "critical", interrupted: false), .bannerAndSound)
        XCTAssertEqual(AlertPresentation.foreground(severity: "warning", interrupted: true), .bannerAndSound)
        XCTAssertEqual(AlertPresentation.foreground(severity: "warning", interrupted: false), .silentList)
    }
}
