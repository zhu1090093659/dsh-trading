//
//  AssetsScreens.swift
//  Features
//
//  资产与交易入口：账户权益/可用/保证金、已实现与未实现盈亏、成本项、持仓、
//  订单全生命周期（含部分成交 / 撤单处理中 / 结果未知）、资金变动、机器人归属。
//
//  只做观测：**没有下单入口**（产品定位：不做手动下单面板）。
//

import SwiftUI

public struct AssetsScreen: View {
    @Environment(\.themeColors) private var colors
    private let state: FeaturesState
    private let router: FeaturesRouter
    private let nowMs: Int
    private let timeZone: TimeZone
    private let dispatcher: FeatureActionDispatching
    @State private var orderFilter: OrderFilter = .all

    public init(state: FeaturesState, router: FeaturesRouter, nowMs: Int, timeZone: TimeZone, dispatcher: FeatureActionDispatching) {
        self.state = state
        self.router = router
        self.nowMs = nowMs
        self.timeZone = timeZone
        self.dispatcher = dispatcher
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.Space.m) {
                ConnectionHeader(connection: state.connection, runtimeMode: state.runtimeMode, nowMs: nowMs, timeZone: timeZone)
                summaryCard
                positionsCard
                ordersCard
                fillsCard
                cashMovementsCard
                UpdatedAtFooter(atMs: state.assets.generatedAtMs, nowMs: nowMs, timeZone: timeZone, sourceId: state.assets.sourceId)
            }
            .padding(Theme.Space.m)
        }
        .background(colors.canvas)
        .navigationTitle("资产与交易")
    }

    private var summaryCard: some View {
        SectionCard("账户", subtitle: "这是观测快照；账户级数字不等于单个机器人的业绩。") {
            if let summary = state.assets.summary {
                RenderedOrNotice(rendersData: summary.rendersData, notice: summary.notice, trustAxis: summary.axes.trust) {
                    VStack(alignment: .leading, spacing: Theme.Space.xs) {
                        InfoRow("权益", value: FeaturesFormatter.text(summary.equity), tone: .neutral, systemImage: "banknote")
                        InfoRow("可用", value: FeaturesFormatter.text(summary.available), tone: .neutral)
                        InfoRow("保证金", value: FeaturesFormatter.text(summary.margin), tone: .neutral)
                        InfoRow("已实现盈亏", value: FeaturesFormatter.text(summary.realizedPnl), tone: .neutral)
                        InfoRow("未实现盈亏", value: FeaturesFormatter.text(summary.unrealizedPnl), tone: .neutral)
                        InfoRow("币种", value: FeaturesFormatter.text(summary.currency), tone: .neutral)
                        if !summary.costs.isEmpty {
                            Divider().overlay(colors.separator)
                            Text("成本项").font(.caption.weight(.semibold)).foregroundStyle(colors.secondaryText)
                            ForEach(summary.costs) { cost in
                                InfoRow(cost.label, value: FeaturesFormatter.text(cost.value) + (cost.unit ?? ""), tone: .neutral)
                            }
                        }
                        StateAxesView(summary.axes, showsTitles: false)
                    }
                }
            } else {
                Text("账户汇总未知（服务端未提供资产面）。")
                    .font(.footnote)
                    .foregroundStyle(colors.secondaryText)
            }
        }
    }

    private var positionsCard: some View {
        SectionCard("持仓", subtitle: "多机器人共用账户时，归属不可靠会如实标注。") {
            if state.assets.positions.isEmpty {
                Text("没有持仓（或服务端未下发）。").font(.footnote).foregroundStyle(colors.secondaryText)
            } else {
                ForEach(state.assets.positions) { position in
                    PositionRowView(position: position)
                    Divider().overlay(colors.separator)
                }
            }
        }
    }

    private var ordersCard: some View {
        SectionCard("订单", subtitle: "含部分成交、撤单处理中、结果未知等中间态。") {
            Picker("筛选", selection: $orderFilter) {
                ForEach(OrderFilter.allCases) { filter in
                    Text(filter.label).tag(filter)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("订单状态筛选")
            let filtered = state.assets.orders.filter(orderFilter.matches)
            if filtered.isEmpty {
                Text("此筛选下没有订单。").font(.footnote).foregroundStyle(colors.secondaryText)
            } else {
                ForEach(filtered) { order in
                    NavigationLink(value: FeatureRoute.order(order.id)) {
                        OrderRowView(order: order, timeZone: timeZone)
                    }
                    .buttonStyle(.plain)
                    Divider().overlay(colors.separator)
                }
            }
        }
    }

    private var fillsCard: some View {
        SectionCard("最近成交") {
            if state.assets.fills.isEmpty {
                Text("成交数据未知（服务端未提供成交面）。")
                    .font(.footnote)
                    .foregroundStyle(colors.secondaryText)
            } else {
                ForEach(state.assets.fills) { fill in
                    VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                        InfoRow(
                            (fill.symbol ?? "标的神秘") + " " + (fill.side ?? ""),
                            value: FeaturesFormatter.text(fill.quantity) + " @ " + FeaturesFormatter.text(fill.price),
                            tone: .neutral
                        )
                        if let atMs = fill.atMs {
                            Text(FeaturesFormatter.clock(atMs, timeZone: timeZone) ?? "")
                                .font(.caption2).foregroundStyle(colors.secondaryText)
                        }
                    }
                }
            }
        }
    }

    private var cashMovementsCard: some View {
        SectionCard("资金变动") {
            if state.assets.cashMovements.isEmpty {
                Text("资金变动数据未知（服务端未提供）。")
                    .font(.footnote)
                    .foregroundStyle(colors.secondaryText)
            } else {
                ForEach(state.assets.cashMovements) { movement in
                    InfoRow(
                        movement.label,
                        value: FeaturesFormatter.text(movement.amount) + (movement.unit ?? ""),
                        tone: .neutral
                    )
                }
            }
        }
    }
}

