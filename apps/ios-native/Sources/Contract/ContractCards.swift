import Foundation

/// 服务端驱动卡片协议（P4 步骤 2）—— 等价实现自 packages/contract/src/cards.ts。
///
/// **封闭枚举**：CardType / FieldKind / ActionKind 都是封闭集合。未知值不是"错误"而是**信号**
/// （客户端太旧）：卡片仍要按 fallbackText 显示，但**禁用全部 Action**。
/// 因此 DTO 里的 cardType / field.kind / action.kind 都是 `String`（接口冻结 §4.1），
/// 由本文件的查表判定；**没有 default 分支吞掉未知值**。
///
/// 写作用域：apps/ios-native/Sources/Contract/（IOS-1 冻结面）

/// 12 个封闭卡片类型。
public enum CardType: String, CaseIterable, Sendable, Hashable {
    case deskSummary = "desk-summary"
    case riskState = "risk-state"
    case decision
    case triggerTrace = "trigger-trace"
    case position
    case order
    case mandateStatus = "mandate-status"
    case escalation
    case journalGap = "journal-gap"
    case freshness
    case controlPanel = "control-panel"
    case systemNotice = "system-notice"
}

/// 封闭字段类型（没有 html/template/raw 这类逃生口）。
public enum FieldKind: String, CaseIterable, Sendable, Hashable {
    case text
    case number
    case currency
    case percent
    case timestamp
    case duration
    case severity
    case status
    case bool
    case symbol
    case idRef = "id-ref"
    case enumeration = "enum"
}

/// 封闭动作类型。
public enum ActionKind: String, CaseIterable, Sendable, Hashable {
    case ack
    case dismiss
    case openDetail = "open-detail"
    case retrySync = "retry-sync"
    case approve
    case reject
    case pause
    case resume
    case kill
    case flatten
    case grantControl = "grant-control"
    case revokeDevice = "revoke-device"
}

/// 动作需要的作用域。switch **不用 default**：新增 ActionKind 必然编译失败，逼人显式补一行。
func scopeOf(_ kind: ActionKind) -> ScopePlane {
    switch kind {
    case .ack, .dismiss, .openDetail, .retrySync: return .read
    case .approve, .reject: return .command
    case .pause, .resume, .kill, .flatten, .grantControl, .revokeDevice: return .control
    }
}

public let actionScope: [ActionKind: ScopePlane] =
    Dictionary(uniqueKeysWithValues: ActionKind.allCases.map { ($0, scopeOf($0)) })

/// 12 个硬上限（棘轮：只许降不许升；超限即非法，不截断）。
public struct CardLimits: Equatable, Sendable, Decodable {
    public let maxFields: Int
    public let maxActions: Int
    public let maxFallbackChars: Int
    public let maxLabelChars: Int
    public let maxValueChars: Int
    public let maxCardsPerPage: Int
    public let maxTextChars: Int
    public let maxEnumValues: Int
    public let maxDepth: Int
    public let maxCardBytes: Int
    public let maxIdChars: Int
    public let maxActionParams: Int

    public init(
        maxFields: Int, maxActions: Int, maxFallbackChars: Int, maxLabelChars: Int, maxValueChars: Int,
        maxCardsPerPage: Int, maxTextChars: Int, maxEnumValues: Int, maxDepth: Int, maxCardBytes: Int,
        maxIdChars: Int, maxActionParams: Int
    ) {
        self.maxFields = maxFields
        self.maxActions = maxActions
        self.maxFallbackChars = maxFallbackChars
        self.maxLabelChars = maxLabelChars
        self.maxValueChars = maxValueChars
        self.maxCardsPerPage = maxCardsPerPage
        self.maxTextChars = maxTextChars
        self.maxEnumValues = maxEnumValues
        self.maxDepth = maxDepth
        self.maxCardBytes = maxCardBytes
        self.maxIdChars = maxIdChars
        self.maxActionParams = maxActionParams
    }
}

/// 生产上限（= TS CARD_LIMITS）。
public let cardLimits = CardLimits(
    maxFields: 24, maxActions: 6, maxFallbackChars: 512, maxLabelChars: 64, maxValueChars: 256,
    maxCardsPerPage: 50, maxTextChars: 1024, maxEnumValues: 24, maxDepth: 3, maxCardBytes: 16_384,
    maxIdChars: 64, maxActionParams: 8
)

/// 一个字段。`kind` 是**字符串**（保留未知值，见接口冻结 §4.1）。
public struct CardField: Equatable, Sendable, Decodable {
    public let key: String
    public let label: String
    public let kind: String
    public let value: String?
    public let unit: String?
    public let values: [String]?

    private enum CodingKeys: String, CodingKey { case key, label, kind, value, unit, values }

