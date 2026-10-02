//
//  CardMapping.swift
//  Domain
//
//  卡片 -> 观测态（冻结件 §6 的"字段来源"表）。
//
//  两条不许违反的规则：
//    1. field.key **不是封闭枚举**：认识的 key 走结构化映射，
//       **不认识的一律进 raw 列表原样展示，绝不推断语义**；
//    2. 字段缺失时显示"未知"（nil），**不许填 0 或空串**。
//
//  诚实边界：服务端当前**没有冻结 field.key 的名字**（仓内只有测试夹具用过一个 level）。
//  下面这张"认识的 key"表是客户端读取约定，属于**契约缺口**（已报 Lead，IOS-7 汇总）：
//  服务端应当把每个卡片的 key 冻结下来；在此之前本表是唯一依据，改它要同步 IOS-4/5/6。
//

import Foundation
import DshTradingContract

/// 信任预算：**展示用**的年龄分档（不是交易参数，不受"未标定不得写常量"约束）。
public struct TrustBudget: Hashable, Sendable {
    public let freshMs: Int
    public let agingMs: Int
    public let staleMs: Int
    public let ttlMs: Int

    public init(freshMs: Int, agingMs: Int, staleMs: Int, ttlMs: Int) {
        self.freshMs = freshMs
        self.agingMs = agingMs
        self.staleMs = staleMs
        self.ttlMs = ttlMs
    }

    /// 客户端展示预算（与契约 offline.ts 的三档语义同构）。
    public static let clientDefault = TrustBudget(
        freshMs: 5_000,
        agingMs: 30_000,
        staleMs: 300_000,
        ttlMs: 3_600_000
    )

    /// 由年龄分档。边界不满足 freshMs <= agingMs <= staleMs <= ttlMs 时返回 nil（口径不自洽）。
    public func age(ofMs ageMs: Int) -> DataAge? {
        guard freshMs <= agingMs, agingMs <= staleMs, staleMs <= ttlMs else { return nil }
        let age = max(0, ageMs)
        if age < freshMs { return .fresh }
        if age < agingMs { return .aging }
        if age < staleMs { return .stale }
        return .expired
    }
}

/// 卡片字段索引：按 key 查表。**查不到就是 nil** —— 不替服务端补默认值。
public struct CardFieldIndex: Sendable {
    public let fields: [CardField]

    public init(_ fields: [CardField]) {
        self.fields = fields
    }

    public func string(_ key: String) -> String? {
        guard let raw = fields.first(where: { $0.key == key })?.value else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    public func int(_ key: String) -> Int? {
        guard let raw = string(key) else { return nil }
        return Int(raw)
    }

    public func bool(_ key: String) -> Bool? {
        guard let raw = string(key)?.lowercased() else { return nil }
        if raw == "true" { return true }
        if raw == "false" { return false }
        return nil
    }

    /// 不在认识集合里的字段，原样保留（**绝不推断语义**）。
    public func raw(excluding recognized: Set<String>) -> [CardField] {
        fields.filter { !recognized.contains($0.key) }
    }
}

/// 客户端读取约定：每个卡片类型认识的 field.key。
/// **这不是契约**（契约里 key 不是封闭枚举）；它是缺口清单的一部分。
public enum RecognizedFieldKeys {
    public static let deskSummary: Set<String> = ["deskId", "label", "mode", "phase", "waitReason", "level", "currency", "equity", "available", "margin", "realizedPnl", "unrealizedPnl"]
    public static let riskState: Set<String> = ["level", "alignment", "symbol", "reason", "marketData", "tradeChannel", "accountSync"]
    public static let position: Set<String> = ["symbol", "side", "quantity", "entryPrice", "avgPrice", "avgCost", "pnl", "unrealizedPnl", "attribution", "botId", "accountId"]
    public static let order: Set<String> = ["symbol", "side", "price", "quantity", "state", "stateSinceMs", "filledQuantity", "botId", "orderId"]
    public static let mandate: Set<String> = ["limit", "used", "currency", "label", "unit", "equity", "available", "margin", "realizedPnl", "unrealizedPnl", "costs"]
    public static let freshness: Set<String> = ["age", "ageMs", "atMs"]
    public static let alert: Set<String> = ["severity", "title", "reason", "impact", "firstSeenMs", "lastSeenMs", "recoveredAtMs", "repeatCount", "readAtMs", "acknowledgedAtMs", "recovered", "relatedBotId", "relatedAccountId", "relatedOrderId", "atMs", "botId", "accountId", "orderId"]
}

/// 卡片 -> 观测态的映射器。纯函数：不读时钟（nowMs 由调用方给），不发网络。
public enum DeskMapper {
    /// 在**非主线程**上做卡片解析（冻结件 §9：ObservationStore 的刷新不得在主线程做解析）。
    ///
    /// 纯函数 + Sendable 输入输出，detached 任务里没有共享可变状态；
    /// 只有最终赋值回到 MainActor。用 detached 而不是普通 Task，是因为调用方在主 actor 上，
    /// 普通 Task 会继承主 actor 而达不到"离开主线程"的目的。
    public static func mapOffMain(
        snapshot: ObservationSnapshot,
        nowMs: Int,
        budget: TrustBudget = .clientDefault
    ) async -> DeskObservation {
        await Task.detached(priority: .userInitiated) {
            DeskMapper.map(snapshot: snapshot, nowMs: nowMs, budget: budget)
        }.value
    }