/// 订单筛选：分组刻意按「是否还有悬念」而不是按内部状态机枚举 —— 用户关心的是
/// 还有没有未落定的事（部分成交 / 撤单处理中 / 结果未知都在这一组）。
public enum OrderFilter: String, Sendable, Hashable, CaseIterable, Identifiable {
    case all
    case awaiting
    case filled
    case terminal

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .all: return "全部"
        case .awaiting: return "未落定"
        case .filled: return "已成交"
        case .terminal: return "已终结"
        }
    }

    public func matches(_ order: OrderPresentation) -> Bool {
        switch self {
        case .all: return true
        case .awaiting: return order.stage.isAwaiting
        case .filled:
            if case .filled = order.stage { return true }
            return false
        case .terminal:
            switch order.stage {
            case .filled, .canceled, .rejected, .expired, .neverArrived: return true
            case .submitted, .partiallyFilled, .cancelPending, .cancelling, .submittedUnknown, .unknownState: return false
            }
        }
    }
}

public struct OrderDetailScreen: View {
    @Environment(\.themeColors) private var colors
    private let order: OrderPresentation
    private let nowMs: Int
    private let timeZone: TimeZone
    private let runtimeMode: RuntimeMode
    private let router: FeaturesRouter

    public init(order: OrderPresentation, nowMs: Int, timeZone: TimeZone, runtimeMode: RuntimeMode, router: FeaturesRouter) {
        self.order = order
        self.nowMs = nowMs
        self.timeZone = timeZone
        self.runtimeMode = runtimeMode
        self.router = router
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.Space.m) {
                SectionCard("订单 " + order.id) {
                    EnvironmentBadge(runtimeMode)
                    RenderedOrNotice(rendersData: order.rendersData, notice: order.notice, trustAxis: order.axes.trust) {
                        VStack(alignment: .leading, spacing: Theme.Space.xs) {
                            InfoRow("标的", value: FeaturesFormatter.text(order.symbol), tone: .neutral)
                            InfoRow("方向", value: FeaturesFormatter.text(order.side), tone: .neutral)
                            InfoRow("价格", value: FeaturesFormatter.text(order.price), tone: .neutral)
                            InfoRow("数量", value: FeaturesFormatter.text(order.quantity), tone: .neutral)
                            InfoRow("已成交", value: FeaturesFormatter.text(order.filledQuantity), tone: .neutral)
                            InfoRow("状态", value: order.stage.label, tone: order.stage.tone, systemImage: "arrow.triangle.2.circlepath")
                            if let stateSinceMs = order.stateSinceMs {
                                InfoRow("此状态自", value: FeaturesFormatter.clock(stateSinceMs, timeZone: timeZone) ?? "未知", tone: .neutral)
                            }
                            if let attribution = order.attribution {
                                InfoRow("机器人归属", value: attribution, tone: .neutral)
                            } else {
                                InfoRow("机器人归属", value: "未知（服务端未给出）", tone: .unknown)
                            }
                            StateAxesView(order.axes, showsTitles: false)
                        }
                    }
                }
                if !order.fallbackText.isEmpty {
                    SectionCard("服务端兜底文本", subtitle: "协议要求每张卡片都能在客户端不会渲染时退化成纯文本。") {
                        Text(order.fallbackText).font(.footnote).foregroundStyle(colors.secondaryText).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if !order.actions.isEmpty {
                    SectionCard("可用动作") {
                        ActionList(actions: order.actions, isBusy: false, runtimeMode: runtimeMode) { _ in }
                    }
                }
                UpdatedAtFooter(atMs: nil, nowMs: nowMs, timeZone: timeZone)
            }
            .padding(Theme.Space.m)
        }
        .background(colors.canvas)
        .navigationTitle("订单详情")
    }
}

public struct AccountDetailScreen: View {
    @Environment(\.themeColors) private var colors
    private let accountId: String
    private let state: FeaturesState
    private let nowMs: Int
    private let timeZone: TimeZone

    public init(accountId: String, state: FeaturesState, nowMs: Int, timeZone: TimeZone) {
        self.accountId = accountId
        self.state = state
        self.nowMs = nowMs
        self.timeZone = timeZone
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.Space.m) {
                SectionCard("账户 " + accountId) {
                    Text("账户级数字属于整台执行核；多机器人共用账户时，单个机器人的收益/持仓不能简单照搬这些数字。")
                        .font(.footnote)
                        .foregroundStyle(colors.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                    if let summary = state.assets.summary {
                        InfoRow("权益", value: FeaturesFormatter.text(summary.equity), tone: .neutral)
                        InfoRow("可见性", value: summary.rendersData ? "可信（本次快照）" : "不可信（已隐藏）", tone: summary.rendersData ? .positive : .unknown)
                    } else {
                        InfoRow("权益", value: "未知（服务端未提供）", tone: .unknown)
                    }
                }
                SectionCard("同一账户下的机器人") {
                    ForEach(state.bots) { bot in
                        InfoRow(bot.label, value: bot.state.label, tone: bot.state.tone)
                    }
                }
                UpdatedAtFooter(atMs: state.overview.generatedAtMs, nowMs: nowMs, timeZone: timeZone, sourceId: state.overview.sourceId)
            }
            .padding(Theme.Space.m)
        }
        .background(colors.canvas)
        .navigationTitle("账户详情")
    }
}