    public init(key: String, label: String, kind: String, value: String? = nil, unit: String? = nil, values: [String]? = nil) {
        self.key = key
        self.label = label
        self.kind = kind
        self.value = value
        self.unit = unit
        self.values = values
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = (try? container.decode(String.self, forKey: .key)) ?? ""
        label = (try? container.decode(String.self, forKey: .label)) ?? ""
        kind = (try? container.decode(String.self, forKey: .kind)) ?? ""
        value = ((try? container.decodeIfPresent(LenientText.self, forKey: .value)) ?? nil)?.value
        unit = (try? container.decodeIfPresent(String.self, forKey: .unit)) ?? nil
        values = (try? container.decodeIfPresent([String].self, forKey: .values)) ?? nil
    }
}

/// 一个动作。`kind` 同样是字符串。
public struct CardAction: Equatable, Sendable, Decodable {
    public let kind: String
    public let label: String
    public let params: [String: String]?
    public let confirm: Bool?

    private enum CodingKeys: String, CodingKey { case kind, label, params, confirm }

    public init(kind: String, label: String, params: [String: String]? = nil, confirm: Bool? = nil) {
        self.kind = kind
        self.label = label
        self.params = params
        self.confirm = confirm
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? container.decode(String.self, forKey: .kind)) ?? ""
        label = (try? container.decode(String.self, forKey: .label)) ?? ""
        params = ((try? container.decodeIfPresent(LenientTextMap.self, forKey: .params)) ?? nil)?.value
        confirm = (try? container.decodeIfPresent(Bool.self, forKey: .confirm)) ?? nil
    }
}

/// 一张卡片。**公开 memberwise init + Decodable**：IOS-2 直接解 /v1/cards，不要自造一份。
public struct Card: Equatable, Sendable, Decodable {
    public let cardId: String
    /// **字符串**，不是 CardType：未知值要活到 validateCard，而不是在解码期抛掉整张卡。
    public let cardType: String
    /// **Double**，不是 Int：TS 只要求"有限非负数"，服务端真发 3.5 时必须原样接受，
    /// 否则同一份载荷会出现"驾驶舱能显示、iOS 整页解码失败"的分歧（Lead 裁决 2026-10-02）。
    public let revision: Double
    public let fallbackText: String
    public let fields: [CardField]
    public let actions: [CardAction]
    public let freshnessMs: Int?

    private enum CodingKeys: String, CodingKey {
        case cardId, cardType, revision, fallbackText, fields, actions, freshnessMs
    }

    public init(
        cardId: String, cardType: String, revision: Double, fallbackText: String,
        fields: [CardField] = [], actions: [CardAction] = [], freshnessMs: Int? = nil
    ) {
        self.cardId = cardId
        self.cardType = cardType
        self.revision = revision
        self.fallbackText = fallbackText
        self.fields = fields
        self.actions = actions
        self.freshnessMs = freshnessMs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cardId = (try? container.decode(String.self, forKey: .cardId)) ?? ""
        cardType = (try? container.decode(String.self, forKey: .cardType)) ?? ""
        // 缺失/非数字的 revision 记成 -1：与 TS 一样落进"revision 必须是非负有限数"（不钉整数）
        revision = (try? container.decode(Double.self, forKey: .revision)) ?? -1
        fallbackText = (try? container.decode(String.self, forKey: .fallbackText)) ?? ""
        fields = ((try? container.decodeIfPresent([CardField].self, forKey: .fields)) ?? nil) ?? []
        actions = ((try? container.decodeIfPresent([CardAction].self, forKey: .actions)) ?? nil) ?? []
        freshnessMs = (try? container.decodeIfPresent(Int.self, forKey: .freshnessMs)) ?? nil
    }
}

/// 校验结果：非法卡片附原因；**可渲染但不可操作**是另一回事（见 operable）。
public struct CardVerdict: Equatable, Sendable {
    public let valid: Bool
    public let operable: Bool
    public let problems: [String]

    public init(valid: Bool, operable: Bool, problems: [String]) {
        self.valid = valid
        self.operable = operable
        self.problems = problems
    }
}

/// 卡片体积（maxCardBytes 棘轮用）：稳定序列化后的 UTF-8 字节数。
private func cardByteCount(_ card: Card) -> Int {
    func fieldObject(_ field: CardField) -> [String: Any] {
        var object: [String: Any] = ["key": field.key, "label": field.label, "kind": field.kind]
        if let value = field.value { object["value"] = value }
        if let unit = field.unit { object["unit"] = unit }
        if let values = field.values { object["values"] = values }
        return object
    }
    func actionObject(_ action: CardAction) -> [String: Any] {
        var object: [String: Any] = ["kind": action.kind, "label": action.label]
        if let params = action.params { object["params"] = params }
        if let confirm = action.confirm { object["confirm"] = confirm }
        return object
    }
    var object: [String: Any] = [
        "cardId": card.cardId,
        "cardType": card.cardType,
        // 整数值写成 Int：对齐 JS 的 JSON.stringify（1.0 会写成 "1" 而不是 "1.0"），否则字节上限判定会漂
        "revision": card.revision == card.revision.rounded() ? Int(card.revision) : card.revision,
        "fallbackText": card.fallbackText,
        "fields": card.fields.map(fieldObject),
        "actions": card.actions.map(actionObject),
    ]
    if let freshnessMs = card.freshnessMs { object["freshnessMs"] = freshnessMs }
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) else {
        return 0
    }
    return data.count
}

