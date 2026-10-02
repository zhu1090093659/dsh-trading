import XCTest

/// 行为向量的重放：每条向量都带 **TS 的权威输出**，Swift 侧必须逐条复现。
/// 只比对常量表是弱机检（行为漂移会漏过去）；这一层才是真正的防漂移。
final class ContractVectorTests: XCTestCase {

    private func vectors(_ key: String, file: StaticString = #filePath, line: UInt = #line) throws -> [Any] {
        let snap = try ContractSnapshotFile.load()
        let list = snapArray(snapDict(snap["vectors"])[key])
        XCTAssertFalse(
            list.isEmpty,
            "行为向量 \(key) 缺失或为空：夹具缺失必须 FAIL，运行 `\(ContractSnapshotFile.regenerateHint)`",
            file: file, line: line
        )
        return list
    }

    private func budgetFrom(_ any: Any?) -> StalenessBudget {
        let dict = snapDict(any)
        return StalenessBudget(freshMs: snapInt(dict["freshMs"]), staleMs: snapInt(dict["staleMs"]), ttlMs: snapInt(dict["ttlMs"]))
    }

    private func snapshotFrom(_ any: Any?) -> OfflineSnapshot<String>? {
        guard let any, !(any is NSNull) else { return nil }
        let dict = snapDict(any)
        return OfflineSnapshot(data: snapText(dict["data"]), atMs: snapInt(dict["atMs"]), sourceId: snapText(dict["sourceId"]))
    }

    private func sourcedData(_ any: Any?) -> [SourcedDatum<String>] {
        snapArray(any).map { item in
            let dict = snapDict(item)
            return SourcedDatum(id: snapText(dict["id"]), sourceId: snapText(dict["sourceId"]), value: snapText(dict["value"]))
        }
    }

    // MARK: - 版本协商

    func testNegotiateVersionVectors() throws {
        for raw in try vectors("negotiateVersion") {
            let vector = snapDict(raw)
            let name = snapText(vector["name"])
            let input = snapDict(vector["input"])
            let verdict = negotiateVersion(
                clientMajor: snapInt(input["clientMajor"]),
                serverMajor: input["serverMajor"] == nil ? ApiContract.major : snapInt(input["serverMajor"]),
                clientCaps: snapStrings(input["clientCaps"]),
                requiredCaps: snapStrings(input["requiredCaps"]),
                serverCaps: snapStrings(input["serverCaps"])
            )
            let expected = snapDict(vector["expected"])
            switch verdict {
            case let .ok(caps, downgraded):
                XCTAssertEqual(snapText(expected["kind"]), "ok", name)
                XCTAssertEqual(caps, snapStrings(expected["caps"]), name)
                XCTAssertEqual(downgraded, snapStrings(expected["downgraded"]), name)
            case let .rejected(status, code, message):
                XCTAssertEqual(snapText(expected["kind"]), "rejected", name)
                XCTAssertEqual(status, snapInt(expected["status"]), name)
                XCTAssertEqual(code, snapText(expected["code"]), name)
                XCTAssertEqual(message, snapText(expected["message"]), name)
            }
        }
    }

    func testParseCapsVectors() throws {
        for raw in try vectors("parseCaps") {
            let vector = snapDict(raw)
            let rawInput = vector["input"]
            let input: String? = (rawInput == nil || rawInput is NSNull) ? nil : snapText(rawInput)
            XCTAssertEqual(parseCaps(input), snapStrings(vector["expected"]), "parseCaps(\(String(describing: input)))")
        }
    }

    func testFormatCapsVectors() throws {
        for raw in try vectors("formatCaps") {
            let vector = snapDict(raw)
            XCTAssertEqual(formatCaps(snapStrings(vector["input"])), snapText(vector["expected"]))
        }
    }

    // MARK: - 卡片协议