    /// 未知卡片类型一律进 unrecognizedCards，**不丢弃**。
    public static func map(
        snapshot: ObservationSnapshot,
        nowMs: Int,
        budget: TrustBudget = .clientDefault
    ) -> DeskObservation {
        let trust = trustValue(snapshot: snapshot, nowMs: nowMs, budget: budget)
        var unrecognized: [UnrecognizedCardObservation] = []
        var positions: [PositionObservation] = []
        var orders: [OrderObservation] = []
        var assets: [AssetObservation] = []
        var alerts: [AlertObservation] = []
        var events: [EventObservation] = []
        var deskId: String?
        var label: String?
        var phase: String?
        var waitReason: String?
        var summaryCurrency: String?
        var summaryEquity: String?
        var summaryAvailable: String?
        var summaryMargin: String?
        var summaryRealized: String?
        var summaryUnrealized: String?
        var costs: [AssetObservation] = []
        var report = DependencyReport.missing

        for card in snapshot.cards {
            guard let type = CardType(rawValue: card.cardType) else {
                unrecognized.append(UnrecognizedCardObservation(
                    cardId: card.cardId,
                    cardType: card.cardType,
                    revision: card.revision,
                    fallbackText: card.fallbackText,
                    rawFields: card.fields,
                    reason: "未知卡片类型（客户端需升级）"
                ))
                continue
            }
            let index = CardFieldIndex(card.fields)
            switch type {
            case .deskSummary:
                let raw = index.raw(excluding: RecognizedFieldKeys.deskSummary)
                deskId = index.string("deskId") ?? deskId
                label = index.string("label") ?? label
                phase = index.string("phase") ?? index.string("mode") ?? phase
                waitReason = index.string("waitReason") ?? waitReason
                summaryCurrency = index.string("currency") ?? summaryCurrency
                summaryEquity = index.string("equity") ?? summaryEquity
                summaryAvailable = index.string("available") ?? summaryAvailable
                summaryMargin = index.string("margin") ?? summaryMargin
                summaryRealized = index.string("realizedPnl") ?? summaryRealized
                summaryUnrealized = index.string("unrealizedPnl") ?? summaryUnrealized
                assets.append(contentsOf: assetRows(card: card, index: index, recognized: RecognizedFieldKeys.deskSummary, raw: raw))
            case .riskState:
                report = dependencyReport(card: card, index: index)
            case .position:
                let raw = index.raw(excluding: RecognizedFieldKeys.position)
                positions.append(PositionObservation(
                    cardId: card.cardId,
                    symbol: index.string("symbol"),
                    side: index.string("side"),
                    quantity: index.string("quantity"),
                    entryPrice: index.string("entryPrice") ?? index.string("avgPrice") ?? index.string("avgCost"),
                    pnl: index.string("pnl") ?? index.string("unrealizedPnl"),
                    fallbackText: card.fallbackText,
                    trust: trust,
                    rawFields: raw,
                    attribution: index.string("attribution") ?? index.string("botId")
                ))
            case .order:
                let raw = index.raw(excluding: RecognizedFieldKeys.order)
                orders.append(OrderObservation(
                    cardId: card.cardId,
                    symbol: index.string("symbol"),
                    side: index.string("side"),
                    price: index.string("price"),
                    quantity: index.string("quantity"),
                    state: index.string("state"),
                    fallbackText: card.fallbackText,
                    trust: trust,
                    stateSinceMs: index.int("stateSinceMs"),
                    filledQuantity: index.string("filledQuantity"),
                    rawFields: raw
                ))
            case .mandateStatus:
                let raw = index.raw(excluding: RecognizedFieldKeys.mandate)
                assets.append(contentsOf: assetRows(card: card, index: index, recognized: RecognizedFieldKeys.mandate, raw: raw))
                costs.append(contentsOf: costRows(card: card, index: index, trust: trust))
                summaryCurrency = index.string("currency") ?? summaryCurrency
                summaryEquity = index.string("equity") ?? summaryEquity
                summaryAvailable = index.string("available") ?? summaryAvailable
                summaryMargin = index.string("margin") ?? summaryMargin
                summaryRealized = index.string("realizedPnl") ?? summaryRealized
                summaryUnrealized = index.string("unrealizedPnl") ?? summaryUnrealized
            case .freshness:
                break
            case .escalation, .journalGap, .systemNotice:
                let raw = index.raw(excluding: RecognizedFieldKeys.alert)
                alerts.append(alertRow(card: card, index: index, trust: trust, raw: raw))
                if let atMs = index.int("atMs") ?? index.int("firstSeenMs") {
                    events.append(EventObservation(
                        atMs: atMs,
                        kind: card.cardType,
                        title: index.string("title") ?? card.fallbackText,
                        detail: index.string("reason") ?? index.string("impact")
                    ))
                }
            case .decision, .triggerTrace, .controlPanel:
                // 这三类属于决策/控制面，不产出观测项；不认识的 key 仍要能露出来。
                let raw = index.fields
                if !raw.isEmpty {
                    events.append(EventObservation(
                        atMs: index.int("atMs") ?? snapshot.atMs,
                        kind: card.cardType,
                        title: index.string("title") ?? card.fallbackText,
                        detail: nil
                    ))
                }
            }
        }

        let focusCandidate = positions.compactMap(\.symbol).first ?? report.priceStates.first?.symbol
        let focusSymbol = (focusCandidate?.isEmpty == false) ? focusCandidate : nil
        let dependency = DependencyHealth.from(report, symbol: focusSymbol)
        let permission = report.permission(for: focusSymbol)
        let issues = DependencyAssessment.issues(report, permission: permission, symbol: focusSymbol)
        let blockers = DependencyAssessment.blockers(issues)
        let assessment = ObservationProjector.assess(
            reachability: snapshot.reachability,
            execution: snapshot.execution,
            dependency: dependency,
            trust: trust,
            heartbeat: snapshot.heartbeat ?? HeartbeatStatus(lastBeatAtMs: nil, policy: HeartbeatPolicy(intervalMs: 15_000, graceFactor: 3)),
            atMs: nowMs,
            openRiskAllowed: permission.openRiskAllowed,
            blockers: blockers
        )

        let botStatus = BotStatus(
            reachability: snapshot.reachability,
            execution: snapshot.execution,
            dependency: dependency,
            trust: trust,
            deskId: deskId,
            label: label,
            phase: phase,
            waitReason: waitReason,
            assessment: assessment,
            lastConfirmedHealthyAtMs: nil
        )

        events.sort { $0.atMs > $1.atMs }

        return DeskObservation(
            bot: botStatus,
            positions: positions,
            orders: orders,
            assets: assets,
            alerts: alerts,
            generatedAtMs: nowMs,
            bots: [botStatus],
            events: events,
            assetsSummary: AssetsSummaryObservation(
                currency: summaryCurrency,
                equity: summaryEquity,
                available: summaryAvailable,
                margin: summaryMargin,
                realizedPnl: summaryRealized,
                unrealizedPnl: summaryUnrealized,
                costs: costs
            ),
            fills: [],
            cashMovements: [],
            connection: nil,
            unrecognizedCards: unrecognized,
            sourceId: snapshot.sourceId
        )
    }

