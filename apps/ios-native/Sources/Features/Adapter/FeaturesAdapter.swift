//
//  FeaturesAdapter.swift
//  Features
//
//  Domain -> Features 的**唯一翻译点**。视图不 import Domain 语义判定，也不 import Transport；
//  所有「这个状态该显示成什么」的翻译都发生在这里。
//
//  三条纪律：
//    1. 不认识的 closed 枚举 / 缺字段一律翻译成「未知」，**不填 0、不猜**；
//    2. 三维语义各自翻译，永不合并（BotStateKind 的 case 分法保证"看不见"与"已停止"不同）；
//    3. 数据不可信（DataTrust.rendersData == false）时 rendersData 传 false，视图只渲染提示。
//

import Foundation
import DshTradingContract
import DshTradingDomain

/// 装配呈现状态所需的全部输入。App 组合根负责提供；Features 不自己去问网络。
public struct FeaturesAdapterInput: Sendable {
    public let observation: DeskObservation?
    public let runtimeMode: RuntimeMode
    public let nowMs: Int
    public let notificationMutedDesks: [String]
    public let privacyHidesAmounts: Bool
    public let displayThemePreference: String
    public let contractGaps: [String]

    public init(
        observation: DeskObservation?,
        runtimeMode: RuntimeMode = .unknown,
        nowMs: Int,
        notificationMutedDesks: [String] = [],
        privacyHidesAmounts: Bool = false,
        displayThemePreference: String = "system",
        contractGaps: [String] = []
    ) {
        self.observation = observation
        self.runtimeMode = runtimeMode
        self.nowMs = nowMs
        self.notificationMutedDesks = notificationMutedDesks
        self.privacyHidesAmounts = privacyHidesAmounts
        self.displayThemePreference = displayThemePreference
        self.contractGaps = contractGaps
    }
}

public enum FeaturesAdapter {
    // MARK: - 顶层

    public static func featuresState(from input: FeaturesAdapterInput) -> FeaturesState {
        let observation = input.observation
        let statuses = botStatuses(observation)
        let caps = observation?.connection?.caps ?? []
        let connection = connectionPresentation(observation, runtimeMode: input.runtimeMode, nowMs: input.nowMs)
        let bots = botPresentations(observation, statuses: statuses, input: input, caps: caps)
        let alerts = alertPresentations(observation, statuses: statuses, input: input, caps: caps)
        let assets = assetsPresentation(observation, input: input, caps: caps)
        let overview = overviewPresentation(observation, statuses: statuses, bots: bots, alerts: alerts, assets: assets, connection: connection, input: input)
        let settings = settingsPresentation(observation, connection: connection, input: input)
        let unrecognized = (observation?.unrecognizedCards ?? []).map { card in
            UnrecognizedCardPresentation(
                id: card.cardId,
                cardType: card.cardType,
                revision: card.revision,
                fallbackText: card.fallbackText,
                reason: card.reason
            )
        }
        return FeaturesState(
            overview: overview,
            bots: bots,
            alerts: alerts,
            assets: assets,
            settings: settings,
            connection: connection,
            runtimeMode: input.runtimeMode,
            emptyMessage: observation == nil ? "还没有拿到任何观测数据 —— 这不等于「没有机器人」，请先完成配对并联网。" : nil,
            unrecognizedCards: unrecognized
        )
    }

    static func botStatuses(_ observation: DeskObservation?) -> [BotStatus] {
        guard let observation else { return [] }
        if observation.bots.isEmpty { return [observation.bot] }
        return observation.bots
    }

    // MARK: - 连接

    static func connectionPresentation(_ observation: DeskObservation?, runtimeMode: RuntimeMode, nowMs: Int) -> ConnectionPresentation {
        guard let observation else { return .unknown }
        let link = observation.connection?.link ?? (observation.bot.reachability.isReachable ? MonitorLinkState.connected : MonitorLinkState.down)
        let isReachable = observation.bot.reachability.isReachable
        var apiVersionLabel: String?
        if let major = observation.connection?.apiMajor {
            apiVersionLabel = "v" + String(major) + "." + String(observation.connection?.apiMinor ?? 0)
        }
        var notice: String?
        if case let .unreachable(reason) = observation.bot.reachability {
            notice = "看不到机器人：" + reason
        }
        return ConnectionPresentation(
            linkLabel: link.label,
            linkTone: link == .down ? .unknown : (link == .degraded ? .warning : .positive),
            linkIsDown: link == .down,
            isReachable: isReachable,
            originLabel: observation.connection?.originLabel,
            deviceLabel: observation.connection?.deviceLabel,
            scopes: (observation.connection?.scopes ?? []).map(\.rawValue),
            caps: observation.connection?.caps ?? [],
            apiVersionLabel: apiVersionLabel,
            lastUpdatedMs: observation.generatedAtMs == 0 ? nil : observation.generatedAtMs,
            sourceId: observation.sourceId.isEmpty ? nil : observation.sourceId,
            notice: notice
        )
    }

