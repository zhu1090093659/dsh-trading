//
//  NumericRangeGuardTests.swift
//  DomainTests
//
//  数值文本 -> Int 的**范围守卫**（缺陷来源：独立审查 C4，卡 IOS-9）。
//
//  为什么这些是**合法可达输入**而不是伪造载荷：TS 权威 packages/contract/src/cards.ts
//  对字段值只查**字符串长度**上限（maxValueChars = 256），"1e100" 只有 5 个字符，
//  所以服务端按契约判 valid 且 operable。Swift 的 Int(Double) 在 NaN / Inf / 越界时是
//  **trap（进程终止，不可 catch）**，因此这些负例在加守卫前会**直接崩掉测试进程**；
//  加守卫后一律必须是 nil —— 拿不准就不显示（fail-closed），绝不兜底成一个可能错的年龄。
//

import XCTest
import DshTradingContract
@testable import DshTradingDomain

final class NumericRangeGuardTests: XCTestCase {

    private func ageField(_ value: String, unit: String? = nil) -> CardField {
        CardField(key: "age", label: "账龄", kind: "duration", value: value, unit: unit)
    }

    // MARK: - ageMs：越界的值文本在每个单位分支都必须是 nil

    func test_givenAgeTextBeyondFiniteRange_whenParsed_thenNilOnEveryUnitBranch() {
        // When / Then：1e100 在默认（毫秒）与 s / m 三个分支都返回 nil，而不是 trap
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("1e100")))
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("1e100", unit: "ms")))
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("1e100", unit: "s")))
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("1e100", unit: "m")))
    }

    func test_givenGreatestFiniteMagnitudeText_whenParsed_thenNilOnEveryUnitBranch() {
        let raw = String(Double.greatestFiniteMagnitude)

        XCTAssertNil(DeskMapper.ageMs(fromField: ageField(raw)))
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField(raw, unit: "s")))
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField(raw, unit: "m")))
    }

    func test_givenNonFiniteText_whenParsed_thenNilInsteadOfTrapping() {
        for raw in ["inf", "Infinity", "+inf", "-inf", "infinity", "INF", "nan", "NaN", "-nan", "1e400"] {
            XCTAssertNil(DeskMapper.ageMs(fromField: ageField(raw)), raw)
            XCTAssertNil(DeskMapper.ageMs(fromField: ageField(raw, unit: "s")), raw)
            XCTAssertNil(DeskMapper.ageMs(fromField: ageField(raw, unit: "m")), raw)
        }
    }

    // MARK: - 值本身合法、但换算后的**乘积**越界：只在该单位分支判 nil

    func test_givenValueFitsIntButProductDoesNot_whenParsed_thenNilOnlyForTheOverflowingUnits() {
        // 1e18 ms 本身落在 Int 安全范围内；乘 1000（秒）/ 乘 60000（分）之后越界
        XCTAssertEqual(DeskMapper.ageMs(fromField: ageField("1e18")), 1_000_000_000_000_000_000)
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("1e18", unit: "s")))
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("1e18", unit: "m")))

        // 1e15 s = 1e18 ms 合法；1e15 m = 6e19 ms 越界
        XCTAssertEqual(DeskMapper.ageMs(fromField: ageField("1e15", unit: "s")), 1_000_000_000_000_000_000)
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("1e15", unit: "m")))
    }

    func test_givenTextAtOrAboveSignedSixtyFourBitBoundary_whenParsed_thenNilNotTrapping() {
        // 2^63 恰好越过 Int.max；Double(Int.max) 也舍入到 2^63 ⇒ 两者都判 nil（拿不准就不显示）
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("9223372036854775808")))
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("9223372036854775807")))
        // 2^63 之下最接近的可精确表示值仍要正常解析（守卫不能把合法边界一起判没）
        XCTAssertEqual(DeskMapper.ageMs(fromField: ageField("9223372036854774784")), 9_223_372_036_854_774_784)
    }

    // MARK: - 合法值不许因为加守卫而变成 nil

    func test_givenOrdinaryAgeTexts_whenParsed_thenUnitsAreHonouredAndNothingIsWronglyRejected() {
        XCTAssertEqual(DeskMapper.ageMs(fromField: ageField("0")), 0)
        XCTAssertEqual(DeskMapper.ageMs(fromField: ageField("500")), 500)
        XCTAssertEqual(DeskMapper.ageMs(fromField: ageField("1.9")), 1)
        XCTAssertEqual(DeskMapper.ageMs(fromField: ageField("2", unit: "s")), 2_000)
        XCTAssertEqual(DeskMapper.ageMs(fromField: ageField("3", unit: "secs")), 3_000)
        XCTAssertEqual(DeskMapper.ageMs(fromField: ageField("2", unit: "m")), 120_000)
        XCTAssertEqual(DeskMapper.ageMs(fromField: ageField("3", unit: "minutes")), 180_000)
        XCTAssertEqual(DeskMapper.ageMs(fromField: ageField("500", unit: "ms")), 500)
        XCTAssertEqual(DeskMapper.ageMs(fromField: ageField("1000000", unit: "ms")), 1_000_000)
    }

    func test_givenNegativeEmptyOrNonNumericAgeText_whenParsed_thenNil() {
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("-1")))
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("-0.5", unit: "s")))
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("")))
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("   ")))
        XCTAssertNil(DeskMapper.ageMs(fromField: ageField("not-a-number")))
        XCTAssertNil(DeskMapper.ageMs(fromField: nil))
    }

    // MARK: - 走完整映射链路：不许崩，也不许把读不出来的年龄显示成"最新"

    func test_givenFreshnessCardWithHugeAgeText_whenMapped_thenTrustIsNotFreshAndNothingTraps() {
        // Given 一张服务端按契约认为合法的 freshness 卡片（age "1e100" 只有 5 个字符）
        let card = Fixtures.card("fresh-huge", "freshness", fields: [("age", "1e100")])
        let budget = TrustBudget(freshMs: 1_000, agingMs: 2_000, staleMs: 3_000, ttlMs: 4_000)

        // When 映射成观测态（卡片自称的年龄读不出来 ⇒ 回退到客户端自己量到的快照账龄）
        let observation = DeskMapper.map(snapshot: Fixtures.snapshot(cards: [card], atMs: 0), nowMs: 5_000, budget: budget)

        // Then 不许崩，也不许因为一个字段读不出来就把它当作"最新"
        XCTAssertNotEqual(observation.bot.trust, .fresh)
        XCTAssertEqual(observation.bot.trust, .expired)
        XCTAssertFalse(observation.bot.trust.rendersData)
    }

    func test_givenHugeAgeMsKeyText_whenReadThroughIndex_thenNilInsteadOfATrappedConversion() {
        let huge = CardFieldIndex([CardField(key: "ageMs", label: "账龄", kind: "duration", value: "1e100")])
        let ordinary = CardFieldIndex([CardField(key: "ageMs", label: "账龄", kind: "duration", value: "12")])

        XCTAssertNil(huge.int("ageMs"))
        XCTAssertEqual(ordinary.int("ageMs"), 12)
    }
}

