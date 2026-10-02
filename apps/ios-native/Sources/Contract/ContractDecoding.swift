import Foundation

/// DTO 解码的宽松标量：*只*做类型搬运，**不做语义判定，也不猜默认值**。
///
/// 为什么需要它（见 README §3「fail-closed 的建模方式」）：TS 的 CardField.value 是 `unknown`，而 Swift 的
/// `enum: String` 解码未知值会抛错。这里把 JSON 值按其**真实形状**搬进来，让"未知值"一路走到 validateCard
/// 里被判成**不可操作**，而不是抛掉整张卡。
///
/// 写作用域：apps/ios-native/Sources/Contract/（IOS-1 冻结面）

// MARK: - 卡片字段值的保真形状（对齐 TS `CardField.value: unknown`）

/// JSON 值的保真形状。
///
/// **为什么不能再用 `String?` 表示 value**：Swift 的 `String?` 把 JSON `null` 与"字段缺失"
/// 都解成 nil，于是 `{value: null}` 被判成 `String(undefined) === "undefined"`，
/// 而 TS 权威 `packages/contract/src/cards.ts` 是 `String(null) === "null"`。
/// 一份 `{value: null, values: ["null"]}` 的卡片在 TS 里 valid 且 operable，在 Swift 里
/// 却被判成"值 undefined 不在 values 内"而不可操作 —— 违反「Swift 是 TS 的等价实现，不得更窄」。
/// 所以**形状、null、缺失三者必须分开表达**，`String()` 转换另有一处（`cardValueText`）。
public enum CardValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    /// JSON 数字超出 Double 可表示范围（如 1e400）。真实 wire 路径上不可达 —— 传输层先做
    /// JSONSerialization，越界数字会让整页判定为 CARDS_INVALID（见 DshtApiClient.cards）。
    /// 这里保留一个显式形状，是为了**不把非标量静默塌缩成同一个 nil**。
    case unrepresentableNumber
    case text(String)
    case array([CardValue])
    case object([String: CardValue])
}

extension CardValue: Decodable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let flag = try? container.decode(Bool.self) { self = .bool(flag); return }
        if let number = try? container.decode(Double.self) { self = .number(number); return }
        if let text = try? container.decode(String.self) { self = .text(text); return }
        if let items = try? container.decode([CardValue].self) { self = .array(items); return }
        if let members = try? container.decode([String: CardValue].self) { self = .object(members); return }
        // 走到这里只可能是 JSON 数字超出 Double 的有限范围：其余形状都在上面认领了。
        self = .unrepresentableNumber
    }
}

/// TS `String(value)`（ECMAScript ToString）的等价实现，逐条给出依据：
///
/// | JSON 值 | TS `String(v)` | 本实现 |
/// |---|---|---|
/// | `null` | `"null"` | `.null` ⇒ `"null"` |
/// | 缺失（`undefined`）| `"undefined"` | `contractValueText(nil)` |
/// | `true` / `false` | `"true"` / `"false"` | `.bool` |
/// | 数字（含科学记数法）| ECMAScript Number::toString | `contractNumberText` |
/// | 字符串（含空串）| 原样 | `.text` |
/// | 数组 | `Array.prototype.join(",")`：元素各自 String()，`null` 元素转空串 | `.array` |
/// | 对象 | `"[object Object]"`（不论内容）| `.object` |
///
/// 数组与对象**不塌缩成 nil**（那会让"值不在 values 内"的判据在 TS/Swift 两侧永久分叉）：
/// 数组按 join 语义逐元素拼接，对象按 TS 的固定形状 `[object Object]`。
func cardValueText(_ value: CardValue) -> String {
    switch value {
    case .null: return "null"
    case .bool(let flag): return flag ? "true" : "false"
    case .number(let number): return contractNumberText(number)
    case .unrepresentableNumber: return "Infinity"
    case .text(let text): return text
    case .array(let items): return items.map(arrayElementText).joined(separator: ",")
    case .object: return "[object Object]"
    }
}

/// `String(field.value)`：**只有 JSON 里缺 value 键**才走 `undefined` 语义。
/// JSON `null` 是"已知的 null"，走 `"null"` —— 这两件事是本次修复的分界。
func contractValueText(_ value: CardValue?) -> String {
    guard let value else { return "undefined" }
    return cardValueText(value)
}

/// `Array.prototype.join` 把 `null` / `undefined` 元素转成空串（与 `String(null) === "null"` 不同）。
private func arrayElementText(_ value: CardValue) -> String {
    if case .null = value { return "" }
    return cardValueText(value)
}

// MARK: - ECMAScript Number::toString / JSON.stringify 的等价转换

