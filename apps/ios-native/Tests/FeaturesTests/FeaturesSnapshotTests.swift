//
//  FeaturesSnapshotTests.swift
//  DshTradingFeaturesTests
//
//  渲染证据：把关键界面渲染成 PNG，落到仓内 .local/（gitignored）。
//
//  为什么不用 SwiftUI 的 ImageRenderer：本机实测它对本项目的 ScrollView/NavigationStack/TabView 容器
//  渲染出的是**空白画布**（44 张图里 43 张字节数相同）。改用 UIHostingController + UIWindow +
//  drawHierarchy(afterScreenUpdates:) 这条经典路径，并在拿不到内容时退回 layer.render(in:)，
//  最后还有一道「空白即失败」的自检：采样颜色数太少直接判红 —— 不接受自欺的渲染证据。
//
//  覆盖面（判据要求的那几类）：
//    * 五入口根屏：总览 / 机器人 / 资产与交易 / 告警 / 设置；
//    * 详情：机器人详情 / 订单详情 / 告警详情；
//    * 三态 + 两种「未知」：断连（unreachable）/ 陈旧过期（expired）/ 依赖异常受限（runningRestricted）/
//      「已连上但无法判定」/「确认已停止」；
//    * 双形态：模拟盘与实盘；深浅色 + Dynamic Type 大字号各一组。
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
    /// 每张图的像素指纹：用于断言「不同界面确实画出了不同内容」。
    private var fingerprints: [String: Int] = [:]

    override func setUpWithError() throws {
        written = []
        fingerprints = [:]
    }

    override func tearDownWithError() throws {
        print("[ios4-snapshots] wrote \(written.count) files")
        for path in written { print("[ios4-snapshots] " + path) }
    }

    // MARK: - 五入口 x 多状态

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
            let router = FeaturesRouter()
            let dispatcher = NoopActionDispatcher()
            try render(.init(RootTabView(state: variant.state, dispatcher: dispatcher, router: router, nowMs: Self.nowMs, timeZone: Self.timeZone)), name: variant.name + "-00-root")
            try render(.init(OverviewScreen(state: variant.state, router: router, nowMs: Self.nowMs, timeZone: Self.timeZone, dispatcher: dispatcher)), name: variant.name + "-01-overview")
            try render(.init(BotsScreen(state: variant.state, router: router, nowMs: Self.nowMs, timeZone: Self.timeZone, dispatcher: dispatcher)), name: variant.name + "-02-bots")
            try render(.init(AssetsScreen(state: variant.state, router: router, nowMs: Self.nowMs, timeZone: Self.timeZone, dispatcher: dispatcher)), name: variant.name + "-03-assets")
            try render(.init(AlertsScreen(state: variant.state, router: router, nowMs: Self.nowMs, timeZone: Self.timeZone, dispatcher: dispatcher)), name: variant.name + "-04-alerts")
            try render(.init(SettingsScreen(state: variant.state, nowMs: Self.nowMs, timeZone: Self.timeZone)), name: variant.name + "-05-settings")
        }
        // 不同界面必须画出不同内容：否则「渲染证据」就是自欺（本文件正是被空白图抓过一次）。
        let distinct = Set(fingerprints.values)
        XCTAssertGreaterThan(distinct.count, 3, "入口截图只有 \(distinct.count) 种像素指纹，渲染疑似退化")
    }

    // MARK: - 详情屏

    func testRendersDetailScreens() throws {
        let state = FeaturesFixtures.state(runtimeMode: .live, primaryState: .runningRestricted)
        let router = FeaturesRouter()
        let dispatcher = NoopActionDispatcher()
        let bot = try XCTUnwrap(state.bots.first)
        try render(.init(BotDetailScreen(bot: bot, nowMs: Self.nowMs, timeZone: Self.timeZone, runtimeMode: state.runtimeMode, dispatcher: dispatcher, router: router)), name: "detail-01-bot")
        let order = try XCTUnwrap(state.assets.orders.first { $0.stage == .submittedUnknown } ?? state.assets.orders.first)
        try render(.init(OrderDetailScreen(order: order, nowMs: Self.nowMs, timeZone: Self.timeZone, runtimeMode: state.runtimeMode, router: router)), name: "detail-02-order")
        let alert = try XCTUnwrap(state.alerts.first)
        try render(.init(AlertDetailScreen(alert: alert, nowMs: Self.nowMs, timeZone: Self.timeZone, runtimeMode: state.runtimeMode, router: router, dispatcher: dispatcher)), name: "detail-03-alert")
    }

    // MARK: - 深浅色 + Dynamic Type

    func testRendersDarkModeAndAccessibilityType() throws {
        let state = FeaturesFixtures.state(runtimeMode: .simulated, primaryState: .runningRestricted)
        let router = FeaturesRouter()
        let dispatcher = NoopActionDispatcher()
        try render(.init(RootTabView(state: state, dispatcher: dispatcher, router: router, nowMs: Self.nowMs, timeZone: Self.timeZone)), name: "a11y-dark-root", scheme: .dark)
        try render(.init(OverviewScreen(state: state, router: router, nowMs: Self.nowMs, timeZone: Self.timeZone, dispatcher: dispatcher)), name: "a11y-dark-overview", scheme: .dark)
        try render(.init(AlertDetailScreen(alert: state.alerts[0], nowMs: Self.nowMs, timeZone: Self.timeZone, runtimeMode: state.runtimeMode, router: router, dispatcher: dispatcher)), name: "a11y-dark-alert", scheme: .dark)
        try render(.init(RootTabView(state: state, dispatcher: dispatcher, router: router, nowMs: Self.nowMs, timeZone: Self.timeZone)), name: "a11y-xxxl-root", dynamicType: .accessibility3)
        try render(.init(BotsScreen(state: state, router: router, nowMs: Self.nowMs, timeZone: Self.timeZone, dispatcher: dispatcher)), name: "a11y-xxxl-bots", dynamicType: .accessibility3)
    }

    // MARK: - 渲染与落盘

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

        let controller = UIHostingController(rootView: content)
        controller.view.frame = CGRect(origin: .zero, size: Self.size)
        let window = UIWindow(frame: CGRect(origin: .zero, size: Self.size))
        window.rootViewController = controller
        window.isHidden = false
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        CATransaction.flush()

        let renderer = UIGraphicsImageRenderer(size: Self.size)
        var image = renderer.image { _ in
            controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
        }
        var colors = Self.distinctColorCount(in: image)
        if colors <= 8 {
            // drawHierarchy 在无窗口场景下可能拿不到内容：退回直接渲染图层树。
            image = renderer.image { context in
                controller.view.layer.render(in: context.cgContext)
            }
            colors = Self.distinctColorCount(in: image)
        }
        window.isHidden = true

        XCTAssertGreaterThan(colors, 8, "渲染疑似空白（只有 \(colors) 种采样颜色）：\(name)")
        guard let data = image.pngData() else {
            XCTFail("PNG 编码失败：\(name)")
            return
        }
        fingerprints[name] = colors

        let directory = Self.snapshotDirectory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(name + ".png")
        try data.write(to: url, options: .atomic)
        written.append(url.path + " (\(Int(image.size.width))x\(Int(image.size.height))@2x, \(data.count) bytes, \(colors) distinct colors)")
    }

    /// 采样成小位图数颜色：把「这张图是不是空白」变成一条会失败的断言。
    private static func distinctColorCount(in image: UIImage) -> Int {
        guard let cgImage = image.cgImage else { return 0 }
        let width = 40
        let height = 86
        let byteCount = width * height * 4
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: byteCount)
        defer { buffer.deallocate() }
        buffer.initialize(repeating: 0, count: byteCount)
        guard let context = CGContext(
            data: buffer,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return 0 }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        var distinct = Set<String>()
        for index in stride(from: 0, to: byteCount, by: 4) {
            distinct.insert("\(buffer[index]),\(buffer[index + 1]),\(buffer[index + 2])")
        }
        return distinct.count
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
