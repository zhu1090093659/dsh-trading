//
//  AlertsScreens.swift
//  Features
//
//  告警与事件入口。三条硬要求：
//    1. **重复异常聚合**（同一异常重复出现 -> 显示次数与首次/最近时间）；
//    2. **「用户已确认」!=「故障已恢复」** —— 已读/已确认/已恢复是三个独立状态；
//    3. **保留历史可追溯** —— 详情里给出首次/最近/恢复时间与关联机器人/账户/订单/原因。
//

import SwiftUI

public struct AlertsScreen: View {
    @Environment(\.themeColors) private var colors
    private let state: FeaturesState
    private let router: FeaturesRouter
    private let nowMs: Int
    private let timeZone: TimeZone
    private let dispatcher: FeatureActionDispatching
    @State private var severityFilter: AlertSeverityFilter = .all
    @State private var showsRecovered = true

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
                NoticeBox(
                    title: "「已确认」不等于「已恢复」",
                    message: "已读 / 已确认 / 已恢复是三个独立状态：人可以确认自己看到了，但故障是否恢复只有服务端能说。",
                    tone: .info,
                    systemImage: "rectangle.3.group"
                )
                filterBar
                let visible = filtered
                if visible.isEmpty {
                    EmptyStateView(title: "这个筛选下没有告警", message: "换一个严重等级或显示已恢复项。", systemImage: "bell.slash")
                } else {
                    ForEach(visible) { alert in
                        NavigationLink(value: FeatureRoute.alert(alert.id)) {
                            SectionCard {
                                AlertRowView(alert: alert, nowMs: nowMs, timeZone: timeZone, compact: true)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                UpdatedAtFooter(atMs: state.overview.generatedAtMs, nowMs: nowMs, timeZone: timeZone, sourceId: state.overview.sourceId)
            }
            .padding(Theme.Space.m)
        }
        .background(colors.canvas)
        .navigationTitle("告警与事件")
    }

    private var filterBar: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            Picker("严重等级", selection: $severityFilter) {
                ForEach(AlertSeverityFilter.allCases) { filter in
                    Text(filter.label).tag(filter)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("按严重等级筛选告警")
            Toggle("显示已恢复项", isOn: $showsRecovered)
                .font(.footnote)
            Text("默认保留已恢复项，便于对照历史；关闭只是暂时隐藏，**不会删除历史**。")
                .font(.caption2)
                .foregroundStyle(colors.secondaryText)
        }
    }

    private var filtered: [AlertPresentation] {
        state.alerts
            .filter { severityFilter.matches($0.severity) }
            .filter { showsRecovered || $0.lifecycle.isRecovered != true }
            .sorted { left, right in
                if left.severity.rank != right.severity.rank { return left.severity.rank > right.severity.rank }
                return (left.lifecycle.lastSeenMs ?? 0) > (right.lifecycle.lastSeenMs ?? 0)
            }
    }
}

public enum AlertSeverityFilter: String, Sendable, Hashable, CaseIterable, Identifiable {
    case all
    case critical
    case warning
    case info

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .all: return "全部"
        case .critical: return "严重"
        case .warning: return "警告"
        case .info: return "提示"
        }
    }

    public func matches(_ severity: AlertSeverity) -> Bool {
        switch self {
        case .all: return true
        case .critical: return severity.rank == 3
        case .warning: return severity.rank == 2
        case .info: return severity.rank == 1 || severity.rank == 0
        }
    }
}

public struct AlertDetailScreen: View {
    @Environment(\.themeColors) private var colors
    private let alert: AlertPresentation
    private let nowMs: Int
    private let timeZone: TimeZone
    private let runtimeMode: RuntimeMode
    private let router: FeaturesRouter
    private let dispatcher: FeatureActionDispatching
    @State private var dispatchMessage: String?

