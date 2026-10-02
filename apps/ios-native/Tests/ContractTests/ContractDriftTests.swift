import XCTest

/// 契约快照的读取（防漂移机检的公共基础设施）。
///
/// 快照由 `node scripts/gen-contract-snapshot.mjs` 从 packages/contract 的**运行期真值**导出。
/// **夹具缺失必须 FAIL**（打印重新生成命令），绝不 skip、绝不静默通过 —— 对齐本仓"未验证 ≠ 通过"。
enum ContractSnapshotFile {
    static let regenerateHint = "cd apps/ios-native && node scripts/gen-contract-snapshot.mjs"

    private final class BundleToken {}

    static func load() throws -> [String: Any] {
        var urls: [URL] = []
        // 首选**源码相对路径**：#filePath = Tests/ContractTests/<本文件>（编译期绝对路径）。
        // 快照是生成物、不入库，所以不能作为工程 source 列进去（否则干净工作区 xcodegen generate 就红）；
        // 本地可复现构建里编译与运行在同一 checkout，这条路径稳定。
        let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        urls.append(
            testsDir.deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent("Generated/contract-snapshot.json")
        )
        // 次选 bundle resource（若将来有人把它作为资源打进测试包，这里也能读到）
        if let url = Bundle(for: BundleToken.self).url(forResource: "contract-snapshot", withExtension: "json") {
            urls.append(url)
        }
        var tried: [String] = []
        for url in urls {
            tried.append(url.path)
            if let data = try? Data(contentsOf: url),
               let object = try? JSONSerialization.jsonObject(with: data, options: []),
               let dictionary = object as? [String: Any] {
                return dictionary
            }
        }
        throw NSError(domain: "contract-snapshot", code: 1, userInfo: [
            NSLocalizedDescriptionKey:
                "契约快照缺失或不可读（试过：\(tried.joined(separator: ", "))）。夹具缺失必须 FAIL，先运行：\(regenerateHint)",
        ])
    }
}

func snapDict(_ value: Any?) -> [String: Any] { (value as? [String: Any]) ?? [:] }
func snapArray(_ value: Any?) -> [Any] { (value as? [Any]) ?? [] }
func snapStrings(_ value: Any?) -> [String] { snapArray(value).compactMap { $0 as? String } }
func snapText(_ value: Any?) -> String { (value as? String) ?? "" }
func snapInt(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
func snapBool(_ value: Any?) -> Bool {
    if let flag = value as? Bool { return flag }
    return (value as? NSNumber)?.boolValue ?? false
}

/// 把快照里的一段 JSON 解成 DTO —— **走真实的解码路径**，这样"未知封闭枚举值不会抛掉整张卡"
/// 这条 fail-closed 建模也被机检覆盖。
func decodeVector<T: Decodable>(_ type: T.Type, from any: Any, _ what: String) throws -> T {
    let data = try JSONSerialization.data(withJSONObject: any)
    do {
        return try JSONDecoder().decode(T.self, from: data)
    } catch {
        throw NSError(domain: "contract-vector", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "向量 \(what) 解码失败：\(error)",
        ])
    }
}

/// 契约防漂移机检：Swift 侧的常量 / 封闭枚举 / 查表必须与 TS 契约逐字一致。
final class ContractDriftTests: XCTestCase {

    private func snapshot() throws -> [String: Any] { try ContractSnapshotFile.load() }

    // MARK: - 快照自检

    func testSnapshotIsPresentAndCarriesBehaviorVectors() throws {
        let snap = try snapshot()
        XCTAssertEqual(snapText(snap["contractEntry"]), "packages/contract/src/core.ts")
        let vectors = snapDict(snap["vectors"])
        let required = [
            "negotiateVersion", "validateCard", "renderableActions", "fallbackFor", "stalenessOf",
            "offlineView", "parseDeeplink", "grantableByDefault", "parseCaps", "formatCaps",
            "requiresBiometric", "sourceGuard", "validatePushPayload",
        ]
        for key in required {
            XCTAssertFalse(
                snapArray(vectors[key]).isEmpty,
                "行为向量 \(key) 缺失或为空：夹具缺失必须 FAIL，运行 `\(ContractSnapshotFile.regenerateHint)`"
            )
        }
    }

    // MARK: - 常量与表

    func testVersionConstants() throws {
        let snap = try snapshot()
        let version = snapDict(snap["version"])
        XCTAssertEqual(ApiContract.major, snapInt(version["apiMajor"]))
        XCTAssertEqual(ApiContract.minor, snapInt(version["apiMinor"]))
        XCTAssertEqual(ApiContract.compatibleMajorSpan, snapInt(version["compatibleMajorSpan"]))
        XCTAssertEqual(ApiContract.capsHeader, snapText(version["capsHeader"]))
        XCTAssertEqual(ApiContract.clientTooOldStatus, snapInt(version["clientTooOldStatus"]))
    }

