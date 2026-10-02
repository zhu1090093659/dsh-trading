import XCTest

/// A0 wire DTO（`Sources/Contract/ContractA0.swift`）的 fail-closed 行为。
///
/// 写作用域：apps/ios-native/Tests/ContractTests/**（IOS-1）
final class ContractA0Tests: XCTestCase {

    private func decode(_ json: String) throws -> A0Status {
        try JSONDecoder().decode(A0Status.self, from: Data(json.utf8))
    }

    func testDecodesTheRealA0StatusShape() throws {
        let status = try decode(#"""
        {"ok":true,"state":{"killed":false,"paused":true,"reason":"operator pause","atMs":1735689600000},"device":"dev-1","scopes":["read"]}
        """#)
        XCTAssertTrue(status.ok)
        XCTAssertFalse(status.state.killed)
        XCTAssertTrue(status.state.paused)
        XCTAssertEqual(status.state.reason, "operator pause")
        XCTAssertEqual(status.state.atMs, 1_735_689_600_000)
        XCTAssertEqual(status.device, "dev-1")
        XCTAssertEqual(status.scopes, [.read])
        XCTAssertFalse(status.hasControl, "配对不签发 control")
    }

    func testUnknownScopeIsDroppedAndNeverGrantsControl() throws {
        let status = try decode(#"""
        {"ok":true,"state":{"killed":false,"paused":false,"reason":"","atMs":1},"device":"d","scopes":["read","control","future-plane"]}
        """#)
        // 认识的平面保留，未知的丢弃（不猜、不授权）
        XCTAssertEqual(status.scopes, [.read, .control])
        XCTAssertTrue(status.hasControl)
        let onlyUnknown = try decode(#"""
        {"ok":true,"state":{"killed":false,"paused":false},"device":"d","scopes":["admin"]}
        """#)
        XCTAssertEqual(onlyUnknown.scopes, [], "未知平面一律丢弃")
        XCTAssertFalse(onlyUnknown.hasControl)
    }

    func testMissingKillFlagsThrowInsteadOfDefaultingToSafeLooking() {
        // 读不到 killed/paused ⇒ 必须抛错，让调用方按"拿不到 A0 状态"（不可判定）处理；
        // 默认成 false 会把"不知道"显示成"没被杀停"。
        XCTAssertThrowsError(try decode(#"{"ok":true,"state":{"reason":"x"},"device":"d","scopes":["read"]}"#))
        XCTAssertThrowsError(try decode(#"{"ok":true,"state":{"killed":false},"device":"d","scopes":["read"]}"#))
        // ok / state 缺失或类型不符同样抛错
        XCTAssertThrowsError(try decode(#"{"state":{"killed":true,"paused":true}}"#))
        XCTAssertThrowsError(try decode(#"{"ok":"yes","state":{"killed":true,"paused":true}}"#))
    }

    func testReasonAndTimestampAreLenientButFailClosed() throws {
        let status = try decode(#"{"ok":true,"state":{"killed":true,"paused":false},"device":"d"}"#)
        XCTAssertEqual(status.state.reason, "")
        XCTAssertEqual(status.state.atMs, 0, "拿不到 atMs 记 0 ⇒ 消费方按极旧处理")
        XCTAssertTrue(status.state.killed)
    }
}