    func testValidateCardVectors() throws {
        for raw in try vectors("validateCard") {
            let vector = snapDict(raw)
            let name = snapText(vector["name"]) + " TS problems=" + snapStrings(vector["problems"]).description
            let card = try decodeVector(Card.self, from: vector["card"] ?? [:], name)
            let limits = try decodeVector(CardLimits.self, from: vector["limits"] ?? [:], name)
            let verdict = validateCard(card, limits: limits)
            let expected = snapDict(vector["expected"])
            XCTAssertEqual(verdict.valid, snapBool(expected["valid"]), "valid: " + name)
            XCTAssertEqual(verdict.operable, snapBool(expected["operable"]), "operable: " + name)
            XCTAssertEqual(verdict.problems.count, snapInt(expected["problemCount"]), "problemCount: " + name + " 本地=" + verdict.problems.description)
        }
    }

    /// 解码保真：revision 是**有限非负数**，不是整数（TS 的 number 允许小数）。
    /// 服务端真发 3.5 时必须**原样保留** —— 用 Int 解码会让整页解码失败，出现
    /// "驾驶舱能显示、iOS 观测端整页报错"的分歧（Lead 裁决 2026-10-02）。
    func testCardRevisionDecodingVectors() throws {
        let snap = try ContractSnapshotFile.load()
        let cases = snapArray(snap["cardDecoding"])
        XCTAssertFalse(
            cases.isEmpty,
            "解码保真向量缺失：夹具缺失必须 FAIL，运行 `\(ContractSnapshotFile.regenerateHint)`"
        )
        for raw in cases {
            let vector = snapDict(raw)
            let name = snapText(vector["name"])
            let card = try decodeVector(Card.self, from: vector["card"] ?? [:], name)
            let expected = snapDict(vector["expected"])
            let expectedRevision = (expected["revision"] as? NSNumber)?.doubleValue ?? .nan
            XCTAssertEqual(card.revision, expectedRevision, name + "：revision 必须原样保留")
            if let expectedFreshnessNum = expected["freshnessMs"] as? NSNumber {
                XCTAssertEqual(card.freshnessMs, expectedFreshnessNum.doubleValue, name + "：freshnessMs 必须原样保留")
            }
            XCTAssertEqual(validateCard(card).valid, snapBool(expected["valid"]), name)
        }
    }

    /// 字段值的 `String()` 保真：**JSON null 与字段缺失必须是两件事**。
    /// 快照里的每条都带 TS 的 `String(value)`，Swift 侧走真实解码路径后必须逐条复现。
    func testUserSeesTheSameFieldValueTextAsTheAuthorityForEveryJsonShape() throws {
        let cases = snapArray((try ContractSnapshotFile.load())["cardValueText"])
        XCTAssertFalse(
            cases.isEmpty,
            "字段值向量缺失：夹具缺失必须 FAIL，运行 `\(ContractSnapshotFile.regenerateHint)`"
        )
        for raw in cases {
            let vector = snapDict(raw)
            let name = snapText(vector["name"])
            let hasValue = snapBool(vector["hasValue"])
            var field: [String: Any] = ["key": "k", "label": "L", "kind": "enum"]
            if hasValue { field["value"] = vector["value"] as Any }
            let json = try JSONSerialization.data(withJSONObject: field)
            let decoded = try JSONDecoder().decode(CardField.self, from: json)
            // Given 快照里 TS 的 String(value) 就是权威文本
            let expected = snapText(vector["expected"])
            // When 走真实解码，再取用于判定的转换（缺 value 键 ⇒ undefined，JSON null ⇒ "null"）
            // Then 判定文本逐条等于 TS 的 String(value)
            XCTAssertEqual(contractValueText(decoded.rawValue), expected, name + "：判定文本必须等于 TS 的 String(value)")
            if hasValue {
                XCTAssertNotNil(decoded.rawValue, name + "：JSON 里有 value 键就必须留下形状，不许塌成 nil")
                XCTAssertEqual(decoded.value, expected, name + "：展示文本也等于 String(value)")
            } else {
                XCTAssertNil(decoded.rawValue, name + "：字段缺失才是 nil")
                XCTAssertNil(decoded.value, name + "：缺失在 String? 投影里仍是 nil")
            }
        }
    }

