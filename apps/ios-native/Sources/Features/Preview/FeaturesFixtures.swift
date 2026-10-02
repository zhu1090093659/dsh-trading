//
//  FeaturesFixtures.swift
//  Features
//
//  快照/预览夹具。**只在 DEBUG 编译**：它不进发布产物，也不假装是数据源。
//  夹具只构造呈现层模型（FeaturesState），因此渲染证据不需要网络、不需要领域逻辑。
//

#if DEBUG
import Foundation

public enum FeaturesFixtures {
    public static let sampleNowMs = 1_790_000_000_000

    // MARK: - 轴

    public static func axis(_ title: String, _ value: String, _ tone: ThemeTone, _ image: String, _ detail: String? = nil) -> AxisPresentation {
        AxisPresentation(title: title, value: value, tone: tone, systemImage: image, detail: detail)
    }

    public static func axes(execution: AxisPresentation, dependency: AxisPresentation, trust: AxisPresentation) -> StateAxesPresentation {
        StateAxesPresentation(execution: execution, dependency: dependency, trust: trust)
    }

    public static func healthyAxes() -> StateAxesPresentation {
        axes(
            execution: axis("执行状态", "运行中", .positive, "circle.fill"),
            dependency: axis("依赖健康", "依赖正常", .positive, "link"),
            trust: axis("数据可信度", "最新", .positive, "checkmark.circle")
        )
    }

    public static func restrictedAxes() -> StateAxesPresentation {
        axes(
            execution: axis("执行状态", "运行中", .positive, "circle.fill"),
            dependency: axis("依赖健康", "依赖异常：行情延迟、交易通道降级", .warning, "link", "行情延迟、交易通道降级"),
            trust: axis("数据可信度", "最新", .positive, "checkmark.circle")
        )
    }

    public static func unreachableAxes() -> StateAxesPresentation {
        axes(
            execution: axis("执行状态", "无法判定", .unknown, "questionmark.circle"),
            dependency: axis("依赖健康", "依赖状况未知", .unknown, "link"),
            trust: axis("数据可信度", "尚未确认", .unknown, "questionmark.circle", "数据尚未确认，请联网获取")
        )
    }

    public static func expiredAxes() -> StateAxesPresentation {
        axes(
            execution: axis("执行状态", "运行中", .positive, "circle.fill"),
            dependency: axis("依赖健康", "依赖正常", .positive, "link"),
            trust: axis("数据可信度", "已过期", .critical, "xmark.circle", "本地数据已过期，请联网获取后再操作")
        )
    }

    // MARK: - 动作

    public static func actions() -> [ActionPresentation] {
        [
            ActionPresentation(id: "ack", kind: "ack", label: "知道了", enabled: true, requiresBiometric: false, isUnknownKind: false, scopeLabel: "只读", confirmNote: nil),
            ActionPresentation(id: "approve", kind: "approve", label: "批准", enabled: true, requiresBiometric: true, isUnknownKind: false, scopeLabel: "指令", confirmNote: nil),
            ActionPresentation(id: "kill", kind: "kill", label: "紧急停机", enabled: true, requiresBiometric: true, isUnknownKind: false, scopeLabel: "控制", confirmNote: "控制类动作：需强确认（生物识别）；服务端仍会重新判定授权与风控。"),
            ActionPresentation.unknown(rawKind: "escalate-to-operator")
        ]
    }

    // MARK: - 告警

