import Foundation

/// 服务端驱动卡片协议（P4 步骤 2）—— 等价实现自 packages/contract/src/cards.ts。
///
/// **封闭枚举**：CardType / FieldKind / ActionKind 都是封闭集合。未知值不是"错误"而是**信号**
/// （客户端太旧）：卡片仍要按 fallbackText 显示，但**禁用全部 Action**。
/// 因此 DTO 里的 cardType / field.kind / action.kind 都是 `String`（见 README §3「fail-closed 的建模方式」），
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

/// 一个字段。`kind` 是**字符串**（保留未知值，见 README §3「fail-closed 的建模方式」）。
public struct CardField: Equatable, Sendable, Decodable {
    public let key: String
    public let label: String
    public let kind: String
    /// JSON 值原样保留（对齐 TS 的 `value: unknown`）。**nil 表示"JSON 里没有 value 键"**，
    /// 而 JSON `null` 是 `.null` —— 这两件事在 TS 里分别是 `undefined` 与 `null`，必须分开表达。
    /// 旧实现把二者都解成 `String?` 的 nil，于是 `{value: null, values: ["null"]}` 被判成
    /// "值 undefined 不在 values 内"而不可操作 —— Swift 比 TS 窄，本字段就是那条缺陷的落点。
    public let rawValue: CardValue?
    public let unit: String?
    public let values: [String]?

    /// TS `String(field.value)` 的投影（`undefined` ⇒ nil，`null` ⇒ `"null"`）。
    /// 展示/解析路径沿用它；**判定路径必须用 `rawValue`**，否则又会塌回"null 与缺失同形"。
    public var value: String? { rawValue.map(cardValueText) }

    private enum CodingKeys: String, CodingKey { case key, label, kind, value, unit, values }

    public init(key: String, label: String, kind: String, value: String? = nil, unit: String? = nil, values: [String]? = nil) {
        self.init(key: key, label: label, kind: kind, rawValue: value.map { CardValue.text($0) }, unit: unit, values: values)
    }

