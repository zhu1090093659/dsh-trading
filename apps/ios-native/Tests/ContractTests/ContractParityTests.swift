import XCTest

/// 用户视角的契约行为（BDD 命名）：**用户**在未知卡片、非法推送、过期与跨源数据面前
/// 拿不到任何"看起来能用"的东西。常量表的逐字段比对在 ContractDriftTests，这里只锁行为。
///
/// 写作用域：apps/ios-native/Tests/ContractTests/**（IOS-1）
final class ContractParityTests: XCTestCase {

    /// 未知卡片类型 + 请求全平面配对 ⇒ 用户既按不动卡片，也拿不到 control。
    func testUserCannotOperateUnknownCardsOrObtainControlThroughPairing() {
        // Given: 一张比客户端新的卡片，和一次"我要全部 scope"的配对请求。
        let card = Card(
            cardId: "server-id", cardType: "future", revision: 0, fallbackText: "请升级客户端",
            actions: [CardAction(kind: "ack", label: "Ack")]
        )
        // When: 客户端校验卡片、计算可默认签发的平面。
        let verdict = validateCard(card)
        let granted = grantableByDefault(["read", "command", "control"])
        // Then: 卡片不可操作、配对不签发 control、未知动作落到最高档。
        XCTAssertFalse(verdict.valid, "未知 cardType 必须 valid=false（对齐 TS 代码，而不是它的注释）")
        XCTAssertFalse(verdict.operable)
        XCTAssertTrue(renderableActions(card, clientCaps: ["action:*"]).isEmpty)
        XCTAssertFalse(granted.contains(.control), "配对永不签发 control")
        // read/command 可以默认签发，control 永远被剔除（TS grantableByDefault 的真值）
        XCTAssertEqual(granted.map(\.rawValue), ["read", "command"])
    }

    /// 未知动作字符串 ⇒ 最高档（fail-closed）：不认识的绝不是"点一下就过"。
    func testUnknownActionNeverBecomesASafeDefault() {
        for raw in ["future-action", "", "KILL", "kill ", "kill\n"] {
            XCTAssertEqual(scopeForAction(raw), .control, raw)
            XCTAssertEqual(confirmLevel(for: raw), .biometric, raw)
        }
        // 认识的动作仍然按表走（fail-closed 不等于"一律最高档"）
        XCTAssertEqual(scopeForAction("ack"), .read)
        XCTAssertEqual(confirmLevel(for: "ack"), .none)
        XCTAssertEqual(confirmLevel(for: "approve"), .biometric)
        XCTAssertEqual(scopeForAction("approve"), .command)
    }

    /// 非法推送载荷与外部深链 ⇒ 一律 drop，不进入展示层。
    func testUserDropsInvalidPushAndExternalDeepLinks() {
        // Given: actions 不是数组的载荷（最容易被"顺手解析"成空数组）。
        let malformed = Data(#"{"kind":"escalation","severity":"info","deskId":"d","deeplink":"dshtrading://decisions/id","expiresInMs":1000,"actions":42,"fallbackText":"notice","revision":0}"#.utf8)
        // When / Then: 解码与校验闸门都必须拒绝它。
        XCTAssertThrowsError(try JSONDecoder().decode(PushPayload.self, from: malformed))
        XCTAssertNil(acceptedPush(malformed))
        // Given: 外部深链（推送通道的信任级别不足以把用户送去任意站点）。
        let external = Data(#"{"kind":"escalation","severity":"warning","deskId":"d","deeplink":"https://example.com/x","expiresInMs":1000,"actions":["ack"],"fallbackText":"x","revision":0}"#.utf8)
        XCTAssertNil(acceptedPush(external))
        XCTAssertEqual(parseDeeplink("https://example.com"), .rejected(reason: "NOT_APP_SCHEME"))
        // 合法载荷必须能过闸门（闸门不是"一律拒绝"）。
        let good = Data(#"{"kind":"escalation","severity":"warning","deskId":"d","deeplink":"dshtrading://decisions/d1","expiresInMs":1000,"actions":["ack"],"fallbackText":"x","revision":0}"#.utf8)
        XCTAssertNotNil(acceptedPush(good))
        // critical 却没给任何可用动作 ⇒ drop（只喊危险不给出口是不允许的）。
        let criticalNoExit = Data(#"{"kind":"kill-confirmed","severity":"critical","deskId":"d","deeplink":"dshtrading://control","expiresInMs":1000,"actions":[],"fallbackText":"已强制平仓","revision":0}"#.utf8)
        XCTAssertNil(acceptedPush(criticalNoExit))
    }

    /// 过期数据与跨源数据 ⇒ 用户看不到过期内容，也看不到另一个源的内容。
    func testUserCannotSeeExpiredOrMixedSourceData() {
        // Given: 一份已过期的快照与两个源的数据。
        let snapshot = OfflineSnapshot(data: "private", atMs: 0, sourceId: "a")
        let guardState = SourceGuard<String>(activeSourceId: "a")
        let rows = [SourcedDatum(id: "1", sourceId: "a", value: "A"), SourcedDatum(id: "2", sourceId: "b", value: "B")]
        // When: 视图过期、源开始切换。
        let view = offlineView(snapshot, nowMs: 1000, budget: StalenessBudget(freshMs: 10, staleMs: 20, ttlMs: 100))
        guardState.switchTo("b")
        // Then: 过期数据不渲染本身、切换期只读、跨源永不混显。
        if case .data = view { XCTFail("过期的快照不许渲染数据本身") }
        XCTAssertFalse(guardState.writable())
        XCTAssertEqual(guardState.viewOf(rows).map { $0.sourceId }, ["a"])
        XCTAssertFalse(guardState.reconcile(active: rows, incoming: []).ok)
        XCTAssertFalse(guardState.writable())
        XCTAssertTrue(guardState.reconcile(active: rows, incoming: rows).ok)
        XCTAssertEqual(guardState.viewOf(rows).map { $0.sourceId }, ["b"])
    }
}
