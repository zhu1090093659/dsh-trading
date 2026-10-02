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

    /// 客户端展示预算：**由契约面的 StalenessBudget 派生**（一个事实只有一个家）。
    ///
    /// 为什么必须派生而不是各写各的：Domain 的渲染判据与 Offline 的缓存判据曾经是
    /// 两个独立的毫秒常量（3_600_000 与 30 分钟），于是"同一份缓存算不算过期"
    /// 在两个层里得到两个答案 —— 跨源污染的暴露窗口也就有了两个口径。
    /// 现在唯一的毫秒事实是 `StalenessBudget`（App 组合根注入），TrustBudget 只做
    /// "契约三档 → 渲染四档"的同构映射；契约面的 ttlMs 是渲染判据。
    public static func from(_ budget: StalenessBudget) -> TrustBudget {
        TrustBudget(
            freshMs: budget.freshMs,
            // 契约三档没有独立的"aging"边界：aging 在这里取 fresh 与 stale 的中点，
            // 只影响徽标措辞（"可能已变化"），不影响"能不能渲染"。
            agingMs: budget.freshMs + (budget.staleMs - budget.freshMs) / 2,
            staleMs: budget.staleMs,
            ttlMs: budget.ttlMs
        )
    }

    /// 客户端展示预算（与契约 offline.ts 的三档语义同构）。
    public static let clientDefault = TrustBudget.from(ObservationStalenessBudget.clientDefault)

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

    /// 整数 key 的文本形态。`Int(String)` 是**全定义**的：越界或非法都返回 nil，不会 trap
    /// （与本文件里 Double -> Int 的转换是两回事）。语义保持不变：只认纯整数字面量，
    /// "3.5"、"1e3" 这类一律判 nil。字符串已在 `string(_:)` 里 trim 过。
    public func int(_ key: String) -> Int? {
        guard let raw = string(key) else { return nil }
        return Int(raw)
    }

    /// 取整条字段（需要 unit 之类元信息时用）。
    public func field(_ key: String) -> CardField? {
        fields.first { $0.key == key }
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

/// `Double` -> `Int` 的**唯一**安全转换口。
///
/// Swift 的 `Int(_: Double)` 在 NaN / ±Inf / 超出 Int 范围时是
/// **trap（进程终止，不可 catch）**，而卡片字段值只受**字符串长度**约束
/// （TS cards.ts 的 maxValueChars）——"1e100" 只有 5 个字符，服务端按契约判合法。
/// 一张"服务端认为完全合法"的卡片因此足以让客户端当场崩溃。
/// 把范围判据收在这一处：判不出来就返回 nil，由调用方走"未知/不显示"，
/// **给不出一个可能错的具体数字**。
enum NumericRangeGuard {
    /// Int 可无条件表示的上界（2^63，半开区间）。
    /// Double 在 2^63 附近只能精确表示 2^63 与 2^63 - 1024；用半开区间把"恰好等于 2^63"
    /// 也判成越界，而不是去赌平台上的舍入行为。
    static let upperBoundExclusive: Double = 9_223_372_036_854_775_808
    static let lowerBoundInclusive: Double = -9_223_372_036_854_775_808

    /// 值有限且落在 Int 能无条件表示的范围里。
    static func isRepresentable(_ value: Double) -> Bool {
        value.isFinite && value >= lowerBoundInclusive && value < upperBoundExclusive
    }

    /// 转换成 Int；越界或非有限 ⇒ nil（fail-closed）。
    static func int(_ value: Double) -> Int? {
        guard isRepresentable(value) else { return nil }
        return Int(value)
    }
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
        // 形状一：age 是**档位名**（fresh/aging/stale/expired）。
        if let raw = index.string("age"), let band = DataTrust(rawValue: raw) {
            return moreCautious(bySnapshotAge, band)
        }
        // 形状二：age 是**时长**（服务端常给 "1" + unit "s"）；ageMs 同理。
        if let ageMs = index.int("ageMs") ?? DeskMapper.ageMs(fromField: index.field("age")) {
            return moreCautious(bySnapshotAge, DataTrustPolicy.trust(age: budget.age(ofMs: ageMs)))
        }
        // 认不出来的 age 值**不把整份数据判成未知** —— 回退到我们自己量到的快照账龄，
        // 那是独立证据，比"因为一个字段看不懂就什么都不显示"更保守也更诚实。
        return bySnapshotAge
    }

    /// 把 freshness 的 age 字段当**时长**解析：默认毫秒，"s"/"m" 按单位换算。
    ///
    /// 为什么必须支持这一形态：契约 offline.ts 的年龄本来就是毫秒数；
    /// 只认档位名会让服务端给 "1"+unit"s" 时整份观测被判成未知（实测过，界面只剩"数据不可渲染"）。
    ///
    /// **范围守则在数值域这一侧必须硬**（审查 C4）：字段值只受**字符串长度**约束，
    /// "1e100" 只有 5 个字符 ⇒ 服务端按契约判合法，而 `Int(Double)` 在 NaN / ±Inf / 越界时
    /// 是 **trap（进程终止，不可 catch）**。因此**值**与**换算后的乘积**都要过范围检查，
    /// 任一条不满足 ⇒ nil。返回 nil 的后果是"这个年龄读不出来"，调用方按"未知"处理，
    /// **绝不**把它当成一个具体的年龄（更不当作 fresh）。
    public static func ageMs(fromField field: CardField?) -> Int? {
        guard let field, let raw = field.value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        guard let value = Double(raw), value >= 0, NumericRangeGuard.isRepresentable(value) else { return nil }
        // 每一条单位分支各自做范围检查：值合法**不代表**乘积合法
        // （1e15 秒 = 1e18 毫秒合法，1e15 分 = 6e19 毫秒越界）。
        switch (field.unit ?? "ms").lowercased() {
        case "s", "sec", "secs", "second", "seconds":
            return NumericRangeGuard.int(value * 1_000)
        case "m", "min", "mins", "minute", "minutes":
            return NumericRangeGuard.int(value * 60_000)
        default:
            return NumericRangeGuard.int(value)
        }
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
