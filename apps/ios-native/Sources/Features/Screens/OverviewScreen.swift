//
//  OverviewScreen.swift
//  Features
//
//  总览：**先看健康，再看收益**。
//  顺序是硬要求（冻结件 §7 + 卡片）：连接与更新时间 -> 健康分布 -> 异常数 -> 重要告警
//  -> 最近关键事件 -> 最后才是资产/净值/资金占用/风险暴露（明确标注为背景信息，
//  不作为"系统是否正常"的判据；健康异常时出现「收益不能证明系统正常」的横幅）。
//

import SwiftUI

public struct OverviewScreen: View {
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
                ConnectionHeader(
                    connection: state.overview.connection,
                    runtimeMode: state.runtimeMode,
                    nowMs: nowMs,
                    timeZone: timeZone
                )
                if !state.overview.rendersData {
                    RenderedOrNotice(
                        rendersData: false,
                        notice: state.overview.notice,
                        trustAxis: state.overview.axes.trust
                    ) { EmptyView() }
                    UpdatedAtFooter(
                        atMs: state.overview.generatedAtMs == 0 ? nil : state.overview.generatedAtMs,
                        nowMs: nowMs,
                        timeZone: timeZone,
                        sourceId: state.overview.sourceId,
                        prefix: ""
                    )
                } else {
                    healthCard
                    if let warning = state.overview.profitIsNotHealthWarning {
                        ProfitIsNotHealthBanner(text: warning)
                    }
                    importantAlertsCard
                    recentEventsCard
                    backgroundAssetsCard
                    UpdatedAtFooter(
                        atMs: state.overview.generatedAtMs,
                        nowMs: nowMs,
                        timeZone: timeZone,
                        sourceId: state.overview.sourceId,
                        prefix: ""
                    )
                }
            }
            .padding(Theme.Space.m)
        }
        .background(colors.canvas)
        .navigationTitle("总览")
    }

    // MARK: 健康分布（第一屏的重心）

    private var healthCard: some View {
        SectionCard("系统健康", subtitle: "先看这个：账户赚钱也可能有机器人失联。") {
            StateAxesView(state.overview.axes)
            Divider().overlay(colors.separator)
            if state.overview.totalBots == 0 {
                Text("没有观测到任何机器人 —— 这可能是「一台都没有」，也可能是「App 看不到」，请看连接状态。")
                    .font(.footnote)
                    .foregroundStyle(colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: Theme.Space.xs)], spacing: Theme.Space.xs) {
                    ForEach(state.overview.healthBuckets) { bucket in
                        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                            Text(String(bucket.count))
                                .font(.title3.weight(.bold))
                                .foregroundStyle(bucket.tone.color(colors))
                            Text(bucket.label)
                                .font(.caption2)
                                .foregroundStyle(colors.secondaryText)
                                .lineLimit(2)
                        }
                        .padding(Theme.Space.xs)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(bucket.tone.color(colors).opacity(0.10))
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.chip, style: .continuous))
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(bucket.label)
                        .accessibilityValue(String(bucket.count) + " 台")
                    }
                }
                HStack(spacing: Theme.Space.s) {
                    InfoRow("依赖异常", value: String(state.overview.dependencyAnomalyCount), tone: state.overview.dependencyAnomalyCount > 0 ? .warning : .positive, systemImage: "exclamationmark.shield")
                }
                HStack(spacing: Theme.Space.s) {
                    InfoRow("状态未知", value: String(state.overview.unknownCount), tone: state.overview.unknownCount > 0 ? .unknown : .positive, systemImage: "questionmark.circle")
                }
                Text("「状态未知」不等于「已停止」：前者是 App 看不到或数据不可信，后者是执行核确认停机。")
                    .font(.caption2)
                    .foregroundStyle(colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: 重要告警

    private var importantAlertsCard: some View {
        SectionCard("重要告警", subtitle: "按严重等级排序；「已确认」不等于「已恢复」。") {
            if state.overview.topAlerts.isEmpty {
                Text("当前没有重要告警。").font(.footnote).foregroundStyle(colors.secondaryText)
            } else {
                ForEach(state.overview.topAlerts) { alert in
                    Button {
                        router.openAlert(alert.id)
                    } label: {
                        AlertRowView(alert: alert, nowMs: nowMs, timeZone: timeZone, compact: true)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: 最近关键事件

    private var recentEventsCard: some View {
        SectionCard("最近关键事件") {
            if state.overview.recentEvents.isEmpty {
                Text("还没有可展示的事件（服务端未下发）。")
                    .font(.footnote)
                    .foregroundStyle(colors.secondaryText)
            } else {
                ForEach(state.overview.recentEvents) { event in
                    EventRowView(event: event, timeZone: timeZone)
                }
            }
        }
    }

    // MARK: 背景信息（收益）—— 明确不是健康判据

    private var backgroundAssetsCard: some View {
        SectionCard("资产概况（背景信息）", subtitle: "这些数字不能说明系统正常；健康请看上面的「系统健康」。") {
            if let assets = state.overview.assets {
                RenderedOrNotice(rendersData: assets.rendersData, notice: assets.notice, trustAxis: assets.axes.trust) {
                    VStack(alignment: .leading, spacing: Theme.Space.xs) {
                        InfoRow("总资产", value: FeaturesFormatter.text(assets.equity), tone: .neutral)
                        InfoRow("可用", value: FeaturesFormatter.text(assets.available), tone: .neutral)
                        InfoRow("保证金占用", value: FeaturesFormatter.text(assets.margin), tone: .neutral)
                        InfoRow("已实现盈亏", value: FeaturesFormatter.text(assets.realizedPnl), tone: .neutral)
                        InfoRow("未实现盈亏", value: FeaturesFormatter.text(assets.unrealizedPnl), tone: .neutral)
                        StateAxesView(assets.axes, showsTitles: false)
                    }
                }
            } else {
                Text("资产数据未知（服务端未提供）。")
                    .font(.footnote)
                    .foregroundStyle(colors.secondaryText)
            }
        }
    }
}