    // MARK: - 三维

    public static func trustLabel(_ trust: DataTrust) -> String {
        switch trust {
        case .fresh: return "最新"
        case .aging: return "可能已变化"
        case .stale: return "陈旧"
        case .expired: return "已过期"
        case .unknown: return "尚未确认"
        }
    }

    static func trustTone(_ trust: DataTrust) -> ThemeTone {
        switch trust {
        case .fresh: return .positive
        case .aging: return .info
        case .stale: return .warning
        case .expired: return .critical
        case .unknown: return .unknown
        }
    }

    static func trustImage(_ trust: DataTrust) -> String {
        switch trust {
        case .fresh: return "checkmark.circle"
        case .aging: return "clock"
        case .stale: return "clock.badge.exclamationmark"
        case .expired: return "xmark.circle"
        case .unknown: return "questionmark.circle"
        }
    }

    static func executionTone(_ execution: ExecutionState) -> ThemeTone {
        switch execution {
        case .running: return .positive
        case .paused: return .warning
        case .killed: return .neutral
        case .indeterminate: return .unknown
        }
    }

    static func executionImage(_ execution: ExecutionState) -> String {
        switch execution {
        case .running: return "circle.fill"
        case .paused: return "pause.circle.fill"
        case .killed: return "stop.circle.fill"
        case .indeterminate: return "questionmark.circle"
        }
    }

    static func dependencyTone(_ dependency: DependencyHealth) -> ThemeTone {
        switch dependency {
        case .healthy: return .positive
        case .degraded: return .warning
        case .halted: return .critical
        case .unknown: return .unknown
        }
    }

    static func executionAxis(_ execution: ExecutionState) -> AxisPresentation {
        AxisPresentation(title: "执行状态", value: execution.label, tone: executionTone(execution), systemImage: executionImage(execution))
    }

    static func dependencyAxis(_ dependency: DependencyHealth) -> AxisPresentation {
        var detail: String?
        if case let .degraded(reasons) = dependency, !reasons.isEmpty { detail = reasons.joined(separator: "、") }
        return AxisPresentation(title: "依赖健康", value: dependency.label, tone: dependencyTone(dependency), systemImage: "link", detail: detail)
    }

    static func trustAxis(_ trust: DataTrust) -> AxisPresentation {
        AxisPresentation(
            title: "数据可信度",
            value: trustLabel(trust),
            tone: trustTone(trust),
            systemImage: trustImage(trust),
            detail: trust.notice ?? trust.badge
        )
    }

    static func axes(execution: ExecutionState, dependency: DependencyHealth, trust: DataTrust) -> StateAxesPresentation {
        StateAxesPresentation(execution: executionAxis(execution), dependency: dependencyAxis(dependency), trust: trustAxis(trust))
    }

    static func unknownAxes() -> StateAxesPresentation {
        StateAxesPresentation(
            execution: AxisPresentation(title: "执行状态", value: "未知", tone: .unknown, systemImage: "questionmark.circle"),
            dependency: AxisPresentation(title: "依赖健康", value: "未知", tone: .unknown, systemImage: "link"),
            trust: AxisPresentation(title: "数据可信度", value: "尚未确认", tone: .unknown, systemImage: "questionmark.circle")
        )
    }

    // MARK: - 机器人状态（看不见 != 已停止）

