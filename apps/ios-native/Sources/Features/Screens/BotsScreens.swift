//
//  BotsScreens.swift
//  Features
//
//  机器人入口：列表 + 详情。
//  详情把「执行状态 / 依赖健康 / 数据可信度」分列，并把三种"看不到/已停止/无法判定"
//  渲染成**三种不同**的横幅 —— 这是冻结件 §7 的硬要求。
//

import SwiftUI

public struct BotsScreen: View {
    @Environment(\.themeColors) private var colors
    private let state: FeaturesState
    private let router: FeaturesRouter
    private let nowMs: Int
    private let timeZone: TimeZone
    private let dispatcher: FeatureActionDispatching

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
                if state.bots.isEmpty {
                    EmptyStateView(
                        title: "没有可显示的机器人",
                        message: state.emptyMessage ?? "观测快照里没有机器人。注意：这也可能是「App 看不到」，请看上面的连接状态。",
                        systemImage: "cpu"
                    )
                } else {
                    GroupHeader("机器人", count: state.bots.count)
                    ForEach(state.bots) { bot in
                        NavigationLink(value: FeatureRoute.bot(bot.id)) {
                            SectionCard {
                                BotRowView(bot: bot, nowMs: nowMs, timeZone: timeZone)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("查看机器人详情")
                    }
                }
                UpdatedAtFooter(atMs: state.overview.generatedAtMs, nowMs: nowMs, timeZone: timeZone, sourceId: state.overview.sourceId)
            }
            .padding(Theme.Space.m)
        }
        .background(colors.canvas)
        .navigationTitle("机器人")
    }
}

public struct BotDetailScreen: View {
    @Environment(\.themeColors) private var colors
    private let bot: BotPresentation
    private let nowMs: Int
    private let timeZone: TimeZone
    private let runtimeMode: RuntimeMode
    private let dispatcher: FeatureActionDispatching
    private let router: FeaturesRouter
    @State private var dispatchMessage: String?