/// 字符串上限一律用 **UTF-16 码元数**（`utf16.count`），对齐 TS 的 `String.length`
/// —— Swift 的 `String.count` 数的是字素簇，一个 emoji 在 TS 里算 2、在 Swift 里算 1，
/// 用错单位会让"超限"在 emoji 上漏判（机检的 emoji 边界向量就是为此而设）。
///
/// 校验一张卡片：4 条"不退化"规则 + 12 个硬上限（逐条等价于 TS validateCard）。
///
/// 未知封闭枚举值 ⇒ **不可操作**（禁用全部 Action），不猜默认值、不抛掉整张卡。
public func validateCard(_ card: Card, limits: CardLimits = cardLimits) -> CardVerdict {
    var problems: [String] = []
    var operabilityBlocked = false

    if card.cardId == "" || card.cardId.utf16.count > limits.maxIdChars {
        problems.append("cardId 必填且不超过 " + String(limits.maxIdChars) + " 字符")
    }
    if CardType(rawValue: card.cardType) == nil {
        problems.append("未知 cardType: " + card.cardType)
        operabilityBlocked = true
    }
    if !card.revision.isFinite || card.revision < 0 {
        problems.append("revision 必须是非负有限数")
    }
    if card.fallbackText.trimmingCharacters(in: .whitespacesAndNewlines) == "" {
        problems.append("fallbackText 必填（客户端不会渲染时要有纯文本兜底）")
    } else if card.fallbackText.utf16.count > limits.maxFallbackChars {
        problems.append("fallbackText 超过 " + String(limits.maxFallbackChars) + " 字符上限")
    }
    if card.fields.count > limits.maxFields {
        problems.append("fields 不得超过 " + String(limits.maxFields) + " 条")
    }
    if card.actions.count > limits.maxActions {
        problems.append("actions 不得超过 " + String(limits.maxActions) + " 条")
    }
    for field in card.fields {
        guard FieldKind(rawValue: field.kind) != nil else {
            problems.append("未知 fieldKind: " + field.kind)
            operabilityBlocked = true
            continue
        }
        if field.label.utf16.count > limits.maxLabelChars {
            problems.append("字段 " + field.key + " 的 label 超过 " + String(limits.maxLabelChars) + " 字符上限")
        }
        if let value = field.value, value.utf16.count > limits.maxValueChars {
            problems.append("字段 " + field.key + " 的值超过 " + String(limits.maxValueChars) + " 字符上限")
        }
        if field.kind == FieldKind.enumeration.rawValue {
            let values = field.values
            if values == nil || values!.isEmpty {
                problems.append("enum 字段 " + field.key + " 必须给出 values")
                operabilityBlocked = true
            } else if values!.count > limits.maxEnumValues {
                problems.append("enum 字段 " + field.key + " 的 values 超过 " + String(limits.maxEnumValues) + " 个")
            } else if !values!.contains(field.value ?? "undefined") {
                problems.append("enum 字段 " + field.key + " 的值 " + (field.value ?? "undefined") + " 不在 values 内")
                operabilityBlocked = true
            }
        }
    }
    for action in card.actions {
        guard ActionKind(rawValue: action.kind) != nil else {
            problems.append("未知 actionKind: " + action.kind)
            operabilityBlocked = true
            continue
        }
        if scopeOf(ActionKind(rawValue: action.kind)!) == .control && action.confirm != true {
            problems.append("控制类动作 " + action.kind + " 必须 confirm: true（不允许一键触发）")
            operabilityBlocked = true
        }
        if let params = action.params, params.count > limits.maxActionParams {
            problems.append("动作 " + action.kind + " 的 params 超过 " + String(limits.maxActionParams) + " 项")
        }
    }
    let bytes = cardByteCount(card)
    if bytes > limits.maxCardBytes {
        problems.append("卡片体积 " + String(bytes) + " 超过 " + String(limits.maxCardBytes) + " 字节上限")
    }
    let valid = problems.isEmpty
    return CardVerdict(valid: valid, operable: valid && !operabilityBlocked, problems: problems)
}

/// 客户端可渲染的动作列表：卡片非法或含未知枚举 ⇒ 空数组；再按客户端 caps 过滤。
public func renderableActions(_ card: Card, clientCaps: [String], limits: CardLimits = cardLimits) -> [CardAction] {
    guard validateCard(card, limits: limits).operable else { return [] }
    let caps = Set(clientCaps)
    return card.actions.filter { caps.contains("action:" + $0.kind) || caps.contains("action:*") }
}

/// 客户端不会渲染这张卡时给用户的文本（这就是 fallbackText 的用处）。
public func fallbackFor(_ card: Card) -> String {
    let verdict = validateCard(card)
    if verdict.valid && verdict.operable { return card.fallbackText }
    if card.fallbackText.trimmingCharacters(in: .whitespacesAndNewlines) == "" {
        return "（这张卡片无法显示，请升级客户端）"
    }
    return card.fallbackText + "（部分内容无法显示：请升级客户端）"
}