    func testScopeTables() throws {
        let snap = try snapshot()
        let scopes = snapDict(snap["scopes"])
        XCTAssertEqual(ScopePlane.allCases.map(\.rawValue), snapStrings(scopes["planes"]))
        XCTAssertEqual(defaultScopePlanes.map(\.rawValue), snapStrings(scopes["defaultPlanes"]))
        XCTAssertEqual(explicitScopePlanes.map(\.rawValue), snapStrings(scopes["explicitPlanes"]))
        // 配对永不签发 control：默认平面里不得出现 control
        XCTAssertFalse(defaultScopePlanes.contains(.control))
        XCTAssertEqual(explicitScopePlanes, [.control])
    }

    func testClosedCardEnumsAndScopeTable() throws {
        let snap = try snapshot()
        XCTAssertEqual(CardType.allCases.map(\.rawValue), snapStrings(snap["cardTypes"]))
        XCTAssertEqual(FieldKind.allCases.map(\.rawValue), snapStrings(snap["fieldKinds"]))
        XCTAssertEqual(ActionKind.allCases.map(\.rawValue), snapStrings(snap["actionKinds"]))
        let table = snapDict(snap["actionScope"])
        XCTAssertEqual(table.count, ActionKind.allCases.count, "actionScope 表的条目数与 TS 不一致")
        for kind in ActionKind.allCases {
            XCTAssertEqual(actionScope[kind]?.rawValue, snapText(table[kind.rawValue]), "actionScope[\(kind.rawValue)]")
        }
    }

    func testCardLimitsRatchet() throws {
        let snap = try snapshot()
        let limits = snapDict(snap["cardLimits"])
        XCTAssertEqual(cardLimits.maxFields, snapInt(limits["maxFields"]))
        XCTAssertEqual(cardLimits.maxActions, snapInt(limits["maxActions"]))
        XCTAssertEqual(cardLimits.maxFallbackChars, snapInt(limits["maxFallbackChars"]))
        XCTAssertEqual(cardLimits.maxLabelChars, snapInt(limits["maxLabelChars"]))
        XCTAssertEqual(cardLimits.maxValueChars, snapInt(limits["maxValueChars"]))
        XCTAssertEqual(cardLimits.maxCardsPerPage, snapInt(limits["maxCardsPerPage"]))
        XCTAssertEqual(cardLimits.maxTextChars, snapInt(limits["maxTextChars"]))
        XCTAssertEqual(cardLimits.maxEnumValues, snapInt(limits["maxEnumValues"]))
        XCTAssertEqual(cardLimits.maxDepth, snapInt(limits["maxDepth"]))
        XCTAssertEqual(cardLimits.maxCardBytes, snapInt(limits["maxCardBytes"]))
        XCTAssertEqual(cardLimits.maxIdChars, snapInt(limits["maxIdChars"]))
        XCTAssertEqual(cardLimits.maxActionParams, snapInt(limits["maxActionParams"]))
    }

    func testConfirmPolicyTableAndAudit() throws {
        let snap = try snapshot()
        XCTAssertEqual(ConfirmLevel.allCases.map(\.rawValue), snapStrings(snap["confirmLevels"]))
        let table = snapDict(snap["actionConfirm"])
        XCTAssertEqual(table.count, ActionKind.allCases.count, "actionConfirm 表的条目数与 TS 不一致")
        for kind in ActionKind.allCases {
            XCTAssertEqual(actionConfirm[kind]?.rawValue, snapText(table[kind.rawValue]), "actionConfirm[\(kind.rawValue)]")
        }
        let audit = snapDict(snap["confirmAudit"])
        let local = auditConfirmPolicy()
        XCTAssertEqual(local.ok, snapBool(audit["ok"]))
        XCTAssertEqual(local.problems, snapStrings(audit["problems"]))
        XCTAssertTrue(local.ok, "确认策略表自身不完整：\(local.problems)")
    }

    func testPushTables() throws {
        let snap = try snapshot()
        XCTAssertEqual(PushKind.allCases.map(\.rawValue), snapStrings(snap["pushKinds"]))
        XCTAssertEqual(PushSeverity.allCases.map(\.rawValue), snapStrings(snap["pushSeverities"]))
        XCTAssertEqual(PushAction.allCases.map(\.rawValue), snapStrings(snap["pushActions"]))
        XCTAssertEqual(deeplinkScheme, snapText(snap["deeplinkScheme"]))
        let limits = snapDict(snap["pushLimits"])
        XCTAssertEqual(pushLimits.maxActions, snapInt(limits["maxActions"]))
        XCTAssertEqual(pushLimits.maxFallbackChars, snapInt(limits["maxFallbackChars"]))
        XCTAssertEqual(pushLimits.maxDeeplinkChars, snapInt(limits["maxDeeplinkChars"]))
        XCTAssertEqual(pushLimits.maxDeskIdChars, snapInt(limits["maxDeskIdChars"]))
        // maxExpiresInMs 是 Double（与 DTO 的 expiresInMs 同型，避免 Int/Double 混算）
        XCTAssertEqual(pushLimits.maxExpiresInMs, (limits["maxExpiresInMs"] as? NSNumber)?.doubleValue ?? .nan)
    }