    public init(bot: BotPresentation, nowMs: Int, timeZone: TimeZone, runtimeMode: RuntimeMode, dispatcher: FeatureActionDispatching, router: FeaturesRouter) {
        self.bot = bot
        self.nowMs = nowMs
        self.timeZone = timeZone
        self.runtimeMode = runtimeMode
        self.dispatcher = dispatcher
        self.router = router
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.Space.m) {
                stateBanner
                identityCard
                axesCard
                phaseCard
                dependencyCard
                decisionCard
                positionsCard
                ordersCard
                fillsCard
                timelineCard
                actionsCard
                UpdatedAtFooter(atMs: bot.generatedAtMs, nowMs: nowMs, timeZone: timeZone, sourceId: bot.sourceId)
            }
            .padding(Theme.Space.m)
        }
        .background(colors.canvas)
        .navigationTitle(bot.label)
    }

    // MARK: 状态横幅：三种"未知/停止/受限"互不相同

    @ViewBuilder
    private var stateBanner: some View {
        switch bot.state {
        case .unreachable, .unknownDisconnected:
            DisconnectedBanner(lastConfirmedAtMs: bot.lastConfirmedHealthyAtMs, nowMs: nowMs)
        case .unknownStale, .neverConfirmed, .indeterminateExecution, .unrecognizedExecutionState:
            StaleDataBanner(trustAxis: bot.axes.trust)
        case .runningRestricted:
            DependencyAnomalyBanner(issues: bot.dependencyIssues)
        case .stoppedConfirmed:
            NoticeBox(title: "机器人已停止", message: bot.state.explanation, tone: .neutral, systemImage: "stop.circle.fill")
        case .paused:
            NoticeBox(title: "机器人已暂停", message: bot.state.explanation, tone: .warning, systemImage: "pause.circle.fill")
        case .faulted:
            NoticeBox(title: "机器人故障", message: bot.state.explanation, tone: .critical, systemImage: "xmark.octagon.fill")
        case .starting, .operational, .stopping:
            NoticeBox(title: bot.state.label, message: bot.state.explanation, tone: bot.state.tone, systemImage: bot.state.systemImage)
        }
    }

    // MARK: 身份三件套

    private var identityCard: some View {
        SectionCard("身份（稳定身份 / 策略版本 / 运行实例）", subtitle: "三者可区分：重启换实例、调参换版本，都不等于换机器人。") {
            InfoRow("稳定身份", value: FeaturesFormatter.text(bot.identity.botLabel ?? bot.identity.botId), tone: .neutral, systemImage: "person.text.rectangle")
            InfoRow("策略版本", value: FeaturesFormatter.text(bot.identity.strategyLabel), tone: .neutral, systemImage: "doc.text")
            InfoRow("版本哈希", value: FeaturesFormatter.text(bot.identity.strategyHash), tone: .neutral)
            InfoRow("运行实例", value: FeaturesFormatter.text(bot.identity.runLabel), tone: .neutral, systemImage: "play.circle")
            InfoRow("实例主机", value: FeaturesFormatter.text(bot.identity.runHost), tone: .neutral)
        }
    }

    private var axesCard: some View {
        SectionCard("三维状态", subtitle: "执行状态 / 依赖健康 / 数据可信度分列，互不顶替。") {
            StateAxesView(bot.axes, showsTitles: false)
            if let detail = bot.stateDetail {
                InfoRow("最后确认", value: detail, tone: .neutral)
            }
        }
    }

    private var phaseCard: some View {
        SectionCard("当前阶段与等待原因") {
            InfoRow("当前阶段", value: FeaturesFormatter.text(bot.phase), tone: .neutral, systemImage: "point.topleft.down.curvedto.point.bottomright.up")
            InfoRow("等待原因", value: FeaturesFormatter.text(bot.waitReason), tone: bot.waitReason == nil ? .unknown : .warning, systemImage: "hourglass")
        }
    }

    private var dependencyCard: some View {
        SectionCard("依赖健康") {
            if bot.dependencyIssues.isEmpty {
                Text("没有已知的依赖异常。").font(.footnote).foregroundStyle(colors.secondaryText)
            } else {
                ForEach(bot.dependencyIssues, id: \.self) { issue in
                    InfoRow("异常", value: issue, tone: .warning, systemImage: "exclamationmark.triangle")
                }
            }
        }
    }

    private var decisionCard: some View {
        SectionCard("决策摘要") {
            if let summary = bot.decisionSummary {
                Text(summary).font(.subheadline).foregroundStyle(colors.primaryText).fixedSize(horizontal: false, vertical: true)
            } else {
                Text("决策摘要未知（服务端未下发）。").font(.footnote).foregroundStyle(colors.secondaryText)
            }
            if let blocked = bot.decisionBlockedReason {
                InfoRow("未执行原因", value: blocked, tone: .warning, systemImage: "nosign")
            }
        }
    }

    private var positionsCard: some View {
        SectionCard("持仓", subtitle: "归因不可靠时如实标注，不制造精确数字。") {
            RenderedOrNotice(rendersData: bot.rendersData, notice: bot.notice, trustAxis: bot.axes.trust) {
                if bot.positions.isEmpty {
                    Text("没有持仓（或服务端未下发）。").font(.footnote).foregroundStyle(colors.secondaryText)
                } else {
                    ForEach(bot.positions) { position in
                        PositionRowView(position: position)
                        Divider().overlay(colors.separator)
                    }
                }
            }
        }
    }

    private var ordersCard: some View {
        SectionCard("活动订单") {
            RenderedOrNotice(rendersData: bot.rendersData, notice: bot.notice, trustAxis: bot.axes.trust) {
                if bot.orders.isEmpty {
                    Text("没有活动订单（或服务端未下发）。").font(.footnote).foregroundStyle(colors.secondaryText)
                } else {
                    ForEach(bot.orders) { order in
                        NavigationLink(value: FeatureRoute.order(order.id)) {
                            OrderRowView(order: order, timeZone: timeZone)
                        }
                        .buttonStyle(.plain)
                        Divider().overlay(colors.separator)
                    }
                }
            }
        }
    }

    private var fillsCard: some View {
        SectionCard("最近成交") {
            if bot.recentFills.isEmpty {
                Text("成交数据未知（服务端未提供成交面）。")
                    .font(.footnote)
                    .foregroundStyle(colors.secondaryText)
            } else {
                ForEach(bot.recentFills) { fill in
                    InfoRow(
                        (fill.symbol ?? "标的神秘") + " " + (fill.side ?? ""),
                        value: FeaturesFormatter.text(fill.quantity) + " @ " + FeaturesFormatter.text(fill.price),
                        tone: .neutral
                    )
                }
            }
        }
    }

    private var timelineCard: some View {
        SectionCard("运行时间线") {
            if bot.timeline.isEmpty {
                Text("时间线未知（服务端未下发事件）。").font(.footnote).foregroundStyle(colors.secondaryText)
            } else {
                ForEach(bot.timeline) { event in
                    EventRowView(event: event, timeZone: timeZone)
                }
            }
        }
    }

    private var actionsCard: some View {
        SectionCard("可用动作") {
            if !bot.rendersData {
                Text("数据不可信时不派发动作。").font(.footnote).foregroundStyle(colors.secondaryText)
            } else {
                EnvironmentBadge(runtimeMode)
                ActionList(
                    actions: bot.actions,
                    isBusy: false,
                    runtimeMode: runtimeMode,
                    onAction: { action in
                        Task { @MainActor in
                            let outcome = await dispatcher.dispatch(action)
                            dispatchMessage = outcome.message
                        }
                    }
                )
                if let dispatchMessage {
                    Text(dispatchMessage).font(.caption2).foregroundStyle(colors.secondaryText)
                }
            }
        }
    }
}