    /// 含 null / 数组 / 对象 / 极大 revision 的卡片：字节棘轮与 TS 的 JSON.stringify 一致 —— 也证明不 trap。
    func testAdminSeesByteLimitJudgedFromTheSameSerializationAsTheAuthority() throws {
        let cases = snapArray((try ContractSnapshotFile.load())["byteShapes"])
        XCTAssertFalse(
            cases.isEmpty,
            "字节形状向量缺失：夹具缺失必须 FAIL，运行 `\(ContractSnapshotFile.regenerateHint)`"
        )
        for raw in cases {
            let vector = snapDict(raw)
            let name = snapText(vector["name"])
            let card = try decodeVector(Card.self, from: vector["card"] ?? [:], name)
            let expectedBytes = snapInt(vector["expectedBytes"])
            // Given 一条把 maxCardBytes 收紧到"恰好差一字节"的上限
            let limits = CardLimits(
                maxFields: cardLimits.maxFields, maxActions: cardLimits.maxActions,
                maxFallbackChars: cardLimits.maxFallbackChars, maxLabelChars: cardLimits.maxLabelChars,
                maxValueChars: cardLimits.maxValueChars, maxCardsPerPage: cardLimits.maxCardsPerPage,
                maxTextChars: cardLimits.maxTextChars, maxEnumValues: cardLimits.maxEnumValues,
                maxDepth: cardLimits.maxDepth, maxCardBytes: expectedBytes,
                maxIdChars: cardLimits.maxIdChars, maxActionParams: cardLimits.maxActionParams
            )
            // When 校验：恰好等于 TS 字节数 ⇒ 合法；差一字节 ⇒ 非法
            let atLimit = validateCard(card, limits: limits)
            let oneOver = validateCard(card, limits: CardLimits(
                maxFields: limits.maxFields, maxActions: limits.maxActions,
                maxFallbackChars: limits.maxFallbackChars, maxLabelChars: limits.maxLabelChars,
                maxValueChars: limits.maxValueChars, maxCardsPerPage: limits.maxCardsPerPage,
                maxTextChars: limits.maxTextChars, maxEnumValues: limits.maxEnumValues,
                maxDepth: limits.maxDepth, maxCardBytes: expectedBytes - 1,
                maxIdChars: limits.maxIdChars, maxActionParams: limits.maxActionParams
            ))
            // Then 判定与 TS 逐字节对齐（而不是把 null/数组值塌成一个更短的形状）
            XCTAssertTrue(atLimit.valid, name + "：TS 的字节数就是上限，正好等于时必须合法")
            XCTAssertFalse(oneOver.valid, name + "：少一个字节必须判非法（棘轮不许静默通过）")
        }
    }

    func testRenderableActionsVectors() throws {
        for raw in try vectors("renderableActions") {
            let vector = snapDict(raw)
            let name = snapText(vector["name"])
            let card = try decodeVector(Card.self, from: vector["card"] ?? [:], name)
            let limits = try decodeVector(CardLimits.self, from: vector["limits"] ?? [:], name)
            let got = renderableActions(card, clientCaps: snapStrings(vector["clientCaps"]), limits: limits).map(\.kind)
            XCTAssertEqual(got, snapStrings(vector["expected"]), name)
        }
    }

    func testFallbackForVectors() throws {
        for raw in try vectors("fallbackFor") {
            let vector = snapDict(raw)
            let name = snapText(vector["name"])
            let card = try decodeVector(Card.self, from: vector["card"] ?? [:], name)
            XCTAssertEqual(fallbackFor(card), snapText(vector["expected"]), name)
        }
    }

    // MARK: - 离线陈旧度与深链

    func testStalenessOfVectors() throws {
        for raw in try vectors("stalenessOf") {
            let vector = snapDict(raw)
            let name = snapText(vector["name"])
            let staleness = stalenessOf(
                snapshotFrom(vector["snapshot"]),
                nowMs: snapInt(vector["nowMs"]),
                budget: budgetFrom(vector["budget"])
            )
            XCTAssertEqual(staleness.rawValue, snapText(vector["expected"]), name)
        }
    }