    /// 保真构造：`rawValue` 传 `.null` 表示 JSON null、传 nil 表示字段缺失。
    public init(key: String, label: String, kind: String, rawValue: CardValue?, unit: String? = nil, values: [String]? = nil) {
        self.key = key
        self.label = label
        self.kind = kind
        self.rawValue = rawValue
        self.unit = unit
        self.values = values
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = (try? container.decode(String.self, forKey: .key)) ?? ""
        label = (try? container.decode(String.self, forKey: .label)) ?? ""
        kind = (try? container.decode(String.self, forKey: .kind)) ?? ""
        // **用 contains 区分"缺失"与"JSON null"**：decodeIfPresent 对 null 与缺失都返回 nil，
        // 那正是本缺陷的成因（null 被当成 undefined）。
        rawValue = container.contains(.value) ? (try? container.decode(CardValue.self, forKey: .value)) : nil
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
    /// **Double?**：对齐 TS 的 number（允许小数与极大有限数），不因 Int 解码而截断或失败。
    public let freshnessMs: Double?

    private enum CodingKeys: String, CodingKey {
        case cardId, cardType, revision, fallbackText, fields, actions, freshnessMs
    }

    public init(
        cardId: String, cardType: String, revision: Double, fallbackText: String,
        fields: [CardField] = [], actions: [CardAction] = [], freshnessMs: Double? = nil
    ) {
        self.cardId = cardId
        self.cardType = cardType
        self.revision = revision
        self.fallbackText = fallbackText
        self.fields = fields
        self.actions = actions
        self.freshnessMs = freshnessMs
    }

    public init(
        cardId: String, cardType: String, revision: Double, fallbackText: String,
        fields: [CardField] = [], actions: [CardAction] = [], freshnessMs: Int?
    ) {
        self.init(
            cardId: cardId, cardType: cardType, revision: revision, fallbackText: fallbackText,
            fields: fields, actions: actions, freshnessMs: freshnessMs.map(Double.init)
        )
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
        freshnessMs = (try? container.decodeIfPresent(Double.self, forKey: .freshnessMs)) ?? nil
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

/// 卡片体积（maxCardBytes 棘轮用）：`JSON.stringify(card)` 的 UTF-8 字节数。
///
/// **不再走 `JSONSerialization`**，两个理由：
///   1. 它给保真值（数组/对象/null）的序列化结果与 TS 的形状不同；
///   2. **它对非有限 Double 会抛不可捕获的 NSException**（进程终止），而 revision 只要求
///      "非负有限数"是校验**之后**的事 —— 一份 `revision: 1e400` 的载荷会先序列化再判非法。
/// 这里按 TS `JSON.stringify` 的键序与数字格式自己拼文本，判定与 TS 逐字节一致、且绝不 trap。
/// 键序取字段的字典序（TS 用插入序 —— 见 Agent Note 的已知边界）。
private func cardByteCount(_ card: Card) -> Int {
    var members: [(String, String)] = []
    func add(_ key: String, _ text: String) { members.append((key, text)) }
    add("cardId", contractJSONString(card.cardId))
    add("cardType", contractJSONString(card.cardType))
    add("revision", contractJSONNumber(card.revision))
    add("fallbackText", contractJSONString(card.fallbackText))
    add("fields", "[" + card.fields.map(fieldJSON).joined(separator: ",") + "]")
    add("actions", "[" + card.actions.map(actionJSON).joined(separator: ",") + "]")
    if let freshnessMs = card.freshnessMs { add("freshnessMs", contractJSONNumber(freshnessMs)) }
    return jsonObjectText(members).utf8.count
}

/// `JSON.stringify(object)` 的形状：键按字典序、键名同样转义（TS 用插入序 —— 见 Agent Note 边界）。
private func jsonObjectText(_ members: [(String, String)]) -> String {
    let body = members.sorted { $0.0 < $1.0 }
        .map { contractJSONString($0.0) + ":" + $0.1 }
        .joined(separator: ",")
    return "{" + body + "}"
}

private func fieldJSON(_ field: CardField) -> String {
    var members: [(String, String)] = []
    members.append(("key", contractJSONString(field.key)))
    members.append(("label", contractJSONString(field.label)))
    members.append(("kind", contractJSONString(field.kind)))
    if let rawValue = field.rawValue { members.append(("value", contractJSONValue(rawValue))) }
    if let unit = field.unit { members.append(("unit", contractJSONString(unit))) }
    if let values = field.values { members.append(("values", "[" + values.map(contractJSONString).joined(separator: ",") + "]")) }
    return jsonObjectText(members)
}

private func actionJSON(_ action: CardAction) -> String {
    var members: [(String, String)] = []
    members.append(("kind", contractJSONString(action.kind)))
    members.append(("label", contractJSONString(action.label)))
    if let params = action.params {
        let body = params.keys.sorted().map { contractJSONString($0) + ":" + contractJSONString(params[$0]!) }.joined(separator: ",")
        members.append(("params", "{" + body + "}"))
    }
    if let confirm = action.confirm { members.append(("confirm", confirm ? "true" : "false")) }
    return jsonObjectText(members)
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
        // 与 TS 一致：**只对字符串**查 maxValueChars（TS 的 typeof value === 'string'）。
        // 数组/对象也能投影出文本，但它们不受长度上限约束，不能因此把合法卡片判非法。
        if case .text(let text)? = field.rawValue, text.utf16.count > limits.maxValueChars {
            problems.append("字段 " + field.key + " 的值超过 " + String(limits.maxValueChars) + " 字符上限")
        }
        if field.kind == FieldKind.enumeration.rawValue {
            let values = field.values
            // TS 的 String(field.value)：JSON null ⇒ "null"，字段缺失 ⇒ "undefined"。
            // 用 rawValue 判定而不是投影后的 String?，否则 null 与缺失又会被混成同一个值。
            let valueText = contractValueText(field.rawValue)
            if values == nil || values!.isEmpty {
                problems.append("enum 字段 " + field.key + " 必须给出 values")
                operabilityBlocked = true
            } else if values!.count > limits.maxEnumValues {
                problems.append("enum 字段 " + field.key + " 的 values 超过 " + String(limits.maxEnumValues) + " 个")
            } else if !values!.contains(valueText) {
                problems.append("enum 字段 " + field.key + " 的值 " + valueText + " 不在 values 内")
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
