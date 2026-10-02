import Foundation
import DshTradingContract
import DshTradingDomain

/// 测试夹具：**手写的契约真值构造**，不使用任何 mock 框架、不桩内部实现、
/// 不 sleep（全部时间由调用方给定，判定是纯函数）。
enum Fixtures {
    static func card(
        _ cardId: String,
        _ cardType: String,
        fields: [(String, String)] = [],
        actions: [CardAction] = [],
        fallback: String = "fallback"
    ) -> Card {
        Card(
            cardId: cardId,
            cardType: cardType,
            revision: 1,
            fallbackText: fallback,
            fields: fields.map { CardField(key: $0.0, label: $0.0, kind: "text", value: $0.1) },
            actions: actions,
            freshnessMs: nil as Double?
        )
    }

    static func snapshot(
        cards: [Card],
        reachability: BotReachability = .reachable,
        execution: ExecutionState = .running,
        atMs: Int = 1_000,
        heartbeat: HeartbeatStatus? = nil
    ) -> ObservationSnapshot {
        ObservationSnapshot(
            atMs: atMs,
            sourceId: "src-local",
            cards: cards,
            reachability: reachability,
            execution: execution,
            a0: nil,
            heartbeat: heartbeat
        )
    }

    static let healthyHeartbeat = HeartbeatStatus(
        lastBeatAtMs: 1_000,
        policy: HeartbeatPolicy(intervalMs: 1_000, graceFactor: 10)
    )

    static func riskStateCard(level: String, alignment: String, symbol: String = "BTC") -> Card {
        card("risk-1", "risk-state", fields: [("level", level), ("alignment", alignment), ("symbol", symbol)])
    }
}

/// 传输事实的最小实现（不是 mock：它就是 ObservationSource 的一个真实实现）。
enum FixtureTransportError: Error, Equatable {
    case unreachable
    case exhausted
}

/// 按序回放的来源：第一次成功、第二次失败 —— 用来验证"断线不清空最后快照"。
actor SequencedSource: ObservationSource {
    private var steps: [Result<ObservationSnapshot, FixtureTransportError>]

    init(_ steps: [Result<ObservationSnapshot, FixtureTransportError>]) {
        self.steps = steps
    }

    func fetchSnapshot() async throws -> ObservationSnapshot {
        guard !steps.isEmpty else { throw FixtureTransportError.exhausted }
        let next = steps.removeFirst()
        switch next {
        case let .success(snapshot): return snapshot
        case let .failure(error): throw error
        }
    }
}

/// 固定结论的确认闸门（真实实现，不桩内部）。
struct FixedGate: ConfirmationGate {
    let decision: ConfirmDecision

    func confirm(level: ConfirmLevel, reason: String) async -> ConfirmDecision {
        decision
    }
}

/// 记录收到的命令（真实实现，不桩内部）。
actor RecordingSink: CommandSink {
    private var received: [(ActionKind, [String: String])] = []
    private let outcome: CommandOutcome

    init(outcome: CommandOutcome = CommandOutcome(accepted: true, message: "accepted")) {
        self.outcome = outcome
    }

    func send(action: ActionKind, params: [String: String]) async throws -> CommandOutcome {
        received.append((action, params))
        return outcome
    }

    func receivedCount() -> Int { received.count }

    func lastAction() -> ActionKind? { received.last?.0 }
}