    public static func botStateKind(_ status: BotStatus) -> BotStateKind {
        if let verdict = status.assessment?.verdict {
            switch verdict {
            case .cannotSeeBot: return .unreachable
            case .running: return .operational
            case .runningRestricted: return .runningRestricted
            case .paused: return .paused
            case .stopped: return .stoppedConfirmed
            case .indeterminate: return .indeterminateExecution
            case let .dataNotTrustworthy(trust):
                switch trust {
                case .expired: return .unknownStale
                case .fresh, .aging, .stale, .unknown: return .neverConfirmed
                }
            }
        }
        if case .unreachable = status.reachability { return .unreachable }
        if !status.trust.rendersData {
            return status.trust == .expired ? .unknownStale : .neverConfirmed
        }
        switch status.execution {
        case .running:
            return status.dependency == .healthy ? .operational : .runningRestricted
        case .paused: return .paused
        case .killed: return .stoppedConfirmed
        case .indeterminate: return .indeterminateExecution
        }
    }

    static func dependencyIssueLabels(_ status: BotStatus) -> [String] {
        if let blockers = status.assessment?.health.blockers, !blockers.isEmpty {
            return blockers.map(\.label)
        }
        if case let .degraded(reasons) = status.dependency { return reasons }
        return []
    }

    static func identityPresentation(_ status: BotStatus) -> IdentityPresentation {
        IdentityPresentation(
            botLabel: status.identity?.displayName,
            botId: status.identity?.id.rawValue,
            strategyLabel: status.strategyVersion.map { $0.strategyId + " " + $0.version },
            strategyHash: status.strategyVersion?.contentHash,
            runLabel: status.run?.id.rawValue,
            runHost: status.run?.host
        )
    }

    static func botPresentations(_ observation: DeskObservation?, statuses: [BotStatus], input: FeaturesAdapterInput, caps: [String]) -> [BotPresentation] {
        statuses.enumerated().map { index, status in
            let state = botStateKind(status)
            let sharedDeskData = statuses.count > 1
            let positions = (observation?.positions ?? []).map { positionPresentation($0, trust: status.trust, attributionReliable: !sharedDeskData) }
            let orders = (observation?.orders ?? []).map { orderPresentation($0, trust: status.trust) }
            let fills = (observation?.fills ?? []).map { fillPresentation($0) }
            let lastConfirmed = status.lastConfirmedHealthyAtMs
            var stateDetail: String?
            if let lastConfirmed {
                stateDetail = "最后一次确认运行正常：" + FeaturesFormatter.relativeAge(atMs: lastConfirmed, nowMs: input.nowMs)
            }
            return BotPresentation(
                id: status.identity?.id.rawValue ?? status.deskId ?? ("bot-" + String(index)),
                label: status.label ?? status.identity?.displayName ?? ("机器人 " + String(index + 1)),
                identity: identityPresentation(status),
                state: state,
                stateDetail: stateDetail,
                axes: axes(execution: status.execution, dependency: status.dependency, trust: status.trust),
                phase: status.phase,
                waitReason: status.waitReason,
                dependencyIssues: dependencyIssueLabels(status),
                positionCount: observation == nil ? nil : positions.count,
                activeOrderCount: observation == nil ? nil : orders.filter { $0.stage.isAwaiting }.count,
                lastConfirmedHealthyAtMs: lastConfirmed,
                runtimeMode: input.runtimeMode,
                rendersData: status.trust.rendersData && observation != nil,
                notice: status.trust.notice,
                generatedAtMs: observation?.generatedAtMs ?? 0,
                sourceId: observation?.sourceId ?? "",
                timeline: (observation?.events ?? []).map { eventPresentation($0) },
                positions: positions,
                orders: orders,
                recentFills: fills,
                decisionSummary: nil,
                decisionBlockedReason: status.waitReason,
                actions: []
            )
        }
    }

    // MARK: - 观测项

    static func positionPresentation(_ position: PositionObservation, trust: DataTrust, attributionReliable: Bool) -> PositionPresentation {
        let effectiveTrust = position.trust == .unknown ? trust : position.trust
        return PositionPresentation(
            id: position.cardId,
            symbol: position.symbol,
            side: position.side,
            quantity: position.quantity,
            entryPrice: position.entryPrice,
            pnl: position.pnl,
            attribution: position.attribution,
            isAttributionReliable: attributionReliable && position.attribution != nil,
            fallbackText: position.fallbackText,
            rendersData: effectiveTrust.rendersData,
            notice: effectiveTrust.notice,
            axes: axes(execution: .indeterminate, dependency: .unknown, trust: effectiveTrust),
            actions: []
        )
    }

