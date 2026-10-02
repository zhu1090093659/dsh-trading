//
//  SettingsScreen.swift
//  Features
//
//  设置入口：连接 / 设备与权限 / 通知 / 隐私与显示 / 契约缺口。
//  两条纪律：
//    * control 平面**永不默认签发** —— 界面上把默认签发与显式授予分开写，不做暗示；
//    * 服务端还没给的面一律显示「未知」并列进契约缺口，**不填默认值**。
//

import SwiftUI

public struct SettingsScreen: View {
    @Environment(\.themeColors) private var colors
    private let state: FeaturesState
    private let nowMs: Int
    private let timeZone: TimeZone
    private let controller: FeatureSettingsControlling
    @State private var mutedDesks: Set<String>
    @State private var hidesAmounts: Bool
    @State private var themePreference: String
    @State private var revokeMessage: String?

    public init(
        state: FeaturesState,
        nowMs: Int,
        timeZone: TimeZone,
        controller: FeatureSettingsControlling = NoopSettingsController()
    ) {
        self.state = state
        self.nowMs = nowMs
        self.timeZone = timeZone
        self.controller = controller
        self._mutedDesks = State(initialValue: Set(state.settings.notificationMutedDesks))
        self._hidesAmounts = State(initialValue: state.settings.privacyHidesAmounts)
        self._themePreference = State(initialValue: state.settings.displayThemePreference)
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.Space.m) {
                runtimeCard
                connectionCard
                deviceCard
                notificationCard
                privacyCard
                ContractGapNotice(gaps: state.settings.contractGaps)
                aboutCard
            }
            .padding(Theme.Space.m)
        }
        .background(colors.canvas)
        .navigationTitle("设置")
    }

    private var runtimeCard: some View {
        SectionCard("运行形态") {
            EnvironmentBadge(state.runtimeMode)
            Text(state.runtimeMode.destructiveWarning ?? "")
                .font(.footnote)
                .foregroundStyle(colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var connectionCard: some View {
        SectionCard("连接") {
            InfoRow("链路", value: state.settings.connection.linkLabel, tone: state.settings.connection.linkTone, systemImage: "antenna.radiowaves.left.and.right")
            InfoRow("地址", value: FeaturesFormatter.text(state.settings.connection.originLabel), tone: .neutral)
            InfoRow("协议版本", value: FeaturesFormatter.text(state.settings.connection.apiVersionLabel), tone: .neutral)
            InfoRow("数据源", value: FeaturesFormatter.text(state.settings.connection.sourceId), tone: .neutral)
            InfoRow("能力（caps）", value: state.settings.connection.caps.isEmpty ? "未知" : state.settings.connection.caps.joined(separator: ", "), tone: .neutral)
            UpdatedAtFooter(atMs: state.settings.connection.lastUpdatedMs, nowMs: nowMs, timeZone: timeZone, sourceId: state.settings.connection.sourceId)
        }
    }

    private var deviceCard: some View {
        SectionCard("设备与权限") {
            InfoRow("设备", value: FeaturesFormatter.text(state.settings.connection.deviceLabel), tone: .neutral, systemImage: "iphone")
            InfoRow("已授予作用域", value: state.settings.scopes.isEmpty ? "未知" : state.settings.scopes.joined(separator: ", "), tone: .neutral)
            InfoRow("配对默认签发", value: state.settings.defaultScopes.joined(separator: ", "), tone: .neutral)
            InfoRow("需显式授予", value: state.settings.explicitScopes.joined(separator: ", "), tone: .warning)
            Text("配对永不签发 control：控制类动作一律要在设备上强确认，且仍由服务端按授权与风控判定。")
                .font(.caption2)
                .foregroundStyle(colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Button(role: .destructive) {
                Task { @MainActor in
                    let outcome = await controller.revokeDevice()
                    revokeMessage = outcome.message
                }
            } label: {
                Text("撤销本设备").frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: Theme.Size.minimumHitTarget)
            }
            .buttonStyle(.bordered)
            .accessibilityHint("撤销后本设备令牌失效，需要重新配对")
            if let revokeMessage {
                Text(revokeMessage).font(.caption2).foregroundStyle(colors.secondaryText)
            }
        }
    }

    private var notificationCard: some View {
        SectionCard("通知") {
            if state.bots.isEmpty {
                Text("还没有可静音的机器人。").font(.footnote).foregroundStyle(colors.secondaryText)
            } else {
                ForEach(state.bots) { bot in
                    Toggle(isOn: Binding(
                        get: { mutedDesks.contains(bot.id) },
                        set: { muted in
                            if muted { mutedDesks.insert(bot.id) } else { mutedDesks.remove(bot.id) }
                            Task { await controller.setNotificationMuted(desk: bot.id, muted: muted) }
                        }
                    )) {
                        Text("静音 " + bot.label).font(.subheadline)
                    }
                    .frame(minHeight: Theme.Size.minimumHitTarget)
                }
            }
            Text("严重（critical）通知不受静音影响 —— 只喊危险而不给出口等于把人钉在原地。")
                .font(.caption2)
                .foregroundStyle(colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var privacyCard: some View {
        SectionCard("隐私与显示") {
            Toggle(isOn: Binding(
                get: { hidesAmounts },
                set: { hidden in
                    hidesAmounts = hidden
                    Task { await controller.setPrivacyHidesAmounts(hidden) }
                }
            )) {
                Text("隐藏金额（截图/旁观时用）").font(.subheadline)
            }
            .frame(minHeight: Theme.Size.minimumHitTarget)
            Picker("外观", selection: Binding(
                get: { themePreference },
                set: { value in
                    themePreference = value
                    Task { await controller.setDisplayThemePreference(value) }
                }
            )) {
                Text("跟随系统").tag("system")
                Text("浅色").tag("light")
                Text("深色").tag("dark")
            }
            .pickerStyle(.segmented)
            Text("字号跟随系统 Dynamic Type；界面不使用固定像素字号。")
                .font(.caption2)
                .foregroundStyle(colors.secondaryText)
        }
    }

    private var aboutCard: some View {
        SectionCard("关于") {
            Text("这是自动交易机器人的**观测端**：看运行状态、持仓/订单/资产、告警与升级。它不做手动下单，也不做行情终端。")
                .font(.footnote)
                .foregroundStyle(colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Text("这是观测快照，不是实时监控屏；面板/小组件上的更新时间必须被当真。手机崩溃、断线、锁屏都不影响执行（权威态在执行核）。")
                .font(.caption2)
                .foregroundStyle(colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
