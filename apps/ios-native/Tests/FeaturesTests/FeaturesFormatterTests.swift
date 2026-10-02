//
//  FeaturesFormatterTests.swift
//  DshTradingFeaturesTests
//
//  展示格式化的可复现性：时间按给定时区、相对年龄不出现负数、缺失值一律「未知」。
//

import XCTest
@testable import DshTradingFeatures

final class FeaturesFormatterTests: XCTestCase {
    private let shanghai = TimeZone(identifier: "Asia/Shanghai") ?? .gmt

    func testClockUsesGivenTimeZone() {
        // Given 一个确定的毫秒时间戳（1970-01-01T00:00:00Z = 08:00 Asia/Shanghai）
        let atMs = 0

        // Then 按给定时区输出，不受运行机器时区影响
        XCTAssertEqual(FeaturesFormatter.clock(atMs, timeZone: shanghai), "08:00:00")
        XCTAssertEqual(FeaturesFormatter.clock(atMs, timeZone: .gmt), "00:00:00")
        XCTAssertNil(FeaturesFormatter.clock(nil, timeZone: shanghai))
    }

    func testRelativeAgeNeverGoesNegative() {
        XCTAssertEqual(FeaturesFormatter.relativeAge(atMs: 1_000, nowMs: 1_000 + 5_000), "5 秒前")
        XCTAssertEqual(FeaturesFormatter.relativeAge(atMs: 1_000, nowMs: 1_000 + 120_000), "2 分钟前")
        XCTAssertEqual(FeaturesFormatter.relativeAge(atMs: 1_000, nowMs: 1_000 + 7_200_000), "2 小时前")
        // 时钟回拨：显示「刚刚」而不是负数
        XCTAssertEqual(FeaturesFormatter.relativeAge(atMs: 10_000, nowMs: 1_000), "刚刚")
    }

    func testUpdatedLineAlwaysLabelsTheSnapshotTime() {
        let line = FeaturesFormatter.updatedLine(atMs: 0, nowMs: 5_000, timeZone: shanghai)
        XCTAssertTrue(line.contains("数据更新时间 08:00:00"))
        XCTAssertTrue(line.contains("5 秒前"))
        XCTAssertEqual(FeaturesFormatter.updatedLine(atMs: nil, nowMs: 0, timeZone: shanghai), "数据更新时间：未知（尚未取到）")
    }

    func testMissingValuesRenderAsUnknownNotEmptyString() {
        XCTAssertEqual(FeaturesFormatter.text(nil), "未知")
        XCTAssertEqual(FeaturesFormatter.text(""), "未知")
        XCTAssertEqual(FeaturesFormatter.text("0.42"), "0.42")
        XCTAssertEqual(FeaturesFormatter.count(nil), "未知")
        XCTAssertEqual(FeaturesFormatter.bool(nil), "未知")
        XCTAssertEqual(FeaturesFormatter.bool(true), "是")
    }
}