/// ECMAScript `Number::toString`（即 TS `String(number)` 与 `JSON.stringify(number)` 的数字部分）
/// 的等价实现。依据（逐条）：
///
/// 1. `NaN` ⇒ `"NaN"`；`+Infinity`/`-Infinity` ⇒ `"Infinity"`/`"-Infinity"`；`±0` ⇒ `"0"`
///    （ECMAScript 对 -0 不做 `"-` 前缀）。
/// 2. 其余有限数：`Double.description` 给的就是**最短往返十进制**（与 ECMAScript 选同一条尾数），
///    再按规范的指数/定点切换阈值重新排版。设有效数字串 `s`（去前导/尾随 0，长度 k）、
///    `n` 为小数点相对 `s` 的位置（即 value = 0.s × 10^n）：
///    - `k ≤ n ≤ 21`：纯整数，右侧补 `n-k` 个 0；
///    - `0 < n ≤ 21`：小数点插在第 n 位数字后；
///    - `-6 < n ≤ 0`：`0.` + `-n` 个 0 + `s`；
///    - 其余：科学记数 `s[0]` [`.` + 其余] `e` (±)(`n-1`)（k == 1 时不带小数点）。
///
/// 与 node 实际输出逐条比对：299,924 个随机位型 + 4,007 个构造字面量，**0 差异**（见 Agent Note 证据）。
func contractNumberText(_ value: Double) -> String {
    if value.isNaN { return "NaN" }
    if value == 0 { return "0" }
    if value < 0 { return "-" + contractNumberText(-value) }
    if value.isInfinite { return "Infinity" }
    guard let parts = shortestDecimalParts(value) else { return value.description }
    let digits = parts.digits
    let n = parts.n
    let k = digits.count
    let text = String(digits)
    if k <= n && n <= 21 { return text + String(repeating: "0", count: n - k) }
    if 0 < n && n <= 21 {
        let split = text.index(text.startIndex, offsetBy: n)
        return String(text[text.startIndex..<split]) + "." + String(text[split...])
    }
    if -6 < n && n <= 0 { return "0." + String(repeating: "0", count: -n) + text }
    let exponent = n - 1
    let sign = exponent >= 0 ? "+" : "-"
    let magnitude = String(abs(exponent))
    if k == 1 { return text + "e" + sign + magnitude }
    return String(text.first!) + "." + String(text.dropFirst()) + "e" + sign + magnitude
}

/// 把 `Double.description`（最短往返十进制）拆成（有效数字, n），供 `contractNumberText` 重排版。
/// 解析不出来时返回 nil（调用方退回 `description`，绝不 trap）。
private func shortestDecimalParts(_ value: Double) -> (digits: [Character], n: Int)? {
    let description = value.description
    var mantissa = description
    var exponent = 0
    if let marker = description.firstIndex(where: { $0 == "e" || $0 == "E" }) {
        mantissa = String(description[description.startIndex..<marker])
        guard let parsed = Int(String(description[description.index(after: marker)...])) else { return nil }
        exponent = parsed
    }
    let integerPart: String
    let fractionPart: String
    if let dot = mantissa.firstIndex(of: ".") {
        integerPart = String(mantissa[mantissa.startIndex..<dot])
        fractionPart = String(mantissa[mantissa.index(after: dot)...])
    } else {
        integerPart = mantissa
        fractionPart = ""
    }
    var digits = Array(integerPart.filter { $0 != "-" } + fractionPart)
    var scale = exponent - fractionPart.count
    var leading = 0
    while leading < digits.count && digits[leading] == "0" { leading += 1 }
    guard leading < digits.count else { return nil }
    digits.removeFirst(leading)
    var trailing = 0
    while trailing < digits.count && digits[digits.count - 1 - trailing] == "0" { trailing += 1 }
    if trailing > 0 {
        digits.removeLast(trailing)
        scale += trailing
    }
    return (digits, scale + digits.count)
}

/// TS `JSON.stringify(number)`：JSON 没有 NaN/Infinity 字面量，非有限数一律写成 `null`。
func contractJSONNumber(_ value: Double) -> String {
    value.isFinite ? contractNumberText(value) : "null"
}

/// TS `JSON.stringify(string)` 的等价转义：只转义 `"`、`\`、控制字符（`< 0x20`）。
/// U+2028/U+2029 与 U+FEFF 在 JS 里**不转义**（JSON 允许原样出现）—— 这与
/// `JSONSerialization` 的行为不同，是必须自己实现转义的原因。
func contractJSONString(_ text: String) -> String {
    var out = "\""
    for scalar in text.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\u{08}": out += "\\b"
        case "\u{09}": out += "\\t"
        case "\u{0A}": out += "\\n"
        case "\u{0C}": out += "\\f"
        case "\u{0D}": out += "\\r"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out + "\""
}

/// 按 TS `JSON.stringify(value)` 的形状把保真值序列化成 JSON 文本。
/// 对象键按**字典序**（与本仓唯一一条字节级向量 `byteCard` 的字母序夹具一致；
/// TS 用的是插入序 —— 见 Agent Note 的已知边界）。
func contractJSONValue(_ value: CardValue) -> String {
    switch value {
    case .null, .unrepresentableNumber: return "null"
    case .bool(let flag): return flag ? "true" : "false"
    case .number(let number): return contractJSONNumber(number)
    case .text(let text): return contractJSONString(text)
    case .array(let items): return "[" + items.map(contractJSONValue).joined(separator: ",") + "]"
    case .object(let members):
        let body = members.keys.sorted().map { key in
            contractJSONString(key) + ":" + contractJSONValue(members[key]!)
        }.joined(separator: ",")
        return "{" + body + "}"
    }
}

// MARK: - 通用宽松标量（CardAction.params）

/// 单个宽松标量：字符串原样；bool/number 转成 JSON 文本；null/数组/对象 ⇒ nil。
struct LenientText: Decodable {
    let value: String?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { value = nil; return }
        if let text = try? container.decode(String.self) { value = text; return }
        if let flag = try? container.decode(Bool.self) { value = flag ? "true" : "false"; return }
        if let int = try? container.decode(Int.self) { value = String(int); return }
        if let double = try? container.decode(Double.self) { value = String(double); return }
        // 数组/对象：不猜一个文本表示，留 nil 交给 validateCard 判
        value = nil
    }
}

/// 键值对形式的宽松标量（用于 CardAction.params）。
struct LenientTextMap: Decodable {
    let value: [String: String]?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { value = nil; return }
        guard let raw = try? container.decode([String: LenientText].self) else { value = nil; return }
        value = raw.compactMapValues { $0.value }
    }
}