    /// 可信度：**取快照自身年龄与 freshness 卡片自述中更保守的一档**。
    ///
    /// 为什么要取更保守：freshness 卡片的 age 是**服务端在抓取时**的自述，
    /// 而快照年龄是**客户端手里这份数据的真实账龄**。断线期间账龄继续增长，
    /// 若因为卡片自称 fresh 就判 fresh，就会把"断线前的一瞬间"当成"现在" ——
    /// 这正是冻结件 §9「断线不得清空本地最后快照，但 DataTrust 必须如实降档」要防的事。
    public static func trustValue(snapshot: ObservationSnapshot, nowMs: Int, budget: TrustBudget) -> DataTrust {
        let bySnapshotAge = DataTrustPolicy.trust(age: budget.age(ofMs: nowMs - snapshot.atMs))
        guard let freshness = snapshot.cards.first(where: { $0.cardType == CardType.freshness.rawValue }) else {
            return bySnapshotAge
        }
        let index = CardFieldIndex(freshness.fields)
        if let raw = index.string("age") {
            return moreCautious(bySnapshotAge, DataTrustPolicy.trust(stalenessRawValue: raw))
        }
        if let ageMs = index.int("ageMs") {
            return moreCautious(bySnapshotAge, DataTrustPolicy.trust(age: budget.age(ofMs: ageMs)))
        }
        return bySnapshotAge
    }

