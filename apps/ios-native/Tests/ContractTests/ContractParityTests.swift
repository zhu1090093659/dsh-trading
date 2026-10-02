import XCTest

final class ContractParityTests: XCTestCase {
    func testUserReceivesTheAuthoritativeContract() throws {
        // Given: a fresh snapshot exported from the actual TS contract.
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract-snapshot", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        func section(_ name: String) throws -> [String: Any] { try XCTUnwrap(root[name] as? [String: Any]) }
        // When: the native client exposes its negotiated wire surface.
        let version = try section("version")
        // Then: every exported enum and policy table equals the authority, not a handwritten fixture.
        XCTAssertEqual(version["apiMajor"] as? Int, ContractVersion.apiMajor)
        XCTAssertEqual(version["apiMinor"] as? Int, ContractVersion.apiMinor)
        XCTAssertEqual(version["compatibleMajorSpan"] as? Int, ContractVersion.compatibleMajorSpan)
        XCTAssertEqual(version["capsHeader"] as? String, ContractVersion.capsHeader)
        XCTAssertEqual(version["clientTooOldStatus"] as? Int, ContractVersion.clientTooOldStatus)
        let scopes = try section("scopes")
        XCTAssertEqual(scopes["planes"] as? [String], scopePlanes.map(\.rawValue))
        XCTAssertEqual(scopes["defaultPlanes"] as? [String], defaultScopePlanes.map(\.rawValue))
        XCTAssertEqual(scopes["explicitPlanes"] as? [String], explicitScopePlanes.map(\.rawValue))
        let cards = try section("cards")
        XCTAssertEqual(cards["types"] as? [String], CardType.allCases.map(\.rawValue))
        XCTAssertEqual(cards["fieldKinds"] as? [String], FieldKind.allCases.map(\.rawValue))
        XCTAssertEqual(cards["actionKinds"] as? [String], ActionKind.allCases.map(\.rawValue))
        XCTAssertEqual(cards["actionScope"] as? [String: String], Dictionary(uniqueKeysWithValues: actionScope.map { ($0.key.rawValue, $0.value.rawValue) }))
        let confirm = try section("confirm")
        XCTAssertEqual(confirm["levels"] as? [String], ConfirmLevel.allCases.map(\.rawValue))
        XCTAssertEqual(confirm["actionConfirm"] as? [String: String], Dictionary(uniqueKeysWithValues: actionConfirm.map { ($0.key.rawValue, $0.value.rawValue) }))
        let push = try section("push")
        XCTAssertEqual(push["severities"] as? [String], PushSeverity.allCases.map(\.rawValue))
        XCTAssertEqual(push["kinds"] as? [String], PushKind.allCases.map(\.rawValue))
        XCTAssertEqual(push["actions"] as? [String], PushAction.allCases.map(\.rawValue))
        XCTAssertEqual(push["deeplinkScheme"] as? String, deeplinkScheme)
        let offline = try section("offline")
        XCTAssertEqual(offline["staleness"] as? [String], Staleness.allCases.map(\.rawValue))
        XCTAssertEqual(offline["deeplinkScreens"] as? [String], DeeplinkScreen.allCases.map(\.rawValue))
    }

    func testUserCannotOperateUnknownCardsOrObtainControlThroughPairing() {
        // Given: a newer server card and a pairing request asking for all planes.
        let card = Card(cardId: "server-id", cardType: "future", revision: 0, fallbackText: "upgrade", actions: [CardAction(kind: "ack", label: "Ack")])
        // When: the client validates the card and computes pairing scopes.
        let verdict = validateCard(card)
        let granted = grantableByDefault(["read", "command", "control"])
        // Then: no control grant or guessed actionable renderer is possible.
        XCTAssertFalse(verdict.operable)
        XCTAssertFalse(granted.contains(.control))
        XCTAssertEqual(confirmLevel(for: "future-action"), .biometric)
        XCTAssertEqual(scopeForAction("future-action"), .control)
    }

    func testUserDropsInvalidPushAndExternalDeepLinks() throws {
        // Given: malformed actions that must not turn into an empty valid array.
        let json = #"{"kind":"escalation","severity":"info","deskId":"d","deeplink":"dshtrading://decisions/id","expiresInMs":1000,"actions":42,"fallbackText":"notice","revision":0}"#
        // When: the transport decodes the payload.
        // Then: malformed input is rejected before presentation.
        XCTAssertThrowsError(try JSONDecoder().decode(PushPayload.self, from: Data(json.utf8)))
        XCTAssertNil(acceptedPush(Data(json.utf8)))
        XCTAssertEqual(parseDeeplink("https://example.com"), .rejected(reason: "NOT_APP_SCHEME"))
    }

    func testUserCannotSeeExpiredOrMixedSourceData() {
        // Given: an expired snapshot and data from two sources.
        let snapshot = OfflineSnapshot(data: "private", atMs: 0, sourceId: "a")
        let guardState = SourceGuard<String>(activeSourceId: "a")
        let rows = [SourcedDatum(id: "1", sourceId: "a", value: "A"), SourcedDatum(id: "2", sourceId: "b", value: "B")]
        // When: the view expires and the source switches.
        let view = offlineView(snapshot, nowMs: 1000, budget: StalenessBudget(freshMs: 10, staleMs: 20, ttlMs: 100))
        guardState.switchTo("b")
        // Then: expired data is absent, writes stop immediately, and sources never mix.
        if case .data = view { XCTFail("expired data rendered") }
        XCTAssertFalse(guardState.writable())
        XCTAssertEqual(guardState.viewOf(rows).map { $0.sourceId }, ["a"])
        XCTAssertFalse(guardState.reconcile(active: rows, incoming: []).ok)
        XCTAssertFalse(guardState.writable())
        XCTAssertTrue(guardState.reconcile(active: rows, incoming: rows).ok)
        XCTAssertEqual(guardState.viewOf(rows).map { $0.sourceId }, ["b"])
    }
}
