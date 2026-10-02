//
//  Primitives.swift
//  Features
//
//  共享展示原语（卡片容器、键值行、状态药丸、提示条、面板更新时间页脚）。
//  全部只吃呈现层模型 + Theme token，**不碰网络、不碰 Domain 判定**。
//
//  无障碍：装饰性图标一律 accessibilityHidden；每个组合行用 accessibilityElement(children:)
//  合成一句话，保证 VoiceOver 不会把「标签/值/色调」拆成三段互不相关的朗读。
//

import SwiftUI

// MARK: - 卡片容器

public struct SectionCard<Content: View>: View {
    @Environment(\.themeColors) private var colors
    private let title: String?
    private let subtitle: String?
    private let content: Content

    public init(_ title: String? = nil, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            if let title {
                VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                    Text(title).font(.headline).foregroundStyle(colors.primaryText)
                    if let subtitle {
                        Text(subtitle).font(.footnote).foregroundStyle(colors.secondaryText)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            content
        }
        .padding(Theme.Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(colors.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous)
                .stroke(colors.separator, lineWidth: Theme.Size.rule)
        )
    }
}

// MARK: - 键值行

public struct InfoRow: View {
    @Environment(\.themeColors) private var colors
    private let label: String
    private let value: String
    private let tone: ThemeTone
    private let systemImage: String?

    public init(_ label: String, value: String, tone: ThemeTone = .neutral, systemImage: String? = nil) {
        self.label = label
        self.value = value
        self.tone = tone
        self.systemImage = systemImage
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.s) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(colors.secondaryText)
                .frame(minWidth: Theme.Size.minimumHitTarget, alignment: .leading)
            Spacer(minLength: Theme.Space.xs)
            HStack(spacing: Theme.Space.xxs) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.caption)
                        .foregroundStyle(tone.color(colors))
                        .accessibilityHidden(true)
                }
                Text(value)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(colors.primaryText)
                    .multilineTextAlignment(.trailing)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(value)
    }
}

// MARK: - 状态药丸

public struct StatusPill: View {
    @Environment(\.themeColors) private var colors
    private let text: String
    private let tone: ThemeTone
    private let systemImage: String?

    public init(_ text: String, tone: ThemeTone, systemImage: String? = nil) {
        self.text = text
        self.tone = tone
        self.systemImage = systemImage
    }

    public var body: some View {
        HStack(spacing: Theme.Space.xxs) {
            if let systemImage {
                Image(systemName: systemImage).font(.caption2).accessibilityHidden(true)
            }
            Text(text).font(.caption.weight(.semibold))
        }
        .foregroundStyle(tone.color(colors))
        .padding(.horizontal, Theme.Space.xs)
        .padding(.vertical, Theme.Space.xxs)
        .background(tone.color(colors).opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.chip, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.chip, style: .continuous)
                .stroke(tone.color(colors).opacity(0.45), lineWidth: Theme.Size.rule)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
    }
}

// MARK: - 提示条

public struct NoticeBox: View {
    @Environment(\.themeColors) private var colors
    private let title: String
    private let message: String
    private let tone: ThemeTone
    private let systemImage: String

    public init(title: String, message: String, tone: ThemeTone, systemImage: String) {
        self.title = title
        self.message = message
        self.tone = tone
        self.systemImage = systemImage
    }

    public var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.s) {
            Image(systemName: systemImage)
                .font(.body)
                .foregroundStyle(tone.color(colors))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(colors.primaryText)
                Text(message).font(.footnote).foregroundStyle(colors.secondaryText).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(Theme.Space.s)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.color(colors).opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.chip, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.chip, style: .continuous)
                .stroke(tone.color(colors).opacity(0.5), lineWidth: Theme.Size.rule)
        )
        .accessibilityElement(children: .combine)
    }
}

// MARK: - 空态

public struct EmptyStateView: View {
    @Environment(\.themeColors) private var colors
    private let title: String
    private let message: String
    private let systemImage: String

    public init(title: String, message: String, systemImage: String) {
        self.title = title
        self.message = message
        self.systemImage = systemImage
    }

    public var body: some View {
        VStack(spacing: Theme.Space.s) {
            Image(systemName: systemImage)
                .font(.largeTitle)
                .foregroundStyle(colors.unknown)
                .accessibilityHidden(true)
            Text(title).font(.headline).foregroundStyle(colors.primaryText)
            Text(message)
                .font(.footnote)
                .foregroundStyle(colors.secondaryText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Theme.Space.l)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - 更新时间页脚（面板/小组件必须标注）

public struct UpdatedAtFooter: View {
    @Environment(\.themeColors) private var colors
    private let atMs: Int?
    private let nowMs: Int
    private let timeZone: TimeZone
    private let sourceId: String?
    private let prefix: String

    public init(atMs: Int?, nowMs: Int, timeZone: TimeZone = .current, sourceId: String? = nil, prefix: String = "") {
        self.atMs = atMs
        self.nowMs = nowMs
        self.timeZone = timeZone
        self.sourceId = sourceId
        self.prefix = prefix
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
            Text(prefix + FeaturesFormatter.updatedLine(atMs: atMs, nowMs: nowMs, timeZone: timeZone))
                .font(.caption2)
                .foregroundStyle(colors.secondaryText)
            if let sourceId {
                Text("数据源 " + sourceId)
                    .font(.caption2)
                    .foregroundStyle(colors.secondaryText)
            }
            Text("这是观测快照，不是实时监控屏；数字以标注的更新时间为准。")
                .font(.caption2)
                .foregroundStyle(colors.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - 分组标题

public struct GroupHeader: View {
    @Environment(\.themeColors) private var colors
    private let title: String
    private let count: Int?

    public init(_ title: String, count: Int? = nil) {
        self.title = title
        self.count = count
    }

    public var body: some View {
        HStack(spacing: Theme.Space.xs) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(colors.secondaryText)
            if let count {
                Text(String(count)).font(.caption).foregroundStyle(colors.secondaryText)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