    public init(alert: AlertPresentation, nowMs: Int, timeZone: TimeZone, runtimeMode: RuntimeMode, router: FeaturesRouter, dispatcher: FeatureActionDispatching) {
        self.alert = alert
        self.nowMs = nowMs
        self.timeZone = timeZone
        self.runtimeMode = runtimeMode
        self.router = router
        self.dispatcher = dispatcher
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.Space.m) {
                SectionCard(alert.title) {
                    EnvironmentBadge(runtimeMode)
                    HStack(spacing: Theme.Space.xs) {
                        StatusPill(alert.severity.label, tone: alert.severity.tone, systemImage: alert.severity.systemImage)
                        if let aggregation = alert.lifecycle.aggregationLabel {
                            StatusPill(aggregation, tone: .warning, systemImage: "arrow.triangle.2.circlepath")
                        }
                    }
                    Text(alert.fallbackText)
                        .font(.footnote)
                        .foregroundStyle(colors.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                lifecycleCard
                traceCard
                if alert.reason != nil || alert.impact != nil {
                    SectionCard("原因与影响") {
                        InfoRow("原因", value: FeaturesFormatter.text(alert.reason), tone: .neutral)
                        InfoRow("影响", value: FeaturesFormatter.text(alert.impact), tone: .warning)
                    }
                }
                historyCard
                actionsCard
                UpdatedAtFooter(atMs: nil, nowMs: nowMs, timeZone: timeZone)
            }
            .padding(Theme.Space.m)
        }
        .background(colors.canvas)
        .navigationTitle("告警详情")
    }

    private var lifecycleCard: some View {
        SectionCard("状态（三个独立维度）", subtitle: "已读 / 已确认 / 已恢复 互不顶替。") {
            InfoRow("已读", value: FeaturesFormatter.bool(alert.lifecycle.isRead), tone: .neutral, systemImage: "envelope.open")
            InfoRow("已确认", value: FeaturesFormatter.bool(alert.lifecycle.isAcknowledged), tone: .neutral, systemImage: "hand.thumbsup")
            InfoRow("已恢复", value: FeaturesFormatter.bool(alert.lifecycle.isRecovered), tone: .neutral, systemImage: "checkmark.seal")
            Divider().overlay(colors.separator)
            InfoRow("首次出现", value: FeaturesFormatter.clock(alert.lifecycle.firstSeenMs, timeZone: timeZone) ?? "未知", tone: .neutral)
            InfoRow("最近出现", value: FeaturesFormatter.clock(alert.lifecycle.lastSeenMs, timeZone: timeZone) ?? "未知", tone: .neutral)
            InfoRow("恢复时间", value: FeaturesFormatter.clock(alert.lifecycle.recoveredAtMs, timeZone: timeZone) ?? "未知", tone: .neutral)
        }
    }

    private var traceCard: some View {
        SectionCard("关联对象（点开即到）") {
            TraceChips(links: traceLinks) { link in
                router.navigate(link.target)
            }
        }
    }

    private var traceLinks: [TraceLinkPresentation] {
        var links: [TraceLinkPresentation] = []
        if let bot = alert.relatedBot { links.append(bot) }
        if let account = alert.relatedAccount { links.append(account) }
        if let order = alert.relatedOrder { links.append(order) }
        return links
    }

    private var historyCard: some View {
        SectionCard("历史可追溯", subtitle: "重复异常聚合：同一异常的重复次数与首末时间。") {
            InfoRow("重复次数", value: FeaturesFormatter.count(alert.lifecycle.repeatCount), tone: .neutral)
            if let first = alert.lifecycle.firstSeenMs, let last = alert.lifecycle.lastSeenMs, last >= first {
                InfoRow("持续", value: FeaturesFormatter.relativeAge(atMs: first, nowMs: last), tone: .neutral)
            }
            Text("历史不因「已确认」而消失；确认只是记录人看过，不改变故障事实。")
                .font(.caption2)
                .foregroundStyle(colors.secondaryText)
        }
    }

    private var actionsCard: some View {
        SectionCard("可用动作") {
            if !alert.operable {
                NoticeBox(
                    title: "此卡片不可操作",
                    message: alert.unknownEnumReason ?? "含本客户端不认识的取值（未知 closed 枚举 ⇒ 禁用全部动作，只显示兜底文本）。",
                    tone: .unknown,
                    systemImage: "lock"
                )
            }
            ActionList(actions: alert.actions, isBusy: false, runtimeMode: runtimeMode) { action in
                Task { @MainActor in
                    let outcome = await dispatcher.dispatch(action)
                    dispatchMessage = outcome.message
                }
            }
            if let dispatchMessage {
                Text(dispatchMessage).font(.caption2).foregroundStyle(colors.secondaryText)
            }
        }
    }
}
