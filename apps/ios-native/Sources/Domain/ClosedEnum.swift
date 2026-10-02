//
//  ClosedEnum.swift
//  Domain
//
//  契约面把 CardType / FieldKind / ActionKind / Staleness 这些定义成**封闭枚举**：
//  新增成员 = 契约变更，要走版本协商。客户端遇到不认识的值时，唯一正确的行为是
//  **不假装认识** —— 禁用全部动作，必要时整张卡片不渲染。
//
//  本文件只拥有那条规则本身（"未知即 fail-closed"），不拥有任何具体的封闭集合：
//  CardType / ActionKind 的成员表归 packages/contract/src/cards.ts（IOS-1 冻结面），
//  Domain 只消费"这个原始值不在集合里"这个事实。
//

/// 一个能用字符串原始值往返的封闭枚举。成员表由契约面拥有，本模块不复制。
public protocol ClosedEnumValue: RawRepresentable, Hashable, Sendable where RawValue == String {}

/// 封闭枚举的解析结果：认识的走 known，不认识的**原样保留**在 unknown 里。
///
/// 为什么不 throw：解析失败不是异常路径，而是**正常且必须被表达的观测事实**
/// —— "客户端太旧"要在界面上说出来，而不是把一张卡片整张丢掉。
public enum ClosedEnum<Value: ClosedEnumValue>: Hashable, Sendable {
    case known(Value)
    case unknown(String)

    public init(rawValue: String) {
        if let value = Value(rawValue: rawValue) {
            self = .known(value)
        } else {
            self = .unknown(rawValue)
        }
    }

    /// 认识这个值吗？认识的返回它，不认识的返回 nil。
    public var value: Value? {
        if case let .known(value) = self { return value }
        return nil
    }

    public var isUnknown: Bool {
        if case .unknown = self { return true }
        return false
    }

    /// 原始值：认识的路过枚举，不认识的原文返回（**不做任何兜底替换**）。
    public var rawValue: String {
        switch self {
        case let .known(value): return value.rawValue
        case let .unknown(raw): return raw
        }
    }
}
