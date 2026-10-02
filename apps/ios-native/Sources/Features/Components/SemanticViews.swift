//
//  SemanticViews.swift
//  Features
//
//  语义组件：三维分列、环境（实盘/模拟）标识、可信度闸门、动作列表、追溯链接、连接头。
//  这些组件是**冻结件 §7 硬要求的落点**：
//    * StateAxesView 强制三维分列（视图层拿不到「合并成一个状态」的入口）；
//    * RenderedOrNotice 强制「不可信不渲染数据本身」；
//    * ActionList 强制「未知 closed 枚举 ⇒ 禁用全部 Action，只显示 fallbackText」；
//    * EnvironmentBadge 让实盘/模拟在**图标 + 文字 + 形状**三处不同。
//

import SwiftUI

// MARK: - 三维分列

public struct AxisRowView: View {
    @Environment(\.themeColors) private var colors
    private let axis: AxisPresentation

    public init(_ axis: AxisPresentation) {
        self.axis = axis
    }

    public var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.s) {
            Image(systemName: axis.systemImage)
                .font(.caption)
                .foregroundStyle(axis.tone.color(colors))
                .frame(width: Theme.Size.icon, alignment: .center)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(axis.title)
                    .font(.caption2)
                    .foregroundStyle(colors.secondaryText)
                Text(axis.value)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(colors.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = axis.detail {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(colors.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(axis.title)
        .accessibilityValue(axis.detail == nil ? axis.value : axis.value + "，" + (axis.detail ?? ""))
    }
}

/// 三维**分列**视图：执行状态 / 依赖健康 / 数据可信度各占一行，永不合并。
public struct StateAxesView: View {
    private let axes: StateAxesPresentation
    private let showsTitles: Bool

    public init(_ axes: StateAxesPresentation, showsTitles: Bool = true) {
        self.axes = axes
        self.showsTitles = showsTitles
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            if showsTitles {
                Text("三维状态")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            AxisRowView(axes.execution)
            AxisRowView(axes.dependency)
            AxisRowView(axes.trust)
        }
        .accessibilityElement(children: .contain)
    }
}

// MARK: - 环境（实盘 / 模拟）

public struct EnvironmentBadge: View {
    @Environment(\.themeColors) private var colors
    private let mode: RuntimeMode

    public init(_ mode: RuntimeMode) {
        self.mode = mode
    }

    public var body: some View {
        HStack(spacing: Theme.Space.xxs) {
            Image(systemName: mode.systemImage).font(.caption2).accessibilityHidden(true)
            Text(mode.label).font(.caption.weight(.bold))
        }
        .foregroundStyle(mode.tone.color(colors))
        .padding(.horizontal, Theme.Space.xs)
        .padding(.vertical, Theme.Space.xxs)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.chip, style: .continuous)
                .stroke(
                    mode.tone.color(colors),
                    style: StrokeStyle(lineWidth: Theme.Size.rule, dash: mode == .simulated ? [4, 3] : [])
                )
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("运行形态：" + mode.label)
    }
}

// MARK: - 可信度闸门：不可信 ⇒ 不渲染数据本身

/// 数据不可信（过期 / 断连 / 尚未确认）时，**只渲染提示**，绝不渲染数据本身。
public struct RenderedOrNotice<Content: View>: View {
    private let rendersData: Bool
    private let notice: String?
    private let trustAxis: AxisPresentation
    private let content: Content

    public init(rendersData: Bool, notice: String?, trustAxis: AxisPresentation, @ViewBuilder content: () -> Content) {
        self.rendersData = rendersData
        self.notice = notice
        self.trustAxis = trustAxis
        self.content = content()
    }

    public var body: some View {
        if rendersData {
            content
        } else {
            NoticeBox(
                title: "数据不可渲染（" + trustAxis.value + "）",
                message: notice ?? "这份数据不可信，已隐藏内容 —— 显示一个可能完全错的数字比什么都不显示更危险。",
                tone: trustAxis.tone,
                systemImage: trustAxis.systemImage
            )
        }
    }
}

// MARK: - 动作列表（fail-closed）

public struct ActionList: View {
    @Environment(\.themeColors) private var colors
    private let actions: [ActionPresentation]
    private let isBusy: Bool
    private let runtimeMode: RuntimeMode
    private let onAction: (ActionPresentation) -> Void

    public init(actions: [ActionPresentation], isBusy: Bool, runtimeMode: RuntimeMode, onAction: @escaping (ActionPresentation) -> Void) {
        self.actions = actions
        self.isBusy = isBusy
        self.runtimeMode = runtimeMode
        self.onAction = onAction
    }

    public var body: some View {
        if actions.isEmpty {
            Text("没有可用动作")
                .font(.caption)
                .foregroundStyle(colors.secondaryText)
        } else {
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                ForEach(actions) { action in
                    VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                        Button {
                            onAction(action)
                        } label: {
                            HStack(spacing: Theme.Space.xs) {
                                if action.isUnknownKind {
                                    Image(systemName: "questionmark.circle")
                                        .accessibilityHidden(true)
                                }
                                Text(action.label)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .frame(minHeight: Theme.Size.minimumHitTarget)
                        }
                        .buttonStyle(.bordered)
                        .disabled(!action.enabled || isBusy)
                        .accessibilityHint(accessibilityHint(for: action))

                        if let note = action.confirmNote {
                            Text(note).font(.caption2).foregroundStyle(colors.secondaryText)
                        }
                        if action.requiresBiometric && action.enabled {
                            Text("此动作需生物识别确认（由设备闸门执行；它不替代服务端授权与风控）。")
                                .font(.caption2)
                                .foregroundStyle(colors.secondaryText)
                        }
                        if runtimeMode == .live && action.enabled {
                            Text("实盘动作：会影响真实资金。")
                                .font(.caption2)
                                .foregroundStyle(colors.liveTint)
                        }
                    }
                }
            }
        }
    }

    private func accessibilityHint(for action: ActionPresentation) -> String {
        if action.isUnknownKind { return "本客户端不认识这个动作，已禁用" }
        if !action.enabled { return "当前不可用" }
        if action.requiresBiometric { return "需要生物识别确认" }
        return action.scopeLabel.map { "作用域 " + $0 } ?? ""
    }
}