    static func orderPresentation(_ order: OrderObservation, trust: DataTrust) -> OrderPresentation {
        let effectiveTrust = order.trust == .unknown ? trust : order.trust
        return OrderPresentation(
            id: order.cardId,
            symbol: order.symbol,
            side: order.side,
            price: order.price,
            quantity: order.quantity,
            filledQuantity: order.filledQuantity,
            stateRaw: order.state,
            stage: lifecycleStage(order.state),
            stateSinceMs: order.stateSinceMs,
            attribution: nil,
            fallbackText: order.fallbackText,
            rendersData: effectiveTrust.rendersData,
            notice: effectiveTrust.notice,
            axes: axes(execution: .indeterminate, dependency: .unknown, trust: effectiveTrust),
            actions: []
        )
    }

    /// 只识别契约里写过的字面量（Swift 驼峰与常见服务端写法）；**不认识的原始值原样显示**。
    public static func lifecycleStage(_ raw: String?) -> OrderLifecycleStage {
        guard let raw, !raw.isEmpty else { return .unknownState("未知") }
        switch raw {
        case "intentRecorded", "intent_recorded", "intent-recorded", "submitting", "submitted": return .submitted
        case "submittedUnknown", "submitted_unknown", "submitted-unknown": return .submittedUnknown
        case "partiallyFilled", "partially_filled", "partially-filled", "partial": return .partiallyFilled
        case "filled": return .filled
        case "cancelPending", "cancel_pending", "cancel-pending", "cancelRequested": return .cancelPending
        case "cancelling", "canceling", "cancelling_requested": return .cancelling
        case "canceled", "cancelled": return .canceled
        case "rejected": return .rejected
        case "expired": return .expired
        case "neverArrived", "never_arrived", "never-arrived": return .neverArrived
        default: return .unknownState(raw)
        }
    }

    static func fillPresentation(_ fill: FillObservation) -> FillPresentation {
        FillPresentation(
            id: fill.cardId,
            symbol: fill.symbol,
            side: fill.side,
            quantity: fill.quantity,
            price: fill.price,
            atMs: fill.atMs,
            botLabel: fill.botId,
            fallbackText: "",
            rendersData: fill.trust.rendersData,
            notice: fill.trust.notice,
            axes: axes(execution: .indeterminate, dependency: .unknown, trust: fill.trust)
        )
    }

    static func eventPresentation(_ event: EventObservation) -> EventPresentation {
        EventPresentation(
            id: String(event.atMs) + ":" + event.kind + ":" + event.title,
            atMs: event.atMs,
            kind: event.kind,
            title: event.title,
            detail: event.detail,
            tone: toneForEventKind(event.kind)
        )
    }

    static func toneForEventKind(_ kind: String) -> ThemeTone {
        switch kind {
        case "degradation", "degraded", "risk", "alert", "warning": return .warning
        case "kill", "killed", "fault", "faulted", "critical": return .critical
        case "recovery", "recovered", "resumed", "ok": return .positive
        default: return .neutral
        }
    }

    // MARK: - 告警

    public static func severity(_ raw: String) -> AlertSeverity {
        switch raw {
        case "info": return .info
        case "warning": return .warning
        case "critical": return .critical
        default: return .unknown(raw)
        }
    }

