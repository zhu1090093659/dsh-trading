//
//  FeaturesSnapshotTests.swift
//  DshTradingFeaturesTests
//
//  渲染证据：用 SwiftUI 的 ImageRenderer 把关键界面渲染成 PNG，落到仓内 .local/（gitignored）。
//  为什么选快照而不是 UI 测试：五入口与三态都要**看得见**，而 UI 测试要跑一个真实 App + 网络/配对，
//  在 CI 上是另一条很长的链；快照直接吃呈现层夹具，覆盖同一批界面且确定性强。
//
//  覆盖面（本文件渲染的就是判据要求的那几类）：
//    * 五入口根屏：总览 / 机器人 / 资产与交易 / 告警 / 设置；
//    * 详情：机器人详情 / 订单详情 / 告警详情；
//    * 三态：断连（unreachable）/ 陈旧过期（expired）/ 依赖异常受限（runningRestricted），
//      外加第三种「已连上但无法判定」与「确认已停止」；
//    * 双形态：模拟盘与实盘；
//    * 深浅色 + Dynamic Type 大字号各一组。
//

import XCTest
import SwiftUI
import UIKit
@testable import DshTradingFeatures

@MainActor
final class FeaturesSnapshotTests: XCTestCase {
    private static let nowMs = FeaturesFixtures.sampleNowMs
    private static let timeZone = TimeZone(identifier: "Asia/Shanghai") ?? .gmt
    private static let size = CGSize(width: 393, height: 852)

    private var written: [String] = []

    override func setUpWithError() throws {
        written = []
    }

    override func tearDownWithError() throws {
        // 把清单打进测试日志，作为「证据落在哪些文件」的原始输出。
        print("[ios4-snapshots] wrote \(written.count) files")
        for path in written { print("[ios4-snapshots] " + path) }
    }

    // MARK: - 五入口 + 三态

    func testRendersFiveEntriesAcrossStatesAndRuntimeModes() throws {
        let variants: [(name: String, state: FeaturesState)] = [
            ("sim-operational", FeaturesFixtures.state(runtimeMode: .simulated, primaryState: .operational)),
            ("live-restricted", FeaturesFixtures.state(runtimeMode: .live, primaryState: .runningRestricted)),
            ("disconnected", FeaturesFixtures.state(runtimeMode: .simulated, primaryState: .unreachable, reachable: false)),
            ("stale-expired", FeaturesFixtures.state(runtimeMode: .simulated, primaryState: .operational, trust: .expired)),
            ("indeterminate", FeaturesFixtures.state(runtimeMode: .live, primaryState: .indeterminateExecution)),
            ("stopped", FeaturesFixtures.state(runtimeMode: .simulated, primaryState: .stoppedConfirmed))
        ]
        for variant in variants {
            let context = makeContext(state: variant.state)
            try render(.init(RootTabView(state: variant.state, dispatcher: context.dispatcher, router: context.router, nowMs: Self.nowMs, timeZone: Self.timeZone)), name: variant.name + "-00-root")
            try render(.init(OverviewScreen(state: variant.state, router: context.router, nowMs: Self.nowMs, timeZone: Self.timeZone, dispatcher: context.dispatcher)), name: variant.name + "-01-overview")
            try render(.init(BotsScreen(state: variant.state, router: context.router, nowMs: Self.nowMs, timeZone: Self.timeZone, dispatcher: context.dispatcher)), name: variant.name + "-02-bots")
            try render(.init(AssetsScreen(state: variant.state, router: context.router, nowMs: Self.nowMs, timeZone: Self.timeZone, dispatcher: context.dispatcher)), name: variant.name + "-03-assets")
            try render(.init(AlertsScreen(state: variant.state, router: context.router, nowMs: Self.nowMs, timeZone: Self.timeZone, dispatcher: context.dispatcher)), name: variant.name + "-04-alerts")
            try render(.init(SettingsScreen(state: variant.state, nowMs: Self.nowMs, timeZone: Self.timeZone)), name: variant.name + "-05-settings")
        }
    }

    // MARK: - 详情屏