/// 覆盖面百分比：比例 -> Int 的转换属于**同一类**缺陷，同样不得 trap。
final class CoverageRatioGuardTests: XCTestCase {

    private func text(_ share: Double) -> String {
        AttributedDisplay.text(.partial(Decimal(string: "10")!, coveredShare: share)) { String(describing: $0) }
    }

    func test_givenOutOfRangeCoveredShare_whenDisplayed_thenNoFabricatedPercentAndNoTrap() {
        for share in [1e300, 2e307, Double.greatestFiniteMagnitude, Double.infinity, -Double.infinity, Double.nan] {
            let attributed: AttributedValue<Decimal> = .partial(Decimal(string: "10")!, coveredShare: share)

            XCTAssertEqual(attributed.note, "仅覆盖比例未知", String(describing: share))
            XCTAssertEqual(text(share), "10（仅覆盖比例未知）", String(describing: share))
        }
    }

    func test_givenOrdinaryCoveredShare_whenDisplayed_thenPercentTextIsUnchanged() {
        let attributed: AttributedValue<Decimal> = .partial(Decimal(string: "10")!, coveredShare: 0.425)

        XCTAssertEqual(attributed.note, "仅覆盖 43%")
        XCTAssertEqual(text(0.425), "10（仅覆盖 43%）")
    }
}