    func testOfflineTables() throws {
        let snap = try snapshot()
        XCTAssertEqual(Staleness.allCases.map(\.rawValue), snapStrings(snap["staleness"]))
        XCTAssertEqual(DeeplinkScreen.allCases.map(\.rawValue), snapStrings(snap["deeplinkScreens"]))
    }

    // MARK: - fail-closed 行为锁（不依赖快照，锁住判据本身）

    /// Lead 裁决 #1：TS 的注释说"未知 cardType ⇒ valid 仍可为 true"，**代码**是 valid=false。
    /// 这条测试把**代码行为**锁住：改了 TS 语义 → vectors 红；改了 Swift 语义 → 这里红。
    func testUnknownCardTypeIsInvalidAndInoperable() {
        let card = Card(cardId: "c1", cardType: "future-card", revision: 1, fallbackText: "未来卡片")
        let verdict = validateCard(card)
        XCTAssertFalse(verdict.valid, "未知 cardType 必须 valid=false（对齐 TS 代码，而不是它的注释）")
        XCTAssertFalse(verdict.operable, "未知 cardType 必须 operable=false")
        XCTAssertFalse(verdict.problems.isEmpty)
        XCTAssertTrue(verdict.problems.contains("未知 cardType: future-card"))
        // 卡片本身仍要能显示（fallbackText 兜底），不许被整张丢掉
        XCTAssertTrue(fallbackFor(card).hasPrefix("未来卡片"))
        XCTAssertTrue(renderableActions(card, clientCaps: ["action:*"]).isEmpty)
    }

    /// §10 不变量 1：未知 closed 枚举 ⇒ 不可操作（禁用全部 Action）。
    func testUnknownClosedEnumValuesDisableEveryAction() {
        let unknownField = Card(
            cardId: "c2", cardType: "risk-state", revision: 1, fallbackText: "兜底",
            fields: [CardField(key: "level", label: "档", kind: "future-kind", value: "x")],
            actions: [CardAction(kind: "ack", label: "确认")]
        )
        XCTAssertFalse(validateCard(unknownField).operable)
        XCTAssertTrue(renderableActions(unknownField, clientCaps: ["action:*"]).isEmpty)

        let unknownAction = Card(
            cardId: "c3", cardType: "risk-state", revision: 1, fallbackText: "兜底",
            fields: [], actions: [CardAction(kind: "future-action", label: "?")]
        )
        XCTAssertFalse(validateCard(unknownAction).operable)
        XCTAssertTrue(renderableActions(unknownAction, clientCaps: ["action:*"]).isEmpty)
    }

    /// §10 不变量 5：控制类动作一律 biometric 档。
    func testEveryControlActionRequiresBiometric() {
        for kind in ActionKind.allCases where actionScope[kind] == .control {
            XCTAssertEqual(confirmLevel(for: kind), .biometric, "control 类动作 \(kind.rawValue) 的确认档位低于 biometric")
            XCTAssertTrue(requiresBiometric(kind, platform: .mobile))
        }
        XCTAssertEqual(actionScope[.kill], .control)
        XCTAssertEqual(actionScope[.grantControl], .control)
    }

    /// §10 不变量 3：跨源永不混显 + 切换期只读（行为锁）。
    func testSourceGuardNeverMixesSourcesAndIsReadOnlyWhileSwitching() {
        let guardUnit = SourceGuard<String>(activeSourceId: "local")
        let data = [
            SourcedDatum(id: "a", sourceId: "local", value: "1"),
            SourcedDatum(id: "b", sourceId: "remote", value: "2"),
        ]
        XCTAssertEqual(guardUnit.viewOf(data).map(\.id), ["a"])
        guardUnit.switchTo("remote")
        XCTAssertFalse(guardUnit.writable())
        XCTAssertEqual(guardUnit.viewOf(data).map(\.id), ["a"], "切换期只能显示旧源，不能混显")
        let report = guardUnit.reconcile(active: [data[0]], incoming: [data[0]])
        XCTAssertFalse(report.ok, "两侧条数不一致时必须保持只读")
        XCTAssertFalse(guardUnit.writable())
        let matched = guardUnit.reconcile(active: [data[0]], incoming: [data[1]])
        XCTAssertTrue(matched.ok)
        XCTAssertTrue(guardUnit.writable())
        XCTAssertEqual(guardUnit.viewOf(data).map(\.id), ["b"])
    }

    /// §10 不变量 2：过期数据不渲染数据本身。
    func testExpiredSnapshotNeverRendersTheDataItself() {
        let budget = StalenessBudget(freshMs: 1_000, staleMs: 5_000, ttlMs: 20_000)
        let snapshot = OfflineSnapshot(data: "持仓快照", atMs: 0, sourceId: "local")
        let view = offlineView(snapshot, nowMs: 20_000, budget: budget)
        guard case .notice(let staleness, let message) = view else {
            return XCTFail("过期快照必须渲染成 notice，而不是 data")
        }
        XCTAssertEqual(staleness, .expired)
        XCTAssertFalse(message.contains("持仓快照"))
    }
}
