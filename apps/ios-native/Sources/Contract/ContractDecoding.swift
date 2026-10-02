import Foundation

/// DTO 解码的宽松标量：*只*做类型搬运，**不做语义判定，也不猜默认值**。
///
/// 为什么需要它（接口冻结 §4.1）：TS 的 CardField.value 是 `unknown`，而 Swift 的
/// `enum: String` 解码未知值会抛错。这里把 JSON 标量原样搬成文本（字符串原样；
/// bool/number 转成 JSON 文本；null/数组/对象 ⇒ nil），让"未知值"一路走到 validateCard
/// 里被判成**不可操作**，而不是抛掉整张卡。
///
/// 写作用域：apps/ios-native/Sources/Contract/（IOS-1 冻结面）
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
