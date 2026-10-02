//
//  Performance.swift
//  Domain
//
//  绩效指标。**每个指标自己带归属置信度** —— 这样"打印一个数字而不带标注"
//  在类型上就不可能：想显示数字就必须给出 AttributedValue。
//

import Foundation

/// 绩效窗口。
public struct PerformanceWindow: Hashable, Sendable {
    public let startMs: EpochMillis
    public let endMs: EpochMillis

    public init(startMs: EpochMillis, endMs: EpochMillis) {
        self.startMs = startMs
        self.endMs = endMs
    }
}

/// 账户级绩效（来源：账户同步 / 服务端汇总）。
public struct AccountPerformance: Hashable, Sendable {
    public let account: AccountRef
    public let window: PerformanceWindow
    public let realizedPnl: Decimal
    public let unrealizedPnl: Decimal
    public let fees: Decimal
    public let funding: Decimal
    public let tradeCount: Int
    public let maxDrawdown: Decimal?

    public init(
        account: AccountRef,
        window: PerformanceWindow,
        realizedPnl: Decimal,
        unrealizedPnl: Decimal,
        fees: Decimal,
        funding: Decimal,
        tradeCount: Int,
        maxDrawdown: Decimal?
    ) {
        self.account = account
        self.window = window
        self.realizedPnl = realizedPnl
        self.unrealizedPnl = unrealizedPnl
        self.fees = fees
        self.funding = funding
        self.tradeCount = tradeCount
        self.maxDrawdown = maxDrawdown
    }
}

/// 机器人级绩效。每个数字都带归属标注。
public struct PerformanceMetrics: Hashable, Sendable {
    public let botId: BotId
    public let window: PerformanceWindow
    public let realizedPnl: AttributedValue<Decimal>
    public let unrealizedPnl: AttributedValue<Decimal>
    public let fees: AttributedValue<Decimal>
    public let funding: AttributedValue<Decimal>
    public let tradeCount: Int
    public let maxDrawdown: AttributedValue<Decimal>?

    public init(
        botId: BotId,
        window: PerformanceWindow,
        realizedPnl: AttributedValue<Decimal>,
        unrealizedPnl: AttributedValue<Decimal>,
        fees: AttributedValue<Decimal>,
        funding: AttributedValue<Decimal>,
        tradeCount: Int,
        maxDrawdown: AttributedValue<Decimal>?
    ) {
        self.botId = botId
        self.window = window
        self.realizedPnl = realizedPnl
        self.unrealizedPnl = unrealizedPnl
        self.fees = fees
        self.funding = funding
        self.tradeCount = tradeCount
        self.maxDrawdown = maxDrawdown
    }

    /// 净额：**任一分项不可归属，净额就不可归属**（不制造一个"看起来精确"的净额）。
    public var net: AttributedValue<Decimal> {
        guard let realized = realizedPnl.value,
              let unrealized = unrealizedPnl.value,
              let fee = fees.value,
              let fund = funding.value
        else {
            return .unattributable(reason: unattributableReason())
        }
        let confidence = weakestConfidence([realizedPnl.confidence, unrealizedPnl.confidence, fees.confidence, funding.confidence])
        let total = realized + unrealized - fee + fund
        switch confidence {
        case .exact: return .exact(total)
        case .partial: return .partial(total, coveredShare: 1)
        case .estimated: return .estimated(total, note: "由带估算的分项合成")
        case .unattributable: return .unattributable(reason: unattributableReason())
        }
    }

    private func unattributableReason() -> String {
        let notes = [realizedPnl, unrealizedPnl, fees, funding].compactMap { $0.note }
        return notes.first ?? "归属不明"
    }

    private func weakestConfidence(_ values: [AttributionConfidence]) -> AttributionConfidence {
        if values.contains(.unattributable) { return .unattributable }
        if values.contains(.estimated) { return .estimated }
        if values.contains(.partial) { return .partial }
        return .exact
    }
}

/// 账户绩效 -> 机器人绩效。共用账户 ⇒ 全部不可归属。
public enum PerformanceAttribution {
    public static func botMetrics(
        from account: AccountPerformance,
        context: AttributionContext,
        for bot: BotId
    ) -> PerformanceMetrics {
        let realized = BotLevelAttribution.fromAccount(account.realizedPnl, context: context, for: bot)
        let unrealized = BotLevelAttribution.fromAccount(account.unrealizedPnl, context: context, for: bot)
        let fees = BotLevelAttribution.fromAccount(account.fees, context: context, for: bot)
        let funding = BotLevelAttribution.fromAccount(account.funding, context: context, for: bot)
        let drawdown = account.maxDrawdown.map { BotLevelAttribution.fromAccount($0, context: context, for: bot) }
        return PerformanceMetrics(
            botId: bot,
            window: account.window,
            realizedPnl: realized,
            unrealizedPnl: unrealized,
            fees: fees,
            funding: funding,
            tradeCount: account.tradeCount,
            maxDrawdown: drawdown
        )
    }
}