    func testOfflineViewVectors() throws {
        for raw in try vectors("offlineView") {
            let vector = snapDict(raw)
            let name = snapText(vector["name"])
            let expected = snapDict(vector["expected"])
            let view = offlineView(
                snapshotFrom(vector["snapshot"]),
                nowMs: snapInt(vector["nowMs"]),
                budget: budgetFrom(vector["budget"])
            )
            switch view {
            case let .data(data, staleness, badge):
                XCTAssertEqual(snapText(expected["kind"]), "data", name)
                XCTAssertEqual(data, snapText(expected["data"]), name)
                XCTAssertEqual(staleness.rawValue, snapText(expected["staleness"]), name)
                if expected["badge"] == nil || expected["badge"] is NSNull {
                    XCTAssertNil(badge, name)
                } else {
                    XCTAssertEqual(badge, snapText(expected["badge"]), name)
                }
            case let .notice(staleness, message):
                XCTAssertEqual(snapText(expected["kind"]), "notice", name)
                XCTAssertEqual(staleness.rawValue, snapText(expected["staleness"]), name)
                XCTAssertEqual(message, snapText(expected["message"]), name)
            }
        }
    }

    func testParseDeeplinkVectors() throws {
        for raw in try vectors("parseDeeplink") {
            let vector = snapDict(raw)
            let url = snapText(vector["url"])
            let expected = snapDict(vector["expected"])
            switch parseDeeplink(url) {
            case let .ok(screen, id):
                XCTAssertTrue(snapBool(expected["ok"]), url + "：TS 预期被拒绝")
                XCTAssertEqual(screen.rawValue, snapText(expected["screen"]), url)
                let expectedID = expected["id"]
                if expectedID == nil || expectedID is NSNull {
                    XCTAssertNil(id, url)
                } else {
                    XCTAssertEqual(id, snapText(expectedID), url)
                }
            case let .rejected(reason):
                XCTAssertFalse(snapBool(expected["ok"]), url + "：TS 预期成功")
                XCTAssertEqual(reason, snapText(expected["reason"]), url)
            }
        }
    }

    // MARK: - 作用域与确认

    func testGrantableByDefaultVectors() throws {
        for raw in try vectors("grantableByDefault") {
            let vector = snapDict(raw)
            let requested = snapStrings(vector["requested"])
            XCTAssertEqual(
                grantableByDefault(requested).map(\.rawValue),
                snapStrings(vector["expected"]),
                "grantableByDefault(" + requested.description + ")"
            )
        }
    }

    func testRequiresBiometricVectors() throws {
        for raw in try vectors("requiresBiometric") {
            let vector = snapDict(raw)
            let rawAction = snapText(vector["action"])
            let rawPlatform = snapText(vector["platform"])
            guard let action = ActionKind(rawValue: rawAction) else {
                return XCTFail("向量里的 action 不是封闭枚举值：" + rawAction)
            }
            guard let platform = ClientPlatform(rawValue: rawPlatform) else {
                return XCTFail("向量里的 platform 非法：" + rawPlatform)
            }
            XCTAssertEqual(requiresBiometric(action, platform: platform), snapBool(vector["expected"]), rawAction + "/" + rawPlatform)
        }
    }

    // MARK: - 数据源守卫（声明式逐步重放）

