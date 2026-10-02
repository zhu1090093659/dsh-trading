import XCTest

/// 骨架冒烟：证明测试目标真的链接并运行了契约面源码。
final class ContractSmokeTests: XCTestCase {
    func testContractModuleIsLinkedAndFrozenSurfaceCompiles() {
        XCTAssertEqual(ContractVersion.apiMajor, 1)
        XCTAssertEqual(ScopePlane.allCases.count, 3)
        XCTAssertEqual(CardType.allCases.count, 12)
        XCTAssertEqual(ActionKind.allCases.count, 12)
        XCTAssertEqual(ConfirmLevel.allCases.count, 3)
    }
}