    static func alertPresentations(_ observation: DeskObservation?, statuses: [BotStatus], input: FeaturesAdapterInput, caps: [String]) -> [AlertPresentation] {
        let primary = statuses.first
        return (observation?.alerts ?? []).map { alert in
            let execution = primary?.execution ?? ExecutionState.indeterminate
            let dependency = primary?.dependency ?? DependencyHealth.unknown
            var relatedBot: TraceLinkPresentation?
            if let botId = alert.relatedBotId {
                let label = statuses.first { $0.identity?.id.rawValue == botId || $0.deskId == botId }?.label ?? botId
                relatedBot = TraceLinkPresentation(id: "bot:" + botId, label: "机器人 " + label, target: .bot(botId))
            }
            var relatedAccount: TraceLinkPresentation?
            if let accountId = alert.relatedAccountId {
                relatedAccount = TraceLinkPresentation(id: "account:" + accountId, label: "账户 " + accountId, target: .account(accountId))
            }
            var relatedOrder: TraceLinkPresentation?
            if let orderId = alert.relatedOrderId {
                relatedOrder = TraceLinkPresentation(id: "order:" + orderId, label: "订单 " + orderId, target: .order(orderId))
            }
            return AlertPresentation(
                id: alert.cardId,
                severity: severity(alert.severity),
                title: alert.title,
                lifecycle: AlertLifecyclePresentation(
                    readAtMs: alert.readAtMs,
                    acknowledgedAtMs: alert.acknowledgedAtMs,
                    recoveredAtMs: alert.recoveredAtMs,
                    isRecovered: alert.recovered,
                    firstSeenMs: alert.firstSeenMs,
                    lastSeenMs: alert.lastSeenMs,
                    repeatCount: alert.repeatCount
                ),
                relatedBot: relatedBot,
                relatedAccount: relatedAccount,
                relatedOrder: relatedOrder,
                reason: alert.reason,
                impact: alert.impact,
                fallbackText: alert.fallbackText,
                operable: alert.operable,
                unknownEnumReason: alert.operable ? nil : "这张卡片含本客户端不认识的取值（未知 closed 枚举），已禁用全部动作。",
                rendersData: alert.trust.rendersData,
                notice: alert.trust.notice,
                axes: axes(execution: execution, dependency: dependency, trust: alert.trust),
                actions: actionPresentations(alert.actions, operable: alert.operable, caps: caps)
            )
        }
    }

    // MARK: - 动作（fail-closed）

    static func actionPresentations(_ actions: [CardAction], operable: Bool, caps: [String]) -> [ActionPresentation] {
        actions.map { action in
            guard let kind = ActionKind(rawValue: action.kind) else {
                return ActionPresentation.unknown(rawKind: action.kind)
            }
            let scope = actionScope[kind]
            let capAllowed = caps.contains("action:" + kind.rawValue) || caps.contains("action:*")
            let enabled = operable && capAllowed
            var confirmNote: String?
            if scope == .control {
                confirmNote = "控制类动作：需强确认（生物识别）；服务端仍会重新判定授权与风控。"
            } else if !capAllowed {
                confirmNote = "本设备没有这个能力（caps 不含 " + kind.rawValue + "）。"
            }
            return ActionPresentation(
                id: kind.rawValue,
                kind: kind.rawValue,
                label: action.label,
                enabled: enabled,
                requiresBiometric: requiresBiometric(kind, platform: .mobile),
                isUnknownKind: false,
                scopeLabel: scope.map(scopeLabel) ?? nil,
                confirmNote: confirmNote
            )
        }
    }

    static func scopeLabel(_ plane: ScopePlane) -> String {
        switch plane {
        case .read: return "只读"
        case .command: return "指令"
        case .control: return "控制"
        }
    }

    // MARK: - 资产

    static func assetsPresentation(_ observation: DeskObservation?, input: FeaturesAdapterInput, caps: [String]) -> AssetsPresentation {
        let primaryTrust = observation.map { $0.bot.trust } ?? DataTrust.unknown
        var summary: AssetsSummaryPresentation?
        if let raw = observation?.assetsSummary {
            summary = AssetsSummaryPresentation(
                currency: raw.currency,
                equity: raw.equity,
                available: raw.available,
                margin: raw.margin,
                realizedPnl: raw.realizedPnl,
                unrealizedPnl: raw.unrealizedPnl,
                costs: raw.costs.map { cost in
                    AssetPresentation(
                        id: cost.cardId,
                        label: cost.label,
                        value: cost.value,
                        unit: cost.unit,
                        attribution: nil,
                        fallbackText: "",
                        rendersData: cost.trust.rendersData,
                        notice: cost.trust.notice,
                        axes: axes(execution: .indeterminate, dependency: .unknown, trust: cost.trust)
                    )
                },
                rendersData: primaryTrust.rendersData,
                notice: primaryTrust.notice,
                axes: axes(execution: observation?.bot.execution ?? .indeterminate, dependency: observation?.bot.dependency ?? .unknown, trust: primaryTrust)
            )
        }
        return AssetsPresentation(
            summary: summary,
            positions: (observation?.positions ?? []).map { positionPresentation($0, trust: primaryTrust, attributionReliable: (observation?.bots.count ?? 1) <= 1) },
            orders: (observation?.orders ?? []).map { orderPresentation($0, trust: primaryTrust) },
            fills: (observation?.fills ?? []).map { fillPresentation($0) },
            cashMovements: (observation?.cashMovements ?? []).map { movement in
                CashMovementPresentation(
                    id: movement.cardId,
                    label: movement.label,
                    amount: movement.amount,
                    unit: movement.unit,
                    atMs: movement.atMs,
                    fallbackText: "",
                    rendersData: movement.trust.rendersData,
                    notice: movement.trust.notice,
                    axes: axes(execution: .indeterminate, dependency: .unknown, trust: movement.trust)
                )
            },
            runtimeMode: input.runtimeMode,
            generatedAtMs: observation?.generatedAtMs ?? 0,
            sourceId: observation?.sourceId ?? ""
        )
    }