    func testSourceGuardVectors() throws {
        for raw in try vectors("sourceGuard") {
            let scenario = snapDict(raw)
            let name = snapText(scenario["name"])
            let guardUnit = SourceGuard<String>(activeSourceId: snapText(scenario["activeSourceId"]))
            for stepRaw in snapArray(scenario["ops"]) {
                let step = snapDict(stepRaw)
                let op = snapText(step["op"])
                switch op {
                case "sourceId":
                    XCTAssertEqual(guardUnit.sourceId(), snapText(step["expected"]), name + "/sourceId")
                case "writable":
                    XCTAssertEqual(guardUnit.writable(), snapBool(step["expected"]), name + "/writable")
                case "switching":
                    XCTAssertEqual(guardUnit.switching(), snapBool(step["expected"]), name + "/switching")
                case "switchTo":
                    guardUnit.switchTo(snapText(step["sourceId"]))
                case "viewOf":
                    XCTAssertEqual(guardUnit.viewOf(sourcedData(step["data"])).map(\.id), snapStrings(step["expectedIds"]), name + "/viewOf")
                case "reconcile":
                    let report = guardUnit.reconcile(active: sourcedData(step["active"]), incoming: sourcedData(step["incoming"]))
                    let expected = snapDict(step["expected"])
                    XCTAssertEqual(report.ok, snapBool(expected["ok"]), name + "/reconcile.ok")
                    XCTAssertEqual(report.activeCount, snapInt(expected["activeCount"]), name + "/reconcile.activeCount")
                    XCTAssertEqual(report.incomingCount, snapInt(expected["incomingCount"]), name + "/reconcile.incomingCount")
                    XCTAssertEqual(report.reason, expected["reason"] == nil ? nil : snapText(expected["reason"]), name + "/reconcile.reason")
                default:
                    XCTFail("未知的 sourceGuard op：" + op)
                }
            }
        }
    }

    func testUserReceivesOnlyPushPayloadsMatchingAuthority() throws {
        // Given: TS authority inputs and outputs, including UTF-16 length limits.
        let cases = try vectors("validatePushPayload")
        for raw in cases {
            let vector = snapDict(raw)
            let name = snapText(vector["name"])
            let payload = try decodeVector(PushPayload.self, from: vector["payload"] ?? [:], name)
            // When: user receives a payload through the actual decoder and validator.
            let verdict = validatePushPayload(payload)
            let expected = snapDict(vector["expected"])
            // Then: validity and every diagnostic match the TS contract.
            XCTAssertEqual(verdict.valid, snapBool(expected["valid"]), name)
            XCTAssertEqual(verdict.problems, snapStrings(expected["problems"]), name)
        }
    }

    // MARK: - 推送载荷

    func testPushPayloadVectorsFromCardsContract() {
        // 推送载荷的合法/非法判据由 §4 的常量表覆盖；这里补一条端到端行为：
        // 外部深链必须被拒（不允许推送把用户送去任意站点）。
        let external = PushPayload(
            kind: "escalation", severity: "warning", deskId: "desk-1",
            deeplink: "https://example.com/x", expiresInMs: 60_000,
            actions: ["ack"], fallbackText: "有新的升级", revision: 1
        )
        XCTAssertFalse(validatePushPayload(external).valid)
        // critical 通知必须至少给一个可用动作（只喊危险不给出口是不允许的）
        let criticalNoAction = PushPayload(
            kind: "kill-confirmed", severity: "critical", deskId: "desk-1",
            deeplink: deeplinkScheme + "escalations/e1", expiresInMs: 60_000,
            actions: [], fallbackText: "已强制平仓", revision: 2
        )
        XCTAssertFalse(validatePushPayload(criticalNoAction).valid)
        let good = PushPayload(
            kind: "kill-confirmed", severity: "critical", deskId: "desk-1",
            deeplink: deeplinkScheme + "escalations/e1", expiresInMs: 60_000,
            actions: ["ack"], fallbackText: "已强制平仓", revision: 2
        )
        XCTAssertTrue(validatePushPayload(good).valid)
        XCTAssertTrue(shouldInterrupt(good, muted: ["desk-1"]), "critical 不受静音影响")
        let info = PushPayload(
            kind: "stale-data", severity: "info", deskId: "desk-1",
            deeplink: deeplinkScheme + "positions", expiresInMs: 60_000,
            actions: [], fallbackText: "数据陈旧", revision: 3
        )
        XCTAssertFalse(shouldInterrupt(info, muted: ["desk-1"]))
    }
}
