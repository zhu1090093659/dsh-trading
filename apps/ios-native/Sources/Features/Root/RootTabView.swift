//
//  RootTabView.swift
//  Features
//
//  五入口容器：总览 / 机器人 / 资产与交易 / 告警 / 设置。
//  * 每个 tab 一个 SwiftUI 原生 NavigationStack（iOS 习惯：点进详情、边缘滑动返回）；
//  * 告警 tab 带 badge —— badge 的判据是「故障是否已恢复」，**不是**「用户是否已读/已确认」；
//  * 视图只读 FeaturesState（呈现层），动作经 FeatureActionDispatching 端口派发。
//

import SwiftUI

public struct RootTabView: View {
    private let state: FeaturesState
    private let dispatcher: FeatureActionDispatching
    @Bindable private var router: FeaturesRouter
    private let nowMs: Int
    private let timeZone: TimeZone

    public init(
        state: FeaturesState,
        dispatcher: FeatureActionDispatching,
        router: FeaturesRouter = FeaturesRouter(),
        nowMs: Int,
        timeZone: TimeZone = .current
    ) {
        self.state = state
        self.dispatcher = dispatcher
        self._router = Bindable(wrappedValue: router)
        self.nowMs = nowMs
        self.timeZone = timeZone
    }

    public var body: some View {
        TabView(selection: tabSelection) {
            overviewTab.tabItem { Label(FeatureTab.overview.title, systemImage: FeatureTab.overview.systemImage) }.tag(FeatureTab.overview)
            botsTab.tabItem { Label(FeatureTab.bots.title, systemImage: FeatureTab.bots.systemImage) }.tag(FeatureTab.bots)
            assetsTab.tabItem { Label(FeatureTab.assets.title, systemImage: FeatureTab.assets.systemImage) }.tag(FeatureTab.assets)
            alertsTab
                .tabItem { Label(FeatureTab.alerts.title, systemImage: FeatureTab.alerts.systemImage) }
                .badge(unrecoveredAlertCount)
                .tag(FeatureTab.alerts)
            settingsTab.tabItem { Label(FeatureTab.settings.title, systemImage: FeatureTab.settings.systemImage) }.tag(FeatureTab.settings)
        }
        .themedRoot()
    }

    private var tabSelection: Binding<FeatureTab> {
        Binding(get: { router.selectedTab }, set: { router.selectedTab = $0 })
    }

    /// badge 只看「是否已恢复」：用户已确认 **不等于** 故障已恢复（冻结件 §7 与卡片硬要求）。
    private var unrecoveredAlertCount: Int {
        state.alerts.filter { $0.lifecycle.isRecovered != true }.count
    }

    private var overviewTab: some View {
        NavigationStack {
            OverviewScreen(state: state, router: router, nowMs: nowMs, timeZone: timeZone, dispatcher: dispatcher)
        }
    }

    private var botsTab: some View {
        NavigationStack(path: $router.botsPath) {
            BotsScreen(state: state, router: router, nowMs: nowMs, timeZone: timeZone, dispatcher: dispatcher)
                .navigationDestination(for: FeatureRoute.self) { route in
                    routeDestination(route)
                }
        }
    }

    private var assetsTab: some View {
        NavigationStack(path: $router.assetsPath) {
            AssetsScreen(state: state, router: router, nowMs: nowMs, timeZone: timeZone, dispatcher: dispatcher)
                .navigationDestination(for: FeatureRoute.self) { route in
                    routeDestination(route)
                }
        }
    }

    private var alertsTab: some View {
        NavigationStack(path: $router.alertsPath) {
            AlertsScreen(state: state, router: router, nowMs: nowMs, timeZone: timeZone, dispatcher: dispatcher)
                .navigationDestination(for: FeatureRoute.self) { route in
                    routeDestination(route)
                }
        }
    }

    private var settingsTab: some View {
        NavigationStack {
            SettingsScreen(state: state, nowMs: nowMs, timeZone: timeZone)
        }
    }

    @ViewBuilder
    private func routeDestination(_ route: FeatureRoute) -> some View {
        switch route {
        case let .bot(id):
            if let bot = state.bots.first(where: { $0.id == id }) {
                BotDetailScreen(bot: bot, nowMs: nowMs, timeZone: timeZone, runtimeMode: state.runtimeMode, dispatcher: dispatcher, router: router)
            } else {
                MissingObjectScreen(kind: "机器人", id: id)
            }
        case let .order(id):
            if let order = state.assets.orders.first(where: { $0.id == id }) {
                OrderDetailScreen(order: order, nowMs: nowMs, timeZone: timeZone, runtimeMode: state.runtimeMode, router: router)
            } else {
                MissingObjectScreen(kind: "订单", id: id)
            }
        case let .account(id):
            AccountDetailScreen(accountId: id, state: state, nowMs: nowMs, timeZone: timeZone)
        case let .alert(id):
            if let alert = state.alerts.first(where: { $0.id == id }) {
                AlertDetailScreen(alert: alert, nowMs: nowMs, timeZone: timeZone, runtimeMode: state.runtimeMode, router: router, dispatcher: dispatcher)
            } else {
                MissingObjectScreen(kind: "告警", id: id)
            }
        }
    }
}

/// 追溯到一个当前观测里不存在的对象：**如实说找不到**，不编造一个空壳详情页。
public struct MissingObjectScreen: View {
    private let kind: String
    private let id: String

    public init(kind: String, id: String) {
        self.kind = kind
        self.id = id
    }

    public var body: some View {
        EmptyStateView(
            title: "找不到这个" + kind,
            message: "标识 " + id + " 不在当前观测快照里。它可能已经结束、被清理，或这份快照不完整 —— 客户端不编造它的内容。",
            systemImage: "questionmark.folder"
        )
        .navigationTitle(kind + "不可见")
    }
}