    func testRendersDetailScreens() throws {
        let state = FeaturesFixtures.state(runtimeMode: .live, primaryState: .runningRestricted)
        let context = makeContext(state: state)
        if let bot = state.bots.first {
            try render(.init(BotDetailScreen(bot: bot, nowMs: Self.nowMs, timeZone: Self.timeZone, runtimeMode: state.runtimeMode, dispatcher: context.dispatcher, router: context.router)), name: "detail-01-bot")
        } else {
            XCTFail("夹具必须有机器人")
        }
        if let order = state.assets.orders.first(where: { $0.stage == .submittedUnknown }) ?? state.assets.orders.first {
            try render(.init(OrderDetailScreen(order: order, nowMs: Self.nowMs, timeZone: Self.timeZone, runtimeMode: state.runtimeMode, router: context.router)), name: "detail-02-order")
        } else {
            XCTFail("夹具必须有订单")
        }
        if let alert = state.alerts.first {
            try render(.init(AlertDetailScreen(alert: alert, nowMs: Self.nowMs, timeZone: Self.timeZone, runtimeMode: state.runtimeMode, router: context.router, dispatcher: context.dispatcher)), name: "detail-03-alert")
        } else {
            XCTFail("夹具必须有告警")
        }
    }

    // MARK: - 深浅色 + Dynamic Type

    func testRendersDarkModeAndAccessibilityType() throws {
        let state = FeaturesFixtures.state(runtimeMode: .simulated, primaryState: .runningRestricted)
        let context = makeContext(state: state)
        try render(.init(RootTabView(state: state, dispatcher: context.dispatcher, router: context.router, nowMs: Self.nowMs, timeZone: Self.timeZone)), name: "a11y-dark-root", scheme: .dark)
        try render(.init(OverviewScreen(state: state, router: context.router, nowMs: Self.nowMs, timeZone: Self.timeZone, dispatcher: context.dispatcher)), name: "a11y-dark-overview", scheme: .dark)
        try render(.init(AlertDetailScreen(alert: state.alerts[0], nowMs: Self.nowMs, timeZone: Self.timeZone, runtimeMode: state.runtimeMode, router: context.router, dispatcher: context.dispatcher)), name: "a11y-dark-alert", scheme: .dark)
        try render(.init(RootTabView(state: state, dispatcher: context.dispatcher, router: context.router, nowMs: Self.nowMs, timeZone: Self.timeZone)), name: "a11y-xxxl-root", dynamicType: .accessibility3)
        try render(.init(BotsScreen(state: state, router: context.router, nowMs: Self.nowMs, timeZone: Self.timeZone, dispatcher: context.dispatcher)), name: "a11y-xxxl-bots", dynamicType: .accessibility3)
    }

    // MARK: - 渲染与落盘

    private struct Context {
        let router: FeaturesRouter
        let dispatcher: FeatureActionDispatching
    }

    private func makeContext(state: FeaturesState) -> Context {
        _ = state
        return Context(router: FeaturesRouter(), dispatcher: NoopActionDispatcher())
    }

    private func render(
        _ view: AnyView,
        name: String,
        scheme: ColorScheme = .light,
        dynamicType: DynamicTypeSize = .large
    ) throws {
        let content = view
            .themedRoot()
            .environment(\.colorScheme, scheme)
            .dynamicTypeSize(dynamicType)
            .frame(width: Self.size.width, height: Self.size.height)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        guard let image = renderer.uiImage else {
            XCTFail("ImageRenderer 没有产出图像：\(name)")
            return
        }
        guard let data = image.pngData() else {
            XCTFail("PNG 编码失败：\(name)")
            return
        }
        let directory = Self.snapshotDirectory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(name + ".png")
        try data.write(to: url, options: .atomic)
        written.append(url.path + " (\(Int(image.size.width))x\(Int(image.size.height))@2x, \(data.count) bytes)")
    }

    /// .local/ios4-snapshots —— 从 #filePath 反推仓根，避免把绝对路径写死进断言。
    private static var snapshotDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(".local")
            .appendingPathComponent("ios4-snapshots")
    }
}
