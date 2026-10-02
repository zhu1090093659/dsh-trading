//
//  OfflineBackoff.swift
//  Offline
//
//  弱网重试纪律（冻结件 §9）：**指数退避 + 抖动，不做无退避的重试风暴**。
//
//  两件事在这里被钉死：
//    1. 「能不能重试」由失败**类别**决定，不由"网络错误"这个笼统印象决定 ——
//       未配对/令牌失效/客户端过旧/跨源这些都**不该重试**，重试只是把用户卡在转圈里；
//    2. 退避必须**有界**（有上限、有次数上限），否则弱网会把客户端变成对服务端的压力源。
//
//  本文件不 import Transport：失败类别经 rawValue 桥接（见 FetchFailure.init(kindRawValue:)），
//  未知类别一律 fail-closed 成 .unknown，不会被误判成可重试。
//

import Foundation

/// 取快照失败的**类别**（与 Transport 的 TransportErrorKind 同名同 rawValue）。
///
/// 用 rawValue 桥接而不是 import Transport：冻结件 §3 的 Offline 只允许依赖 Contract + Domain。
public enum FetchFailure: String, Sendable, CaseIterable, Hashable {
    /// 目标 origin ≠ 配对绑定 origin（请求根本没发出）⇒ 要回配对，不重试。
    case originNotBound
    /// 连不上服务端，或还没有可用令牌。**可重试**。
    case unreachable
    /// 服务端回了不能按协议解析的内容。**可重试**（可能是中间层瞬态）。
    case badResponse
    /// 401：令牌缺失/无效 ⇒ 清令牌回配对门，不重试。
    case unauthorized
    /// 403：缺该作用域 ⇒ 要人去授权，不重试。
    case scopeRequired
    /// 426：客户端过旧 ⇒ 要升级，不重试。
    case clientTooOld
    /// 不认识的类别 ⇒ fail-closed：不重试。
    case unknown

    /// 由 Transport 的分类入口按 rawValue 桥接；未知/缺失 ⇒ .unknown。
    public init(kindRawValue: String?) {
        guard let raw = kindRawValue, let parsed = FetchFailure(rawValue: raw) else {
            self = .unknown
            return
        }
        self = parsed
    }

    /// 穷尽 switch（无 default）。
    public var isRetryable: Bool {
        switch self {
        case .unreachable, .badResponse: return true
        case .originNotBound, .unauthorized, .scopeRequired, .clientTooOld, .unknown: return false
        }
    }

    /// 需要用户回到配对门的失败。
    public var requiresRelinking: Bool {
        switch self {
        case .originNotBound, .unauthorized: return true
        case .unreachable, .badResponse, .scopeRequired, .clientTooOld, .unknown: return false
        }
    }

    /// 穷尽 switch（无 default）。
    public var label: String {
        switch self {
        case .originNotBound: return "令牌与配对来源不一致"
        case .unreachable: return "连不上机器人"
        case .badResponse: return "响应无法按协议解析"
        case .unauthorized: return "设备令牌已失效，需要重新配对"
        case .scopeRequired: return "缺少该操作所需的作用域"
        case .clientTooOld: return "客户端版本过旧"
        case .unknown: return "未知的失败类别"
        }
    }
}

/// 取快照失败（Offline 侧的失败词汇，带类别）。
///
/// SnapshotFetching 的实现**必须**抛这个类型；抛别的会被当成 .unknown（fail-closed，不重试）。
public struct ObservationFetchFailure: Error, Sendable, Equatable {
    public let failure: FetchFailure
    public let message: String

    public init(failure: FetchFailure, message: String) {
        self.failure = failure
        self.message = message
    }
}

/// 退避参数。**全部由调用方给**，本模块不发明常量、也不 sleep。
public struct BackoffPolicy: Sendable, Hashable {
    public let baseMs: Int
    public let maxMs: Int
    public let multiplier: Double
    /// 抖动比例（0...1）：延迟在 [raw * (1 - jitterFraction), raw] 之间取。
    public let jitterFraction: Double
    /// 次数上限：到点就放弃，避免无限重试。
    public let maxAttempts: Int

    public init(baseMs: Int, maxMs: Int, multiplier: Double, jitterFraction: Double, maxAttempts: Int) {
        self.baseMs = max(1, baseMs)
        self.maxMs = max(self.baseMs, maxMs)
        self.multiplier = multiplier < 1 ? 1 : multiplier
        self.jitterFraction = min(1, max(0, jitterFraction))
        self.maxAttempts = max(1, maxAttempts)
    }

    /// 第 attempt 次（从 0 起）失败后的延迟。
    /// randomFraction 由调用方提供（0..<1）⇒ 可复现、不需要真随机、也不需要 sleep。
    public func delayMs(attempt: Int, randomFraction: Double) -> Int {
        let step = Double(max(0, attempt))
        let raw = min(Double(maxMs), Double(baseMs) * pow(multiplier, step))
        let jitter = min(1, max(0, randomFraction))
        let value = raw * (1 - jitterFraction * jitter)
        return max(1, Int(value.rounded()))
    }

    /// 是否还要再试（次数上限 + 类别）。
    public func shouldRetry(attempt: Int, failure: FetchFailure) -> Bool {
        failure.isRetryable && attempt + 1 < maxAttempts
    }
}

/// 一次失败后的决定。
public enum RetryDecision: Equatable, Sendable {
    case retry(afterMs: Int)
    case giveUp(reason: String)

    public var delayMs: Int? {
        if case let .retry(afterMs) = self { return afterMs }
        return nil
    }
}

/// 决定下一次要不要重试、以及等多久。
public enum RetryScheduler {
    public static func decide(
        attempt: Int,
        failure: FetchFailure,
        policy: BackoffPolicy,
        randomFraction: Double
    ) -> RetryDecision {
        if failure.requiresRelinking {
            return .giveUp(reason: "需要重新配对：" + failure.label)
        }
        guard failure.isRetryable else {
            return .giveUp(reason: failure.label)
        }
        guard policy.shouldRetry(attempt: attempt, failure: failure) else {
            return .giveUp(reason: "重试次数已达上限（" + String(policy.maxAttempts) + "）")
        }
        return .retry(afterMs: policy.delayMs(attempt: attempt, randomFraction: randomFraction))
    }
}