    // MARK: - 总览

    static func overviewPresentation(
        _ observation: DeskObservation?,
        statuses: [BotStatus],
        bots: [BotPresentation],
        alerts: [AlertPresentation],
        assets: AssetsPresentation,
        connection: ConnectionPresentation,
        input: FeaturesAdapterInput
    ) -> OverviewPresentation {
        let total = bots.count
        func count(of predicate: (BotPresentation) -> Bool) -> Int { bots.filter(predicate).count }
        let buckets: [HealthBucketPresentation] = [
            HealthBucketPresentation(id: BotStateKind.operational.rawValue, label: "运行中", count: count { $0.state == .operational }, tone: .positive),
            HealthBucketPresentation(id: BotStateKind.runningRestricted.rawValue, label: "运行中（受限）", count: count { $0.state == .runningRestricted }, tone: .warning),
            HealthBucketPresentation(id: BotStateKind.paused.rawValue, label: "已暂停", count: count { $0.state == .paused }, tone: .warning),
            HealthBucketPresentation(id: BotStateKind.stoppedConfirmed.rawValue, label: "已停止", count: count { $0.state == .stoppedConfirmed }, tone: .neutral),
            HealthBucketPresentation(id: "unknown", label: "状态未知/看不到", count: count { $0.state.isUnknown }, tone: .unknown)
        ]
        let dependencyAnomalies = bots.filter { $0.state == .runningRestricted }.count
        let unknownCount = count { $0.state.isUnknown }
        var warning: String?
        if dependencyAnomalies > 0 || unknownCount > 0 {
            warning = "当前有 " + String(dependencyAnomalies) + " 台机器人依赖异常、" + String(unknownCount) + " 台状态未知/看不到。账户收益即使为正，也不能说明自动交易系统正常。"
        }
        let topAlerts = alerts.sorted { left, right in
            if left.severity.rank != right.severity.rank { return left.severity.rank > right.severity.rank }
            return (left.lifecycle.lastSeenMs ?? 0) > (right.lifecycle.lastSeenMs ?? 0)
        }.prefix(3)
        let recentEvents = Array((observation?.events ?? []).sorted { $0.atMs > $1.atMs }.prefix(5)).map { eventPresentation($0) }
        let primary = statuses.first
        let axesValue = primary.map { axes(execution: $0.execution, dependency: $0.dependency, trust: $0.trust) } ?? unknownAxes()
        return OverviewPresentation(
            connection: connection,
            runtimeMode: input.runtimeMode,
            generatedAtMs: observation?.generatedAtMs ?? 0,
            sourceId: observation?.sourceId ?? "",
            totalBots: total,
            healthBuckets: buckets,
            dependencyAnomalyCount: dependencyAnomalies,
            unknownCount: unknownCount,
            profitIsNotHealthWarning: warning,
            topAlerts: Array(topAlerts),
            recentEvents: recentEvents,
            assets: assets.summary,
            rendersData: observation != nil && (primary?.trust.rendersData ?? false),
            notice: primary?.trust.notice,
            axes: axesValue
        )
    }

    // MARK: - 设置

    static func settingsPresentation(_ observation: DeskObservation?, connection: ConnectionPresentation, input: FeaturesAdapterInput) -> SettingsPresentation {
        SettingsPresentation(
            connection: connection,
            scopes: (observation?.connection?.scopes ?? []).map(\.rawValue),
            defaultScopes: defaultScopePlanes.map(\.rawValue),
            explicitScopes: explicitScopePlanes.map(\.rawValue),
            notificationMutedDesks: input.notificationMutedDesks,
            privacyHidesAmounts: input.privacyHidesAmounts,
            displayThemePreference: input.displayThemePreference,
            runtimeMode: input.runtimeMode,
            contractGaps: input.contractGaps
        )
    }
}
