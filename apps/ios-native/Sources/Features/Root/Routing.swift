//
//  Routing.swift
//  Features
//
//  五入口导航：TabView 的五个 tab + 每个 tab 独立 NavigationStack 路径。
//  追溯（异常 -> 机器人/账户/订单）经 FeaturesRouter.navigate 完成：切换 tab 并 push，
//  因此「从异常一路追到原因」不需要用户在多页面手工拼线索。
//

import SwiftUI

public enum FeatureTab: String, Sendable, Hashable, CaseIterable, Identifiable {
    case overview
    case bots
    case assets
    case alerts
    case settings

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .overview: return "总览"
        case .bots: return "机器人"
        case .assets: return "资产与交易"
        case .alerts: return "告警"
        case .settings: return "设置"
        }
    }

    public var systemImage: String {
        switch self {
        case .overview: return "gauge.with.dots.needle.50percent"
        case .bots: return "cpu"
        case .assets: return "chart.pie"
        case .alerts: return "bell.badge"
        case .settings: return "gearshape"
        }
    }
}

/// 可以 push 到的目的地。Hashable，供 NavigationStack(path:) 使用。
public enum FeatureRoute: Hashable, Sendable {
    case bot(String)
    case order(String)
    case account(String)
    case alert(String)
}

@MainActor
@Observable
public final class FeaturesRouter {
    public var selectedTab: FeatureTab
    public var botsPath: [FeatureRoute] = []
    public var assetsPath: [FeatureRoute] = []
    public var alertsPath: [FeatureRoute] = []

    public init(selectedTab: FeatureTab = .overview) {
        self.selectedTab = selectedTab
    }

    /// 追溯跳转：切到承载该对象的 tab 并 push 它的详情。
    public func navigate(_ target: TraceLinkPresentation.Target) {
        switch target {
        case let .bot(id):
            selectedTab = .bots
            botsPath = [.bot(id)]
        case let .order(id):
            selectedTab = .assets
            assetsPath = [.order(id)]
        case let .account(id):
            selectedTab = .assets
            assetsPath = [.account(id)]
        case .none:
            break
        }
    }

    /// 告警详情跳转（告警列表 -> 详情）。
    public func openAlert(_ id: String) {
        selectedTab = .alerts
        alertsPath = [.alert(id)]
    }
}