    public static func alerts(trust: TrustFixture) -> [AlertPresentation] {
        let renders = trust == .fresh
        return [
            AlertPresentation(
                id: "esc-1",
                severity: .critical,
                title: "行情延迟 12s，已禁止新增仓位",
                lifecycle: AlertLifecyclePresentation(readAtMs: sampleNowMs - 300_000, acknowledgedAtMs: sampleNowMs - 240_000, recoveredAtMs: nil, isRecovered: false, firstSeenMs: sampleNowMs - 3_600_000, lastSeenMs: sampleNowMs - 60_000, repeatCount: 7),
                relatedBot: TraceLinkPresentation(id: "bot:alpha", label: "机器人 Alpha", target: .bot("alpha")),
                relatedAccount: TraceLinkPresentation(id: "account:okx-demo", label: "账户 okx-demo", target: .account("okx-demo")),
                relatedOrder: TraceLinkPresentation(id: "order:ord_1", label: "订单 ord_…a1", target: .order("ord_1")),
                reason: "行情快照年龄超过预算，RiskGate 降到只减不增",
                impact: "不会新增仓位；保护性挂单保留",
                fallbackText: "行情延迟，已限制开新仓",
                operable: true,
                unknownEnumReason: nil,
                rendersData: renders,
                notice: trust.notice,
                axes: trust == .fresh ? restrictedAxes() : expiredAxes(),
                actions: actions()
            ),
            AlertPresentation(
                id: "esc-2",
                severity: .warning,
                title: "账户同步落后 3 个周期",
                lifecycle: AlertLifecyclePresentation(readAtMs: sampleNowMs - 500_000, acknowledgedAtMs: nil, recoveredAtMs: sampleNowMs - 120_000, isRecovered: true, firstSeenMs: sampleNowMs - 7_200_000, lastSeenMs: sampleNowMs - 200_000, repeatCount: 2),
                relatedBot: TraceLinkPresentation(id: "bot:beta", label: "机器人 Beta", target: .bot("beta")),
                relatedAccount: nil,
                relatedOrder: nil,
                reason: "对账面未完成",
                impact: "数字可能略旧",
                fallbackText: "账户同步落后",
                operable: true,
                unknownEnumReason: nil,
                rendersData: renders,
                notice: trust.notice,
                axes: trust == .fresh ? healthyAxes() : expiredAxes(),
                actions: [ActionPresentation(id: "ack", kind: "ack", label: "知道了", enabled: true, requiresBiometric: false, isUnknownKind: false, scopeLabel: "只读", confirmNote: nil)]
            ),
            AlertPresentation(
                id: "esc-3",
                severity: .unknown("emergency"),
                title: "服务端新增了一类告警（本客户端不认识）",
                lifecycle: AlertLifecyclePresentation(readAtMs: nil, acknowledgedAtMs: nil, recoveredAtMs: nil, isRecovered: nil, firstSeenMs: sampleNowMs - 30_000, lastSeenMs: sampleNowMs - 30_000, repeatCount: nil),
                relatedBot: nil,
                relatedAccount: nil,
                relatedOrder: nil,
                reason: nil,
                impact: nil,
                fallbackText: "未知严重等级的告警",
                operable: false,
                unknownEnumReason: "这张卡片含本客户端不认识的取值（未知 closed 枚举），已禁用全部动作。",
                rendersData: renders,
                notice: trust.notice,
                axes: trust == .fresh ? healthyAxes() : expiredAxes(),
                actions: [ActionPresentation.unknown(rawKind: "escalate-to-operator")]
            )
        ]
    }

    // MARK: - 机器人

    public static func bot(
        id: String,
        label: String,
        state: BotStateKind,
        axes: StateAxesPresentation,
        phase: String?,
        waitReason: String?,
        issues: [String],
        trust: TrustFixture
    ) -> BotPresentation {
        let renders = trust == .fresh
        return BotPresentation(
            id: id,
            label: label,
            identity: IdentityPresentation(botLabel: label, botId: id, strategyLabel: "ema-cross 3.2.1", strategyHash: "sha256:9f2a…", runLabel: "run-2026-10-02-01", runHost: "bot-01.internal"),
            state: state,
            stateDetail: "最后一次确认运行正常：3 分钟前",
            axes: axes,
            phase: phase,
            waitReason: waitReason,
            dependencyIssues: issues,
            positionCount: renders ? 2 : nil,
            activeOrderCount: renders ? 3 : nil,
            lastConfirmedHealthyAtMs: sampleNowMs - 180_000,
            runtimeMode: .simulated,
            rendersData: renders,
            notice: trust.notice,
            generatedAtMs: sampleNowMs - 12_000,
            sourceId: "okx-demo",
            timeline: events(trust: trust),
            positions: renders ? positions() : [],
            orders: renders ? orders() : [],
            recentFills: [],
            decisionSummary: "EMA 双均线金叉，计划加仓 0.05 BTC；风控此刻不允许新增风险，因此只记录不执行。",
            decisionBlockedReason: "禁止新增仓位（RiskGate 只减不增）",
            actions: actions()
        )
    }

    public static func positions() -> [PositionPresentation] {
        [
            PositionPresentation(id: "pos-1", symbol: "BTC/USDT", side: "long", quantity: "0.42", entryPrice: "61230.5", pnl: "+312.40", attribution: "机器人 Alpha", isAttributionReliable: true, fallbackText: "BTC 多头 0.42", rendersData: true, notice: nil, axes: healthyAxes(), actions: []),
            PositionPresentation(id: "pos-2", symbol: "ETH/USDT", side: "short", quantity: "3.0", entryPrice: "2410.2", pnl: "-88.10", attribution: nil, isAttributionReliable: false, fallbackText: "ETH 空头 3.0", rendersData: true, notice: nil, axes: healthyAxes(), actions: [])
        ]
    }