// MARK: - 追溯链接（异常 -> 机器人/账户/订单）

public struct TraceChips: View {
    @Environment(\.themeColors) private var colors
    private let links: [TraceLinkPresentation]
    private let onNavigate: (TraceLinkPresentation) -> Void

    public init(links: [TraceLinkPresentation], onNavigate: @escaping (TraceLinkPresentation) -> Void) {
        self.links = links
        self.onNavigate = onNavigate
    }

    public var body: some View {
        if links.isEmpty {
            Text("没有可追溯的关联对象（服务端未给出）")
                .font(.caption2)
                .foregroundStyle(colors.secondaryText)
        } else {
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text("追溯")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(colors.secondaryText)
                FlexibleChips(links: links, onNavigate: onNavigate)
            }
        }
    }
}

private struct FlexibleChips: View {
    let links: [TraceLinkPresentation]
    let onNavigate: (TraceLinkPresentation) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
            ForEach(links) { link in
                Button {
                    onNavigate(link)
                } label: {
                    HStack(spacing: Theme.Space.xxs) {
                        Image(systemName: "arrow.turn.down.right").font(.caption2).accessibilityHidden(true)
                        Text(link.label).font(.caption)
                    }
                    .frame(minHeight: Theme.Size.minimumHitTarget * 0.6, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("追溯：" + link.label)
            }
        }
    }
}

// MARK: - 连接头（含数据更新状态）

public struct ConnectionHeader: View {
    @Environment(\.themeColors) private var colors
    private let connection: ConnectionPresentation
    private let runtimeMode: RuntimeMode
    private let nowMs: Int
    private let timeZone: TimeZone

