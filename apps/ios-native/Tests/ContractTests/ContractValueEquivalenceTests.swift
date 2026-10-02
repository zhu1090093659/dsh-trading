import XCTest

/// 卡片字段值与 revision 的**等价性**（缺陷来源：独立审查 C6 + IOS-9 的第二个家，卡 IOS-1 收口）。
///
/// 两条都是"Swift 比 TS 窄"：
///   1. `CardField.value` 用 `String?` 表示，于是 JSON `null` 与"字段缺失"都成 nil，
///      `{value: null, values: ["null"]}` 被判成"值 undefined 不在 values 内"而**不可操作**
///      （TS 权威 `packages/contract/src/cards.ts` 用的是 `String(field.value)`）；
///   2. `cardByteCount` 的 `Int(card.revision)` 在 revision 是极大有限数（如 1e100）时
///      **溢出 trap（进程终止，不可 catch）** —— 守卫只挡了"带小数"，没挡"超出 Int 范围"。
///
/// 写作用域：apps/ios-native/Tests/ContractTests/**（IOS-1）
final class ContractValueEquivalenceTests: XCTestCase {

    private func card(fields: [CardField] = [], revision: Double = 1) -> Card {
        Card(cardId: "c1", cardType: "risk-state", revision: revision, fallbackText: "ok", fields: fields, actions: [])
    }

    private func decoded(_ json: String) throws -> CardField {
        try JSONDecoder().decode(CardField.self, from: Data(json.utf8))
    }

    // MARK: - JSON null 与字段缺失是两件事