    public static func orders() -> [OrderPresentation] {
        [
            OrderPresentation(id: "ord_1", symbol: "BTC/USDT", side: "buy", price: "60800", quantity: "0.05", filledQuantity: "0.02", stateRaw: "partiallyFilled", stage: .partiallyFilled, stateSinceMs: sampleNowMs - 45_000, attribution: "机器人 Alpha", fallbackText: "部分成交", rendersData: true, notice: nil, axes: restrictedAxes(), actions: []),
            OrderPresentation(id: "ord_2", symbol: "ETH/USDT", side: "sell", price: "2395", quantity: "1.0", filledQuantity: nil, stateRaw: "cancelPending", stage: .cancelPending, stateSinceMs: sampleNowMs - 5_000, attribution: "机器人 Alpha", fallbackText: "撤单处理中", rendersData: true, notice: nil, axes: healthyAxes(), actions: []),
            OrderPresentation(id: "ord_3", symbol: "SOL/USDT", side: "buy", price: "148.2", quantity: "12", filledQuantity: nil, stateRaw: "submittedUnknown", stage: .submittedUnknown, stateSinceMs: sampleNowMs - 90_000, attribution: nil, fallbackText: "已报出但结果未知", rendersData: true, notice: nil, axes: restrictedAxes(), actions: []),
            OrderPresentation(id: "ord_4", symbol: "DOGE/USDT", side: "buy", price: "0.128", quantity: "5000", filledQuantity: nil, stateRaw: "weird-new-state", stage: .unknownState("weird-new-state"), stateSinceMs: nil, attribution: nil, fallbackText: "未知状态", rendersData: true, notice: nil, axes: healthyAxes(), actions: [])
        ]
    }

    public static func summary(trust: TrustFixture) -> AssetsSummaryPresentation {
        AssetsSummaryPresentation(
            currency: "USDT",
            equity: "128,420.55",
            available: "41,220.10",
            margin: "87,200.45",
            realizedPnl: "+2,140.20",
            unrealizedPnl: "+820.30",
            costs: [
                AssetPresentation(id: "cost-fee", label: "手续费", value: "312.40", unit: "USDT", attribution: nil, fallbackText: "", rendersData: true, notice: nil, axes: healthyAxes()),
                AssetPresentation(id: "cost-funding", label: "资金费", value: "-48.10", unit: "USDT", attribution: nil, fallbackText: "", rendersData: true, notice: nil, axes: healthyAxes())
            ],
            rendersData: trust == .fresh,
            notice: trust.notice,
            axes: trust == .fresh ? healthyAxes() : expiredAxes()
        )
    }

    public static func events(trust: TrustFixture) -> [EventPresentation] {
        [
            EventPresentation(id: "e1", atMs: sampleNowMs - 60_000, kind: "degradation", title: "行情延迟触发受限交易", detail: "RiskGate -> reduce_only", tone: .warning),
            EventPresentation(id: "e2", atMs: sampleNowMs - 240_000, kind: "escalation", title: "升级到人：是否继续保持只减不增", detail: nil, tone: .critical),
            EventPresentation(id: "e3", atMs: sampleNowMs - 900_000, kind: "recovery", title: "交易通道恢复正常", detail: "通道心跳恢复", tone: .positive)
        ]
    }

    public enum TrustFixture: String, Sendable {
        case fresh
        case expired

        public var notice: String? {
            switch self {
            case .fresh: return nil
            case .expired: return "本地数据已过期，请联网获取后再操作"
            }
        }
    }

    // MARK: - 顶层

    public static func connection(trust: TrustFixture, reachable: Bool) -> ConnectionPresentation {
        ConnectionPresentation(
            linkLabel: reachable ? "已连接" : "连接中断",
            linkTone: reachable ? .positive : .unknown,
            linkIsDown: !reachable,
            isReachable: reachable,
            originLabel: "https://bot-01.internal:8443",
            deviceLabel: "iPhone · 设备 7f3a",
            scopes: ["read", "command"],
            caps: ["action:ack", "action:approve", "action:kill"],
            apiVersionLabel: "v1.0",
            lastUpdatedMs: reachable ? sampleNowMs - 12_000 : nil,
            sourceId: "okx-demo",
            notice: reachable ? nil : "看不到机器人：与监控服务连接中断"
        )
    }