    public init(connection: ConnectionPresentation, runtimeMode: RuntimeMode, nowMs: Int, timeZone: TimeZone = .current) {
        self.connection = connection
        self.runtimeMode = runtimeMode
        self.nowMs = nowMs
        self.timeZone = timeZone
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(spacing: Theme.Space.xs) {
                EnvironmentBadge(runtimeMode)
                StatusPill(connection.linkLabel, tone: connection.linkTone, systemImage: linkIcon)
                Spacer(minLength: 0)
            }
            UpdatedAtFooter(atMs: connection.lastUpdatedMs, nowMs: nowMs, timeZone: timeZone, sourceId: connection.sourceId)
            if let notice = connection.notice {
                Text(notice).font(.caption2).foregroundStyle(colors.secondaryText)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var linkIcon: String {
        if connection.linkIsDown { return "wifi.slash" }
        return connection.isReachable ? "checkmark.circle" : "questionmark.circle"
    }
}

// MARK: - 三态横幅（断连 / 陈旧 / 依赖异常 互不相同）

public struct DisconnectedBanner: View {
    private let lastConfirmedAtMs: Int?
    private let nowMs: Int

    public init(lastConfirmedAtMs: Int?, nowMs: Int) {
        self.lastConfirmedAtMs = lastConfirmedAtMs
        self.nowMs = nowMs
    }

    public var body: some View {
        NoticeBox(
            title: "看不到机器人（连接中断）",
            message: message,
            tone: .unknown,
            systemImage: "wifi.slash"
        )
    }

    private var message: String {
        guard let lastConfirmedAtMs else {
            return "此刻无法确认机器人的任何状态；也从未确认过它是否正常。这不是「已停止」。"
        }
        return "此刻无法确认机器人的任何状态；最后一次确认运行正常是在 " + FeaturesFormatter.relativeAge(atMs: lastConfirmedAtMs, nowMs: nowMs) + "。这不是「已停止」。"
    }
}

public struct StaleDataBanner: View {
    private let trustAxis: AxisPresentation

    public init(trustAxis: AxisPresentation) {
        self.trustAxis = trustAxis
    }

    public var body: some View {
        NoticeBox(
            title: "数据 " + trustAxis.value,
            message: trustAxis.detail ?? "手里这份数据不足以判断现状。",
            tone: trustAxis.tone,
            systemImage: "clock.badge.exclamationmark"
        )
    }
}

public struct DependencyAnomalyBanner: View {
    private let issues: [String]

    public init(issues: [String]) {
        self.issues = issues
    }

    public var body: some View {
        NoticeBox(
            title: "机器人仍在运行，但依赖异常、已禁止新增仓位",
            message: issues.isEmpty ? "依赖不健康。" : ("异常项：" + issues.joined(separator: "、") + "。这与「已停止」不是一回事。"),
            tone: .warning,
            systemImage: "exclamationmark.shield.fill"
        )
    }
}

/// 健康异常时必须出现：**收益为正不代表系统正常**。
public struct ProfitIsNotHealthBanner: View {
    private let text: String

    public init(text: String) {
        self.text = text
    }

    public var body: some View {
        NoticeBox(
            title: "收益不能证明系统正常",
            message: text,
            tone: .warning,
            systemImage: "chart.line.uptrend.xyaxis"
        )
    }
}

public struct ContractGapNotice: View {
    private let gaps: [String]

    public init(gaps: [String]) {
        self.gaps = gaps
    }

    public var body: some View {
        if !gaps.isEmpty {
            NoticeBox(
                title: "契约缺口（服务端尚未提供）",
                message: gaps.joined(separator: "；") + "。这些项在界面上显示为「未知」，客户端不填默认值、不从兜底文本猜语义。",
                tone: .unknown,
                systemImage: "questionmark.circle"
            )
        }
    }
}
