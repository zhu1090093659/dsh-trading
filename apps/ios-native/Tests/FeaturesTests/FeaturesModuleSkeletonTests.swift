import XCTest
import DshTradingContract
@testable import DshTradingFeatures

/// Features 子目录的测试骨架占位 —— 认领该目录的子卡直接在这里（或同目录新文件）写用例，
/// 不必改 project.yml：`Tests/FeaturesTests/**` 已被 DshTradingFeaturesTests 目标整体 glob。
///
/// 写作用域：apps/ios-native/Tests/FeaturesTests/**
final class FeaturesModuleSkeletonTests: XCTestCase {
    func testModuleIsLinkedAndContractSurfaceIsAvailable() {
        // 子卡只需 import DshTradingContract 就能拿到冻结的封闭枚举与判据，不要在本模块另立一份。
        XCTAssertEqual(ScopePlane.allCases.count, 3)
        XCTAssertEqual(ScopePlane.allCases.map(\.rawValue), ["read", "command", "control"])
    }
}
