//
//  Attribution.swift
//  Domain
//
//  多机器人共用账户时的**归因**。
//
//  规则只有一条，但它是硬规则：**账户级数字只有在"本机器人独占该账户且无外部成交"时
//  才等于机器人级数字**。共用账户时不许照搬，也不许用"按名义额比例摊"制造一个
//  看起来很精确的数字 —— 不制造精确数字，如实标注"不可归属"。
//

import Foundation

/// 归属可靠度。
public enum AttributionConfidence: String, ClosedEnumValue, CaseIterable, Sendable {
    /// 归属确切（独占账户，或有逐笔归属证据）。
    case exact
    /// 只覆盖一部分（其余不可归属）。
    case partial
    /// 估算（必须带说明；界面上要显示"约"与原因）。
    case estimated
    /// 不可归属（**不显示数字，只显示原因**）。
    case unattributable

    /// 穷尽 switch（无 default）。
    public var allowsPreciseDisplay: Bool {
        switch self {
        case .exact: return true
        case .partial, .estimated, .unattributable: return false
        }
    }
}

/// 账户的归属上下文：这个账户上还跑着谁、有没有非机器人来源的成交。
public struct AttributionContext: Hashable, Sendable {
    public let account: AccountRef
    public let botsOnAccount: [BotId]
    /// 手动单 / 其它系统 / 未标注来源的成交。
    public let hasManualOrExternalFlow: Bool

    public init(account: AccountRef, botsOnAccount: [BotId], hasManualOrExternalFlow: Bool) {
        self.account = account
        self.botsOnAccount = botsOnAccount
        self.hasManualOrExternalFlow = hasManualOrExternalFlow
    }
}

/// 归属质量。
public enum AttributionQuality: Hashable, Sendable {
    /// 账户只属于这一个机器人，且没有外部成交。
    case exclusive(bot: BotId)
    /// 账户被多个机器人/外部来源共用：**账户数字不能当作机器人数字**。
    case shared(bots: [BotId], externalFlow: Bool)

    /// 穷尽 switch（无 default）。
    public var allowsAccountNumbersOnBot: Bool {
        switch self {
        case .exclusive: return true
        case .shared: return false
        }
    }

    /// 穷尽 switch（无 default）。
    public var label: String {
        switch self {
        case let .exclusive(bot): return "归属确切（账户由机器人 " + bot.rawValue + " 独占）"
        case let .shared(bots, externalFlow):
            var text = "账户由 " + String(bots.count) + " 个机器人共用"
            if externalFlow { text += "，且存在手动/外部成交" }
            return text + "，账户级数字不能当作本机器人数字"
        }
    }
}

/// 一个带归属标注的值。
public enum AttributedValue<Value: Hashable & Sendable>: Hashable, Sendable {
    case exact(Value)
    case partial(Value, coveredShare: Double)
    case estimated(Value, note: String)
    case unattributable(reason: String)

    /// 可显示的数字；不可归属时为 nil（**不编**）。
    public var value: Value? {
        switch self {
        case let .exact(value): return value
        case let .partial(value, _): return value
        case let .estimated(value, _): return value
        case .unattributable: return nil
        }
    }

    /// 穷尽 switch（无 default）。
    public var confidence: AttributionConfidence {
        switch self {
        case .exact: return .exact
        case .partial: return .partial
        case .estimated: return .estimated
        case .unattributable: return .unattributable
        }
    }

    public var note: String? {
        switch self {
        case .exact: return nil
        case let .partial(_, share): return Self.coverageText(share)
        case let .estimated(_, note): return note
        case let .unattributable(reason): return reason
        }
    }

    /// 覆盖比例 -> 展示文本。**同一类数值陷阱的第二个落点**（审查 C4）：`coveredShare` 是
    /// 外部给的 Double，比例 -> 百分比的转换在 NaN / ±Inf / 极大值下是 trap 而不是可捕获错误。
    /// 判不出范围就不编一个百分比，如实说"比例未知"（宁可少说，不说错）。
    static func coverageText(_ share: Double) -> String {
        let percent = (share * 100).rounded()
        guard NumericRangeGuard.isRepresentable(percent) else { return "仅覆盖比例未知" }
        return "仅覆盖 " + String(Int(percent)) + "%"
    }
}

/// 从账户数字导出机器人级数字的唯一入口。
public enum BotLevelAttribution {
    /// 判定归属质量。
    public static func quality(of context: AttributionContext, for bot: BotId) -> AttributionQuality {
        let others = context.botsOnAccount.filter { $0 != bot }
        if others.isEmpty && !context.hasManualOrExternalFlow {
            return .exclusive(bot: bot)
        }
        return .shared(bots: context.botsOnAccount, externalFlow: context.hasManualOrExternalFlow)
    }

    /// 账户数字 -> 机器人数字。**共用账户时一律 unattributable**（不摊派、不照搬）。
    public static func fromAccount<Value: Hashable & Sendable>(
        _ accountValue: Value,
        context: AttributionContext,
        for bot: BotId
    ) -> AttributedValue<Value> {
        switch quality(of: context, for: bot) {
        case .exclusive:
            return .exact(accountValue)
        case let .shared(bots, externalFlow):
            var reason = "账户由 " + String(bots.count) + " 个机器人共用"
            if externalFlow { reason += "，且存在手动/外部成交" }
            reason += "：账户级数字不能当作本机器人数字"
            return .unattributable(reason: reason)
        }
    }

    /// 账户持仓 -> 机器人持仓。
    public static func botPosition(
        from accountPosition: AccountPosition,
        context: AttributionContext,
        for bot: BotId
    ) -> AttributedValue<BotPosition> {
        switch fromAccount(accountPosition, context: context, for: bot) {
        case let .exact(position):
            return .exact(BotPosition(
                botId: bot,
                runId: nil,
                symbol: position.symbol,
                quantity: position.quantity,
                averageCost: position.averageCost,
                markPrice: position.markPrice,
                unrealizedPnl: position.unrealizedPnl
            ))
        case let .unattributable(reason):
            return .unattributable(reason: reason)
        case let .partial(_, share):
            return .partial(
                BotPosition(botId: bot, runId: nil, symbol: accountPosition.symbol, quantity: accountPosition.quantity, averageCost: accountPosition.averageCost, markPrice: accountPosition.markPrice, unrealizedPnl: accountPosition.unrealizedPnl),
                coveredShare: share
            )
        case let .estimated(_, note):
            return .estimated(
                BotPosition(botId: bot, runId: nil, symbol: accountPosition.symbol, quantity: accountPosition.quantity, averageCost: accountPosition.averageCost, markPrice: accountPosition.markPrice, unrealizedPnl: accountPosition.unrealizedPnl),
                note: note
            )
        }
    }
}

/// 归属值的显示文本。**不可归属时不产生任何数字**。
public enum AttributedDisplay {
    public static func text<Value: Hashable & Sendable>(
        _ attributed: AttributedValue<Value>,
        format: (Value) -> String
    ) -> String {
        switch attributed {
        case let .exact(value):
            return format(value)
        case let .partial(value, share):
            return format(value) + "（" + AttributedValue<Value>.coverageText(share) + "）"
        case let .estimated(value, note):
            return "约 " + format(value) + "（估算：" + note + "）"
        case let .unattributable(reason):
            return "不可归属：" + reason
        }
    }
}
