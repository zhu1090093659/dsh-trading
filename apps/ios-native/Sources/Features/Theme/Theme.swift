//
//  Theme.swift
//  Features
//
//  配色/间距/字体的**唯一之家**：界面里不出现裸色值与裸间距（可机检：Features/Screens 与
//  Features/Components 下不得出现 Color(.literal) 与数字 padding 字面量）。
//
//  深浅色与 Dynamic Type：
//    * 颜色按 colorScheme 解析（ThemeColors.resolve），不写死 .white/.black；
//    * 字体一律用 SwiftUI **语义字号**（.body/.headline/.caption…）与相对度量，
//      因此 Dynamic Type 自动生效，不需要在每个页面手写 @ScaledMetric。
//

import SwiftUI

/// 一处解析出的调色板（同一套 token 在浅色/深色下给出不同取值）。
public struct ThemeColors: Sendable, Equatable {
    public let canvas: Color
    public let surface: Color
    public let surfaceElevated: Color
    public let primaryText: Color
    public let secondaryText: Color
    public let separator: Color
    public let accent: Color
    public let positive: Color
    public let negative: Color
    public let info: Color
    public let warning: Color
    public let critical: Color
    public let unknown: Color
    /// 实盘（真实资金）：与模拟盘**必须在视觉上永远不同**，且不只靠颜色区分。
    public let liveTint: Color
    /// 模拟盘。
    public let simulatedTint: Color

    public static func resolve(_ scheme: ColorScheme) -> ThemeColors {
        switch scheme {
        case .dark:
            return ThemeColors(
                canvas: Color(red: 0.05, green: 0.05, blue: 0.06),
                surface: Color(red: 0.11, green: 0.11, blue: 0.12),
                surfaceElevated: Color(red: 0.16, green: 0.16, blue: 0.18),
                primaryText: Color(red: 0.96, green: 0.96, blue: 0.97),
                secondaryText: Color(red: 0.68, green: 0.68, blue: 0.71),
                separator: Color(red: 0.26, green: 0.26, blue: 0.28),
                accent: Color(red: 0.36, green: 0.62, blue: 1.0),
                positive: Color(red: 0.30, green: 0.82, blue: 0.48),
                negative: Color(red: 1.0, green: 0.42, blue: 0.42),
                info: Color(red: 0.44, green: 0.72, blue: 1.0),
                warning: Color(red: 1.0, green: 0.72, blue: 0.25),
                critical: Color(red: 1.0, green: 0.36, blue: 0.36),
                unknown: Color(red: 0.60, green: 0.60, blue: 0.64),
                liveTint: Color(red: 1.0, green: 0.44, blue: 0.36),
                simulatedTint: Color(red: 0.55, green: 0.66, blue: 1.0)
            )
        case .light:
            return ThemeColors(
                canvas: Color(red: 0.95, green: 0.95, blue: 0.97),
                surface: Color(red: 1.0, green: 1.0, blue: 1.0),
                surfaceElevated: Color(red: 1.0, green: 1.0, blue: 1.0),
                primaryText: Color(red: 0.07, green: 0.07, blue: 0.09),
                secondaryText: Color(red: 0.38, green: 0.38, blue: 0.42),
                separator: Color(red: 0.84, green: 0.84, blue: 0.86),
                accent: Color(red: 0.05, green: 0.36, blue: 0.85),
                positive: Color(red: 0.07, green: 0.55, blue: 0.24),
                negative: Color(red: 0.78, green: 0.15, blue: 0.15),
                info: Color(red: 0.05, green: 0.36, blue: 0.85),
                warning: Color(red: 0.72, green: 0.45, blue: 0.0),
                critical: Color(red: 0.78, green: 0.12, blue: 0.12),
                unknown: Color(red: 0.42, green: 0.42, blue: 0.46),
                liveTint: Color(red: 0.72, green: 0.16, blue: 0.10),
                simulatedTint: Color(red: 0.18, green: 0.34, blue: 0.78)
            )
        @unknown default:
            // 新色貌（高对比等）：回落到浅色，**不崩**，也不假装是深色。
            return ThemeColors.resolve(.light)
        }
    }
}

private struct ThemeColorsKey: EnvironmentKey {
    static let defaultValue = ThemeColors.resolve(.light)
}

public extension EnvironmentValues {
    var themeColors: ThemeColors {
        get { self[ThemeColorsKey.self] }
        set { self[ThemeColorsKey.self] = newValue }
    }
}

/// 间距/圆角/尺寸 token。
public enum Theme {
    public enum Space {
        public static let hair: CGFloat = 2
        public static let xxs: CGFloat = 4
        public static let xs: CGFloat = 8
        public static let s: CGFloat = 12
        public static let m: CGFloat = 16
        public static let l: CGFloat = 24
        public static let xl: CGFloat = 32
    }

    public enum Radius {
        public static let chip: CGFloat = 8
        public static let card: CGFloat = 14
        public static let sheet: CGFloat = 20
    }

    public enum Size {
        public static let minimumHitTarget: CGFloat = 44
        public static let icon: CGFloat = 18
        public static let chipIcon: CGFloat = 12
        public static let rule: CGFloat = 1
    }
}

/// 语义色调：把"严重/健康/未知/实盘/模拟"这些**语义**映射到颜色，
/// 界面不直接选颜色，只选语义（换主题时只改这里）。
public enum ThemeTone: Sendable, Hashable {
    case neutral
    case positive
    case negative
    case warning
    case critical
    case info
    case unknown
    case live
    case simulated

    public func color(_ colors: ThemeColors) -> Color {
        switch self {
        case .neutral: return colors.secondaryText
        case .positive: return colors.positive
        case .negative: return colors.negative
        case .warning: return colors.warning
        case .critical: return colors.critical
        case .info: return colors.info
        case .unknown: return colors.unknown
        case .live: return colors.liveTint
        case .simulated: return colors.simulatedTint
        }
    }
}

/// 根视图修饰器：把当前 colorScheme 解析成 token 注入环境。
public struct ThemedRoot: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    public init() {}
    public func body(content: Content) -> some View {
        content
            .environment(\.themeColors, ThemeColors.resolve(scheme))
            .background(ThemeColors.resolve(scheme).canvas)
    }
}

public extension View {
    /// 在界面根（或每个预览/快照）上套一次，保证 token 到位。
    func themedRoot() -> some View { modifier(ThemedRoot()) }
}
