//
//  Primitives.swift
//  Domain
//
//  领域原语：时间戳、带标签的不透明 id、订单号形态判定。
//

import Foundation

/// 毫秒级 Unix 时间戳。
///
/// 全模块**不读系统时钟**：nowMs 一律由调用方传入。心跳、陈旧度、"最后确认时间"
/// 因此都是可复现的纯函数 —— 测试里不需要 sleep，也不需要把时钟注入成 mock。
public typealias EpochMillis = Int64

/// 领域 id 的标签类型：不同实体的 id 互为**不同类型**，编译期就不能互相顶替。
public protocol IdTag: Sendable {}

/// 不透明 id。**只比较、不解析**：字符串里不含 venue slug、不含版本位语义。
public struct OpaqueId<Tag: IdTag>: Hashable, Sendable, Codable, CustomStringConvertible, Comparable {
    public let rawValue: String

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    public var description: String { rawValue }

    public static func < (lhs: OpaqueId<Tag>, rhs: OpaqueId<Tag>) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

public enum BotTag: IdTag {}
public enum StrategyVersionTag: IdTag {}
public enum RunInstanceTag: IdTag {}
public enum OrderTag: IdTag {}
public enum FillTag: IdTag {}
public enum CashMovementTag: IdTag {}
public enum AccountTag: IdTag {}

/// 机器人身份（稳定）。
public typealias BotId = OpaqueId<BotTag>
/// 策略版本身份。
public typealias StrategyVersionId = OpaqueId<StrategyVersionTag>
/// 一次运行实例的身份。
public typealias RunInstanceId = OpaqueId<RunInstanceTag>
/// 观察面上的订单句柄（唯一可被客户端引用撤单的 id）。
public typealias OrderId = OpaqueId<OrderTag>
/// 成交身份。
public typealias FillId = OpaqueId<FillTag>
/// 资金变动身份。
public typealias CashMovementId = OpaqueId<CashMovementTag>
/// 账户引用（交易账户，不是 desk，也不是设备）。
public typealias AccountRef = OpaqueId<AccountTag>

/// 订单号形态判定。
///
/// 设计文档第 4 节冻结的是 **ord_ + UUID 规范形、且不钉版本位**（第三组写
/// [0-9a-f]{4} 而不是 4[0-9a-f]{3}），这样日后 UUID v4 -> v7 不需要改契约版本、
/// 也不需要客户端发版。这里按冻结形态实现：**只用于校验与比较，不解析出任何语义**。
public enum OrderIdFormat {
    public static let pattern = "^ord_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

    public static func isValid(_ raw: String) -> Bool {
        raw.range(of: pattern, options: .regularExpression) != nil
    }

    /// 从一个小写 UUID 规范形造出 orderId（去横线以外不做任何改动）。
    public static func make(uuid: String) -> OrderId {
        OrderId("ord_" + uuid.lowercased())
    }
}
