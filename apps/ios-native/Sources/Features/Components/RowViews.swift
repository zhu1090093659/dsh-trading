//
//  RowViews.swift
//  Features
//
//  列表行（告警 / 事件 / 机器人 / 订单 / 持仓）。全部只吃呈现层模型。
//
//  告警行刻意把「已读 / 已确认 / 已恢复」做成**三个并列且独立的判断**：
//  用户确认过不等于故障恢复了 —— 合成一个状态机就会把这两件事一起丢掉。
//

import SwiftUI

// MARK: - 告警行

public struct AlertRowView: View {
    @Environment(\.themeColors) private var colors
    private let alert: AlertPresentation
    private let nowMs: Int
    private let timeZone: TimeZone
    private let compact: Bool

    public init(alert: AlertPresentation, nowMs: Int, timeZone: TimeZone, compact: Bool = false) {
        self.alert = alert
        self.nowMs = nowMs
        self.timeZone = timeZone
        self.compact = compact
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(spacing: Theme.Space.xs) {
                StatusPill(alert.severity.label, tone: alert.severity.tone, systemImage: alert.severity.systemImage)
                if let aggregation = alert.lifecycle.aggregationLabel {
                    StatusPill(aggregation, tone: .warning, systemImage: "arrow.triangle.2.circlepath")
                }
                Spacer(minLength: 0)
            }
            Text(alert.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(colors.primaryText)
                .fixedSize(horizontal: false, vertical: true)
            lifecycleRow
            if !compact {
                timeRow
                if let reason = alert.reason {
                    InfoRow("原因", value: reason, tone: .neutral)
                }
                if let impact = alert.impact {
                    InfoRow("影响", value: impact, tone: .warning)
                }
            }
            if let bot = alert.relatedBot {
                Text("关联 " + bot.label)
                    .font(.caption2)
                    .foregroundStyle(colors.secondaryText)
            }
        }
        .padding(.vertical, Theme.Space.xxs)
        .accessibilityElement(children: .contain)
    }

    /// 三个独立状态并排 —— 这是本页最重要的一处排版。
    private var lifecycleRow: some View {
        HStack(spacing: Theme.Space.xxs) {
            independentStatePill("已读", value: alert.lifecycle.isRead, tone: .neutral)
            independentStatePill("已确认", value: alert.lifecycle.isAcknowledged, tone: .info)
            independentStatePill("已恢复", value: alert.lifecycle.isRecovered, tone: .positive)
        }
        .accessibilityElement(children: .contain)
    }

    private func independentStatePill(_ label: String, value: Bool?, tone: ThemeTone) -> some View {
        let text: String
        let pillTone: ThemeTone
        switch value {
        case .some(true):
            text = label
            pillTone = tone
        case .some(false):
            text = "未" + label
            pillTone = .unknown
        case .none:
            text = label + "未知"
            pillTone = .unknown
        }
        return StatusPill(text, tone: pillTone)
    }

    private var timeRow: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
            InfoRow("首次出现", value: FeaturesFormatter.clock(alert.lifecycle.firstSeenMs, timeZone: timeZone) ?? "未知", tone: .neutral)
            InfoRow("最近出现", value: FeaturesFormatter.clock(alert.lifecycle.lastSeenMs, timeZone: timeZone) ?? "未知", tone: .neutral)
            InfoRow("恢复时间", value: FeaturesFormatter.clock(alert.lifecycle.recoveredAtMs, timeZone: timeZone) ?? "未知", tone: .neutral)
        }
    }
}

// MARK: - 事件行

public struct EventRowView: View {
    @Environment(\.themeColors) private var colors
    private let event: EventPresentation
    private let timeZone: TimeZone

    public init(event: EventPresentation, timeZone: TimeZone) {
        self.event = event
        self.timeZone = timeZone
    }