    /// 取更保守的一档（fresh < aging < stale < expired，unknown 最保守）。
    public static func moreCautious(_ left: DataTrust, _ right: DataTrust) -> DataTrust {
        rank(left) >= rank(right) ? left : right
    }

    private static func rank(_ trust: DataTrust) -> Int {
        switch trust {
        case .fresh: return 0
        case .aging: return 1
        case .stale: return 2
        case .expired: return 3
        case .unknown: return 4
        }
    }

    /// risk-state 卡片 -> 依赖零件箱。
    /// **只把卡片真正报出来的维度放进去**；没报的留 nil（不声称健康，也不声称坏了）。
    public static func dependencyReport(card: Card, index: CardFieldIndex) -> DependencyReport {
        let symbol = index.string("symbol")
        var priceStates: [InstrumentPriceState] = []
        if let alignmentRaw = index.string("alignment") {
            priceStates = [InstrumentPriceState(
                symbol: symbol ?? "",
                alignment: ClosedEnum<InstrumentAlignment>(rawValue: alignmentRaw)
            )]
        }
        return DependencyReport(
            marketData: closedEnum(index.string("marketData")),
            tradeChannel: closedEnum(index.string("tradeChannel")),
            accountSync: closedEnum(index.string("accountSync")),
            riskLevel: index.string("level").map { ClosedEnum<RiskLevel>(rawValue: $0) },
            priceStates: priceStates
        )
    }

    /// 有原文才解析；没报就是 nil。
    private static func closedEnum<Value: ClosedEnumValue>(_ raw: String?) -> ClosedEnum<Value>? {
        guard let raw else { return nil }
        return ClosedEnum<Value>(rawValue: raw)
    }

    private static func assetRows(card: Card, index: CardFieldIndex, recognized: Set<String>, raw: [CardField]) -> [AssetObservation] {
        let rows = ["equity", "available", "margin", "limit", "used"].compactMap { key -> AssetObservation? in
            guard let value = index.string(key) else { return nil }
            let sourceField = card.fields.first { $0.key == key }
            return AssetObservation(
                cardId: card.cardId,
                label: sourceField?.label ?? key,
                value: value,
                unit: sourceField?.unit,
                trust: .fresh,
                rawFields: []
            )
        }
        if rows.isEmpty && !raw.isEmpty {
            return [AssetObservation(cardId: card.cardId, label: card.fallbackText, value: "", unit: nil, trust: .fresh, rawFields: raw)]
        }
        return rows
    }

    private static func costRows(card: Card, index: CardFieldIndex, trust: DataTrust) -> [AssetObservation] {
        guard let costs = index.string("costs") else { return [] }
        return [AssetObservation(cardId: card.cardId, label: "成本项", value: costs, unit: nil, trust: trust, rawFields: [])]
    }

    private static func alertRow(card: Card, index: CardFieldIndex, trust: DataTrust, raw: [CardField]) -> AlertObservation {
        let verdict = validateCard(card)
        let unknownActions = card.actions.filter { ActionKind(rawValue: $0.kind) == nil }
        return AlertObservation(
            cardId: card.cardId,
            severity: index.string("severity") ?? "info",
            title: index.string("title") ?? card.fallbackText,
            actions: card.actions,
            operable: verdict.operable && unknownActions.isEmpty,
            fallbackText: card.fallbackText,
            trust: trust,
            firstSeenMs: index.int("firstSeenMs"),
            lastSeenMs: index.int("lastSeenMs"),
            recoveredAtMs: index.int("recoveredAtMs"),
            repeatCount: index.int("repeatCount"),
            readAtMs: index.int("readAtMs"),
            acknowledgedAtMs: index.int("acknowledgedAtMs"),
            recovered: index.bool("recovered"),
            relatedBotId: index.string("relatedBotId") ?? index.string("botId"),
            relatedAccountId: index.string("relatedAccountId") ?? index.string("accountId"),
            relatedOrderId: index.string("relatedOrderId") ?? index.string("orderId"),
            reason: index.string("reason"),
            impact: index.string("impact"),
            rawFields: raw
        )
    }
}