    func testUserGetsAnOperableCardWhenTheEnumValueIsJsonNullAndValuesContainsNull() throws {
        // Given 一份 TS 判 valid 且 operable 的载荷：value 是 JSON null，values 里是 "null"
        let field = try decoded(#"{"key":"mode","label":"模式","kind":"enum","value":null,"values":["null"]}"#)
        // When 校验卡片
        let verdict = validateCard(card(fields: [field]))
        // Then null 是**已知值**，走 String(null) === "null"，卡片可操作；展示值也不丢
        XCTAssertEqual(field.value, "null", "展示文本必须是 null，不是 undefined")
        XCTAssertTrue(verdict.valid, verdict.problems.description)
        XCTAssertTrue(verdict.operable, verdict.problems.description)
        XCTAssertEqual(verdict.problems, [])
    }

    func testUserStillCannotOperateWhenJsonNullIsNotInValues() throws {
        // Given values 里只有 "undefined"（旧实现会把 null 误当成它而"恰好"通过或误判）
        let field = try decoded(#"{"key":"mode","label":"模式","kind":"enum","value":null,"values":["undefined"]}"#)
        // When / Then 按 TS 的 String(null) = "null"，不在集合里 ⇒ 不可操作
        let verdict = validateCard(card(fields: [field]))
        XCTAssertFalse(verdict.operable)
        XCTAssertTrue(verdict.problems.joined(separator: " ").contains("不在 values 内"))
    }

    func testUserGetsAnOperableCardOnlyForAbsentValueWhenValuesContainsUndefined() throws {
        // Given 字段**缺失**（不是 null）
        let field = try decoded(#"{"key":"mode","label":"模式","kind":"enum","values":["undefined"]}"#)
        // When 校验
        let verdict = validateCard(card(fields: [field]))
        // Then 缺失才走 undefined 语义
        XCTAssertNil(field.rawValue, "缺失必须是 nil，而不是 .null")
        XCTAssertNil(field.value)
        XCTAssertTrue(verdict.valid, verdict.problems.description)
        XCTAssertTrue(verdict.operable, verdict.problems.description)
    }

    func testUserCannotDistinguishShapesBlindlyBecauseNullAndAbsentAreDifferent() throws {
        // Given 两条载荷只差一个 value 键
        let nullField = try decoded(#"{"key":"mode","label":"模式","kind":"enum","value":null,"values":["null","undefined"]}"#)
        let absentField = try decoded(#"{"key":"mode","label":"模式","kind":"enum","values":["null","undefined"]}"#)
        // Then 三者互不相等（旧实现里两者都是 nil，等于把 null 静默塌成缺失）
        XCTAssertNotEqual(nullField.rawValue, absentField.rawValue)
        XCTAssertEqual(nullField.rawValue, .null)
        XCTAssertNil(absentField.rawValue)
        XCTAssertNotEqual(nullField.value, absentField.value)
    }

    // MARK: - TS String() 的逐条语义

    func testAdminSeesEveryScalarConvertedTheSameWayAsTheAuthority() {
        // Given TS 权威的 String() 结果（ECMAScript ToString）
        let expected: [(CardValue, String)] = [
            (.null, "null"),
            (.bool(true), "true"),
            (.bool(false), "false"),
            (.number(42), "42"),
            (.number(3.5), "3.5"),
            (.number(1e-7), "1e-7"),
            (.number(1e20), "100000000000000000000"),
            (.number(1e21), "1e+21"),
            (.number(1e100), "1e+100"),
            (.text(""), ""),
            (.text("x"), "x"),
        ]
        // When / Then 每个形状的文本逐条与 TS 相同，且缺失另有其文本
        for (value, text) in expected {
            XCTAssertEqual(cardValueText(value), text)
        }
        XCTAssertEqual(contractValueText(nil), "undefined")
        XCTAssertEqual(contractValueText(.null), "null")
    }

    func testAdminSeesJsonNumbersFormattedExactlyLikeTheHostLanguage() {
        // Given node 实测的输出（JSON.stringify 与 String() 在数字上同源）
        let expected: [(Double, String)] = [
            (0, "0"),
            (-0.0, "0"),
            (1, "1"),
            (-1.5, "-1.5"),
            (0.1, "0.1"),
            (1e15, "1000000000000000"),
            (1e16, "10000000000000000"),
            (1e17, "100000000000000000"),
            (1e19, "10000000000000000000"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1e22, "1e+22"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (9007199254740992, "9007199254740992"),
            (0.30000000000000004, "0.30000000000000004"),
        ]
        // When / Then 阈值与 ECMAScript 一致（1e21 才切科学记数法、1e-7 才切）
        for (number, text) in expected {
            XCTAssertEqual(contractNumberText(number), text, String(number))
        }
        // 非有限数的形状（JSON 里写成 null，String() 里是 Infinity/NaN）
        XCTAssertEqual(contractNumberText(Double.nan), "NaN")
        XCTAssertEqual(contractNumberText(Double.infinity), "Infinity")
        XCTAssertEqual(contractNumberText(-Double.infinity), "-Infinity")
        XCTAssertEqual(contractJSONNumber(Double.infinity), "null")
        XCTAssertEqual(contractJSONNumber(Double.nan), "null")
    }

    func testAdminSeesArraysJoinedAndObjectsFlattenedExactlyLikeTheAuthority() {
        // Given TS 的 Array.prototype.join(",") 与 "[object Object]"
        let rows: [(CardValue, String)] = [
            (.array([]), ""),
            (.array([.number(1), .number(2)]), "1,2"),
            (.array([.null]), ""),
            (.array([.null, .number(1)]), ",1"),
            (.array([.text("a"), .null, .text("b")]), "a,,b"),
            (.array([.array([.number(1), .number(2)]), .array([.number(3)])]), "1,2,3"),
            (.array([.text("x"), .bool(false), .number(2.5)]), "x,false,2.5"),
            (.object(["a": .number(1)]), "[object Object]"),
            (.object([:]), "[object Object]"),
            (.array([.object([:]), .object([:])]), "[object Object],[object Object]"),
        ]
        // When / Then 数组按 join 拼接（null 元素成空串），对象不论内容都是固定形状
        for (value, text) in rows {
            XCTAssertEqual(cardValueText(value), text)
        }
    }

    func testUserGetsTheSameEnumVerdictAsTheAuthorityForEveryJsonShape() throws {
        // Given 每种形状 + 权威文本作为 values
        let shapes: [(String, String)] = [
            (#"{"key":"mode","label":"M","kind":"enum","value":true,"values":["true"]}"#, "true"),
            (#"{"key":"mode","label":"M","kind":"enum","value":false,"values":["false"]}"#, "false"),
            (#"{"key":"mode","label":"M","kind":"enum","value":42,"values":["42"]}"#, "42"),
            (#"{"key":"mode","label":"M","kind":"enum","value":3.5,"values":["3.5"]}"#, "3.5"),
            (#"{"key":"mode","label":"M","kind":"enum","value":1e-7,"values":["1e-7"]}"#, "1e-7"),
            (#"{"key":"mode","label":"M","kind":"enum","value":1e20,"values":["100000000000000000000"]}"#, "100000000000000000000"),
            (#"{"key":"mode","label":"M","kind":"enum","value":1e21,"values":["1e+21"]}"#, "1e+21"),
            (#"{"key":"mode","label":"M","kind":"enum","value":"","values":[""]}"#, ""),
            (#"{"key":"mode","label":"M","kind":"enum","value":[1,2],"values":["1,2"]}"#, "1,2"),
            (#"{"key":"mode","label":"M","kind":"enum","value":[[1,2],[3]],"values":["1,2,3"]}"#, "1,2,3"),
            (#"{"key":"mode","label":"M","kind":"enum","value":[null,1],"values":[",1"]}"#, ",1"),
            (#"{"key":"mode","label":"M","kind":"enum","value":{"a":1},"values":["[object Object]"]}"#, "[object Object]"),
        ]
        // When / Then 每条都命中 values ⇒ 合法且可操作（展示值等于权威文本）
        for (json, text) in shapes {
            let field = try decoded(json)
            XCTAssertEqual(field.value, text, json)
            let verdict = validateCard(card(fields: [field]))
            XCTAssertEqual(verdict.valid, true, json)
            XCTAssertEqual(verdict.operable, true, json)
        }
    }

    func testUserStillCannotOperateOnAnUnknownEnumValue() throws {
        // Given 一个越界的值（fail-closed 不动：本卡只改 null 的等价性）
        let field = try decoded(#"{"key":"mode","label":"M","kind":"enum","value":"halt","values":["normal"]}"#)
        // When / Then 仍然不可操作
        let verdict = validateCard(card(fields: [field]))
        XCTAssertFalse(verdict.valid)
        XCTAssertFalse(verdict.operable)
    }

    func testAdminSeesNonScalarShapesNeverCollapseIntoOneNil() throws {
        // Given 三种不同的非标量 / 越界形状
        let arrayShape = try decoded(#"{"key":"k","label":"L","kind":"enum","value":[1,2],"values":["1,2"]}"#)
        let objectShape = try decoded(#"{"key":"k","label":"L","kind":"enum","value":{"a":1},"values":["[object Object]"]}"#)
        // 越界数字（1e400）在真实 wire 路径上不可达 —— 传输层先做 JSONSerialization，
        // 它会因"Number 1e400 is not representable in Swift"把整页判 CARDS_INVALID。
        // 这里直接走 JSONDecoder，锁住"形状彼此可区分、且文本对齐 String(Infinity)"，
        // 防止将来有人把 CardValue 又塌回一个值。
        let overflowShape = try decoded(#"{"key":"k","label":"L","kind":"enum","value":1e400,"values":["Infinity"]}"#)
        // When / Then 三者文本互不相同、都不是 nil
        XCTAssertEqual(arrayShape.value, "1,2")
        XCTAssertEqual(objectShape.value, "[object Object]")
        XCTAssertEqual(overflowShape.rawValue, .unrepresentableNumber)
        XCTAssertEqual(overflowShape.value, "Infinity")
        XCTAssertEqual(contractNumberText(Double.infinity), "Infinity")
        XCTAssertNotEqual(arrayShape.rawValue, objectShape.rawValue)
        XCTAssertNotEqual(objectShape.rawValue, overflowShape.rawValue)
        XCTAssertNotNil(arrayShape.rawValue)
        XCTAssertNotNil(objectShape.rawValue)
        XCTAssertNotNil(overflowShape.rawValue)
    }

    // MARK: - revision 的 Int(Double) trap

    func testUserIsNotCrashedByAHugeButFiniteRevision() {
        // Given TS 判 valid+operable 的三个极大有限 revision（1e100 只有 6 个字符）
        for revision in [1e100, Double.greatestFiniteMagnitude, 1e19, 1e21, 9007199254740993.0] {
            let candidate = card(revision: revision)
            // When 校验（旧实现在这里 Int(card.revision) 直接 SIGTRAP，测试进程当场死）
            let verdict = validateCard(candidate)
            // Then 必须判合法且不 trap（本用例能跑完本身就是"没 trap"的证据）
            XCTAssertTrue(verdict.valid, String(revision) + "：" + verdict.problems.description)
            XCTAssertTrue(verdict.operable, String(revision))
        }
    }

    func testAdminKeepsFractionalAndNonFiniteRevisionJudgementsUnchanged() {
        // Given 小数与非法值
        // When / Then 语义不变：3.5 合法，NaN / -1 非法
        XCTAssertTrue(validateCard(card(revision: 3.5)).valid)
        XCTAssertFalse(validateCard(card(revision: Double.nan)).valid)
        XCTAssertFalse(validateCard(card(revision: -1)).valid)
        XCTAssertFalse(validateCard(card(revision: Double.infinity)).valid)
    }

    func testAdminSeesTheByteLimitCountedFromAJsonStringifyEquivalent() {
        // Given 两条只差 value 键的卡片
        let nullValueCard = card(fields: [CardField(key: "k", label: "L", kind: "enum", rawValue: .null, values: ["null"])])
        let absentValueCard = card(fields: [CardField(key: "k", label: "L", kind: "enum", rawValue: nil, values: ["null"])])
        // When / Then null 在 JSON 里占 4 字节（"null"），且两张卡片的形状不同 —— 旧实现里它们同形
        XCTAssertEqual(contractJSONValue(.null), "null")
        XCTAssertEqual(contractJSONValue(.null).utf8.count, 4)
        XCTAssertNotEqual(nullValueCard.fields.first?.rawValue, absentValueCard.fields.first?.rawValue)
        XCTAssertTrue(contractJSONValue(.null) != contractJSONValue(.text("undefined")))
    }

    // MARK: - ContractOffline 的 Int(...rounded())

    func testUserIsNotCrashedByExtremeSnapshotTimestamps() {
        // Given 两端异号的极端时间戳（Int 相减会溢出 trap）
        let budgets = StalenessBudget(freshMs: 1_000, staleMs: 5_000, ttlMs: 20_000)
        // When
        let extreme = offlineView(OfflineSnapshot(data: "payload", atMs: Int.min, sourceId: "s"), nowMs: Int.max, budget: budgets)
        // Then 必须判 expired 且不 trap；消息里的秒数是一个有限的非负整数
        guard case .notice(let staleness, let message) = extreme else {
            return XCTFail("两端极值的快照必须判过期，而不是渲染数据")
        }
        XCTAssertEqual(staleness, .expired)
        XCTAssertTrue(message.contains("秒前"), message)
        XCTAssertNil(Int.min.description.range(of: "overflow"))
    }

    func testAdminSeesOrdinaryStalenessJudgementsUnchanged() {
        // Given 常规边界（本卡只去掉溢出路径，不改分档语义）
        let budgets = StalenessBudget(freshMs: 1_000, staleMs: 5_000, ttlMs: 20_000)
        let snapshot = OfflineSnapshot(data: "p", atMs: 0, sourceId: "s")
        // When / Then 四档边界逐条不变
        XCTAssertEqual(stalenessOf(snapshot, nowMs: 0, budget: budgets), .fresh)
        XCTAssertEqual(stalenessOf(snapshot, nowMs: 999, budget: budgets), .fresh)
        XCTAssertEqual(stalenessOf(snapshot, nowMs: 1_000, budget: budgets), .aging)
        XCTAssertEqual(stalenessOf(snapshot, nowMs: 5_000, budget: budgets), .stale)
        XCTAssertEqual(stalenessOf(snapshot, nowMs: 20_000, budget: budgets), .expired)
        let noSnapshot: OfflineSnapshot<String>? = nil
        XCTAssertEqual(stalenessOf(noSnapshot, nowMs: 0, budget: budgets), .unknown)
    }
}