    public static func settings(connection: ConnectionPresentation, runtimeMode: RuntimeMode) -> SettingsPresentation {
        SettingsPresentation(
            connection: connection,
            scopes: ["read", "command"],
            defaultScopes: ["read"],
            explicitScopes: ["control"],
            notificationMutedDesks: ["beta"],
            privacyHidesAmounts: false,
            displayThemePreference: "system",
            runtimeMode: runtimeMode,
            contractGaps: [
                "成交（fill）面：当前 12 个封闭卡片类型里没有成交卡片，成交列表显示未知",
                "资金变动面：缺卡片，显示未知",
                "机器人「当前阶段 / 等待原因」：卡片未提供，显示未知",
                "订单 stateSinceMs / filledQuantity：卡片未提供逐字段映射时显示未知",
                "运行形态（实盘/模拟）：无法从契约面判定，由 App 装配时注入，缺省显示「形态未知」",
                "归因置信度（AttributionConfidence）：未接进观测项，只能显示字符串归属"
            ]
        )
    }

    public static func state(
        runtimeMode: RuntimeMode = .simulated,
        primaryState: BotStateKind = .runningRestricted,
        trust: TrustFixture = .fresh,
        reachable: Bool = true
    ) -> FeaturesState {
        let axesValue: StateAxesPresentation
        switch primaryState {
        case .unreachable, .unknownDisconnected, .neverConfirmed, .indeterminateExecution:
            axesValue = unreachableAxes()
        case .runningRestricted, .paused, .faulted:
            axesValue = restrictedAxes()
        default:
            axesValue = trust == .fresh ? healthyAxes() : expiredAxes()
        }
        let primary = bot(
            id: "alpha",
            label: "Alpha",
            state: primaryState,
            axes: axesValue,
            phase: "等待风控放行",
            waitReason: "禁止新增仓位（RiskGate 只减不增）",
            issues: primaryState == .runningRestricted ? ["行情延迟", "交易通道降级"] : [],
            trust: trust
        )
        let secondary = bot(
            id: "beta",
            label: "Beta",
            state: .operational,
            axes: healthyAxes(),
            phase: "持有中",
            waitReason: nil,
            issues: [],
            trust: trust
        )
        let connectionValue = connection(trust: trust, reachable: reachable)
        let alertsValue = alerts(trust: trust)
        let assetsValue = AssetsPresentation(
            summary: summary(trust: trust),
            positions: trust == .fresh ? positions() : [],
            orders: trust == .fresh ? orders() : [],
            fills: [],
            cashMovements: [],
            runtimeMode: runtimeMode,
            generatedAtMs: sampleNowMs - 12_000,
            sourceId: "okx-demo"
        )
        let warning = primaryState.isUnknown || primaryState == .runningRestricted
            ? "当前有 2 台机器人依赖异常、1 台状态未知/看不到。账户收益即使为正，也不能说明自动交易系统正常。"
            : nil
        let overview = OverviewPresentation(
            connection: connectionValue,
            runtimeMode: runtimeMode,
            generatedAtMs: sampleNowMs - 12_000,
            sourceId: "okx-demo",
            totalBots: 2,
            healthBuckets: [
                HealthBucketPresentation(id: "operational", label: "运行中", count: 1, tone: .positive),
                HealthBucketPresentation(id: "runningRestricted", label: "运行中（受限）", count: primaryState == .runningRestricted ? 1 : 0, tone: .warning),
                HealthBucketPresentation(id: "paused", label: "已暂停", count: primaryState == .paused ? 1 : 0, tone: .warning),
                HealthBucketPresentation(id: "stoppedConfirmed", label: "已停止", count: primaryState == .stoppedConfirmed ? 1 : 0, tone: .neutral),
                HealthBucketPresentation(id: "unknown", label: "状态未知/看不到", count: primaryState.isUnknown ? 1 : 0, tone: .unknown)
            ],
            dependencyAnomalyCount: primaryState == .runningRestricted ? 1 : 0,
            unknownCount: primaryState.isUnknown ? 1 : 0,
            profitIsNotHealthWarning: warning,
            topAlerts: alertsValue,
            recentEvents: events(trust: trust),
            assets: summary(trust: trust),
            rendersData: true,
            notice: nil,
            axes: axesValue
        )
        return FeaturesState(
            overview: overview,
            bots: [primary, secondary],
            alerts: alertsValue,
            assets: assetsValue,
            settings: settings(connection: connectionValue, runtimeMode: runtimeMode),
            connection: connectionValue,
            runtimeMode: runtimeMode,
            emptyMessage: nil,
            unrecognizedCards: [
                UnrecognizedCardPresentation(id: "card-new", cardType: "position-v2", revision: 4, fallbackText: "服务端新增了一种卡片类型", reason: "未知 cardType：position-v2")
            ]
        )
    }
}
#endif
