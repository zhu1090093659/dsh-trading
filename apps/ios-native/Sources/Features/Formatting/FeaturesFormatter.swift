//
//  FeaturesFormatter.swift
//  Features
//
//  展示格式化的唯一之家：时间、相对年龄、计数。**纯函数、不读系统时钟**（now 由调用方传入），
//  因此快照与单测都可复现；时区显式传入，避免把运行机器的时区写进证据。
//

import Foundation

public enum FeaturesFormatter {
    /// 毫秒时间戳 -> HH:mm:ss（按给定时区；不做本地化，证据可复现）。
    public static func clock(_ atMs: Int?, timeZone: TimeZone) -> String? {
        guard let atMs else { return nil }
        let base = atMs / 1000
        let offsetSeconds = timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: TimeInterval(base)))
        var secondsOfDay = (base + offsetSeconds) % 86_400
        if secondsOfDay < 0 { secondsOfDay += 86_400 }
        let hours = secondsOfDay / 3_600
        let minutes = (secondsOfDay % 3_600) / 60
        let seconds = secondsOfDay % 60
        return pad(hours) + ":" + pad(minutes) + ":" + pad(seconds)
    }

    private static func pad(_ value: Int) -> String {
        value < 10 ? "0" + String(value) : String(value)
    }

    /// 相对年龄：秒 / 分钟 / 小时 / 天。负数（时钟回拨）一律显示「刚刚」，**不显示负龄**。
    public static func relativeAge(atMs: Int, nowMs: Int) -> String {
        let deltaMs = nowMs - atMs
        if deltaMs <= 0 { return "刚刚" }
        let seconds = deltaMs / 1_000
        if seconds < 60 { return String(seconds) + " 秒前" }
        let minutes = seconds / 60
        if minutes < 60 { return String(minutes) + " 分钟前" }
        let hours = minutes / 60
        if hours < 24 { return String(hours) + " 小时前" }
        return String(hours / 24) + " 天前"
    }

    /// 「数据更新时间」——**面板/小组件必须标注**的那一行。
    public static func updatedLine(atMs: Int?, nowMs: Int, timeZone: TimeZone) -> String {
        guard let atMs else { return "数据更新时间：未知（尚未取到）" }
        let clockText = clock(atMs, timeZone: timeZone) ?? "—"
        return "数据更新时间 " + clockText + "（" + relativeAge(atMs: atMs, nowMs: nowMs) + "）"
    }

    /// 缺失值一律显示「未知」，**绝不填 0 或空串**。
    public static func text(_ value: String?, unknown: String = "未知") -> String {
        guard let value, !value.isEmpty else { return unknown }
        return value
    }

    public static func count(_ value: Int?) -> String {
        guard let value else { return "未知" }
        return String(value)
    }

    public static func bool(_ value: Bool?) -> String {
        guard let value else { return "未知" }
        return value ? "是" : "否"
    }
}