    public var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.s) {
            Circle()
                .fill(event.tone.color(colors))
                .frame(width: Theme.Space.xs, height: Theme.Space.xs)
                .padding(.top, Theme.Space.xxs)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                HStack(spacing: Theme.Space.xs) {
                    Text(FeaturesFormatter.clock(event.atMs, timeZone: timeZone) ?? "时间未知")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(colors.secondaryText)
                    Text(event.kind).font(.caption2).foregroundStyle(colors.secondaryText)
                }
                Text(event.title).font(.subheadline).foregroundStyle(colors.primaryText)
                if let detail = event.detail {
                    Text(detail).font(.caption2).foregroundStyle(colors.secondaryText).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - 机器人行

public struct BotRowView: View {
    @Environment(\.themeColors) private var colors
    private let bot: BotPresentation
    private let nowMs: Int
    private let timeZone: TimeZone

    public init(bot: BotPresentation, nowMs: Int, timeZone: TimeZone) {
        self.bot = bot
        self.nowMs = nowMs
        self.timeZone = timeZone
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(spacing: Theme.Space.xs) {
                Text(bot.label).font(.headline).foregroundStyle(colors.primaryText)
                Spacer(minLength: 0)
                StatusPill(bot.state.label, tone: bot.state.tone, systemImage: bot.state.systemImage)
            }
            HStack(spacing: Theme.Space.xxs) {
                ForEach(bot.axes.all, id: \.title) { axis in
                    StatusPill(axis.title + "：" + axis.value, tone: axis.tone, systemImage: axis.systemImage)
                }
            }
            if let phase = bot.phase {
                InfoRow("当前阶段", value: phase, tone: .neutral)
            }
            if let wait = bot.waitReason {
                InfoRow("等待原因", value: wait, tone: .warning)
            }
            if !bot.dependencyIssues.isEmpty {
                Text("依赖异常：" + bot.dependencyIssues.joined(separator: "、"))
                    .font(.caption2)
                    .foregroundStyle(colors.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: Theme.Space.s) {
                Text("持仓 " + FeaturesFormatter.count(bot.positionCount))
                    .font(.caption2).foregroundStyle(colors.secondaryText)
                Text("活动订单 " + FeaturesFormatter.count(bot.activeOrderCount))
                    .font(.caption2).foregroundStyle(colors.secondaryText)
            }
        }
        .padding(.vertical, Theme.Space.xxs)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - 订单行

public struct OrderRowView: View {
    @Environment(\.themeColors) private var colors
    private let order: OrderPresentation
    private let timeZone: TimeZone

    public init(order: OrderPresentation, timeZone: TimeZone) {
        self.order = order
        self.timeZone = timeZone
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(spacing: Theme.Space.xs) {
                Text(order.symbol ?? "标的神秘").font(.subheadline.weight(.semibold)).foregroundStyle(colors.primaryText)
                Text(order.side ?? "方向未知").font(.caption).foregroundStyle(colors.secondaryText)
                Spacer(minLength: 0)
                StatusPill(order.stage.label, tone: order.stage.tone)
            }
            HStack(spacing: Theme.Space.s) {
                Text("数量 " + FeaturesFormatter.text(order.quantity))
                    .font(.caption2).foregroundStyle(colors.secondaryText)
                Text("已成交 " + FeaturesFormatter.text(order.filledQuantity))
                    .font(.caption2).foregroundStyle(colors.secondaryText)
                Text("价格 " + FeaturesFormatter.text(order.price))
                    .font(.caption2).foregroundStyle(colors.secondaryText)
            }
            if let stateSinceMs = order.stateSinceMs {
                Text("此状态自 " + (FeaturesFormatter.clock(stateSinceMs, timeZone: timeZone) ?? "未知") + " 起")
                    .font(.caption2).foregroundStyle(colors.secondaryText)
            }
            if let attribution = order.attribution {
                Text("归属 " + attribution).font(.caption2).foregroundStyle(colors.secondaryText)
            }
        }
        .padding(.vertical, Theme.Space.xxs)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - 持仓行

public struct PositionRowView: View {
    @Environment(\.themeColors) private var colors
    private let position: PositionPresentation

    public init(position: PositionPresentation) {
        self.position = position
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(spacing: Theme.Space.xs) {
                Text(position.symbol ?? "标的神秘").font(.subheadline.weight(.semibold)).foregroundStyle(colors.primaryText)
                Text(position.side ?? "方向未知").font(.caption).foregroundStyle(colors.secondaryText)
                Spacer(minLength: 0)
                StatusPill("盈亏 " + FeaturesFormatter.text(position.pnl), tone: pnlTone, systemImage: "chart.bar")
            }
            HStack(spacing: Theme.Space.s) {
                Text("数量 " + FeaturesFormatter.text(position.quantity))
                    .font(.caption2).foregroundStyle(colors.secondaryText)
                Text("开仓价 " + FeaturesFormatter.text(position.entryPrice))
                    .font(.caption2).foregroundStyle(colors.secondaryText)
            }
            attributionRow
        }
        .padding(.vertical, Theme.Space.xxs)
        .accessibilityElement(children: .contain)
    }

    private var pnlTone: ThemeTone { .neutral }

    /// 归因：多机器人共用账户时**不照搬账户数字**；不可靠就如实说不可靠。
    @ViewBuilder
    private var attributionRow: some View {
        if position.isAttributionReliable, let attribution = position.attribution {
            Text("归因：" + attribution).font(.caption2).foregroundStyle(colors.secondaryText)
        } else if let attribution = position.attribution {
            Text("归因（不可靠）：" + attribution + " —— 多机器人共用账户时归属无法精确判定，此处不作为精确数字使用。")
                .font(.caption2)
                .foregroundStyle(colors.warning)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Text("归因：未知（服务端未给出机器人归属）")
                .font(.caption2)
                .foregroundStyle(colors.secondaryText)
        }
    }
}
